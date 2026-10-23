# Household Brain

A self-hosted **MCP server** that gives an AI assistant one shared brain for
running a household: pantry, grocery list, meal plan, chores, and the morning
brief. Built for the Alexa+ track of the Amazon "Build, Ship, Shape" hackathon
as a Model Context Protocol server using revision 2025-11-25. A local web
client calls the real server. Future Alexa+ integration has not been tested.

The household workflow uses **one shared household store**. `groceries_add`,
`chore_log` and `restock_for_meals` can update it; other household operations
read it. Health and preference helpers report metadata. The demonstrated
workflow is the tool call for:
*"Make sure we have everything for dinner the next two nights."*
`restock_for_meals` reads the meal plan and pantry and proposes missing
name-and-unit pairs. A write requires the token from that preview. State
validation and the whole batch insertion share one store transaction; if
the household changed, nothing is added and a fresh preview needs confirmation.

- TypeScript, official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (1.32.x)
- **Streamable HTTP** transport, protocol revision **2025-11-25**, stateless
  (one server instance per request)
- a browser client with deliberate restock previews, actual list/brief
  updates and visible error recovery, using same-origin JSON-RPC
- code/HTTP tests exercise real loopback clients, interrupted requests, bounded
  model/tool inputs, preview conflicts, persistence rollback and concurrent restocking
- an optional server-side Amazon Bedrock Converse planner reads real MCP tools
  and proposes a restock; its model cannot commit changes
- optional bounded local-file persistence preserves confirmed changes across restarts

## Tools (9, snake_case)

| Tool | What it does | Writes |
|---|---|---|
| `health` | Liveness, tool inventory, demo-mode disclosure | no |
| `brief_get` | Household and fictional weather/calendar/home sections; household reads dinner ingredients, low stock and due-soon chores | no |
| `brief_preferences` | Lists brief sources, defaults, and demo disclosure | no |
| `pantry_query` | Look up one item by name, or hear everything running low | no |
| `groceries_add` | Add an item to the grocery list; same name+unit lines merge | yes |
| `mealplan_get` | Read the meal plan and its ingredient checklist | no |
| `chore_log` | Mark a chore done by exact or unambiguous partial name | yes |
| `household_summary` | Low pantry stock, actual grocery lines and count, tonight's meal, open chores | no |
| `restock_for_meals` | Preview missing ingredients and low staples; a commit requires `expected_token` from that preview and atomically validates state before adding one unit per absent name/unit pair | yes |

Tool names use `snake_case`, which avoids dotted-name restrictions in
common LLM tool-calling APIs. The optional planner uses Amazon Nova Lite through
Bedrock Converse; it is disabled by default. Mock mode makes no AWS requests.
Successful tool results include `text` content and machine-readable
`structuredContent`. Household results use concise text intended for spoken
presentation; `health` and `brief_preferences` serialize JSON as text. MCP
tool annotations are declared in the tool definitions.

## Quickstart

Node 20 or later (reviewed on Node 24.14.0, npm 10.5.0, with the committed lock file).

```sh
npm ci --ignore-scripts
npm test        # builds with tsc, then runs the code/HTTP regression suites
npm start
```

Open **http://127.0.0.1:8099/** in a browser and choose **Open sample household**.
The page initializes the MCP connection, sends the initialized notification,
discovers all nine tools and reads the household state. It uses the real
server responses, with optional technical receipts. No LLM interprets
the form controls.

1. Read the selected dinner plans and low pantry items. Keep the meal selector
   at 2 and choose **Check what to add**. A fresh server
   proposes six additions; blueberries are already listed. This explicit
   `dry_run: true` request changes nothing.
2. Review the meal ingredients, low staples, units and reasons, then choose
   **Add 6 items to sample list**. One unit per missing item is proposed;
   recipe-serving quantities are not calculated. This
   separate `dry_run: false` call sends the preview's `expected_token`.
   The store atomically validates the decision state and adds the batch.
   If another client changed the pantry, plan or list, the write is rejected
   with a fresh preview; review and confirm again. A fresh fixture produces
   six additions, seven grocery lines and a brief that reflects the list.
3. Read the updated sample list, then check again. The repeated check shows
   nothing new to add and disables confirmation; it makes no additional write.
