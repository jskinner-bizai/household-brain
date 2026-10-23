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

async function start(t: { after(fn: () => Promise<void>): void }, options: Parameters<typeof createDemoHttpServer>[0] = {}) {
  const server = createDemoHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const url = `${base}${options.endpoint ?? "/mcp"}`;
  const post = async (body: unknown) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, base, post };
}

async function rawStatus(url: string, host: string, target?: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { path: target, method: "POST", headers: { ...headers, host } }, res => {
      res.resume(); res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject); req.end(JSON.stringify(initialize));
  });
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

test("HTTP restock cannot bypass preview and stale approval writes nothing", async t => {
  const { post } = await start(t);
  let nextId = 100;
  const call = async (name: string, args = {}) => (await post({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } })).body.result;
  const before = await call("household_summary");
  const bypass = await call("restock_for_meals", { days: 2, dry_run: false });
  assert.equal(bypass.isError, true);
  assert.equal(bypass.structuredContent.writeApplied, false);
  assert.deepEqual((await call("household_summary")).structuredContent, before.structuredContent);
  const preview = await call("restock_for_meals", { days: 2, dry_run: true });
  assert.equal(preview.structuredContent.added.length, 6);
  await call("groceries_add", { name: "salmon fillets", quantity: 1, unit: "each" });
  await call("groceries_add", { name: "broccoli", quantity: 1, unit: "lb" });
  const changed = await call("household_summary");
  const stale = await call("restock_for_meals", { days: 2, dry_run: false, expected_token: preview.structuredContent.previewToken });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.writeApplied, false);
  assert.equal(stale.structuredContent.dryRun, true);
  assert.notEqual(stale.structuredContent.previewToken, preview.structuredContent.previewToken);
  assert.deepEqual((await call("household_summary")).structuredContent, changed.structuredContent);
  const confirmed = await call("restock_for_meals", { days: 2, dry_run: false, expected_token: stale.structuredContent.previewToken });
  assert.notEqual(confirmed.isError, true);
  assert.equal(confirmed.structuredContent.added.length, 5);
});

test("parallel HTTP clients consume a changed-state preview atomically once", async t => {
  const { post } = await start(t);
  const call = async (id: number, name: string, args = {}) => (await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).body.result;
  const preview = await call(1, "restock_for_meals", { days: 2, dry_run: true });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i + 10, "restock_for_meals", {
    days: 2, dry_run: false, expected_token: preview.structuredContent.previewToken
  })));
  const applied = results.filter(result => result.isError !== true);
  const rejected = results.filter(result => result.isError === true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].structuredContent.added.length, 6);
  assert.equal(rejected.length, 19);
  assert.ok(rejected.every(result => result.structuredContent.writeApplied === false));
  assert.equal((await call(100, "household_summary")).structuredContent.groceryCount, 7);
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

test("only exact same-origin browser requests or an explicit HTTP origin are allowed", async t => {
  const { url, base } = await start(t);
  for (const origin of ["", "https://evil.example", "null", "ftp://localhost", `${base}/path`, base.replace("http:", "https:"), "http://localhost:5173", base.replace("127.0.0.1", "localhost"), base.replace("http://", "http://user@")]) {
    const response = await fetch(url, { method: "POST", headers: { ...headers, origin }, body: JSON.stringify(initialize) });
    assert.equal(response.status, 403, origin); await response.text();
  }
  const response = await fetch(url, { method: "POST", headers: { ...headers, origin: base }, body: JSON.stringify(initialize) });
  assert.equal(response.status, 200); await response.text();
  const allowed = "http://localhost:5173";
  const explicit = await start(t, { allowedOrigins: [allowed] });
  const accepted = await fetch(explicit.url, { method: "POST", headers: { ...headers, origin: allowed }, body: JSON.stringify(initialize) });
  assert.equal(accepted.status, 200); await accepted.text();
  for (const origin of ["ftp://localhost", "http://localhost:5173/path", "null"]) {
    assert.throws(() => createDemoHttpServer({ allowedOrigins: [origin] }), /ALLOWED_ORIGINS/);
  }
});

test("malformed hosts and numeric loopback aliases are refused before MCP dispatch", async t => {
  const { url, base, post } = await start(t); const port = new URL(base).port;
  for (const host of ["[", "evil.example", `evil@127.0.0.1:${port}`, `127.0.0.1:${port}#evil`, `127.1:${port}`, `2130706433:${port}`, "127.0.0.1:99999"]) {
    assert.equal(await rawStatus(url, host), 403, host);
  }
  assert.equal((await post(initialize)).status, 200);
});

test("custom MCP endpoint is advertised and cannot shadow static, health or config routes", async t => {
  for (const endpoint of ["/", "/app.js", "/styles.css", "/healthz", "/demo-config.json", "//mcp", "/a/../mcp", "/mcp?x", "/mcp#x", "/mcp\\path", "mcp"]) {
    assert.throws(() => createDemoHttpServer({ endpoint }), /MCP_ENDPOINT/, endpoint);
  }
  const { base, post } = await start(t, { endpoint: "/custom/mcp" });
  const config = await fetch(`${base}/demo-config.json`);
  assert.equal(config.status, 200); assert.deepEqual(await config.json(), { mcpEndpoint: "/custom/mcp" });
  assert.equal((await post(initialize)).body.result.protocolVersion, "2025-11-25");
  const missing = await fetch(`${base}/mcp`); assert.equal(missing.status, 404); await missing.text();
});

test("only the three explicit GET assets are served with restrictive content headers", async t => {
  const { base, url } = await start(t);
  for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/styles.css", "text/css"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path); assert.ok((await response.text()).length > 0);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(type));
    const csp = response.headers.get("content-security-policy") ?? "";
    for (const directive of ["script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), directive);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const wrongMethod = await fetch(base + path, { method: "POST" });
    assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "GET"); await wrongMethod.text();
  }
  for (const path of ["/package.json", "/src/server.ts", "/web/app.js", "/.git/config", "/index.html"]) {
    const response = await fetch(base + path); assert.equal(response.status, 404, path); await response.text();
  }
  const host = new URL(base).host;
  for (const path of ["/web/../app.js", "/web/%2e%2e/app.js", "//example.com/app.js", "/web\\..\\app.js"]) {
    assert.equal(await rawStatus(url, host, path), 400, path);
  }
  for (const path of ["/healthz", "/demo-config.json"]) {
    const response = await fetch(base + path, { method: "POST" }); assert.equal(response.status, 405); await response.text();
  }
});
