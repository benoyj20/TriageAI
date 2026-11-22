# engine/

The private Python triage engine (FastAPI). Only the Go gateway calls it. The JSON it speaks is defined in [`contracts/`](../contracts/README.md).

## Run it

From the repo root:

```
pip install -r engine/requirements.txt -r engine/requirements-dev.txt
uvicorn engine.app.main:app --port 8000 --workers 1
```

Keep one worker: the burst detector keeps its window in memory.

Try it:

```
curl localhost:8000/healthz
curl -X POST localhost:8000/v1/triage -H "content-type: application/json" -d "{\"body\": \"Our VPN is down since 8am.\"}"
```

Run the tests from the repo root with `python -m pytest`.

## Layout and owners

| Path | What | Owner |
|---|---|---|
| `app/main.py` | HTTP endpoints, error envelope | Hriday |
| `app/schemas.py` | Contract v1 as Pydantic models | Hriday |
| `app/contract_rules.py` | Cross-field contract rules, used by the tests | Hriday |
| `app/pipeline.py` | Stage order, timing, failure fallbacks, gate wiring | Hriday |
| `app/state.py` | `TicketState`, the object every stage reads and writes | Hriday |
| `app/stubs.py` | Stand-in stages until the real ones land | (replaced by each owner) |
| `app/generate/` | Drafting, validator, LLM-free fallbacks | Hriday |
| `app/analyze/` | Language detection, classifier | ML engineer |
| `app/retrieval/` | Level-1 router, level-2 chunk search | ML engineer |
| `app/policy/` | Escalation gate, keywords, burst detector | Data analyst |

Imports always start from the repo root, for example `from engine.app.policy.gate import EscalationGate`.

## Pipeline

```
language -> global_search -> classify -> route_and_search -> draft -> validate -> gate
```

Every stage is `fn(state: TicketState) -> None`. It reads what earlier stages wrote and fills in its own part of `TicketState`, using the contract's JSON shapes (plain dicts). `pipeline.py` times each stage, validates the assembled response against the contract, and turns a stage that raises into a warning plus a safe fallback. One broken stage never fails the request; the gate sends the ticket to a human instead.

| Stage | Writes | Owner | Status |
|---|---|---|---|
| `language` | `state.language` | ML engineer | stub |
| `global_search` | `state.query_embedding`, `state.global_neighbours` (unfiltered top 10) | ML engineer | stub |
| `classify` | `state.classification` | ML engineer | stub |
| `route_and_search` | `state.retrieval`, `state.precedents`, `state.evidence` (full answers for the prompt) | ML engineer | stub |
| `draft` | `state.draft` (without `validation`), `state.llm_failed` | Hriday | stub |
| `validate` | `state.draft["validation"]`, `state.draft["citations"]` | Hriday | stub |
| `gate` | `state.gate`, `state.burst` | Data analyst | **real** |

`GET /healthz` lists which stages are still stubs. Stubs are deliberately honest: low confidence and no precedents, so every ticket goes to human review with a holding reply until the real stages are in.

## Replacing a stub with your stage

1. Write `fn(state)` in your folder, for example `engine/app/analyze/classify.py`.
2. In `pipeline.STAGES`, point that stage's `run` at your function. Keep its `fallback`.
3. Run `python -m pytest`. The API tests run real requests through the whole pipeline and check every response against the contract, so a wrong field name or shape fails right away with the exact path.
