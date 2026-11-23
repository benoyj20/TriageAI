# API contract v1

Frozen on 2026-11-21. This folder is the single source of truth for every JSON message that crosses a folder boundary: console ↔ Go gateway ↔ Python engine. Build, mock and test against it.

| Path | What it is |
|---|---|
| [`examples/`](examples/) | Complete JSON for every request and response. Start here. |
| [`schema/`](schema/) | JSON Schema (draft 2020-12), generated from `engine/app/schemas.py`. Use it to validate or to generate types. |
| [`reason_codes.md`](reason_codes.md) | The 11 gate reason codes, their severities and when each fires. |

Values in the examples (ticket IDs, scores, timings, answer text) are made up. Field names, types and the rules on this page are binding.

## Endpoints

| Caller → callee | Method and path | Request | Success |
|---|---|---|---|
| Console → gateway | `POST /api/v1/triage` | [`triage_request.json`](examples/triage_request.json) | 200 + TriageResponse |
| Console → gateway | `GET /api/v1/health` | none | 200 + [`health.json`](examples/health.json) |
| Gateway → engine | `POST /v1/triage` | [`engine/triage_request.json`](examples/engine/triage_request.json) | 200 + EngineTriageResponse |
| Gateway → engine | `GET /healthz` | none | 200 + [`engine/healthz.json`](examples/engine/healthz.json) |

The engine is private (port 8000, never exposed). Only the gateway calls it.

The gateway also serves `GET /api/v1/insights/{name}` and proxies the ticket store routes (`/api/v1/tickets...`) to the engine's `/v1/tickets...`. Those are outside contract v1; see [`backend/README.md`](../backend/README.md).

TriageResponse examples, one per state the console must render:

| Example | Decision | What it shows |
|---|---|---|
| [`triage_response.auto_draft.en.json`](examples/triage_response.auto_draft.en.json) | AUTO_DRAFT | English password reset, one queue searched, grounded draft |
| [`triage_response.escalate_oncall.de.json`](examples/triage_response.escalate_oncall.de.json) | ESCALATE_ONCALL | German VPN outage, two P1 reasons, burst cluster, German reply citing an English precedent |
| [`triage_response.human_review.en.json`](examples/triage_response.human_review.en.json) | HUMAN_REVIEW | Refund demand with a prompt injection; the draft promises nothing |
| [`triage_response.degraded.en.json`](examples/triage_response.degraded.en.json) | HUMAN_REVIEW | LLM timed out: extractive draft, global fallback, a warning |

## Request: `POST /api/v1/triage`

| Field | Type | Rules |
|---|---|---|
| `subject` | string or null | Optional, up to 500 characters. Null, missing and `""` all mean "no subject". |
| `body` | string | Required, 1 to 10,000 characters, not only whitespace. |
| `ticket_id` | string | Optional, up to 64 characters of letters, digits and `_ . : -`. The gateway assigns `LIVE-XXXXXXXX` when it's missing. |

Unknown request fields are ignored. A request body over 64 KiB gets 413.

## What the gateway does (Full-stack)

