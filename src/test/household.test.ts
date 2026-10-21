import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerHouseholdTools } from "../tools/household.js";
import { MemoryStore, matchChores, type GroceryLine, type EnsureGroceriesResult } from "../store.js";

async function connect(t: TestContext, store = new MemoryStore()) {
  const server = new McpServer({ name: "test", version: "1" });
  registerHouseholdTools(server, store);
  const client = new Client({ name: "test", version: "1" });
  t.after(() => Promise.all([client.close(), server.close()]).then(() => {}));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");

test("pantry query normalizes names and lists low stock", async (t) => {
  const client = await connect(t);
  assert.match(text(await call(client, "pantry_query", { item: "  EGGS " })), /4 each of eggs/);
  assert.match(text(await call(client, "pantry_query")), /Running low:.*blueberries/);
  assert.equal((await call(client, "pantry_query", { item: "  " })).isError, true);
});

test("grocery addition normalizes name and unit and returns structured content", async (t) => {
  const store = new MemoryStore();
  const result = await call(await connect(t, store), "groceries_add", { name: "  BLUEBERRIES ", quantity: 3, unit: " PACK " });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { demo: true, list: [{ name: "blueberries", quantity: 5, unit: "pack", addedBy: "Maya (fictional)" }] });
  assert.match(text(result), /Added 3 pack of blueberries/);
});

test("grocery addition keeps incompatible units separate", async (t) => {
  const store = new MemoryStore();
  await call(await connect(t, store), "groceries_add", { name: "blueberries", quantity: 500, unit: "G" });
  assert.deepEqual((await store.groceries()).map(({ quantity, unit }) => ({ quantity, unit })), [{ quantity: 2, unit: "pack" }, { quantity: 500, unit: "g" }]);
});

test("blank names and units reject without mutations", async (t) => {
  const store = new MemoryStore(); const before = await store.groceries(); const client = await connect(t, store);
  for (const args of [{ name: " \t " }, { name: "eggs", unit: "  " }]) assert.equal((await call(client, "groceries_add", args)).isError, true);
  assert.deepEqual(await store.groceries(), before);
});

test("invalid quantities reject without mutations", async (t) => {
  const store = new MemoryStore(); const before = await store.groceries(); const client = await connect(t, store);
  for (const quantity of [0, -1, "1"]) assert.equal((await call(client, "groceries_add", { name: "eggs", quantity })).isError, true);
  for (const quantity of [Infinity, NaN, -1]) await assert.rejects(store.addGrocery({ name: "eggs", unit: "each", quantity, addedBy: "audit" }), /finite and positive/);
  assert.deepEqual(await store.groceries(), before);
});

test("overflow rejects before changing an existing quantity", async () => {
  const store = new MemoryStore();
  const line = { name: "large", quantity: Number.MAX_VALUE, unit: "each", addedBy: "audit" };
  await store.addGrocery(line);
  const before = await store.groceries();
  await assert.rejects(store.addGrocery(line), /too large/);
  assert.deepEqual(await store.groceries(), before);
});

test("store validates direct callers and returns defensive copies", async () => {
  const store = new MemoryStore(); const before = await store.groceries();
  await assert.rejects(store.addGrocery({ name: " ", unit: "each", quantity: 1, addedBy: "audit" }), /blank/);
  await assert.rejects(store.addGrocery({ name: "apples", unit: " ", quantity: 1, addedBy: "audit" }), /blank/);
  const copy = await store.groceries(); copy[0].quantity = -1;
  assert.deepEqual(await store.groceries(), before);
});

test("meal plan lists tonight and its ingredient checklist", async (t) => {
  const result = await call(await connect(t), "mealplan_get");
  assert.match(text(result), /tonight: sheet-pan salmon/);
  assert.match(text(result), /still need salmon fillets and broccoli/);
  assert.ok((result.structuredContent as { plan: unknown[] }).plan.length);
});

test("chore logging accepts normalized unique partial names", async (t) => {
  const store = new MemoryStore(); const result = await call(await connect(t, store), "chore_log", { chore: "  ReCYCLING " });
  assert.match(text(result), /Logged: take out recycling/);
  assert.deepEqual((await store.chores()).map((chore) => chore.done), [true, false, false]);
});

test("blank chores reject without changing state", async (t) => {
  const store = new MemoryStore(); const before = await store.chores(); const client = await connect(t, store);
  for (const chore of ["", " \t "]) assert.equal((await call(client, "chore_log", { chore })).isError, true);
  await assert.rejects(store.logChore("  "), /blank/);
  assert.deepEqual(await store.chores(), before);
});

test("ambiguous names remain ambiguous across done and open chores", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store);
  await call(client, "chore_log", { chore: "recycling" });
  const before = await store.chores();
  for (let i = 0; i < 2; i++) {
    const result = await call(client, "chore_log", { chore: "r" });
    assert.equal(result.isError, true); assert.match(text(result), /Multiple chores match/);
  }
  assert.equal(await store.logChore("r"), null);
  assert.deepEqual(await store.chores(), before);
});

test("exact chore names take precedence over partial matches including done entries", () => {
  const chores = [{ name: "water", assignee: "fictional", dueInDays: 0, done: true }, { name: "water plants", assignee: "fictional", dueInDays: 0, done: false }];
  assert.deepEqual(matchChores(chores, " WATER "), [chores[0]]);
});

test("negated and unknown phrases do not log chores", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store); const before = await store.chores();
  for (const chore of ["do not take out recycling", "mow the lawn"]) assert.equal((await call(client, "chore_log", { chore })).isError, true);
  assert.deepEqual(await store.chores(), before);
});

