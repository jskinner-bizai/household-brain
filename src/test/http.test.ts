// End-to-end over real Streamable HTTP: the path Alexa+ (or the demo page) actually uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;

before(async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(PORT), NODE_ENV: "" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
  });
});
after(() => { child?.kill(); });

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" };
async function rpc(method: string, params: unknown, id = 1, extra: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await r.text();
  const m = text.match(/data: (.*)/);
  return { status: r.status, body: m ? JSON.parse(m[1]) : text ? JSON.parse(text) : null };
}
const callTool = (name: string, args: Record<string, unknown> = {}, id = 1) => rpc("tools/call", { name, arguments: args }, id);

test("initialize negotiates 2025-11-25", async () => {
  const { status, body } = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(status, 200);
  assert.equal(body.result.protocolVersion, "2025-11-25");
  assert.equal(body.result.serverInfo.name, "household-brain");
});

test("tools/list exposes all nine tools", async () => {
  const { body } = await rpc("tools/list", {});
  assert.equal(body.result.tools.length, 9);
});

test("household state persists across stateless requests", async () => {
  const preview = await callTool("restock_for_meals", { days: 1, dry_run: true });
  const first = await callTool("restock_for_meals", { days: 1, expected_token: preview.body.result.structuredContent.previewToken });
  assert.match(first.body.result.content[0].text, /Added 4 items/);
  assert.equal(first.body.result.structuredContent.added.length, 4);
  const nextPreview = await callTool("restock_for_meals", { days: 1, dry_run: true });
  const second = await callTool("restock_for_meals", { days: 1, expected_token: nextPreview.body.result.structuredContent.previewToken }, 2);
  assert.match(second.body.result.content[0].text, /checklist is covered/i);
  assert.equal(second.body.result.structuredContent.added.length, 0);
  const summary = await callTool("household_summary", {}, 3);
  assert.equal(summary.body.result.structuredContent.groceryCount, 5);
});

test("40 concurrent calls each get their own answer", async () => {
  const items = ["eggs", "rice", "coffee", "oat milk", "blueberries"];
  const results = await Promise.all(items.flatMap((item) => Array.from({ length: 8 }, (_, k) => ({ item, id: 100 + items.indexOf(item) * 10 + k })))
    .map(async ({ item, id }) => ({ item, id, res: await callTool("pantry_query", { item }, id) })));
  for (const { item, id, res } of results) {
    assert.equal(res.body.id, id);
    assert.match(res.body.result.content[0].text, new RegExp(item));
  }
});

test("browser requests require the exact same origin rather than any localhost port", async () => {
  const evil = await rpc("tools/list", {}, 1, { origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const otherLocal = await rpc("tools/list", {}, 1, { origin: "http://localhost:5173" });
  assert.equal(otherLocal.status, 403);
  const sameOrigin = await rpc("tools/list", {}, 1, { origin: BASE });
  assert.equal(sameOrigin.status, 200);
});

test("/healthz answers for load balancers", async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});
