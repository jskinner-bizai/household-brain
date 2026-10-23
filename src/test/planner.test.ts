import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerHouseholdTools } from "../tools/household.js";
import { registerBriefTools } from "../tools/brief.js";
import { MemoryStore } from "../store.js";
import { HouseholdPlanner, PlannerError, PLANNER_LIMITS, PLANNER_MODEL_ID,
  type PlannerModel, type PlannerModelRequest, type PlannerModelResponse, type PlannerMcpPort, type PlannerProgress } from "../planner.js";

const response = (names: string[], round = 1): PlannerModelResponse => ({
  output: { message: { role: "assistant", content: names.map((name, i) => ({ toolUse: { name, toolUseId: `r${round}_${i}`, input: {} } })) } },
  stopReason: "tool_use", usage: { inputTokens: 500, outputTokens: 80 },
});
const final = (text = "Review these missing ingredients and low staples, then confirm in the app."): PlannerModelResponse => ({
  output: { message: { role: "assistant", content: [{ text }] } }, stopReason: "end_turn", usage: { inputTokens: 700, outputTokens: 30 },
});
class ScriptedModel implements PlannerModel {
  requests: PlannerModelRequest[] = [];
  constructor(private replies: (PlannerModelResponse | Error)[]) {}
  async converse(input: PlannerModelRequest): Promise<PlannerModelResponse> {
    this.requests.push(structuredClone(input));
    const next = this.replies.shift();
    if (!next) throw new Error("Unexpected model request.");
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}
async function harness(t: TestContext, replies: (PlannerModelResponse | Error)[] = [response(["mealplan_get", "pantry_query"]), response(["restock_preview"], 2), final()]) {
  const store = new MemoryStore();
  const server = new McpServer({ name: "planner-tests", version: "1" });
  registerHouseholdTools(server, store); registerBriefTools(server, store);
  const client = new Client({ name: "planner-test-client", version: "1" });
  t.after(() => Promise.all([client.close(), server.close()]).then(() => {}));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const mcp: PlannerMcpPort = {
    listTools: () => client.listTools(),
    callTool: input => { calls.push(structuredClone(input)); return client.callTool(input); },
  };
  const model = new ScriptedModel(replies);
  const planner = new HouseholdPlanner({ model, mcp });
  return { store, client, calls, model, planner, mcp };
}
const code = (expected: string) => (error: unknown) => error instanceof PlannerError && error.code === expected;

test("Bedrock-shaped loop reads real MCP tools, previews without mutation, and withholds tokens from the model", async t => {
  const h = await harness(t); const before = await h.store.groceries();
  const result = await h.planner.run({ days: 2 });
  assert.deepEqual(h.calls.map(c => c.name), ["mealplan_get", "pantry_query", "restock_for_meals"]);
  assert.deepEqual(h.calls[2].arguments, { days: 2, dry_run: true });
  assert.deepEqual(await h.store.groceries(), before);
  assert.equal(result.preview.structuredContent?.dryRun, true);
  assert.equal(result.preview.structuredContent?.writeApplied, false);
  const token = String(result.preview.structuredContent?.previewToken);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(h.model.requests).includes(token), false);
  assert.equal(JSON.stringify(h.model.requests).includes('"previewToken"'), false);
  assert.equal(JSON.stringify(result.trace).includes(token), false);
  assert.equal(result.receipt.modelId, PLANNER_MODEL_ID);
  assert.equal(result.receipt.region, "us-east-2");
  assert.equal(result.receipt.modelRequests, 3); assert.equal(result.receipt.toolCalls, 3);
  assert.equal(result.receipt.inputTokens, 1700); assert.equal(result.receipt.outputTokens, 190);
  assert.equal(result.receipt.mutationsPerformedByPlanner, 0);
  for (const req of h.model.requests) {
    assert.equal(req.inferenceConfig.maxTokens, 1024);
    const names = req.toolConfig.tools.map(tool => tool.toolSpec.name);
    assert.deepEqual(names, ["mealplan_get", "pantry_query", "household_summary", "brief_get", "restock_preview"]);
    assert.equal(JSON.stringify(req.toolConfig).includes("expected_token"), false);
  }
});

test("write tools and raw restock calls are rejected before MCP executes them", async t => {
  for (const name of ["groceries_add", "chore_log", "restock_for_meals", "shell"]) {
    const h = await harness(t, [response([name])]); const before = await h.store.groceries();
    await assert.rejects(h.planner.run({ days: 2 }), code("unsafe_tool"));
    assert.equal(h.calls.length, 0); assert.deepEqual(await h.store.groceries(), before);
  }
});