4. Expand the other household tools and mark **take out recycling** done.
   It leaves the open chores and the next
   household brief. Pantry, meal-plan and brief controls expose the remaining
   journeys; server details show health, preferences and discovered definitions.

Manual grocery additions **increase** the existing quantity for the same
normalized item name and unit. There is no undo/remove tool. In-flight
controls prevent double clicks, and the client never retries a write
automatically. If a write response is lost or uncertain, use **Reload household**,
inspect the actual list and decide whether to retry.
The read-only refresh does not repeat the write.

All clients share one store. With the default in-memory store, restarting
creates fresh fictional fixtures; refreshing the page does not reset it. Set
`HOUSEHOLD_STATE_FILE` for durable local state, as described below. Adding to
the grocery list does not replenish pantry stock or place an order. The
restock is an ingredient checklist, not a recipe-quantity calculation.
The fixture plan contains three meals; the web selector exposes those three.

Every restock write, including direct MCP calls, requires `expected_token`
from a prior `dry_run: true` result's `structuredContent.previewToken`.
Missing/stale tokens return `isError`, `writeApplied: false` and a fresh
read-only preview. This changes the older direct-commit calling contract.
Tokens bind decision state and meal count; they are concurrency controls,
not authentication, permissions or an inventory reservation. Other clients
can still change the local list before confirmation. A persistent adapter
must provide the same atomic validation/write guarantee across its writers.

Names support visible Unicode, normalized with NFKC, up to 80 characters;
units support up to 40. Control and default-ignorable characters are rejected,
including legitimate joiners and variation selectors. This is a deliberate
input limit, not complete Unicode spoofing prevention. The list is capped at
200 name/unit pairs. Quantities and combined
totals range from 0.001 to 10000 with at most three decimal places.
Different units are shown separately without conversion. Low stock already
on the list is identified without pretending the pantry was replenished.

For the scripted SDK-client alternative:

```sh
npm run demo
```

`npm run demo` starts a temporary loopback server, connects a real SDK
`Client` over Streamable HTTP, lists the tools, and runs the scripted
household workflow, then shuts both down. Point MCP Inspector at
`http://127.0.0.1:8099/mcp` after `npm start` to poke at it interactively.
This older scripted demo automatically commits synthetic changes. It is not
evidence of human confirmation; use the web client for that workflow.

## Optional planner and persistent state

See [AWS-DEMO.md](AWS-DEMO.md) for offline/mock setup, the bounded live proof
procedure, model permissions, exact limits, cost calculation and judging notes.
The ordinary MCP checklist is free to run and needs no AWS account. No API key
or credential is shipped in this repository.

For a mock planner with real MCP calls and durable fictional state in PowerShell:

```powershell
$env:HOUSEHOLD_PLANNER_MODE = 'mock'
$env:HOUSEHOLD_STATE_FILE = Join-Path (Get-Location) 'data/household.snapshot.json'
npm run build
npm start
```

Open the sample household and choose **Plan these meals**. The mock model reads
the meal plan and pantry, then requests a dry-run preview. It makes no AWS calls.
Only **Add items to sample list** commits the retained preview. Refreshing the
page can restore that proposal without repeating inference. A server restart
invalidates old preview tokens while retaining confirmed household state.

Environment: `PORT` (default 8099), `MCP_ENDPOINT` (default `/mcp`) and
`ALLOWED_ORIGINS` (comma-separated exact HTTP(S) origins, without paths).
The web client reads the actual MCP path from `GET /demo-config.json`, so a
custom normalized endpoint also works from the root page. Custom endpoints
must not shadow static, health, config or planner routes. Planner mode is
`off` (default), `mock` or explicitly authorized `bedrock`.

The server binds loopback. Browser requests require the exact same HTTP
origin by default; native MCP clients may omit Origin. An explicit allowlist
does not relax the page's same-origin Content Security Policy. The page uses
only local scripts/styles and same-origin connections, with no inline script,
external font or remote asset. Result strings are inserted as text. These boundaries
support a local fictional-data demo, not production authentication.

## Architecture

