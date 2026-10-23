import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBriefTools } from "../tools/brief.js";
import { registerSystemTools } from "../tools/system.js";
import { registerHouseholdTools } from "../tools/household.js";
import { MemoryStore } from "../store.js";

async function connect(t: TestContext, store: MemoryStore | undefined = new MemoryStore()) {
  const server = new McpServer({ name: "test", version: "1" }); const inventory: string[] = [];
  registerSystemTools(server, () => inventory);
  inventory.push(...registerBriefTools(server, store));
  if (store) inventory.push(...registerHouseholdTools(server, store));
  const client = new Client({ name: "test", version: "1" });
  t.after(() => Promise.all([client.close(), server.close()]).then(() => {}));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");

test("all nine tool names retain snake_case and dynamic inventory", async (t) => {
  const client = await connect(t); const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 9);
  for (const tool of tools) assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
  const health = JSON.parse(text(await call(client, "health")));
  assert.deepEqual([...health.tools].sort(), tools.map((tool) => tool.name).sort());
});

test("health discloses fictional local demo mode", async (t) => {
  const health = JSON.parse(text(await call(await connect(t), "health")));
  assert.equal(health.ok, true); assert.equal(health.demo, true); assert.equal(health.liveConnections, false);
  assert.equal(health.dataSource, "synthetic fixtures"); assert.match(health.notice, /fictional household data/);
});

test("brief leads with the shared synthetic household block", async (t) => {
  const result = await call(await connect(t), "brief_get"); const out = text(result);
  assert.match(out, /^Synthetic demo: fictional household data\./);
  assert.match(out.split("\n")[2], /^\* Household: Dinner tonight is sheet-pan salmon/);
  assert.match(out, /still need salmon fillets and broccoli/);
  assert.match(out, /Calendar: 2 fictional events/);
  assert.equal((result.structuredContent as { sections: { source: string }[] }).sections[0].source, "household");
});

test("brief reflects completed chores", async (t) => {
  const client = await connect(t); await call(client, "chore_log", { chore: "refill dog bowl" });
  const out = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.doesNotMatch(out, /refill dog bowl/); assert.match(out, /take out recycling for Maya \(fictional\)/);
});

test("brief reflects groceries and distinguishes listed ingredients from stock", async (t) => {
  const client = await connect(t); await call(client, "groceries_add", { name: " SALMON FILLETS ", unit: " EACH " });
  const out = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.match(out, /still need broccoli/);
  assert.match(out, /On the grocery list for dinner: salmon fillets/);
  assert.doesNotMatch(out, /still need salmon fillets/);
});

test("successful restock changes next brief without pretending pantry was replenished", async (t) => {
  const store = new MemoryStore(); const pantryBefore = await store.pantry();
  const client = await connect(t, store); const before = text(await call(client, "brief_get", { topics: ["household"] }));
  const preview = await call(client, "restock_for_meals", { days: 1, dry_run: true });
  const expected_token = (preview.structuredContent as { previewToken: string }).previewToken;
  assert.notEqual((await call(client, "restock_for_meals", { days: 1, dry_run: false, expected_token })).isError, true);
  const after = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.notEqual(after, before); assert.doesNotMatch(after, /still need/);
  assert.match(after, /On the grocery list for dinner: salmon fillets and broccoli/);
  assert.match(after, /Pantry running low, already on the grocery list: oat milk, eggs, blueberries/);
  assert.doesNotMatch(after, /Pantry running low, not on the grocery list in the same unit:/);
  assert.match(after, /Grocery additions do not replenish pantry stock/);
  assert.deepEqual(await store.pantry(), pantryBefore);
});

test("brief does not confuse incompatible grocery units", async (t) => {
  const client = await connect(t); await call(client, "groceries_add", { name: "salmon fillets", unit: "pack" });
  const out = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.match(out, /still need salmon fillets and broccoli/);
  assert.match(out, /Unit check: "salmon fillets" is listed as 1 "pack"; restock uses 1 "each"\. Units are not converted/);
  assert.doesNotMatch(out, /On the grocery list for dinner: salmon fillets/);
});

test("matching checklist unit covers dinner even when another unit is also listed", async (t) => {
  const client = await connect(t);
  await call(client, "groceries_add", { name: "salmon fillets", unit: "lb", quantity: 2 });
  await call(client, "groceries_add", { name: "salmon fillets", unit: "each" });
  const out = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.match(out, /still need broccoli/);
  assert.match(out, /On the grocery list for dinner: salmon fillets/);
  assert.doesNotMatch(out, /Unit check: "salmon fillets"|still need salmon fillets/);
});

