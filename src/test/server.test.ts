import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDemoHttpServer } from "../server.js";

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "review-test", version: "1" }
} };

async function start(t: { after(fn: () => Promise<void>): void }) {
  const server = createDemoHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const post = async (body: unknown) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, post };
}

test("HTTP negotiates MCP 2025-11-25 and exposes all nine tools to a real SDK client", async t => {
  const { url, post } = await start(t);
  const initialized = await post(initialize);
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-11-25");
  const client = new Client({ name: "sdk-integration-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  const health = await client.callTool({ name: "health", arguments: {} });
  const inventory = JSON.parse((health.content as { text?: string }[]).map(c => c.text ?? "").join(""));
  assert.deepEqual([...inventory.tools].sort(), tools.tools.map(x => x.name).sort());
});

test("HTTP state survives separate stateless requests", async t => {
  const { post } = await start(t);
  const call = (name: string, args = {}) => post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const add = await call("groceries_add", { name: "pears", quantity: 2, unit: "each" });
  assert.equal(add.status, 200);
  assert.equal(add.body.result.isError, undefined);
  const summary = await call("household_summary");
  assert.match(summary.body.result.content[0].text, /Grocery list has 2 items/i);
});

test("an incomplete POST does not break an overlapping initialize request", async t => {
  const { url, post } = await start(t);
  const held = request(url, { method: "POST", headers });
  held.on("error", () => {});
  t.after(async () => { held.destroy(); });
  held.write('{"jsonrpc":"2.0",');
  const socket = held.socket ?? await once(held, "socket").then(([socket]) => socket);
  if (socket.connecting) await once(socket, "connect");
  const response = await post(initialize);
  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, "2025-11-25");
  held.destroy();
});

test("twenty concurrent initializes complete without transport reuse", async t => {
  const { post } = await start(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post({ ...initialize, id: i + 1 })));
  assert.ok(results.every(r => r.status === 200 && r.body.result.protocolVersion === "2025-11-25"));
});

test("malformed JSON and oversized bodies are rejected and later requests still succeed", async t => {
  const { url, post } = await start(t);
  const malformed = await fetch(url, { method: "POST", headers, body: "{" });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const oversized = await fetch(url, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(270000) }) });
  assert.equal(oversized.status, 413);
  await oversized.text();
  assert.equal((await post(initialize)).status, 200);
});

test("paths, stateless methods and untrusted origins are rejected", async t => {
  const { url, post } = await start(t);
  for (const [target, options, status] of [
    [url + "/wrong", {}, 404],
    [url, {}, 405],
    [url, { method: "DELETE" }, 405],
    [url, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: JSON.stringify(initialize) }, 403]
  ] as const) {
    const response = await fetch(target, options);
    assert.equal(response.status, status, JSON.stringify({ target, options }));
    await response.text();
  }
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, host: "untrusted.example" } }, res => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end(JSON.stringify(initialize));
  });
  assert.equal(hostStatus, 403);
  assert.equal((await post(initialize)).status, 200);
});