1. Validate the request. On failure return the error envelope (see Errors).
2. Assign `request_id` (`req_` + 12 lowercase hex), `ticket_id` when missing (`LIVE-` + 8 uppercase hex) and `created_at` (now, UTC, RFC 3339).
3. Mask PII in subject and body with typed, numbered placeholders: `[EMAIL_1]`, `[PHONE_1]`, `[IP_1]`, `[IBAN_1]`, `[CARD_1]`, `[ACCOUNT_1]`. Count each type.
4. `POST {ENGINE_URL}/v1/triage` with `{request_id, ticket_id, subject, body, created_at}`. Send `""` for a missing subject. Use a 12 s timeout.
5. On 200, add `pii`, add `latency_ms.gateway` (the gateway's own time, not counting the engine call), and set `latency_ms.total` to the engine's total plus `gateway`. Pass every other field through unchanged.
6. On failure, map to the error table below and always include `request_id`.

**Mock mode** (`MOCK_ENGINE=true`) skips the engine and returns one of the response examples. Use outage words (vpn, outage, ausfall) for `escalate_oncall.de`, refund words for `human_review.en`, crash words for `degraded.en`, and `auto_draft.en` otherwise. Replace `request_id`, `ticket_id`, `created_at`, `processed_at`, `subject`, `body` and `pii` with the real values.

## Response: TriageResponse

| Field | Type | Notes | Produced by |
|---|---|---|---|
| `contract_version` | `"1.0"` | | engine |
| `request_id`, `ticket_id` | string | Assigned by the gateway; the engine echoes them | gateway |
| `subject`, `body` | string | PII-masked text. `subject` is `""` when there was none | gateway masks, engine echoes |
| `created_at`, `processed_at` | RFC 3339 UTC | `processed_at` ≥ `created_at` | gateway, engine |
| `language` | `{code, confidence, supported}` | `code` is ISO 639-1 or `unknown`. `supported` is true only for `en` and `de` | ML |
| `pii.masked[]` | `{type, count}` | Empty list when nothing was masked | gateway |
| `classification.type` | `{label, confidence, probs}` | `probs` has all four types. `confidence` always equals `probs[label]` | ML |
| `classification.queue` | `{label, confidence, probs, votes, k}` | `probs` has the top 5 queues. `votes` of the `k` global neighbours share `label` | ML |
| `classification.priority` | `{label, confidence, probs, p_high}` | `probs` has high, medium, low. `p_high` equals `probs.high` | ML |
| `retrieval.route` | `{queues, searched, fallback_global}` | `queues`: top 3 level-1 scores, best first. `searched`: queues the level-2 search ran in. `fallback_global`: precedents came from the global search instead | ML |
| `retrieval.top_similarity`, `retrieval.k` | number, integer | Similarity of `precedents[0]`, or 0 when there are none. `k` is the most precedents returned (5) | ML |
| `precedents[]` | `{ticket_id, similarity, language, type, queue, priority, subject, answer_snippet, tags}` | Best first. KB IDs only (`TKT-` + 5 digits). `answer_snippet` is the first ~300 characters of the agent's answer. **Can be empty** | ML |
| `gate` | `{decision, reasons[]}` | `reasons[]` is `{code, severity, detail}`. See [`reason_codes.md`](reason_codes.md) | data analyst |
| `draft` | `{language, text, citations, mode, validation}` | See Draft modes. `citations` lists every `[TKT-xxxxx]` in `text`, in order of first use | Benoy |
| `draft.validation` | `{passed, citations_ok, numbers_ok, language_ok, retries, issues}` | `passed` = all three checks. `issues` are sentences for the operator | Benoy |
| `burst` | null or `{cluster_id, queue, lead_term, ticket_count, first_seen, last_seen}` | Present exactly when `ACTIVE_OUTAGE` fired | data analyst |
| `latency_ms` | `{gateway, language, classify, retrieve, gate, draft, validate, total}` | Milliseconds. `retrieve` covers embedding, global search, routing and the level-2 search. `total` ≥ the sum of the stages | gateway, engine |
| `warnings[]` | `{stage, code, message}` | Stage failures and stub notices. For a details or debug view, not the main panel | engine |

### Draft modes

| `mode` | When | Citations | Gate effect |
|---|---|---|---|
| `generated` | The LLM wrote it from the precedents | At least 1 | `UNGROUNDED_DRAFT` if it fails validation |
| `extractive` | The LLM failed; the reply quotes the best precedent | Exactly the precedent it quotes | `ENGINE_DEGRADED`, always human review |
| `holding` | No precedents to ground a reply on. A fixed acknowledgement that promises nothing | None | Never `AUTO_DRAFT` (normally `NO_PRECEDENT`) |

The draft is in `language.code` when that is `en` or `de`, otherwise in English.

### Rules a schema can't express

`engine/app/contract_rules.py` checks these. The tests run it on every example and on live engine output.

- `gate.decision` follows from the reason severities. Each code has the severity in [`reason_codes.md`](reason_codes.md), and no code appears twice.
- `confidence` equals `probs[label]` for every head, and `p_high` equals `probs.high`. Type and priority probabilities sum to 1.
- `precedents` are sorted best first, with no duplicates and at most `retrieval.k` of them. `top_similarity` equals the first one's similarity.
- Every queue in `route.searched` appears in `route.queues`. `searched` can only be empty when `fallback_global` is true.
- `draft.citations` are exactly the IDs in `draft.text`, and each one is in `precedents`.
- `burst` is present exactly when `ACTIVE_OUTAGE` fired. `UNSUPPORTED_LANGUAGE` fires exactly when `language.supported` is false.

## Errors

Every non-200 response from the gateway or the engine has this body:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "body: must not be only whitespace", "request_id": "req_9b1d0c4e2a77" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_JSON` | The body isn't valid JSON |
| 413 | `PAYLOAD_TOO_LARGE` | The request is over 64 KiB |
| 422 | `VALIDATION_ERROR` | A field breaks the rules above |
| 429 | `RATE_LIMITED` | Too many requests from one client |
| 500 | `INTERNAL` | Unexpected error. In the engine this includes a stage that produced a response breaking the contract |
| 502 | `ENGINE_BAD_RESPONSE` | The engine answered with something that isn't a contract response |
| 503 | `ENGINE_UNAVAILABLE` | The gateway can't connect to the engine |
| 504 | `ENGINE_TIMEOUT` | The engine didn't answer within 12 s |

The console shows `message` to the operator as is, so write it for them. When the engine returns an error envelope, the gateway passes it through with the same status and adds `request_id`.

## Health

`GET /api/v1/health` always answers 200 so the console can render it. `status` is `ok` when every component is ok, `degraded` when the engine reports degraded (for example, stub stages), and `down` when the engine is unreachable. `mode` is `live` or `mock`. `components` holds `gateway`, `engine` and `vector_db`, each `ok`, `down`, `stub` or `unknown`. The gateway copies `vector_db` from the engine's `/healthz`.

The engine's `GET /healthz` adds `stages`, which says whether each pipeline stage is `real` or still a `stub`, and `components` for `vector_db`, `llm` and `artifacts`.

## Engine API (gateway ↔ engine only)

- **Request:** `{request_id, ticket_id, subject, body, created_at}`, with text already masked. Unknown fields get 422. While developing you can call the engine with only `body`: it fills in the rest.
- **Response:** exactly the TriageResponse without `pii` and without `latency_ms.gateway`. `latency_ms.total` is the engine's own time.
- **Errors:** the same envelope, with 400 `INVALID_JSON`, 422 `VALIDATION_ERROR` or 500 `INTERNAL`.

## Changing the contract

1. Agree the change with Benoy first.
2. Edit `engine/app/schemas.py`, update the examples and this page, and regenerate the schemas with `python -m engine.app.contract_export`.
3. Run `python -m pytest` from the repo root. It must pass.
4. Announce it in the team chat. Additive changes bump to 1.x; renames and removals bump to 2.0.

## Migrating the console from the provisional shape

Done: the console in `frontend/` already uses contract v1. Kept for reference. Everything the console read before kept its name and meaning. Changes:

- **Paths:** `/api/triage` → `/api/v1/triage`, and `/api/health` → `/api/v1/health` (in `frontend/src/api/client.js`).
- **Health:** the `qdrant` key is gone. Read `components.vector_db` (Redis now); `status` works as before.
- **`draft.mode` has a third value, `holding`.** `normalize.js` accepts it, and the console labels it "Holding reply".
- **`precedents` can be empty** (every NO_PRECEDENT ticket). `DetailsModal.jsx` checks for that before reading `t.precedents[0]`.
- **`burst`** is `null` or an object with `cluster_id`, plus `queue`, `lead_term`, `ticket_count`, `first_seen` and `last_seen`.
- **New fields to show:**
  - `precedents[].answer_snippet` (the brief asks for the historical answer snippet)
  - `retrieval.route` (routing path, FS-09)
  - `classification.*.probs` (top-3 bars)
  - `draft.validation.language_ok`
  - `request_id` (put it in error toasts for debugging)
  - `warnings`
- **Errors** always use `{error: {code, message, request_id}}`.
- **The request needs `body`.** A subject-only ticket gets 422, and the in-browser mock rejects it too.
