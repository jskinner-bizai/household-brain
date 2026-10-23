// Synthetic Household Brain demo. No household credentials or live controls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, ServerResponse, IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerSystemTools, SERVICE } from "./tools/system.js";
import { registerBriefTools } from "./tools/brief.js";
import { registerHouseholdTools } from "./tools/household.js";

import { HouseholdStore, MemoryStore } from "./store.js";
import { measuredDemoState } from "./measured-fixture.js";
import { HouseholdPlanner, PlannerError, type PlannerModel, type PlannerResult, type PlannerProgress } from "./planner.js";
import type { FileStore } from "./file-store.js";

const defaultStore: HouseholdStore = new MemoryStore();

export function buildServer(store: HouseholdStore = defaultStore) {
  const server = new McpServer(
    { name: SERVICE.name, version: SERVICE.version },
    { capabilities: { tools: {}, logging: {} } }
  );
  const inventory: string[] = [];
  registerSystemTools(server, () => inventory);
  inventory.push(...registerBriefTools(server, store), ...registerHouseholdTools(server, store));
  return server;
}

function errorResponse(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({
    jsonrpc: "2.0", id: null, error: { code: -32000, message }
  }));
}

function localBase(req: IncomingMessage): URL | undefined {
  const host = req.headers.host;
  if (!host || !/^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/i.test(host)) return;
  try { return new URL(`http://${host}`); } catch { return; }
}

function isHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === value;
  } catch { return false; }
}

export function originAllowed(req: IncomingMessage, allowedOrigins: string[] = []): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // Native MCP clients do not send a browser Origin; an empty header is invalid.
  if (!isHttpOrigin(origin)) return false;
  return origin === localBase(req)?.origin || allowedOrigins.includes(origin);
}

const webAssets = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ["/assets/household-brain-lockup-light.svg", { name: "assets/household-brain-lockup-light.svg", type: "image/svg+xml" }],
  ["/assets/household-brain-favicon.svg", { name: "assets/household-brain-favicon.svg", type: "image/svg+xml" }],
  ["/assets/herb-chicken-brussels-quinoa.svg", { name: "assets/herb-chicken-brussels-quinoa.svg", type: "image/svg+xml" }],
  ["/assets/steak-fajita-cauliflower-bowl.svg", { name: "assets/steak-fajita-cauliflower-bowl.svg", type: "image/svg+xml" }],
]);
const reservedPaths = new Set([...webAssets.keys(), "/healthz", "/demo-config.json", "/planner/preview", "/planner/result"]);
const webRoot = new URL("../web/", import.meta.url);

class PlannerRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function plannerDays(req: IncomingMessage): Promise<number> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new PlannerRequestError(415, "Use application/json.");
  }
  if (Number(req.headers["content-length"] ?? 0) > 2048) {
    req.resume(); throw new PlannerRequestError(413, "Planner request is too large.");
  }
  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2048) {
        chunks.length = 0;
        if (!settled) { settled = true; reject(new PlannerRequestError(413, "Planner request is too large.")); }
      } else if (!settled) chunks.push(chunk);
    });
    req.once("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.once("error", () => { if (!settled) { settled = true; reject(new PlannerRequestError(400, "Planner request interrupted.")); } });
    req.once("aborted", () => { if (!settled) { settled = true; reject(new PlannerRequestError(400, "Planner request interrupted.")); } });
  });
  let value;
  try { value = JSON.parse(body); } catch { throw new PlannerRequestError(400, "Invalid planner request."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "days")
      || !Number.isInteger(value.days) || value.days < 1 || value.days > 7) {
    throw new PlannerRequestError(400, "Choose between one and seven meals. No other planner arguments are accepted.");
  }
  return value.days;
}

export interface DemoServerOptions {
  store?: HouseholdStore;
  endpoint?: string;
  allowedOrigins?: string[];
  persistentState?: boolean;
  planner?: { model: PlannerModel; mode: "mock" | "bedrock"; beforeRun?: () => Promise<void>; onProgress?: (progress: PlannerProgress) => Promise<void> };
}

