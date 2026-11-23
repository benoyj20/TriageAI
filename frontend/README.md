# TriageAI console (frontend)

React + Vite (JavaScript), Tailwind v4, Recharts, lucide-react icons. Owner: Full-stack dev.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm test           # gate, PII masking, language detection, response checks (node --test)
```

In `npm run dev` the console runs on a built-in **mock engine** (`src/api/mockEngine.js`), so it works with no backend.
To go through the Go gateway instead (see `backend/README.md`), start it on :8080 and create `.env.local`:

```
VITE_USE_MOCK=false
```

**Production builds (`npm run build`) always call the gateway.** Demo mode for a deploy is the gateway's
`MOCK_ENGINE` switch (FS-03), not the browser mock. The gateway also serves the build (FS-16), so
`npm run build` and then running the gateway gives the full app on http://localhost:8080. Setting `VITE_USE_MOCK=true` at build time is only for an
offline demo build.

Vite proxies `/api/*` to `http://localhost:8080`. To point it elsewhere, set `GATEWAY_URL` in the shell that
runs `npm run dev` (it is read by `vite.config.js`, not from `.env.local`). If you set `VITE_API_BASE` to a full
URL instead, the gateway must allow CORS from the console's origin.

## Views

| Route | View | Tasks |
|---|---|---|
| `#/` | Landing: choose a role (ticket creator or incident manager) | |
| `#/help`, `#/help/ticket/:id` | Ticket creator portal (`pages/CreatorPortal.jsx`): submit a ticket, follow your own tickets with live status, related reading | |
| `#/console`, `#/view/:view` | Triage dashboard (Overview): triage split bar, tabs (Needs action / Escalated / Human review / Auto-drafted / Resolved / Degraded), sortable table, accept/reject suggestions, bulk actions, "why" details modal | FS-04, FS-07 |
| `#/board` | Kanban board: Incoming → Escalated → Human review → Draft ready → Resolved, drag-and-drop plus a keyboard "move" menu | FS-07 |
| `#/ticket/:id` | Ticket detail: triage suggestions with Apply, escalation gate reasons, text-only draft with citation chips and validation, precedents with answer snippets and the routing path (`retrieval.route`), top-3 class probabilities, holding / extractive / generated drafts, warnings, request ID, latency strip, PII summary | FS-09, FS-10, FS-11 |
| `#/lab` | Live triage (`pages/TriageLab.jsx`): paste any ticket or pick a sample scenario and inspect the full triage (tickets tagged `TEST-`) | FS-05 |
| `#/funnel` | Funnel (`pages/FunnelPage.jsx`): waterfall funnel of live tickets with pivots | |
| `#/insights` | Reports (`pages/InsightsPage.jsx`): "Dataset & model" and "This session" tabs, reading the Data analyst's exports in `features/insights/data/` (DA-07). Shared chart components are in `components/charts/` | FS-18 |
| History in side rail | History drawer | FS-14 |
| "Outage drill" on the Overview | Burst of 4 VPN tickets (tagged `SIM-`) → major-incident banner | FS-13 |

## API

The console follows the frozen contract in [`contracts/README.md`](../contracts/README.md) (v1):
`POST /api/v1/triage` with `{subject?, body, ticket_id?}` and `GET /api/v1/health`, plus the shared ticket store
(`GET /api/v1/tickets`, `GET /api/v1/tickets/:id`, `.../status`, `.../related`, `PUT /api/v1/tickets/:id/status`). All network calls are in
`src/api/client.js` (timeouts plus readable `ApiError` messages that carry the `request_id`, FS-06);
`src/api/normalize.js` checks each TriageResponse so a missing field shows an error instead of a blank view.
The browser mock (`src/api/mockEngine.js`) returns the same TriageResponse shape; its output passes the
engine's contract checks (`engine/app/schemas.py`, `engine/app/contract_rules.py`).