test("low pantry brief distinguishes groceries already listed without changing stock", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store);
  const before = await store.pantry();
  const initial = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.match(initial, /Pantry running low, not on the grocery list in the same unit: oat milk, eggs/);
  assert.match(initial, /Pantry running low, already on the grocery list: blueberries/);
  await call(client, "groceries_add", { name: "oat milk", unit: "carton" });
  const updated = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.match(updated, /Pantry running low, not on the grocery list in the same unit: eggs/);
  assert.match(updated, /Pantry running low, already on the grocery list: oat milk, blueberries/);
  assert.deepEqual(await store.pantry(), before);
});

test("brief recognizes exact positive pantry stock", async (t) => {
  class PlanStore extends MemoryStore { override async mealPlan() { return [{ day: "tonight", meal: "sample rice bowl", servings: 1, missingIngredients: [" RICE "] }]; } }
  const out = text(await call(await connect(t, new PlanStore()), "brief_get", { topics: ["household"] }));
  assert.match(out, /sample rice bowl/); assert.doesNotMatch(out, /still need/);
});

test("brief normalizes topic names and honors headline detail", async (t) => {
  const result = await call(await connect(t), "brief_get", { topics: [" WEATHER "], detail: "headline" });
  assert.match(text(result), /68 degrees Fahrenheit/); assert.doesNotMatch(text(result), /Calendar|air quality/i);
});

test("brief topics normalize visible Unicode before source lookup", async (t) => {
  const result = await call(await connect(t), "brief_get", { topics: [" ＷＥＡＴＨＥＲ "], detail: "headline" });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /68 degrees Fahrenheit/);
  assert.doesNotMatch(text(result), /Calendar|Pantry running low/i);
});

test("brief bounds untrusted topic count and text without affecting household state", async (t) => {
  const store = new MemoryStore(); const client = await connect(t, store); const before = await store.groceries();
  for (const topics of [Array(9).fill("weather"), ["a".repeat(21)], ["weather\u202e"], ["wea\u200bther"], ["weather\n"], [" "]]) {
    const result = await call(client, "brief_get", { topics });
    assert.equal(result.isError, true, JSON.stringify(topics));
  }
  assert.deepEqual(await store.groceries(), before);
  const atCountBoundary = await call(client, "brief_get", { topics: Array(8).fill("weather") });
  assert.notEqual(atCountBoundary.isError, true);
  const atTextBoundary = await call(client, "brief_get", { topics: ["a".repeat(20)] });
  assert.equal(atTextBoundary.isError, true);
  assert.match(text(atTextBoundary), /Available sources:/, "20-character topic reaches source lookup rather than validation failure");
});

test("unknown or empty topic selections report an error instead of an empty successful brief", async (t) => {
  const client = await connect(t);
  for (const topics of [["unknown"], []]) {
    const result = await call(client, "brief_get", { topics }); assert.equal(result.isError, true); assert.match(text(result), /Available sources:/);
  }
});

test("fixture-only mode advertises its actual sources and no schedule", async (t) => {
  // Passing no store directly to registration keeps this mode available to callers.
  const server = new McpServer({ name: "fixture-only", version: "1" }); registerBriefTools(server);
  const client = new Client({ name: "test", version: "1" }); t.after(() => Promise.all([client.close(), server.close()]).then(() => {}));
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(ct), server.connect(st)]);
  const result = await call(client, "brief_preferences"); const prefs = JSON.parse(text(result));
  assert.deepEqual(prefs.availableSources, ["weather", "calendar", "home"]);
  assert.equal(prefs.demo, true); assert.equal(prefs.liveConnections, false); assert.match(prefs.spokenAt, /no scheduler/);
});

test("all tools disclose synthetic mode through discovery and return structured content", async (t) => {
  const client = await connect(t);
  for (const tool of (await client.listTools()).tools) {
    assert.match(tool.description ?? "", /synthetic demo/); assert.equal(tool.annotations?.openWorldHint, false);
  }
  for (const name of ["health", "brief_get", "brief_preferences"]) {
    const result = await call(client, name); assert.ok(result.structuredContent);
    assert.equal((result.structuredContent as { demo: boolean }).demo, true);
    assert.match(text(result), /fictional household data/);
    assert.doesNotMatch(text(result), /sleep|heart.rate|wearable/i);
  }
});