export function createDemoHttpServer(options: DemoServerOptions = {}) {
  const store = options.store ?? new MemoryStore();
  const endpoint = options.endpoint ?? "/mcp";
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(endpoint)
      || new URL(endpoint, "http://localhost").pathname !== endpoint || reservedPaths.has(endpoint)) {
    throw new Error("MCP_ENDPOINT must be a normalized absolute path that does not shadow demo routes");
  }
  const allowedOrigins = options.allowedOrigins ?? [];
  if (allowedOrigins.some(origin => !isHttpOrigin(origin))) throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths");
  let plannerClient: Client | undefined;
  const getPlannerClient = async () => {
    if (!plannerClient) {
      const address = httpServer.address();
      if (!address || typeof address !== "object") throw new Error("MCP server unavailable");
      plannerClient = new Client({ name: "household-brain-planner", version: "1" });
      await plannerClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${endpoint}`)));
    }
    return plannerClient;
  };
  const planner = options.planner ? new HouseholdPlanner({
    model: options.planner.model,
    onProgress: options.planner.onProgress,
    mcp: {
      listTools: async () => (await getPlannerClient()).listTools(),
      callTool: async call => (await getPlannerClient()).callTool(call),
    },
  }) : undefined;
  let plannerAttempted = false;
  let cachedPlan: { days: number; result: PlannerResult } | undefined;
  const httpServer = createServer(async (req, res) => {
    let server: McpServer | undefined;
    try {
      res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("cache-control", "no-store");
      const base = localBase(req);
      if (!base) {
        errorResponse(res, 403, "Local demo host required");
        return;
      }
      if (!originAllowed(req, allowedOrigins)) {
        errorResponse(res, 403, "Untrusted origin");
        return;
      }
      const target = req.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
        errorResponse(res, 400, "Absolute request path required");
        return;
      }
      const url = new URL(target, base);
      if (url.pathname !== target.split("?")[0]) {
        errorResponse(res, 400, "Normalized request path required");
        return;
      }
      const asset = webAssets.get(url.pathname);
      if (asset || url.pathname === "/healthz" || url.pathname === "/demo-config.json") {
        if (req.method !== "GET") {
          res.setHeader("allow", "GET");
          errorResponse(res, 405, "Method not allowed");
          return;
        }
        if (asset) {
          const body = await readFile(new URL(asset.name, webRoot));
          res.writeHead(200, { "content-type": asset.type }).end(body);
        } else {
          const body = url.pathname === "/demo-config.json" ? {
            mcpEndpoint: endpoint,
            ...(options.persistentState ? { persistentState: true } : {}),
            ...(options.planner ? { planner: { endpoint: "/planner/preview", resultEndpoint: "/planner/result", mode: options.planner.mode, maximumRequests: 6, confirmationRequired: true } } : {}),
          }
            : { ok: true, service: SERVICE.name, version: SERVICE.version, demo: true };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        }
        return;
      }
      if (url.pathname === "/planner/result") {
        if (req.method !== "GET") { res.setHeader("allow", "GET"); errorResponse(res, 405, "Method not allowed"); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(cachedPlan
          ? { available: true, days: cachedPlan.days, ...cachedPlan.result, mode: options.planner!.mode }
          : { available: false, attempted: plannerAttempted, ...(planner ? { progress: planner.progress() } : {}) }));
        return;
      }
      if (url.pathname === "/planner/preview") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST"); errorResponse(res, 405, "Method not allowed"); return;
        }
        if (!planner) { errorResponse(res, 503, "The optional planner is unavailable. The checklist still works without it."); return; }
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 90_000);
        let ownsAttempt = false;
        res.once("close", () => { if (!res.writableEnded) abort.abort(); });
        try {
          const days = await plannerDays(req);
          if (plannerAttempted) throw new PlannerRequestError(409, "This server's single planner attempt has already been used. It will not run again automatically.");
          plannerAttempted = true;
          ownsAttempt = true;
          // The live runner reserves its durable one-attempt receipt before any
          // model request. A lost response or provider error never resets it.
          await options.planner?.beforeRun?.();
          const result = await planner.run({ days }, abort.signal);
          cachedPlan = { days, result };
          if (!res.destroyed) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...result, mode: options.planner!.mode }));
        } catch (error) {
          const status = error instanceof PlannerRequestError ? error.status : error instanceof PlannerError ? 422 : 503;
          const message = error instanceof PlannerRequestError || error instanceof PlannerError ? error.message
            : "Planner unavailable or the demo receipt could not be reserved. Nothing was added. No request will be retried automatically.";
          if (!res.destroyed && !res.headersSent) errorResponse(res, status, message);
        } finally {
          clearTimeout(timer);
          if (ownsAttempt) {
            await plannerClient?.close().catch(() => {});
            plannerClient = undefined;
          }
        }
        return;
      }
      if (url.pathname !== endpoint) {
        errorResponse(res, 404, `Use ${endpoint}`);
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        errorResponse(res, 405, "Method not allowed in stateless mode");
        return;
      }
      // One Protocol instance per transport; keep fixture state across requests.
      server = buildServer(store);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: 256 * 1024
      });
      const requestServer = server;
      res.once("close", () => { void requestServer.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) errorResponse(res, 500, "Internal server error");
      else if (!res.writableEnded) res.end();
      await server?.close().catch(() => {});
    }
  });
  httpServer.requestTimeout = 5_000;
  httpServer.headersTimeout = 5_000;
  return httpServer;
}

async function startLocalDemo() {
  const port = Number(process.env.PORT ?? 8099);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  const endpoint = process.env.MCP_ENDPOINT ?? "/mcp";
  const mode = process.env.HOUSEHOLD_PLANNER_MODE ?? "off";
  if (!["off", "mock", "bedrock"].includes(mode)) throw new Error("HOUSEHOLD_PLANNER_MODE must be off, mock or bedrock");
  if (mode === "bedrock" && (process.env.HOUSEHOLD_AWS_DEMO_APPROVED !== "1" || !process.env.HOUSEHOLD_AWS_DEMO_RECEIPT)) {
    throw new Error("Live mode requires explicit demo approval and a durable HOUSEHOLD_AWS_DEMO_RECEIPT path. No AWS request was made.");
  }
  const fixture = process.env.HOUSEHOLD_DEMO_FIXTURE ?? "recipes";
  if (!["recipes", "legacy"].includes(fixture)) throw new Error("HOUSEHOLD_DEMO_FIXTURE must be recipes or legacy");
  const initialState = fixture === "recipes" ? measuredDemoState() : undefined;
  const persistent = process.env.HOUSEHOLD_STATE_FILE;
  let fileStore: FileStore | undefined;
  if (persistent) {
    try {
      fileStore = await (await import("./file-store.js")).FileStore.open(resolve(persistent), initialState);
    } catch {
      // Keep paths, snapshot contents and raw filesystem errors out of startup output.
      // FileStore retains its existing validation and owned-lock cleanup behavior.
      console.error("Household Brain could not open its saved household. Check HOUSEHOLD_STATE_FILE and the snapshot. If a writer lock exists, inspect the owning process before recovering it. Existing data was not reset.");
      process.exitCode = 1;
      return;
    }
  }
  let httpServer: ReturnType<typeof createDemoHttpServer> | undefined;
  try {
    let plannerConfig: DemoServerOptions["planner"];
    if (mode === "mock") plannerConfig = { model: (await import("./mock-model.js")).createMockModel(), mode };
    if (mode === "bedrock") {
      const { reserveDemoRun, createDemoJournal } = await import("./demo-lease.js");
      plannerConfig = {
        model: (await import("./bedrock.js")).createBedrockModel(), mode,
        beforeRun: () => reserveDemoRun(process.env.HOUSEHOLD_AWS_DEMO_RECEIPT!),
        onProgress: createDemoJournal(process.env.HOUSEHOLD_AWS_DEMO_RECEIPT!),
      };
    }
    const server = createDemoHttpServer({ endpoint, store: fileStore ?? (initialState ? new MemoryStore({ initialState }) : undefined), persistentState: Boolean(fileStore), planner: plannerConfig,
      allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean) });
    httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      try { server.listen(port, "127.0.0.1"); }
      catch (error) { server.off("error", onError); server.off("listening", onListening); reject(error); }
    });
    const address = server.address();
    const demoBase = `http://127.0.0.1:${typeof address === "object" ? address?.port : port}`;
    console.log(`Synthetic Household Brain demo listening on ${demoBase}/`);
    console.log(`Guided web client: ${demoBase}/ | MCP endpoint: ${demoBase}${endpoint}`);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => { server.closeAllConnections(); server.close(() => { void fileStore?.close().finally(() => process.exit(0)); if (!fileStore) process.exit(0); }); });
    }
  } catch {
    if (httpServer) {
      try {
        httpServer.closeAllConnections();
        await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      } catch { /* Continue to release our own store even if server cleanup fails. */ }
    }
    // Only FileStore.close may release this instance's token-verified writer lock.
    // A replaced/foreign lock is preserved; never reset state or unlink it here.
    try { await fileStore?.close(); } catch { /* Leave unverified locks for inspection. */ }
    console.error("Household Brain could not start. Check PORT, MCP_ENDPOINT and ALLOWED_ORIGINS. Inspect the saved-household writer before recovering any remaining lock. Existing data was not reset.");
    process.exitCode = 1;
  }
}

if (process.env.NODE_ENV !== "test" && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startLocalDemo();
}
