import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { FileStore } from "../file-store.js";
import {
  MemoryStore, type GroceryLine, type HouseholdState, type MealPlanEntry,
  type PantryItem, type RecipeIngredient, type RestockResult,
} from "../store.js";

// Independent expectations use literal recipe/stock/list amounts, rather than
// importing the production calculation to produce their own expected values.
const line = (name: string, quantity: number, unit: string): GroceryLine => ({ name, quantity, unit, addedBy: "synthetic test" });
const stock = (name: string, quantity: number, unit: string, lowAt = 0): PantryItem => ({ name, quantity, unit, lowAt });
const recipe = (ingredients: RecipeIngredient[], day = "tonight"): MealPlanEntry => ({
  day, meal: "synthetic measured recipe", servings: 4, missingIngredients: [], ingredients,
});
function household(meal: MealPlanEntry[], pantryItems: PantryItem[] = [], groceryLines: GroceryLine[] = []): HouseholdState {
  return { meal, pantryItems, groceryLines, choreList: [] };
}
function coverage(result: RestockResult, name: string, unit: string) {
  assert.ok(result.coverage, "measured results must expose the amount calculation for inspection");
  const found = result.coverage.find(item => item.name === name && item.unit === unit);
  assert.ok(found, `missing measured coverage for ${name} / ${unit}`);
  return found;
}
function amounts(result: RestockResult, name: string, unit: string) {
  const item = coverage(result, name, unit);
  return {
    required: item.requiredQuantity, pantry: item.pantryQuantity,
    listed: item.listedQuantity, delta: item.quantity, total: item.resultingListQuantity,
  };
}

test("measured adversarial: fractional existing groceries are topped up only by the deficit, then repeat adds zero", async () => {
  const store = new MemoryStore({ initialState: household(
    [recipe([{ name: "flour", quantity: 2.35, unit: "kg" }])],
    [stock("flour", 0.7, "kg")], [line("flour", 0.65, "kg")],
  ) });
  const before = store.snapshot();
  const preview = await store.restockForMeals(1, true);
  assert.equal(preview.quantityMode, "measured");
  assert.deepEqual(amounts(preview, "flour", "kg"), { required: 2.35, pantry: 0.7, listed: 0.65, delta: 1, total: 1.65 });
  assert.deepEqual(store.snapshot(), before, "preview must not alter any household state");
  const written = await store.restockForMeals(1, false, preview.previewToken);
  assert.equal(written.writeApplied, true);
  assert.equal((await store.groceries())[0].quantity, 1.65);
  assert.deepEqual(await store.pantry(), before.pantryItems, "shopping must not consume or replenish pantry stock");
  const after = store.snapshot();
  const repeatPreview = await store.restockForMeals(1, true);
  assert.deepEqual(amounts(repeatPreview, "flour", "kg"), { required: 2.35, pantry: 0.7, listed: 1.65, delta: 0, total: 1.65 });
  const repeat = await store.restockForMeals(1, false, repeatPreview.previewToken);
  assert.equal(repeat.writeApplied, false);
  assert.deepEqual(repeat.added, []);
  assert.deepEqual(store.snapshot(), after);
});

test("measured adversarial: the same normalized ingredient sums across meals without floating error or serving scaling", async () => {
  const store = new MemoryStore({ initialState: household([
    recipe([{ name: " Milk ", quantity: 0.1, unit: "l" }, { name: "ＭＩＬＫ", quantity: 0.005, unit: " L " }]),
    recipe([{ name: "milk", quantity: 0.2, unit: "l" }], "tomorrow"),
  ], [stock("milk", 0.055, "l")], [line("milk", 0.05, "l")]) });
  const preview = await store.restockForMeals(2, true);
  assert.equal(preview.coverage?.length, 1);
  assert.deepEqual(amounts(preview, "milk", "l"), { required: 0.305, pantry: 0.055, listed: 0.05, delta: 0.2, total: 0.25 });
  await store.restockForMeals(2, false, preview.previewToken);
  assert.equal((await store.groceries())[0].quantity, 0.25);
  assert.equal((await store.mealPlan())[0].servings, 4, "stored servings do not multiply declared ingredient amounts");
});