test("repeated completed chore is acknowledged without selecting another chore", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store);
  await call(client, "chore_log", { chore: "recycling" }); const before = await store.chores();
  assert.match(text(await call(client, "chore_log", { chore: "RECYCLING" })), /Already logged: take out recycling/);
  assert.deepEqual(await store.chores(), before);
});

test("summary combines the fixture sources", async (t) => {
  const result = await call(await connect(t), "household_summary");
  assert.match(text(result), /Pantry low:/); assert.match(text(result), /Grocery list has 1 item/); assert.match(text(result), /Open chores:/);
});

test("restock dry run previews without invoking the write operation", async (t) => {
  class ReadOnlyStore extends MemoryStore { override async ensureGroceries(_lines: GroceryLine[]): Promise<EnsureGroceriesResult> { throw new Error("dry run attempted a write"); } }
  const store = new ReadOnlyStore(); const before = await store.groceries();
  const result = await call(await connect(t, store), "restock_for_meals", { days: 2, dry_run: true });
  assert.equal(result.isError, undefined); assert.match(text(result), /I'd add/); assert.match(text(result), /tortillas/);
  assert.equal((result.structuredContent as { dryRun: boolean }).dryRun, true);
  assert.deepEqual(await store.groceries(), before);
});

test("restock ensures missing ingredients and low staples once", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store);
  const first = await call(client, "restock_for_meals", { days: 1 });
  assert.deepEqual((first.structuredContent as { added: { name: string }[] }).added.map((a) => a.name).sort(), ["broccoli", "eggs", "oat milk", "salmon fillets"]);
  const before = await store.groceries();
  const second = await call(client, "restock_for_meals", { days: 1 });
  assert.deepEqual((second.structuredContent as { added: unknown[] }).added, []);
  assert.deepEqual(await store.groceries(), before);
});

test("concurrent restocks across separate servers do not double quantities", async (t) => {
  const store = new MemoryStore(); const clients = await Promise.all([connect(t, store), connect(t, store)]);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(clients[i % 2], "restock_for_meals", { days: 1 })));
  assert.ok(results.every((result) => !result.isError));
  assert.equal(results.reduce((count, result) => count + (result.structuredContent as { added: unknown[] }).added.length, 0), 4);
  assert.deepEqual((await store.groceries()).map(({ name, quantity }) => ({ name, quantity })), [
    { name: "blueberries", quantity: 2 }, { name: "salmon fillets", quantity: 1 }, { name: "broccoli", quantity: 1 }, { name: "oat milk", quantity: 1 }, { name: "eggs", quantity: 1 },
  ]);
});

test("restock deduplicates exact name and unit without confusing similar ingredients", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store);
  await call(client, "groceries_add", { name: "salmon fillets for pet food" });
  await call(client, "groceries_add", { name: "oat milk", unit: "liter" });
  const result = await call(client, "restock_for_meals", { days: 1 });
  assert.deepEqual((result.structuredContent as { added: { name: string; unit: string }[] }).added.filter((line) => ["salmon fillets", "oat milk"].includes(line.name)).map(({ name, unit }) => ({ name, unit })), [{ name: "salmon fillets", unit: "each" }, { name: "oat milk", unit: "carton" }]);
});

test("restock skips exact ingredients on hand and deduplicates across meals", async (t) => {
  class PlanStore extends MemoryStore { override async mealPlan() { return [
    { day: "tonight", meal: "sample meal", servings: 4, missingIngredients: [" RICE ", " SALMON FILLETS "] },
    { day: "tomorrow", meal: "sample meal two", servings: 4, missingIngredients: ["salmon fillets"] },
  ]; } }
  const store = new PlanStore(); await call(await connect(t, store), "restock_for_meals", { days: 2 });
  const groceries = await store.groceries(); assert.equal(groceries.some((line) => line.name === "rice"), false);
  assert.equal(groceries.find((line) => line.name === "salmon fillets")?.quantity, 1);
});

test("atomic ensure validates the whole batch before mutation and returns defensive results", async () => {
  const store = new MemoryStore(); const before = await store.groceries();
  await assert.rejects(store.ensureGroceries([{ name: "carrots", quantity: 1, unit: "each", addedBy: "audit" }, { name: " ", quantity: 1, unit: "each", addedBy: "audit" }]), /blank/);
  assert.deepEqual(await store.groceries(), before);
  const result = await store.ensureGroceries([{ name: " Carrots ", quantity: 1, unit: " EACH ", addedBy: "audit" }, { name: "carrots", quantity: 1, unit: "each", addedBy: "audit" }]);
  assert.equal(result.added.length, 1); result.added[0].quantity = -1;
  assert.equal((await store.groceries()).find((line) => line.name === "carrots")?.quantity, 1);
});

test("all household tools disclose fictional demo state and retain annotations and structured content", async (t) => {
  const client = await connect(t);
  for (const [name, args] of [["pantry_query", {}], ["groceries_add", { name: "apples" }], ["mealplan_get", {}], ["chore_log", { chore: "recycling" }], ["household_summary", {}], ["restock_for_meals", { dry_run: true }]] as const) {
    const result = await call(client, name, args);
    assert.match(text(result), /Synthetic demo: fictional household data/);
    assert.equal((result.structuredContent as { demo: boolean }).demo, true);
  }
  for (const tool of (await client.listTools()).tools) {
    assert.match(tool.description ?? "", /synthetic demo/);
    assert.equal(tool.annotations?.openWorldHint, false);
  }
});
