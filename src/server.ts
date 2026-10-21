// Synthetic Household Brain demo. No household credentials or live controls.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, ServerResponse, IncomingMessage } from "node:http";
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

export function originAllowed(req: IncomingMessage, allowedOrigins: string[] = []): boolean {
  if (!req.headers.origin || allowedOrigins.includes(req.headers.origin)) return true;
  try {
    const origin = new URL(req.headers.origin);
    if (origin.host === req.headers.host) return true;
    return ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  } catch { return false; }
}

export function createDemoHttpServer(options: { store?: HouseholdStore; endpoint?: string; allowedOrigins?: string[] } = {}) {
  const store = options.store ?? new MemoryStore();
  const endpoint = options.endpoint ?? "/mcp";
  if (!endpoint.startsWith("/") || endpoint.includes("?") || endpoint.includes("#")) {
    throw new Error("MCP_ENDPOINT must be an absolute URL path without a query or fragment");
  }
  const httpServer = createServer(async (req, res) => {
    let server: McpServer | undefined;
    try {
      const base = new URL(`http://${req.headers.host ?? "invalid"}`);
      if (!["127.0.0.1", "localhost"].includes(base.hostname)) {
        errorResponse(res, 403, "Local demo host required");
        return;
      }
      if (!originAllowed(req, options.allowedOrigins ?? [])) {
        errorResponse(res, 403, "Untrusted origin");
        return;
      }
      const url = new URL(req.url ?? "/", base);
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, service: SERVICE.name, version: SERVICE.version, demo: true }));
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
    console.log(`Synthetic Household Brain demo listening on http://127.0.0.1:${typeof address === "object" ? address?.port : port}${endpoint}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { httpServer.closeAllConnections(); httpServer.close(() => process.exit(0)); });
  }
}
