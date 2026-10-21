// Liveness/introspection: every judge pokes this first. The inventory is passed in
// by server.ts so it can never drift from what is actually registered.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYNTHETIC_DEMO_LABEL } from "../store.js";

export const SERVICE = { name: "household-brain", version: "0.2.0" };

export function registerSystemTools(server: McpServer, inventory: () => string[] = () => []): string[] {
  server.registerTool(
    "health",
    {
      title: "Health check",
      description: "Returns server liveness, tool inventory and synthetic demo mode. No live household sources are connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const status = { ok: true, service: SERVICE.name, version: SERVICE.version, uptimeSec: Math.round(process.uptime()), tools: ["health", ...inventory()], demo: true, dataSource: "synthetic fixtures", liveConnections: false, notice: SYNTHETIC_DEMO_LABEL };
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
    }
  );
  return ["health"];
}
