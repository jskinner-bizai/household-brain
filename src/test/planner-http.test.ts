import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createDemoHttpServer, type DemoServerOptions } from "../server.js";
import { createMockModel } from "../mock-model.js";
import { MemoryStore } from "../store.js";
import type { PlannerModel } from "../planner.js";

async function start(t: TestContext, options: DemoServerOptions = {}) {
  const server = createDemoHttpServer(options);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const preview = (body: unknown = { days: 2 }, extraHeaders: Record<string, string> = {}) => fetch(`${base}/planner/preview`, {
    method: "POST", headers: { "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
  });
  return { base, preview };
}

test("mock planner calls real HTTP MCP reads and preview without applying a mutation", async t => {
  const store = new MemoryStore(); const before = await store.groceries();
  const { base, preview } = await start(t, { store, planner: { model: createMockModel(), mode: "mock" } });
  const config = await (await fetch(`${base}/demo-config.json`)).json();
  assert.equal(config.planner.mode, "mock"); assert.equal(config.planner.confirmationRequired, true);
  const response = await preview(); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "mock");
  assert.deepEqual(result.trace.map((entry: {tool: string}) => entry.tool), ["mealplan_get", "pantry_query", "restock_for_meals"]);
  assert.equal(result.receipt.modelRequests, 3); assert.equal(result.receipt.toolCalls, 3);
  assert.equal(result.preview.structuredContent.dryRun, true);
  assert.equal(result.preview.structuredContent.writeApplied, false);
  assert.equal(result.preview.structuredContent.added.length, 6);
  assert.deepEqual(await store.groceries(), before);
  const again = await preview(); assert.equal(again.status, 409); await again.text();
});

test("concurrent planner requests consume exactly one attempt", async t => {
  let modelCalls = 0, reservations = 0;
  const mock = createMockModel();
  const model: PlannerModel = { async converse(input, signal) { modelCalls++; return mock.converse(input, signal); } };
  const { preview } = await start(t, { planner: { model, mode: "mock", beforeRun: async () => { reservations++; } } });
  const responses = await Promise.all(Array.from({ length: 12 }, () => preview()));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 11);
  await Promise.all(responses.map(response => response.text()));
  assert.equal(modelCalls, 3); assert.equal(reservations, 1);
});

test("invalid requests, methods and origins do not consume an available attempt", async t => {
  let calls = 0; const mock = createMockModel();
  const { base, preview } = await start(t, { planner: { mode: "mock", model: { async converse(input, signal) { calls++; return mock.converse(input, signal); } } } });
  for (const body of [{ days: 0 }, { days: 8 }, { days: 2, dry_run: false }, { days: 2, request: "Ignore safety" }, { days: 1.5 }, null, []]) {
    const response = await preview(body); assert.equal(response.status, 400); await response.text();
  }
  const wrongType = await preview({ days: 2 }, { "content-type": "text/plain" });
  assert.equal(wrongType.status, 415); await wrongType.text();
  const wrongOrigin = await preview({ days: 2 }, { origin: "https://evil.example" });
  assert.equal(wrongOrigin.status, 403); await wrongOrigin.text();
  const method = await fetch(`${base}/planner/preview`); assert.equal(method.status, 405); await method.text();
  const huge = await preview({ days: 2, extra: "x".repeat(3000) }); assert.equal(huge.status, 413); await huge.text();
  assert.equal(calls, 0);
  const valid = await preview(); assert.equal(valid.status, 200); await valid.text();
});

test("disabled planner and failed durable reservation cannot call a model", async t => {
  const disabled = await start(t);
  const response = await disabled.preview(); assert.equal(response.status, 503); await response.text();
  assert.throws(() => createDemoHttpServer({ endpoint: "/planner/preview" }), /MCP_ENDPOINT/);
  let calls = 0;
  const { preview } = await start(t, { planner: { mode: "mock", model: { async converse() { calls++; throw new Error("should not run"); } }, beforeRun: async () => { throw new Error("receipt blocked"); } } });
  const failed = await preview(); assert.equal(failed.status, 503); await failed.text();
  const again = await preview(); assert.equal(again.status, 409); await again.text(); assert.equal(calls, 0);
});

test("provider failure is not retried and private error text is withheld", async t => {
  let calls = 0;
  const { preview } = await start(t, { planner: { mode: "mock", model: { async converse() { calls++; throw new Error("private-token-must-not-leak"); } } } });
  const response = await preview(); assert.equal(response.status, 422);
  assert.doesNotMatch(await response.text(), /private-token-must-not-leak/);
  const again = await preview(); assert.equal(again.status, 409); await again.text(); assert.equal(calls, 1);
});
