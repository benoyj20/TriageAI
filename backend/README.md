# TriageAI gateway (backend)

Go 1.22+, standard library only. Owner: Full-stack dev. The console talks only to this gateway; the Python
engine (:8000) and Redis stay private. Every message follows the frozen API contract in
[`contracts/README.md`](../contracts/README.md) (v1).

```bash
cd backend
go test ./...
go run ./cmd/api            # http://localhost:8080, mock engine by default
MOCK_ENGINE=false go run ./cmd/api   # calls the engine at ENGINE_URL
```

To get the whole app from the gateway, build the console first (`cd frontend && npm run build`); the gateway
serves `../frontend/dist`. For the Vite dev server instead, put `VITE_USE_MOCK=false` in
`frontend/.env.local`; Vite proxies `/api/*` to :8080.

## What it does

| Task | Where |
|---|---|
| FS-02 skeleton: request rules, IDs, error envelope, JSON logs (never ticket text), panic recovery, graceful shutdown | `cmd/api`, `internal/api` |
| FS-03 mock mode (`MOCK_ENGINE=true`): answers with the contract's example responses, picked by keyword, with the real IDs, times and masked text | `internal/engine/mock.go` |
| FS-08 real engine (`MOCK_ENGINE=false`): `POST {ENGINE_URL}/v1/triage` with a 12 s timeout, `GET /healthz` | `internal/engine/client.go` |
| FS-15 PII guardrail: `[EMAIL_1]`, `[PHONE_1]`, `[IP_1]`, `[IBAN_1]`, `[CARD_1]`, `[ACCOUNT_1]`, numbered per ticket | `internal/pii` |
| FS-16 serves the built console and the Insights JSON | `internal/api/server.go` |
| FS-17 per-client rate limit on triage | `internal/ratelimit` |

## Routes

| Route | Notes |
|---|---|
| `POST /api/v1/triage` | Contract request rules; assigns `request_id`, `ticket_id` (when missing) and `created_at`; masks PII; adds `pii` and `latency_ms.gateway` to the engine's answer |
| `GET /api/v1/health` | Always 200. `status` is `down` when the engine is unreachable and `degraded` while it reports stub stages. In mock mode it is `degraded` with `mode: "mock"` (engine and `vector_db` report `stub`) |
| `GET /api/v1/insights/{operations\|model}` | `operations_insights.json` / `model_insights.json` from `INSIGHTS_DIR` (not part of the contract) |
| `GET /api/v1/tickets`, `GET /api/v1/tickets/{id}`, `GET /api/v1/tickets/{id}/status`, `GET /api/v1/tickets/{id}/related`, `PUT /api/v1/tickets/{id}/status` | Ticket store, proxied to the engine's `/v1/tickets...` routes after an ID check (`internal/api/tickets.go`; not part of the contract). In mock mode they answer 503 `ENGINE_UNAVAILABLE` |
| everything else | the built console; unknown paths get `index.html`, unknown `/api/` paths a 404 envelope |

Errors use the contract envelope `{"error":{"code","message","request_id"}}` and codes: `INVALID_JSON` 400,
`PAYLOAD_TOO_LARGE` 413, `VALIDATION_ERROR` 422, `RATE_LIMITED` 429 (with `Retry-After`), `INTERNAL` 500,
`ENGINE_BAD_RESPONSE` 502, `ENGINE_UNAVAILABLE` 503, `ENGINE_TIMEOUT` 504. Engine error envelopes pass through
with their status. The `X-Request-ID` response header carries the same `request_id`.

Mock answers come from `internal/engine/examples/`, copies of `contracts/examples/triage_response.*.json`
(Go can't embed files outside its module). A test fails if they drift; copy them again after a contract change.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `MOCK_ENGINE` | `true` | `false` to call the Python engine |
| `ENGINE_URL` | `http://localhost:8000` | `http://engine:8000` in docker-compose |
| `ENGINE_TIMEOUT` | `12s` | contract v1 |
| `WEB_DIR` | `../frontend/dist` | empty string turns static serving off |
| `INSIGHTS_DIR` | `../analytics/insights` | |
| `RATE_LIMIT_PER_MIN` | `60` | per client IP; `0` turns it off |
| `RATE_LIMIT_BURST` | `10` | requests allowed at once |
| `TRUST_PROXY` | `false` | `true` only behind our own reverse proxy, to read `X-Forwarded-For` |