```
   MCP clients using protocol 2025-11-25
   local web client | MCP Inspector | scripted SDK client
   optional server-side Bedrock planner (or disclosed mock)
                       |
                       | Streamable HTTP, stateless
                       | (POST /mcp, JSON responses,
                       |  one server instance per request)
                       v
 +---------------------------------------------------+
 | node:http server  (loopback by default)           |
 |   - host allow-list + browser-Origin validation   |
 |   - web page + exact static assets + CSP          |
 |   - /demo-config.json and /healthz                |
 |   - new McpServer per request (SDK pattern for    |
 |     serverless/stateless deployments)             |
 +------------------------+--------------------------+
                          |
                          v
 +---------------------------------------------------+
 | 9 registered tools                                |
 |   MCP annotations on tool definitions             |
 |   successful results: text + structuredContent     |
 +------------------------+--------------------------+
                          |
                          v
 +---------------------------------------------------+
 | HouseholdStore interface (src/store.ts)           |
 |   - MemoryStore: default, synthetic fixtures,     |
 |     resets on restart                             |
 |   - FileStore: bounded local versioned snapshots  |
 |     one writer, atomic replace before publication |
 |     preview tokens invalidated on restart         |
 +---------------------------------------------------+
```

The implemented optional planner calls Bedrock Converse from the local Node
backend and drives the same MCP server through a real SDK HTTP client. It needs
no AWS deployment. Lambda, API Gateway, DynamoDB and AgentCore deployment are
not implemented or required for this demonstration.

## Demo mode (honesty notes)

All household data in this repository is **fictional fixtures** (a synthetic
demo family). Successful tool results disclose `Synthetic demo: fictional
household data.` in text or a JSON `notice` field. Local demonstrations run
against the selected local memory or file store.

Bedrock is an optional integration, disabled by default. Mock mode must never
be presented as a live AWS response. The live mode uses fictional household
fixtures and the operator's explicitly selected named personal AWS login; it
ships no credentials and connects no live household sources, purchases or devices. The server
deliberately binds `127.0.0.1` and runs unauthenticated for a fictional-data
demo and local judging. It is not ready for real household data or public exposure.

Writes affect only the selected fictional local store. File persistence is
single-writer process-restart persistence, not a guaranteed power-loss database.
A crash leaves a lock requiring deliberate manual recovery; external editors
and hostile local filesystem races are outside this private-store contract. The
demo checks an ingredient checklist; it does not calculate recipe quantities
or claim that adding groceries replenishes the pantry.

## Tests

Tests across `src/test/` cover brief composition and topic
filtering, household-tool behavior (normalization, ambiguous chore matching,
dedup, atomic batch validation), real loopback HTTP (initialize negotiation
of 2025-11-25, tools/list, state across stateless requests, 40 concurrent
calls, Origin refusal, /healthz, malformed/oversized bodies, interrupted
requests), static routes/configuration/security headers, exact-origin checks
for browser requests, pantry ambiguity, read-only grocery-list exposure,
mandatory preview tokens, conflict rejection and bounded numeric/text input.
HTTP tests need local socket access.

New suites cover planner tool restrictions, strict arguments, token withholding,
request/input/output limits, failed and cancelled model usage, SDK SigV4 signing
and no retries, HTTP one-attempt concurrency, the durable live-attempt lease,
file rollback, corrupt snapshots, restart invalidation and duplicate prevention.
All automated model responses use test doubles. `node scripts/ui-smoke.mjs`
runs a separate headless Chrome test with a fresh profile; its automated mock
confirmation is not evidence of human approval for a live demonstration.

A separate October 22 run passed 58 local headless Chromium checks using
Playwright 1.58 and the real SDK 1.32.1. These cover all nine tool journeys,
non-mutating previews, another client's intervening changes, zero-write stale
preview rejection, explicit reconfirmation, duplicate-safe restocking,
keyboard focus after actions/errors, preservation of user-moved focus,
truthful failed-refresh and lost-write recovery without automatic retries,
and phone layouts at 360, 390 and 430 pixels. No uncaught page errors or
external browser requests occurred. Screenshots and request/response receipts
are retained in the separate review packet. The browser runner is separate
from `npm test`; these checks are not a complete accessibility audit or a
final submission video. No physical device, screen-reader or human household
validation is claimed.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 Jordan Skinner.
