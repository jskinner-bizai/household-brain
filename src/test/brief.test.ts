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
  const client = await connect(t); const before = text(await call(client, "brief_get", { topics: ["household"] }));
  await call(client, "restock_for_meals", { days: 1 });
  const after = text(await call(client, "brief_get", { topics: ["household"] }));
  assert.notEqual(after, before); assert.doesNotMatch(after, /still need/);
  assert.match(after, /On the grocery list for dinner: salmon fillets and broccoli/);
  assert.match(after, /Running low on oat milk, eggs, blueberries/);
});

test("brief does not confuse incompatible grocery units", async (t) => {
  const client = await connect(t); await call(client, "groceries_add", { name: "salmon fillets", unit: "pack" });
  assert.match(text(await call(client, "brief_get", { topics: ["household"] })), /still need salmon fillets and broccoli/);
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
