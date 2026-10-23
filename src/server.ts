// Synthetic Household Brain demo. No household credentials or live controls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, ServerResponse, IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSystemTools, SERVICE } from "./tools/system.js";
import { registerBriefTools } from "./tools/brief.js";
import { registerHouseholdTools } from "./tools/household.js";

import { HouseholdStore, MemoryStore } from "./store.js";

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
]);
const reservedPaths = new Set([...webAssets.keys(), "/healthz", "/demo-config.json"]);
const webRoot = new URL("../web/", import.meta.url);

export function createDemoHttpServer(options: { store?: HouseholdStore; endpoint?: string; allowedOrigins?: string[] } = {}) {
  const store = options.store ?? new MemoryStore();
  const endpoint = options.endpoint ?? "/mcp";
  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(endpoint)
      || new URL(endpoint, "http://localhost").pathname !== endpoint || reservedPaths.has(endpoint)) {
    throw new Error("MCP_ENDPOINT must be a normalized absolute path that does not shadow demo routes");
  }
  const allowedOrigins = options.allowedOrigins ?? [];
  if (allowedOrigins.some(origin => !isHttpOrigin(origin))) throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths");
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
          const body = url.pathname === "/demo-config.json" ? { mcpEndpoint: endpoint }
            : { ok: true, service: SERVICE.name, version: SERVICE.version, demo: true };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
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

if (process.env.NODE_ENV !== "test" && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8099);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  const endpoint = process.env.MCP_ENDPOINT ?? "/mcp";
  const httpServer = createDemoHttpServer({ endpoint, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean) });
  httpServer.listen(port, "127.0.0.1", () => {
    const address = httpServer.address();
    const demoBase = `http://127.0.0.1:${typeof address === "object" ? address?.port : port}`;
    console.log(`Synthetic Household Brain demo listening on ${demoBase}/`);
    console.log(`Guided web client: ${demoBase}/ | MCP endpoint: ${demoBase}${endpoint}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { httpServer.closeAllConnections(); httpServer.close(() => process.exit(0)); });
  }
}
