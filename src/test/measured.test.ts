import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../file-store.js";
import { measuredDemoState } from "../measured-fixture.js";
import { MemoryStore, type RecipeIngredient } from "../store.js";
import { registerHouseholdTools } from "../tools/household.js";
import { registerBriefTools } from "../tools/brief.js";

async function connect(t: TestContext, store: MemoryStore) {
  const server = new McpServer({ name: "measured-test", version: "1" });
  registerHouseholdTools(server, store); registerBriefTools(server, store);
  const client = new Client({ name: "measured-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  t.after(() => Promise.all([client.close(), server.close()]).then(() => {}));
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text?: string }[]).map(block => block.text ?? "").join("\n");
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "household-measured-seed-"));
  const stores: FileStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Refusing test cleanup outside the temporary root");
    await rm(directory, { recursive: true, force: true });
  });
  return { path: join(directory, "household.json"), stores };
}

test("authorized recipe fixture distinguishes complete cooking amounts from exactly six shopping deltas", async () => {
  const store = new MemoryStore({ initialState: measuredDemoState() }); const before = store.snapshot();
  const preview = await store.restockForMeals(2, true);
  assert.equal(preview.quantityMode, "measured"); assert.equal(preview.coverage?.length, 20);
  assert.deepEqual(preview.added.map(({ name, unit, quantity, requiredQuantity, pantryQuantity, listedQuantity, resultingListQuantity }) => ({ name, unit, quantity, requiredQuantity, pantryQuantity, listedQuantity, resultingListQuantity })), [
    { name: "bone-in chicken thighs", unit: "each", quantity: 4, requiredQuantity: 8, pantryQuantity: 4, listedQuantity: 0, resultingListQuantity: 4 },
    { name: "brussels sprouts", unit: "lb", quantity: 1, requiredQuantity: 2, pantryQuantity: 1, listedQuantity: 0, resultingListQuantity: 1 },
    { name: "garlic cloves", unit: "each", quantity: 2, requiredQuantity: 6, pantryQuantity: 4, listedQuantity: 0, resultingListQuantity: 2 },
    { name: "flank steak", unit: "lb", quantity: 1, requiredQuantity: 1.5, pantryQuantity: 0.5, listedQuantity: 0, resultingListQuantity: 1 },
    { name: "bell peppers", unit: "each", quantity: 2, requiredQuantity: 3, pantryQuantity: 1, listedQuantity: 0, resultingListQuantity: 2 },
    { name: "cauliflower rice", unit: "cup", quantity: 3, requiredQuantity: 6, pantryQuantity: 3, listedQuantity: 0, resultingListQuantity: 3 },
  ]);
  assert.ok(preview.coverage?.find(item => item.name === "blueberries" && item.quantity === 0 && item.lowStockFloor === 1 && item.listedQuantity === 2));
  assert.deepEqual(store.snapshot(), before);
  const confirmed = await store.restockForMeals(2, false, preview.previewToken);
  assert.equal(confirmed.writeApplied, true); assert.equal((await store.groceries()).length, 7);
  assert.deepEqual(await store.pantry(), before.pantryItems);
  const next = await store.restockForMeals(2, true);
  assert.deepEqual(next.added, []);
  assert.equal((await store.restockForMeals(2, false, next.previewToken)).writeApplied, false);
});

test("real MCP returns recipe cooking quantities separately from shopping additions and refreshed brief", async t => {
  const store = new MemoryStore({ initialState: measuredDemoState() }); const client = await connect(t, store);
  const plan = await call(client, "mealplan_get");
  const first = (plan.structuredContent as { plan: { servings: number; ingredients: RecipeIngredient[] }[] }).plan[0];
  assert.equal(first.servings, 4); assert.equal(first.ingredients[0].quantity, 8);
  assert.match(text(plan), /8 each of bone-in chicken thighs/); assert.match(text(plan), /not shopping additions/);
  const beforeBrief = await call(client, "brief_get", { topics: ["household"] });
  assert.match(text(beforeBrief), /4 each of "bone-in chicken thighs"/);
  assert.match(text(beforeBrief), /1 lb of "brussels sprouts"/);
  const preview = await call(client, "restock_for_meals", { days: 2, dry_run: true });
  const token = (preview.structuredContent as { previewToken: string }).previewToken;
  assert.match(text(preview), /4 each of "bone-in chicken thighs"/);
  assert.doesNotMatch(text(preview), /I'd add.*8 each of "bone-in chicken thighs"/);
  const receipt = await call(client, "restock_for_meals", { days: 2, dry_run: false, expected_token: token });
  assert.equal(receipt.isError, undefined); assert.match(text(receipt), /list total 4 each/);
  const afterBrief = await call(client, "brief_get", { topics: ["household"] });
  assert.match(text(afterBrief), /measured cooking amounts are covered/);
  assert.doesNotMatch(text(afterBrief), /Still needed for dinner/);
});

test("library default remains the legacy checklist with unchanged result shape", async () => {
  const store = new MemoryStore();
  assert.equal((await store.mealPlan())[0].meal, "sheet-pan salmon with rice and greens");
  assert.equal((await store.mealPlan())[0].ingredients, undefined);
  const preview = await store.restockForMeals(2, true);
  assert.equal(preview.quantityMode, undefined); assert.equal(preview.coverage, undefined);
  assert.equal(preview.added.length, 6);
  for (const item of preview.added) assert.deepEqual(Object.keys(item).sort(), ["name", "reason", "unit"]);
});

test("a fresh FileStore detaches and validates its measured seed before persistence", async t => {
  const { path, stores } = await temporary(t); const seed = measuredDemoState();
  const opening = FileStore.open(path, seed);
  seed.meal[0].ingredients![0].quantity = 999;
  const store = await opening; stores.push(store);
  assert.equal((await store.mealPlan())[0].ingredients![0].quantity, 8);
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.equal(document.state.meal[0].ingredients[0].quantity, 8);
  assert.equal((await store.restockForMeals(2, true)).added.length, 6);
});

test("existing FileStore bytes win over changed or invalid seeds without fixture replacement", async t => {
  const { path, stores } = await temporary(t);
  const first = await FileStore.open(path, measuredDemoState()); stores.push(first);
  await first.addGrocery({ name: "bone-in chicken thighs", quantity: 2, unit: "each", addedBy: "test" });
  const before = await readFile(path); const plan = await first.mealPlan();
  await first.close();
  const invalidSeed = measuredDemoState(); invalidSeed.meal[0].ingredients![0].unit = "T";
  const second = await FileStore.open(path, invalidSeed); stores.push(second);
  assert.deepEqual(await second.mealPlan(), plan); assert.deepEqual(await readFile(path), before);
  assert.equal((await second.restockForMeals(2, true)).added.find(item => item.name === "bone-in chicken thighs")?.quantity, 2);
  await second.close();
  const third = await FileStore.open(path, new MemoryStore().snapshot()); stores.push(third);
  assert.deepEqual(await third.mealPlan(), plan); assert.deepEqual(await readFile(path), before);
});

test("an invalid measured seed fails closed without a state file or abandoned lock", async t => {
  const { path } = await temporary(t); const seed = measuredDemoState();
  seed.meal[0].ingredients![0].quantity = Number.NaN;
  await assert.rejects(FileStore.open(path, seed), /finite and positive/);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await assert.rejects(readFile(path + ".lock"), { code: "ENOENT" });
});
