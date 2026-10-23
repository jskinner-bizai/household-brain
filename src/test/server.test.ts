import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTcpServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDemoHttpServer } from "../server.js";
import { MemoryStore } from "../store.js";

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
  for (const endpoint of ["/", "/app.js", "/styles.css", "/assets/household-brain-lockup-light.svg", "/assets/household-brain-favicon.svg", "/healthz", "/demo-config.json", "//mcp", "/a/../mcp", "/mcp?x", "/mcp#x", "/mcp\\path", "mcp"]) {
    assert.throws(() => createDemoHttpServer({ endpoint }), /MCP_ENDPOINT/, endpoint);
  }
  const { base, post } = await start(t, { endpoint: "/custom/mcp" });
  const config = await fetch(`${base}/demo-config.json`);
  assert.equal(config.status, 200); assert.deepEqual(await config.json(), { mcpEndpoint: "/custom/mcp" });
  assert.equal((await post(initialize)).body.result.protocolVersion, "2025-11-25");
  const missing = await fetch(`${base}/mcp`); assert.equal(missing.status, 404); await missing.text();
});

test("only explicit GET assets are served with restrictive content headers", async t => {
  const { base, url } = await start(t);
  for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/styles.css", "text/css"], ["/assets/household-brain-lockup-light.svg", "image/svg\\+xml"], ["/assets/household-brain-favicon.svg", "image/svg\\+xml"]]) {
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
  for (const path of ["/package.json", "/src/server.ts", "/web/app.js", "/.git/config", "/index.html", "/assets/", "/assets/README.md", "/assets/BricolageGrotesque-OFL.txt", "/assets/not-allowed.svg"]) {
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

async function rejectedStartup(statePath: string, settings: { PORT?: string; MCP_ENDPOINT?: string; ALLOWED_ORIGINS?: string } = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    // No AWS environment, profiles or approval flags are inherited by this process.
    const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
      env: { NODE_ENV: "startup-check", PORT: "0", ...settings, HOUSEHOLD_PLANNER_MODE: "off", HOUSEHOLD_STATE_FILE: statePath,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("corrupt snapshot startup fails concisely without exposing or resetting the saved household", async t => {
  const directory = await mkdtemp(join(tmpdir(), "household-startup-"));
  const path = join(directory, "private-snapshot-path.snapshot.json");
  t.after(async () => { await rm(path, { force: true }); await rm(`${path}.lock`, { force: true }); await rmdir(directory); });
  const bytes = Buffer.from('{"private":"DO_NOT_PRINT_CORRUPT_DETAIL",');
  await writeFile(path, bytes);
  const result = await rejectedStartup(path);
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not open its saved household/);
  assert.match(result.stderr, /HOUSEHOLD_STATE_FILE/);
  assert.doesNotMatch(result.stderr, /DO_NOT_PRINT|private-snapshot-path|Error:|node:internal|file:\/\//);
  assert.ok(!result.stderr.includes(directory));
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(directory), ["private-snapshot-path.snapshot.json"]);
});

test("stale lock startup stays nonzero and preserves the unknown lock and snapshot", async t => {
  const directory = await mkdtemp(join(tmpdir(), "household-startup-"));
  const path = join(directory, "private-locked-path.snapshot.json");
  t.after(async () => { await rm(path, { force: true }); await rm(`${path}.lock`, { force: true }); await rmdir(directory); });
  const snapshot = Buffer.from('{"private":"DO_NOT_PRINT_SNAPSHOT_DETAIL"}');
  const lock = Buffer.from("another-writer:DO_NOT_PRINT_LOCK_DETAIL\n");
  await writeFile(path, snapshot); await writeFile(`${path}.lock`, lock);
  const result = await rejectedStartup(path);
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
  assert.match(result.stderr, /inspect the owning process before recovering/);
  assert.doesNotMatch(result.stderr, /DO_NOT_PRINT|private-locked-path|Error:|node:internal|file:\/\//);
  assert.ok(!result.stderr.includes(directory));
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.deepEqual(await readFile(path), snapshot);
  assert.deepEqual(await readFile(`${path}.lock`), lock);
});

async function savedHouseholdFixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "household-startup-"));
  const path = join(directory, "private-saved-household.snapshot.json");
  t.after(async () => { await rm(path, { force: true }); await rm(`${path}.lock`, { force: true }); await rmdir(directory); });
  const bytes = Buffer.from(JSON.stringify({ version: 1, syntheticDemo: true, state: new MemoryStore().snapshot() }) + "\n");
  await writeFile(path, bytes);
  return { directory, path, bytes };
}

async function assertOwnedStartupFailure(fixture: { directory: string; path: string; bytes: Buffer }, settings: { PORT?: string; MCP_ENDPOINT?: string; ALLOWED_ORIGINS?: string }) {
  const result = await rejectedStartup(fixture.path, settings);
  assert.equal(result.code, 1); assert.equal(result.signal, null); assert.equal(result.stdout, "");
  assert.match(result.stderr, /could not start/);
  assert.match(result.stderr, /PORT, MCP_ENDPOINT and ALLOWED_ORIGINS/);
  assert.doesNotMatch(result.stderr, /DO_NOT_PRINT|private-saved-household|Error:|node:internal|file:\/\//);
  assert.ok(!result.stderr.includes(fixture.directory));
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.deepEqual(await readFile(fixture.path), fixture.bytes);
  assert.deepEqual(await readdir(fixture.directory), ["private-saved-household.snapshot.json"]);
}

test("invalid MCP endpoint after opening saved state releases only its owned lock", async t => {
  const fixture = await savedHouseholdFixture(t);
  await assertOwnedStartupFailure(fixture, { MCP_ENDPOINT: "/mcp?DO_NOT_PRINT_ENDPOINT" });
});

test("invalid allowed origin after opening saved state releases only its owned lock", async t => {
  const fixture = await savedHouseholdFixture(t);
  await assertOwnedStartupFailure(fixture, { ALLOWED_ORIGINS: "https://example.invalid/DO_NOT_PRINT_ORIGIN" });
});

test("occupied port startup is nonzero, preserves saved state and releases its owned lock", async t => {
  const fixture = await savedHouseholdFixture(t);
  const occupied = createTcpServer();
  occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const address = occupied.address(); assert.ok(address && typeof address === "object");
  await assertOwnedStartupFailure(fixture, { PORT: String(address.port) });
  assert.equal(occupied.listening, true);
});
