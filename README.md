# SentinelDesk

Multilingual (English and German) incident triage, escalation and precedent-grounded reply drafting, built on the [`Tobi-Bueck/customer-support-tickets`](https://huggingface.co/datasets/Tobi-Bueck/customer-support-tickets) dataset.

**Demo video:** [youtu.be/UBkSEnIPQRM](https://youtu.be/UBkSEnIPQRM) · **Live app:** [gdg-sentinal.vercel.app](https://gdg-sentinal.vercel.app/)

For every incoming ticket (subject optional, body required) SentinelDesk:

1. **Classifies and prioritises:** type, queue and priority, each with a calibrated confidence.
2. **Gates it:** escalates to on-call, sends it to human review, or marks the draft ready, and says why.
3. **Retrieves precedents:** the 5 most similar resolved tickets from the 80% knowledge base.
4. **Drafts a grounded reply** in the customer's language that cites the past tickets it used as `[TKT-xxxxx]`, then checks the draft before anyone sees it.

## Results

All numbers are on the 20% holdout (**8,034 tickets**) that was never used for training, tuning or indexing. The deployed engine blends the classifier with the votes of the 5 nearest past tickets (`blend_weight` 0.5, tuned on `kb_val`).

| Target | Macro-F1, deployed (blend) | Accuracy | ECE | Macro-F1, classifier alone | ECE |
|---|---|---|---|---|---|
| Type (4 classes) | **0.894** | 0.891 | 0.059 | 0.859 | 0.008 |
| Priority (3) | **0.704** | 0.718 | 0.113 | 0.592 | 0.015 |
| Queue (10) | **0.639** | 0.655 | 0.129 | 0.528 | 0.012 |

The neighbour vote lifts every head by 4 to 11 points. Its votes are not calibrated, so the blended confidence is less calibrated than the classifier's on its own; the gate thresholds are tuned on the blended scores.

**High-priority incident recall** (1,462 true high-priority incidents in the holdout, deployed engine):

| Gate rule | Recall | Precision | Tickets sent to on-call |
|---|---|---|---|
| Live: predicted Incident and P(high) ≥ 0.26 | **0.870** | 0.534 | 29.7% |
| Recall-tuned: P(Incident) ≥ 0.15 and P(high) ≥ 0.26 | **0.934** | 0.436 | 39.0% |

The recall-tuned rule is one setting away (`"gate_incident_rule": true` in `thresholds.json`). Thresholds are tuned on `kb_val`, the last 10% of the knowledge base, never on the holdout. The classifier-alone numbers need no API key; the blended ones need the embedded knowledge base (`python -m ml.indexing.embed`, then `python -m ml.evaluate --blend`).

**Latency:** language detection 2.6 ms and classification 9.0 ms per ticket (p50, offline, one laptop). Retrieval and drafting depend on Redis and the LLM; the console shows the real time of every stage on every ticket.

**Leakage:** `python qa/audit_leakage.py` checks the real split: no shared ticket IDs or ticket text between KB and holdout, the inference inputs hold only `ticket_id, subject, body`, no holdout `answer` is saved anywhere, and the files match the checksums recorded at split time. Result: [`qa/LEAKAGE_AUDIT.md`](qa/LEAKAGE_AUDIT.md).

## How the brief maps to the code

| Requirement | Where |
|---|---|
| Multi-task triage with confidence | TF-IDF + logistic regression per head, temperature-calibrated: [`engine/app/analyze/classify.py`](engine/app/analyze/classify.py), trained by [`ml/train.py`](ml/train.py) |
| Holdout Macro-F1 and high-priority incident recall | [`ml/evaluate.py`](ml/evaluate.py), the only code that reads holdout labels |
| Exact 80/20 split, no leakage | [`ml/split.py`](ml/split.py) (`sample(frac=1.0, random_state=42)`, IDs `TKT-{i:05d}`), audited by [`qa/audit_leakage.py`](qa/audit_leakage.py) |
| Missing subjects | Treated as empty everywhere; covered by tests and [`contracts/examples/triage_request.no_subject.json`](contracts/examples/triage_request.no_subject.json) |
| Automatic language detection | [`engine/app/analyze/language.py`](engine/app/analyze/language.py) |
| Escalation and safety gate | [`engine/app/policy/gate.py`](engine/app/policy/gate.py): high-priority incident, low confidence, no precedent, unsupported request, plus security, outage, legal, prompt injection, language, ungrounded draft, degraded engine. Reason codes: [`contracts/reason_codes.md`](contracts/reason_codes.md) |
| Retrieval of top-k precedents | Hierarchical search in Redis (queue routing, then KNN inside the routed queues, global fallback): [`engine/app/retrieval/search.py`](engine/app/retrieval/search.py) |
| Grounded reply with citations, no invented policies | Prompt: [`engine/app/generate/prompt.py`](engine/app/generate/prompt.py). Validator (cited IDs must be retrieved, numbers must be in the evidence, language must match, one retry): [`engine/app/generate/validator.py`](engine/app/generate/validator.py) |
| Live triage console | React console. Landing page with two roles: **ticket creators** submit tickets, open each one to follow its status, and get *Similar issues, already solved* (past answers, translated into their language by the engine when needed) (`#/help`); **incident managers** get Overview, Board, ticket detail, a **Funnel** with pivots, Reports and **Live triage** (`#/lab`) for pasting any ticket: [`frontend/`](frontend/README.md) |
| Bonus: cross-lingual precedents | Multilingual embeddings; the prompt translates evidence into the reply language |
| Bonus: outage burst detection | [`engine/app/policy/burst.py`](engine/app/policy/burst.py) and the major-incident banner |
| Bonus: PII guardrail | The Go gateway masks emails, phones, IPs, IBANs, cards and account numbers before the engine or any LLM sees the text: [`backend/internal/pii`](backend/internal/pii) |

## Architecture

```
React console ──► Go gateway :8080 ──► Python engine :8000 (private) ──► Redis (private)
                  validate, rate limit,  language → embed → classify →     KB index, HNSW cosine
                  mask PII, timing       route + search → draft →        ──► OpenAI, then Gemini
                                         validate → gate + burst check
```

| Part | Choice |
|---|---|
| Console | React + Vite, Tailwind, Recharts |
| Gateway | Go 1.22, standard library |
| Engine | Python, FastAPI |
| Vector store | Redis Query Engine, HNSW cosine, 768 dims |
| Embeddings | OpenAI `text-embedding-3-small` (Gemini `gemini-embedding-2` without an OpenAI key) |
| Drafts | OpenAI `gpt-5.4-mini`, then Gemini, then an extractive fallback |
| Deploy | Docker Compose on AWS EC2, artifacts in Cloudflare R2 |

More detail: [`docs/architecture-diagram.md`](docs/architecture-diagram.md), [`docs/system-architecture-and-stack-guide.md`](docs/system-architecture-and-stack-guide.md), the API contract in [`contracts/`](contracts/README.md), and the original plan in [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).

## Run it

Prerequisites: Node 20+, Go 1.22+, Python 3.11+, Docker (for Redis).

**Console + gateway, no keys** (the gateway answers with the contract's example responses):

```
cd frontend && npm install && npm run build
cd ../backend && go run ./cmd/api          # http://localhost:8080
```

**Full pipeline:**

```
cp infra/env.template .env                 # fill in OPENAI_API_KEY and REDIS_PASSWORD
pip install -r requirements.txt
docker compose --env-file .env -f infra/docker-compose.dev.yml up -d     # Redis Stack
python -m ml.split                         # download the dataset (pinned revision), make the split
python -m ml.train                         # classifier, calibration, thresholds
python -m ml.indexing.embed                # embed the KB (needs the key)
python -m ml.indexing.build_index --url redis://:<REDIS_PASSWORD>@localhost:6379
uvicorn engine.app.main:app --port 8000 --workers 1
cd backend && MOCK_ENGINE=false go run ./cmd/api
```

Production deploy (EC2, Caddy for TLS): [`infra/README.md`](infra/README.md) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Evaluation

```
pip install -r requirements.txt
python -m ml.split                  # 32,133 KB / 8,034 holdout
python -m ml.train
python -m ml.evaluate               # writes ml/artifacts/reports/v1/metrics.json
python qa/audit_leakage.py          # writes qa/LEAKAGE_AUDIT.md
python analytics/export_model_insights.py   # updates the Reports page
```

`python -m ml.evaluate --blend` adds the retrieval vote once the KB is embedded. `python -m ml.latency` measures per-stage latency. `python qa/run_golden_set.py --endpoint <host>/api/v1/triage` runs the 30 golden tickets through a running stack.

## Tests

```
python -m pytest                    # engine + ML (one test needs a live Redis)
cd backend && go test ./...
cd frontend && npm test
```

## Repository

| Folder | What | Owner |
|---|---|---|
| `frontend/` | React console | Full-stack dev |
| `backend/` | Go gateway, PII guardrail, rate limit | Full-stack dev |
| `engine/` | Python engine: pipeline, generation, gate | Hriday (pipeline, generation), Data analyst (`policy/`), ML engineer (`analyze/`, `retrieval/`) |
| `ml/` | Split, training, indexing, evaluation | ML engineer |
| `analytics/` | EDA and Reports data | Data analyst |
| `contracts/` | API contract v1 (frozen) | Hriday |
| `infra/` | Docker, deploy, Redis | Hriday |
| `qa/` | Test plan, golden set, leakage audit, judge Q&A | QA |
| `docs/` | Architecture, demo script, build plan | |

Data, splits, embeddings and models are never committed; they live in `ml/artifacts/` (gitignored) and in R2. The dataset is CC BY-NC 4.0.