test("measured adversarial: incompatible pantry and list units deduct nothing and remain visible as conflicts", async () => {
  const store = new MemoryStore({ initialState: household(
    [recipe([{ name: "flour", quantity: 1, unit: "kg" }])],
    [stock("flour", 800, "g")], [line("flour", 0.5, "lb")],
  ) });
  const preview = await store.restockForMeals(1, true);
  assert.deepEqual(amounts(preview, "flour", "kg"), { required: 1, pantry: 0, listed: 0, delta: 1, total: 1 });
  assert.deepEqual(preview.unitConflicts, [{
    name: "flour", requestedUnit: "kg", listed: [{ quantity: 0.5, unit: "lb" }], pantry: [{ quantity: 800, unit: "g" }],
  }]);
  await store.restockForMeals(1, false, preview.previewToken);
  assert.deepEqual((await store.groceries()).map(({ name, quantity, unit }) => ({ name, quantity, unit })), [
    { name: "flour", quantity: 0.5, unit: "lb" }, { name: "flour", quantity: 1, unit: "kg" },
  ]);
  assert.equal((await store.pantry())[0].quantity, 800);
});

test("measured adversarial: raw, cooked and generic ingredient names are distinct identities", async () => {
  const store = new MemoryStore({ initialState: household(
    [recipe([{ name: "rice (dry)", quantity: 0.2, unit: "kg" }])],
    [stock("rice (cooked)", 2, "kg")], [line("rice", 1, "kg")],
  ) });
  const preview = await store.restockForMeals(1, true);
  assert.deepEqual(amounts(preview, "rice (dry)", "kg"), { required: 0.2, pantry: 0, listed: 0, delta: 0.2, total: 0.2 });
  assert.deepEqual(preview.unitConflicts, [], "different names must not be described as matching-unit coverage");
  await store.restockForMeals(1, false, preview.previewToken);
  assert.equal((await store.groceries()).find(item => item.name === "rice")?.quantity, 1);
  assert.equal((await store.groceries()).find(item => item.name === "rice (dry)")?.quantity, 0.2);
});

test("measured adversarial: the low-stock floor is a maximum with recipe shortfall, not an extra purchase", async () => {
  const store = new MemoryStore({ initialState: household([recipe([
    { name: "beans", quantity: 1.9, unit: "kg" }, { name: "oil", quantity: 0.8, unit: "l" },
  ])], [stock("beans", 0.4, "kg", 0.5), stock("oil", 0.7, "l", 1)], [line("beans", 0.2, "kg"), line("oil", 0.25, "l")]) });
  const preview = await store.restockForMeals(1, true);
  assert.deepEqual(amounts(preview, "beans", "kg"), { required: 1.9, pantry: 0.4, listed: 0.2, delta: 1.3, total: 1.5 });
  assert.deepEqual(amounts(preview, "oil", "l"), { required: 0.8, pantry: 0.7, listed: 0.25, delta: 0.75, total: 1 });
  assert.equal(coverage(preview, "beans", "kg").lowStockFloor, 1);
  assert.equal(coverage(preview, "oil", "l").lowStockFloor, 1);
});

test("measured adversarial: mixed recipes keep measured amounts separate from the disclosed one-unit checklist floor", async () => {
  const legacy: MealPlanEntry = { day: "tomorrow", meal: "synthetic legacy checklist", servings: 4, missingIngredients: ["salt"] };
  const store = new MemoryStore({ initialState: household([
    recipe([{ name: "flour", quantity: 0.5, unit: "kg" }]), legacy,
  ], [stock("flour", 0.1, "kg")], [line("flour", 0.1, "kg"), line("salt", 0.25, "each")]) });
  const preview = await store.restockForMeals(2, true);
  assert.equal(preview.quantityMode, "mixed");
  assert.deepEqual(amounts(preview, "flour", "kg"), { required: 0.5, pantry: 0.1, listed: 0.1, delta: 0.3, total: 0.4 });
  assert.deepEqual(amounts(preview, "salt", "each"), { required: 0, pantry: 0, listed: 0.25, delta: 0.75, total: 1 });
  assert.equal(coverage(preview, "salt", "each").checklistOnly, true, "a legacy floor must not be presented as a measured recipe amount");
  await store.restockForMeals(2, false, preview.previewToken);
  const repeated = await store.restockForMeals(2, true);
  assert.deepEqual(repeated.added, []);
});

