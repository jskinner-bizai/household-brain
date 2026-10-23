# Optional AWS household planner

The planner turns one dinner request into a bounded tool workflow: read the real
MCP meal plan and pantry, request an actual restock preview, explain the proposal,
and wait for the person to confirm it. A local versioned snapshot retains
confirmed changes across server restarts. It does not order groceries, change
pantry stock, connect Alexa or use real household data.

## Run without AWS

Use Node 20.3+ and the committed lock file:

```powershell
npm ci --ignore-scripts
npm test
$env:HOUSEHOLD_PLANNER_MODE = 'mock'
$env:HOUSEHOLD_STATE_FILE = Join-Path (Get-Location) 'data/household.snapshot.json'
npm start
```

Open http://127.0.0.1:8099/, open the sample household, then choose **Plan these
meals**. The mock uses real Streamable HTTP MCP reads and a dry-run preview but
makes no model inference or AWS requests. Review the proposed additions and
confirm through the separate UI action. Reloading the page restores the completed
proposal without another model request. Restarting preserves confirmed state and
requires fresh preview tokens.

`HOUSEHOLD_PLANNER_MODE=off` is the default and retains the ordinary manual
checklist. Unset `HOUSEHOLD_STATE_FILE` for the original ephemeral fixture store.
The optional `node scripts/ui-smoke.mjs` test uses isolated headless Chrome and
an automated mock confirmation. It is not a live-human approval recording.

## Authorized live demonstration

This configuration deliberately pins `buildnextgen-personal`, `us-east-2`, and
direct model `amazon.nova-lite-v1:0`. It never falls back to the default profile,
an employer profile, another model, another Region or a bearer API key. Judges
can run the complete offline workflow free of charge. A separate optional live
reproduction requires their own authorized AWS login with that profile name;
no entrant credentials are provided.

Before any live request, verify the personal account identity, current plan and
credits, model availability and Ohio pricing. An expired login needs normal
browser authorization using the existing named profile. Never bypass MFA.
Read-only preflight commands are:

```powershell
aws sts get-caller-identity --region us-east-2 --profile buildnextgen-personal
aws freetier get-account-plan-state --region us-east-1 --profile buildnextgen-personal
aws bedrock get-foundation-model-availability --region us-east-2 --profile buildnextgen-personal --model-id amazon.nova-lite-v1:0
```

Inspect identity locally and redact account identifiers before sharing receipts.
Do not use raw credential-export commands or copy login URLs/tokens into logs.
The Free Tier API uses its service Region, while model operations stay in Ohio.
If authentication, model availability or permissions fail, stop. This demo does
not authorize an IAM grant, Marketplace subscription, account upgrade, model
agreement, additional terms acceptance or new credential type.

Runtime needs the existing `bedrock:InvokeModel` permission on
`arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-lite-v1:0`.
Metadata checks need their corresponding read permissions. Amazon models avoid
the third-party Marketplace subscription flow, but AWS service terms still apply.
Do not create an API key or deploy infrastructure for this workflow.

After the single bounded run is authorized and preflight passes:

```powershell
$env:HOUSEHOLD_PLANNER_MODE = 'bedrock'
$env:HOUSEHOLD_AWS_DEMO_APPROVED = '1'
$env:HOUSEHOLD_STATE_FILE = Join-Path (Get-Location) 'data/live-synthetic.snapshot.json'
$env:HOUSEHOLD_AWS_DEMO_RECEIPT = Join-Path (Get-Location) 'data/approved-one.demo-receipt.json'
npm run build
npm start
```

The approval flag is an operator acknowledgement, not an authentication boundary
or a substitute for authorization. No credentials are read until the planner is
invoked. The durable attempt file is created exclusively before any model
request. An error, lost response or restart never deletes it or frees the
attempt. Do not delete it or choose a new filename to repeat a paid run without
separate authorization.

Open the household and choose **Plan these meals** once. The model must read
`mealplan_get` and `pantry_query` in a completed earlier round before it can ask
for `restock_preview`. The host maps that wrapper to `restock_for_meals` with
`dry_run:true` and the selected meal count. It never supplies commit tools,
`groceries_add`, `chore_log` or a confirmation token to the model.

Review the actual additions, units, conflicts and reasons. Only the person's
separate UI confirmation sends the retained preview token to the existing MCP
commit route. If the household changed, nothing is added: review the new preview
and confirm again. No automated script should click this live confirmation.

## Bounds and receipts

- One planner attempt per server and one durable attempt per live receipt path.
- At most six total model requests and six MCP tool calls. Failed requests count.
- At most 32 KiB of serialized model input per request, 12 KiB per tool response,
  and 1,024 generated tokens per request. Planning stops after 90 seconds.
- Official AWS SDK `maxAttempts:1`; no retries, streaming or model fallback.
- Fixed direct Ohio model endpoint and SigV4 using the named login provider.
- The application uses the reference rates $0.06/M input and $0.24/M output.
  Current Ohio public price-list terms effective October 1, 2026 confirm these
  rates. Verify prices again before future authorized runs.

Even conservatively allowing the model's entire 300K-token context on each of
six requests, inference costs at most $0.10947456 gross at those rates, before
credits. The approved gross ceiling is $1. This is an application request bound,
not an account-level AWS spend cap. No billable hosting or storage is created.

Successful responses include model, Region, actual reported token usage,
request/tool counts, estimated gross cost and a token-free tool trace. A small
`<attempt-file>.progress.json` journal is written before each attempted model
request and after validated usage and completion. Failures retain known usage,
unreported attempts and `costComplete:false` when exact cost is unknown. A
pre-call journal failure stops before model dispatch. No raw provider errors,
credentials or confirmation tokens belong in the journal.

The UI can restore a completed in-process proposal from `GET /planner/result`
without repeating inference. The receipt and household snapshot directories must
stay private and local. A household file is limited to 512 KiB and one writer
process; it rejects links, corrupt/unsupported snapshots and unexpected external
edits. Writes atomically replace the file before publishing memory. This covers
process restarts, not all power-loss cases or hostile local filesystem races.
A crash may leave `.lock`; inspect the process and state before manually
recovering it. Never silently reset corrupt state to fixtures.

## Runtime proof checklist

1. Record redacted personal identity/model/plan preflight and current price terms.
2. Record one live planner request, actual MCP reads and dry-run additions. Verify
   that the grocery list remains unchanged before confirmation.
3. Capture the human reviewing and explicitly confirming those exact additions.
4. Verify actual list/brief results and a repeated dry-run with no new additions.
5. Restart with the same household file and planner mode `off`; verify confirmed
   data remains and the old token is rejected. This requires no further inference.
6. Keep actual request counts and token-based gross estimate, disclose failures
   or unknown usage, and label every mock or replay clearly.

The old `npm run demo` script automatically commits synthetic changes and cannot
serve as evidence of human approval. Do not claim that an offline test, imported
SDK or staged provider is a completed live AWS integration.

## Official references

- [Hackathon rules](https://amazonappdev2026.devpost.com/rules): Alexa+ primary
  track with documented AWS Builder integration; Kiro Crew development use can
  qualify independently, but must actually have occurred.
- [Nova Lite model and Ohio availability](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html)
- [Converse API and InvokeModel permission](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Model access and Marketplace distinctions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [Current public Ohio price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-2/index.json)
