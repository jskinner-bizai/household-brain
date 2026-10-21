# Household Brain

A self-hosted **MCP server** that gives an AI assistant one shared brain for
running a household: pantry, grocery list, meal plan, chores, and the morning
brief. Built for the Alexa+ track of the Amazon "Build, Ship, Shape" hackathon
as a Model Context Protocol server any spec-2025-11-25 client can call —
designed for future Alexa+ integration, which has not been tested.

Every tool reads and writes **one shared household state**. The demonstrated
workflow is the tool call for:
*"Make sure we have everything for dinner the next two nights."*
`restock_for_meals` reads the meal plan, checks the pantry, skips what is
already on the grocery list, and writes the missing adds — atomically, in one
call.

- TypeScript, official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (1.32.x)
- **Streamable HTTP** transport, protocol revision **2025-11-25**, stateless
  (one server instance per request — the Lambda-friendly pattern)
- 46/46 tests green, including real loopback HTTP clients, concurrent and
  interrupted requests, and atomic concurrent restocking

## Tools (9, snake_case)

| Tool | What it does | Writes |
|---|---|---|
| `health` | Liveness, tool inventory, demo-mode disclosure | no |
| `brief_get` | Morning brief from household + weather/calendar/home sources; reflects grocery and chore changes made through the other tools | no |
| `brief_preferences` | Lists brief sources, defaults, and demo disclosure | no |
| `pantry_query` | Look up one item by name, or hear everything running low | no |
| `groceries_add` | Add an item to the grocery list; same name+unit lines merge | yes |
| `mealplan_get` | Read the meal plan and its ingredient checklist | no |
| `chore_log` | Mark a chore done by exact or unambiguous partial name | yes |
| `household_summary` | One view: low pantry stock, grocery count, tonight's meal, open chores | no |
| `restock_for_meals` | The multi-step workflow: check plan + pantry, de-duplicate against the list, ensure one unit of each missing ingredient or low staple. `dry_run: true` previews | yes |

Tool names use `snake_case`, which avoids dotted-name restrictions in
common LLM tool-calling APIs. No LLM integration is implemented here. Every tool returns both spoken-first
`text` content (written to be read aloud) and machine-readable
`structuredContent` (for cards), plus MCP tool annotations.

## Quickstart

Node 20 or later (reviewed on Node 24, npm 10, with the committed lock file).

```sh
npm ci
npm test        # builds with tsc, then runs all 46 tests
npm run demo    # real MCP SDK client over loopback: handshake, tools/list, scripted workflow
npm start       # serves http://127.0.0.1:8099/mcp  (also GET /healthz)
```

`npm run demo` starts a temporary loopback server, connects a real SDK
`Client` over Streamable HTTP, lists the tools, and runs the scripted
household workflow below, then shuts both down. Point MCP Inspector at
`http://127.0.0.1:8099/mcp` after `npm start` to poke at it interactively.

Environment: `PORT` (default 8099), `MCP_ENDPOINT` (default `/mcp`),
`ALLOWED_ORIGINS` (comma-separated origins permitted by the browser-Origin
check).

## Architecture

```
   any MCP client (protocol 2025-11-25)
   MCP Inspector | scripted SDK client   <-- what exists today
   (future work, not built: a Bedrock Converse
    agent loop driving tools/call from a demo web page)
                       |
                       | Streamable HTTP, stateless
                       | (POST /mcp, JSON responses,
                       |  one server instance per request)
                       v
 +---------------------------------------------------+
 | node:http server  (loopback by default)           |
 |   - host allow-list + browser-Origin validation   |
 |   - /healthz for load balancers                   |
 |   - new McpServer per request (SDK pattern for    |
 |     serverless/stateless deployments)             |
 +------------------------+--------------------------+
                          |
                          v
 +---------------------------------------------------+
 | 9 registered tools                                |
 |   spoken-first text + structuredContent +         |
 |   annotations on every response                   |
 +------------------------+--------------------------+
                          |
                          v
 +---------------------------------------------------+
 | HouseholdStore interface (src/store.ts)           |
 |   - MemoryStore: default, synthetic fixtures,     |
 |     resets on restart                             |
 |   - persistent adapters plug in here; they must   |
 |     implement the atomic ensureGroceries()        |
 |     contract (conditional writes, no read-then-   |
 |     write races)                                  |
 +---------------------------------------------------+
```

The store interface is the seam for a **planned (not built)** AWS deployment:
a DynamoDB adapter behind the same interface, fronted by Lambda + API Gateway
(the official stateless-MCP-on-Lambda pattern), with the agent loop calling
Bedrock Converse. None of that is implemented in this repo. App Runner was
considered and dropped — it is closed to new customers.

## Demo mode (honesty notes)

All household data in this repository is **fictional fixtures** (a synthetic
demo family); every tool response is labeled `Synthetic demo: fictional
household data.` The submission demo runs against this local in-memory store.

Bedrock integration is **designed-for, not integrated**: the tool surface is
shaped for it (snake_case names for Converse tool-calling, structuredContent
for cards), but this repo makes no AWS calls, ships no credentials, and
connects no live household sources, purchases, or devices. The server
deliberately binds `127.0.0.1` and runs unauthenticated — fine for a demo and
for judging, wrong for real household data or public exposure.

Writes affect the in-memory demonstration store and reset on restart. The
demo checks an ingredient checklist; it does not calculate recipe quantities
or claim that adding groceries replenishes the pantry.

## Tests

46/46 across four suites (`src/test/`): brief composition and topic
filtering, household-tool behavior (normalization, ambiguous chore matching,
dedup, atomic batch validation), real loopback HTTP (initialize negotiation
of 2025-11-25, tools/list, state across stateless requests, 40 concurrent
calls, Origin refusal, /healthz, malformed/oversized bodies, interrupted
requests), and server-level checks. HTTP tests need local socket access.

## License

MIT — see [LICENSE](LICENSE). Copyright 2026 Jordan Skinner.