test("measured adversarial: aggregate overflow rejects the whole plan before any publication", async () => {
  let publications = 0;
  const store = new MemoryStore({ initialState: household([
    recipe([{ name: "flour", quantity: 10_000, unit: "kg" }]),
    recipe([{ name: "flour", quantity: 0.001, unit: "kg" }], "tomorrow"),
  ]), beforePublish: async () => { publications++; } });
  const before = store.snapshot();
  await assert.rejects(store.restockForMeals(2, true), /too large|limit/i);
  await assert.rejects(store.restockForMeals(2, false, "a".repeat(64)), /too large|limit/i);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(publications, 0);
});

test("measured adversarial: a full list rejects all top-ups if a later new line exceeds capacity", async () => {
  const list = [line("flour", 0.2, "kg"), ...Array.from({ length: 199 }, (_, i) => line(`synthetic filler ${i}`, 1, "each"))];
  let publications = 0;
  const store = new MemoryStore({ initialState: household([recipe([
    { name: "flour", quantity: 1, unit: "kg" }, { name: "sugar", quantity: 1, unit: "kg" },
  ])], [], list), beforePublish: async () => { publications++; } });
  const before = store.snapshot();
  const preview = await store.restockForMeals(1, true);
  assert.equal(preview.added.length, 2);
  await assert.rejects(store.restockForMeals(1, false, preview.previewToken), /200|limit/i);
  assert.deepEqual(store.snapshot(), before, "earlier flour increment must not escape a later batch failure");
  assert.equal(publications, 0);
  assert.equal((await store.restockForMeals(1, true)).previewToken, preview.previewToken);
});

test("measured adversarial: an amount-only list change invalidates approval and needs explicit fresh confirmation", async () => {
  const store = new MemoryStore({ initialState: household(
    [recipe([{ name: "flour", quantity: 2, unit: "kg" }])],
    [stock("flour", 0.5, "kg")], [line("flour", 0.5, "kg")],
  ) });
  const old = await store.restockForMeals(1, true);
  assert.equal(coverage(old, "flour", "kg").quantity, 1);
  await store.addGrocery(line("flour", 0.25, "kg"));
  const beforeStale = store.snapshot();
  const stale = await store.restockForMeals(1, false, old.previewToken);
  assert.equal(stale.previewChanged, true);
  assert.equal(stale.writeApplied, false);
  assert.equal(stale.dryRun, true);
  assert.equal(coverage(stale, "flour", "kg").quantity, 0.75);
  assert.deepEqual(store.snapshot(), beforeStale);
  const confirmed = await store.restockForMeals(1, false, stale.previewToken);
  assert.equal(confirmed.writeApplied, true);
  assert.equal((await store.groceries())[0].quantity, 1.5);
});

test("measured adversarial: concurrent confirmations of one measured top-up apply exactly once", async () => {
  let publications = 0;
  const store = new MemoryStore({ initialState: household(
    [recipe([{ name: "flour", quantity: 2, unit: "kg" }])], [], [line("flour", 0.75, "kg")],
  ), beforePublish: async () => { publications++; await Promise.resolve(); } });
  const preview = await store.restockForMeals(1, true);
  const results = await Promise.all(Array.from({ length: 16 }, () => store.restockForMeals(1, false, preview.previewToken)));
  assert.equal(results.filter(item => item.writeApplied).length, 1);
  assert.equal(results.filter(item => item.previewChanged).length, 15);
  assert.equal(publications, 1);
  assert.equal((await store.groceries())[0].quantity, 2);
});

test("measured adversarial: beforePublish rejection retains the entire old state and the same usable approval token", async () => {
  const initial = household([recipe([
    { name: "flour", quantity: 1, unit: "kg" }, { name: "oil", quantity: 0.5, unit: "l" },
  ])], [], [line("flour", 0.25, "kg")]);
  let fail = true; let publications = 0;
  let store!: MemoryStore;
  store = new MemoryStore({ initialState: initial, beforePublish: async candidate => {
    publications++;
    if (fail) {
      assert.deepEqual(store.snapshot(), initial, "candidate must remain unpublished while persistence is attempted");
      assert.equal(candidate.groceryLines.find(item => item.name === "flour")?.quantity, 1);
      assert.equal(candidate.groceryLines.find(item => item.name === "oil")?.quantity, 0.5);
      throw new Error("synthetic measured persistence failure");
    }
  } });
  const before = store.snapshot();
  const preview = await store.restockForMeals(1, true);
  await assert.rejects(store.restockForMeals(1, false, preview.previewToken), /synthetic measured persistence failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.restockForMeals(1, true)).previewToken, preview.previewToken);
  fail = false;
  assert.equal((await store.restockForMeals(1, false, preview.previewToken)).writeApplied, true);
  assert.equal(publications, 2);
});

