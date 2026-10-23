import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoJournal, reserveDemoRun } from "../demo-lease.js";
import { HouseholdPlanner, type PlannerProgress } from "../planner.js";

test("one durable live-demo reservation survives competing callers and restarts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "household-demo-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "one.demo-receipt.json");
  const results = await Promise.allSettled(Array.from({ length: 15 }, () => reserveDemoRun(path)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 14);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assert.equal(receipt.maximumModelRequests, 6);
  assert.equal(receipt.maximumGrossUsd, 1);
  assert.equal(receipt.syntheticDataOnly, true);
  await assert.rejects(reserveDemoRun(path), /already reserved/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
});

test("an aborted pending journal write cannot overwrite the terminal receipt with older progress", async t => {
  const directory = await mkdtemp(join(tmpdir(), "household-demo-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writes = 0, calls = 0;
  const path = join(directory, "one.demo-receipt.json");
  const journal = createDemoJournal(path, async () => { if (++writes === 1) { entered(); await blocked; } });
  const controller = new AbortController();
  const planner = new HouseholdPlanner({
    model: { async converse() { calls++; throw new Error("Must not dispatch"); } },
    mcp: {
      async listTools() { return { tools: ["mealplan_get", "pantry_query", "restock_for_meals"].map(name => ({ name, annotations: { readOnlyHint: true }, inputSchema: {} })) }; },
      async callTool() { throw new Error("No tool needed"); },
    }, onProgress: journal,
  });
  const result = planner.run({ days: 2 }, controller.signal);
  const rejected = assert.rejects(result, /stopped|timed out/);
  await waiting; controller.abort();
  await new Promise(resolve => setTimeout(resolve, 5));
  release(); await rejected;
  const persisted = JSON.parse(await readFile(`${path}.progress.json`, "utf8")) as PlannerProgress;
  assert.deepEqual(persisted, planner.progress());
  assert.equal(persisted.outcome, "aborted");
  assert.equal(persisted.modelRequestsNotDispatched, 1);
  assert.equal(persisted.costComplete, true); assert.equal(calls, 0);
});