test("preview cannot precede actual meal and pantry results or share their initial batch", async t => {
  for (const names of [["restock_preview"], ["mealplan_get", "restock_preview"], ["mealplan_get", "pantry_query", "restock_preview"]]) {
    const h = await harness(t, [response(names)]);
    await assert.rejects(h.planner.run({ days: 2 }), code("unsafe_tool"));
    assert.equal(h.calls.some(call => call.name === "restock_for_meals"), false);
  }
});

test("strict arguments prevent preview days, dry-run or token override", async t => {
  for (const input of [{ days: 7 }, { dry_run: false }, { expected_token: "a".repeat(64) }, { unexpected: true }]) {
    const unsafe = response(["restock_preview"], 2);
    (unsafe.output!.message!.content[0] as { toolUse: { input: unknown } }).toolUse.input = input;
    const h = await harness(t, [response(["mealplan_get", "pantry_query"]), unsafe]);
    await assert.rejects(h.planner.run({ days: 2 }), code("unsafe_tool"));
    assert.equal(h.calls.length, 2);
  }
});

test("two concurrent starts cannot receive independent budgets, and the instance cannot run again", async t => {
  const h = await harness(t);
  const outcomes = await Promise.allSettled([h.planner.run({ days: 2 }), h.planner.run({ days: 2 })]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  const rejection = outcomes.find(x => x.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejection.reason.code, "budget_exhausted");
  await assert.rejects(h.planner.run({ days: 2 }), code("budget_exhausted"));
  assert.equal(h.model.requests.length, 3);
});

test("model errors are safe, consume the run, and are not retried", async t => {
  const h = await harness(t, [new Error("Authorization secret=DO_NOT_PRINT and aws-account-123456789012")]);
  await assert.rejects(h.planner.run({ days: 2 }), error => code("model_failed")(error) && !(error as Error).message.includes("DO_NOT_PRINT"));
  await assert.rejects(h.planner.run({ days: 2 }), code("budget_exhausted"));
  assert.equal(h.model.requests.length, 1); assert.equal(h.calls.length, 0);
});

test("six model attempts are a total limit, without hidden retry or fallback", async t => {
  const h = await harness(t, Array.from({ length: 6 }, (_, i) => response(["pantry_query"], i + 1)));
  await assert.rejects(h.planner.run({ days: 2 }), code("budget_exhausted"));
  assert.equal(h.model.requests.length, 6); assert.equal(h.calls.length, 6);
  assert.equal(new Set(h.model.requests.map(req => req.modelId)).size, 1);
});

test("too many tool calls stop before executing an over-budget batch", async t => {
  const h = await harness(t, [response(["pantry_query", "mealplan_get", "household_summary", "brief_get"], 1), response(["pantry_query", "mealplan_get", "restock_preview"], 2)]);
  await assert.rejects(h.planner.run({ days: 2 }), code("budget_exhausted"));
  assert.equal(h.calls.length, 4); assert.equal(h.model.requests.length, 2);
});

test("invalid and oversized requests make no MCP or model calls and do not consume a valid run", async t => {
  const h = await harness(t);
  for (const input of [{ days: 0 }, { days: 1.2 }, { days: 8 }, { days: 2, request: "x".repeat(1001) }, { days: 2, request: "do\u0000this" }]) {
    await assert.rejects(h.planner.run(input), code("invalid_request"));
  }
  assert.equal(h.calls.length, 0); assert.equal(h.model.requests.length, 0);
  await h.planner.run({ days: 1, request: "Help with tonight's meal." });
});

test("output token limit and missing usage fail closed before tool execution", async t => {
  const over = response(["mealplan_get"]); over.usage!.outputTokens = 1025;
  const missing = response(["mealplan_get"]); delete missing.usage;
  for (const bad of [over, missing]) {
    const h = await harness(t, [bad]);
    await assert.rejects(h.planner.run({ days: 2 }), code("protocol_error"));
    assert.equal(h.calls.length, 0); assert.equal(h.model.requests.length, 1);
  }
});

test("oversized tool results never reach a subsequent model request", async t => {
  const h = await harness(t, [response(["mealplan_get"])]);
  const planner = new HouseholdPlanner({ model: h.model, mcp: { listTools: h.mcp.listTools, async callTool() {
    return { content: [{ type: "text", text: "x".repeat(PLANNER_LIMITS.toolResultBytes) }] };
  } } });
  await assert.rejects(planner.run({ days: 2 }), code("tool_failed"));
  assert.equal(h.model.requests.length, 1);
});

test("combined transcript input is byte-bounded before another model call", async t => {
  const h = await harness(t, [response(["mealplan_get", "pantry_query", "household_summary", "brief_get"])]);
  const planner = new HouseholdPlanner({ model: h.model, mcp: { listTools: h.mcp.listTools, async callTool() {
    return { content: [{ type: "text", text: "x".repeat(8500) }], structuredContent: { demo: true } };
  } } });
  await assert.rejects(planner.run({ days: 2 }), code("budget_exhausted"));
  assert.equal(h.model.requests.length, 1);
});

test("an aborted run stops promptly without retry and consumes its run latch", async t => {
  const h = await harness(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.planner.run({ days: 2 }, controller.signal), code("aborted"));
  assert.equal(h.calls.length, 0); assert.equal(h.model.requests.length, 0);
  await assert.rejects(h.planner.run({ days: 2 }), code("budget_exhausted"));
});

test("tool failures and falsely non-read-only inventory fail closed", async t => {
  const h = await harness(t, [response(["mealplan_get"])]);
  const failed = new HouseholdPlanner({ model: h.model, mcp: { listTools: h.mcp.listTools, async callTool() { return { content: [], isError: true }; } } });
  await assert.rejects(failed.run({ days: 2 }), code("tool_failed"));
  const unsafe = new HouseholdPlanner({ model: h.model, mcp: { async listTools() {
    const inventory = await h.mcp.listTools();
    const tools = structuredClone(inventory.tools) as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    tools.find(tool => tool.name === "mealplan_get")!.annotations!.readOnlyHint = false;
    return { tools };
  }, callTool: h.mcp.callTool } });
  await assert.rejects(unsafe.run({ days: 2 }), code("unavailable"));
});

test("an explanation cannot claim success without an actual validated preview", async t => {
  const h = await harness(t, [final("I added your groceries.")]);
  await assert.rejects(h.planner.run({ days: 2 }), code("protocol_error"));
  assert.equal(h.calls.length, 0);
});

test("progress persists a pending reservation before each model call, usage afterward, and a terminal success", async t => {
  const h = await harness(t); const snapshots: PlannerProgress[] = [];
  const planner = new HouseholdPlanner({ model: h.model, mcp: h.mcp, async onProgress(receipt) {
    snapshots.push(structuredClone(receipt));
    if (receipt.outcome === "running" && receipt.unreportedRequests === 1) {
      assert.equal(h.model.requests.length, receipt.modelRequestsAttempted - 1);
      assert.equal(receipt.costComplete, false);
    }
  } });
  assert.equal(planner.progress().outcome, "not_started");
  assert.equal(planner.progress().costComplete, true);
  await planner.run({ days: 2 });
  assert.deepEqual(snapshots.map(p => [p.modelRequestsAttempted, p.modelResponsesWithUsage, p.outcome]), [
    [1, 0, "running"], [1, 1, "running"], [2, 1, "running"], [2, 2, "running"], [3, 2, "running"], [3, 3, "running"], [3, 3, "succeeded"],
  ]);
  assert.deepEqual(planner.progress(), snapshots.at(-1));
  assert.equal(planner.progress().knownInputTokens, 1700); assert.equal(planner.progress().knownOutputTokens, 190);
  assert.equal(planner.progress().unreportedRequests, 0); assert.equal(planner.progress().costComplete, true);
  const copy = planner.progress(); copy.knownInputTokens = 0;
  assert.equal(planner.progress().knownInputTokens, 1700);
});

test("second model request failure preserves the first usage and reports unknown cost without secrets", async t => {
  const h = await harness(t, [response(["mealplan_get", "pantry_query"]), new Error("DO_NOT_PRINT_CREDENTIAL secret 123456789012")]);
  const snapshots: PlannerProgress[] = [];
  const planner = new HouseholdPlanner({ model: h.model, mcp: h.mcp, async onProgress(receipt) { snapshots.push(receipt); } });
  await assert.rejects(planner.run({ days: 2 }), code("model_failed"));
  const receipt = planner.progress();
  assert.equal(receipt.modelRequestsAttempted, 2); assert.equal(receipt.modelResponsesWithUsage, 1);
  assert.equal(receipt.knownInputTokens, 500); assert.equal(receipt.knownOutputTokens, 80);
  assert.equal(receipt.estimatedKnownGrossUsd, 0.0000492);
  assert.equal(receipt.unreportedRequests, 1); assert.equal(receipt.costComplete, false); assert.equal(receipt.outcome, "failed");
  assert.equal(JSON.stringify(snapshots).includes("DO_NOT_PRINT"), false);
  assert.equal(JSON.stringify(snapshots).includes("123456789012"), false);
  assert.deepEqual(snapshots.at(-1), receipt); assert.equal(h.model.requests.length, 2);
});

test("invalid usage on the second response retains known usage and an unreported attempt", async t => {
  const bad = response(["restock_preview"], 2); bad.usage!.outputTokens = Number.NaN;
  const h = await harness(t, [response(["mealplan_get", "pantry_query"]), bad]);
  await assert.rejects(h.planner.run({ days: 2 }), code("protocol_error"));
  const receipt = h.planner.progress();
  assert.equal(receipt.modelRequestsAttempted, 2); assert.equal(receipt.modelResponsesWithUsage, 1);
  assert.equal(receipt.knownInputTokens, 500); assert.equal(receipt.knownOutputTokens, 80);
  assert.equal(receipt.unreportedRequests, 1); assert.equal(receipt.costComplete, false); assert.equal(receipt.outcome, "failed");
  assert.equal(h.calls.length, 2);
});

test("pre-call journal failure dispatches zero model requests and marks the reservation as not dispatched", async t => {
  const h = await harness(t);
  const planner = new HouseholdPlanner({ model: h.model, mcp: h.mcp, async onProgress() { throw new Error("DO_NOT_PRINT_JOURNAL_SECRET"); } });
  await assert.rejects(planner.run({ days: 2 }), error => code("journal_failed")(error) && !(error as Error).message.includes("DO_NOT_PRINT"));
  assert.equal(h.model.requests.length, 0); assert.equal(h.calls.length, 0);
  const receipt = planner.progress();
  assert.equal(receipt.modelRequestsAttempted, 1); assert.equal(receipt.modelRequestsNotDispatched, 1);
  assert.equal(receipt.modelResponsesWithUsage, 0); assert.equal(receipt.unreportedRequests, 0);
  assert.equal(receipt.costComplete, true); assert.equal(receipt.estimatedKnownGrossUsd, 0); assert.equal(receipt.outcome, "failed");
  await assert.rejects(planner.run({ days: 2 }), code("budget_exhausted"));
});

test("journal failure after validated usage retains that cost and never issues another model request", async t => {
  const h = await harness(t);
  const planner = new HouseholdPlanner({ model: h.model, mcp: h.mcp, async onProgress(receipt) {
    if (receipt.modelResponsesWithUsage > 0) throw new Error("Offline write failure");
  } });
  await assert.rejects(planner.run({ days: 2 }), code("journal_failed"));
  assert.equal(h.model.requests.length, 1); assert.equal(h.calls.length, 0);
  const receipt = planner.progress();
  assert.equal(receipt.modelRequestsAttempted, 1); assert.equal(receipt.modelResponsesWithUsage, 1);
  assert.equal(receipt.knownInputTokens, 500); assert.equal(receipt.knownOutputTokens, 80);
  assert.equal(receipt.costComplete, true); assert.equal(receipt.outcome, "failed");
});

test("aborting while a request is outstanding retains an unreported attempt", async t => {
  const h = await harness(t); const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const model: PlannerModel = { converse() { started(); return new Promise(() => {}); } };
  const snapshots: PlannerProgress[] = [];
  const planner = new HouseholdPlanner({ model, mcp: h.mcp, async onProgress(receipt) { snapshots.push(receipt); } });
  const result = planner.run({ days: 2 }, controller.signal);
  await requestStarted; controller.abort();
  await assert.rejects(result, code("aborted"));
  const receipt = planner.progress();
  assert.equal(receipt.modelRequestsAttempted, 1); assert.equal(receipt.modelResponsesWithUsage, 0);
  assert.equal(receipt.unreportedRequests, 1); assert.equal(receipt.costComplete, false); assert.equal(receipt.outcome, "aborted");
  assert.deepEqual(snapshots.at(-1), receipt);
});