async function fileFixture(t: TestContext) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "household-measured-adversarial-"));
  const stores: FileStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    const target = resolve(directory);
    if (!target.startsWith(temporaryRoot + sep) || !basename(target).startsWith("household-measured-adversarial-")) throw new Error("Refusing cleanup outside the fresh measured test directory");
    await rm(target, { recursive: true, force: true });
  });
  const path = join(directory, "synthetic-measured.json");
  return { path, async open(seed?: HouseholdState) { const store = await FileStore.open(path, seed); stores.push(store); return store; } };
}

test("measured adversarial: durable reload preserves declared amounts and top-ups while invalidating pre-restart tokens", async t => {
  const fixture = await fileFixture(t);
  const initial = household([recipe([{ name: "flour", quantity: 2, unit: "kg" }])], [stock("flour", 0.5, "kg")], [line("flour", 0.5, "kg")]);
  const first = await fixture.open(initial);
  const old = await first.restockForMeals(1, true);
  await first.close();
  const second = await fixture.open();
  assert.deepEqual(await second.mealPlan(), initial.meal);
  assert.deepEqual(await second.pantry(), initial.pantryItems);
  const stale = await second.restockForMeals(1, false, old.previewToken);
  assert.equal(stale.previewChanged, true);
  assert.equal(stale.writeApplied, false);
  assert.deepEqual(await second.groceries(), initial.groceryLines);
  assert.deepEqual(amounts(stale, "flour", "kg"), { required: 2, pantry: 0.5, listed: 0.5, delta: 1, total: 1.5 });
  assert.equal((await second.restockForMeals(1, false, stale.previewToken)).writeApplied, true);
  await second.close();
  const third = await fixture.open();
  assert.equal((await third.groceries())[0].quantity, 1.5);
  assert.deepEqual(await third.mealPlan(), initial.meal);
  const repeated = await third.restockForMeals(1, true);
  assert.deepEqual(repeated.added, []);
  const disk = JSON.parse(await readFile(fixture.path, "utf8"));
  assert.deepEqual(disk.state.meal, initial.meal);
  assert.deepEqual(disk.state.groceryLines, await third.groceries());
});

test("measured adversarial: malformed measured ingredient structures, amounts and ambiguous units fail closed", () => {
  const malformed: unknown[] = [
    null, "flour", { name: "flour", quantity: 1 }, { name: "flour", unit: "kg" },
    { name: "flour", quantity: "1", unit: "kg" }, { name: "flour", quantity: 1, unit: "kg", guessed: true },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0001, 0.1234, 10_000.001].map(quantity => ({ name: "flour", quantity, unit: "kg" })),
    ...["t", "T", "c", "kg/lb", "to taste", "cup or tbsp", "?"].map(unit => ({ name: "flour", quantity: 1, unit })),
  ];
  for (const ingredient of malformed) {
    const initial = household([recipe([ingredient as RecipeIngredient])]);
    assert.throws(() => new MemoryStore({ initialState: initial }), /ingredient|quantity|unit|structure|numeric/i);
  }
  for (const ingredients of [null, "flour", { name: "flour", quantity: 1, unit: "kg" }]) {
    assert.throws(() => new MemoryStore({ initialState: household([recipe(ingredients as unknown as RecipeIngredient[])]) }), /array|ingredient/i);
  }
  const tooMany = Array.from({ length: 201 }, () => ({ name: "flour", quantity: 1, unit: "kg" }));
  assert.throws(() => new MemoryStore({ initialState: household([recipe(tooMany)]) }), /200|limit/i);
});

test("measured adversarial: malformed persisted measured amounts are refused without replacing the original bytes", async t => {
  const fixture = await fileFixture(t);
  const first = await fixture.open(household([recipe([{ name: "flour", quantity: 1, unit: "kg" }])]));
  await first.close();
  const valid = JSON.parse(await readFile(fixture.path, "utf8"));
  for (const mutation of [{ quantity: "1" }, { unit: "t" }, { unexpected: true }]) {
    const document = structuredClone(valid);
    Object.assign(document.state.meal[0].ingredients[0], mutation);
    const bytes = Buffer.from(JSON.stringify(document) + "\n");
    await writeFile(fixture.path, bytes);
    await assert.rejects(fixture.open(), /ingredient|quantity|unit|structure|numeric/i);
    assert.deepEqual(await readFile(fixture.path), bytes);
  }
});
