# ml/ — split, classifiers, RAG index (ML-01..14, DA-03/04/05)

Run from the repo root (`pip install -r ml/requirements.txt`). Artifacts go to `ml/artifacts/` (gitignored; mirrors the R2 layout).

| Step | Command | Task |
|---|---|---|
| 1. Split (downloads 3 public CSVs from the pinned HF revision) | `python -m ml.split` | ML-02/03/04 |
| 2. Embed KB + test inputs (`OPENAI_API_KEY` or `GEMINI_API_KEY`, OpenAI first; `--backend hash` for offline) | `python -m ml.indexing.embed` | DA-03 |
| 3. Train, calibrate, tune priority threshold | `python -m ml.train` | ML-05/09/10 |
| 4. Retrieval-vote blend weight | `python -m ml.tune_blend` | ML-08 |
| 5. Hierarchical retrieval quality, routing weight, similarity threshold | `python -m ml.indexing.retrieval_quality` | ML-14 |
| 6. Load Redis (idx:chunks + queue nodes), snapshot | `python -m ml.indexing.build_index --url redis://:<pw>@localhost:6379 --snapshot` | ML-08 |
| 7. Holdout metrics (only reader of test labels) | `python -m ml.evaluate --blend` | ML-11 |
| 8. Latency | `python -m ml.latency` | ML-12 |

Offline check: `python -m pytest ml/tests -q` (synthetic data, hash embeddings; the live Redis test runs only when `REDIS_URL` points at a Redis Stack).

## RAG index (Redis, per [docs/BUILD_PLAN.md](../docs/BUILD_PLAN.md#hierarchical-rag))
- **Level 2:** one hash per ticket, `chunk:<ticket_id>`, indexed by `idx:chunks` (HNSW, cosine, 768d). Fields: ticket_id, queue, type, priority, subject, body, tags (csv), language, answer, queried_count, vector_embedding (+ `precedent`).
- **Level 1:** one hash per queue, `queue:<slug>` (centroid vector, chunk_count, type_mix, top_tags). Built from KB chunks only.
- **German topic rows** have no answer or type: stored under queue `Miscellaneous` with `precedent=0`; every citation search filters `@precedent:{1}` and routing skips that node.
- **Search** (`engine/app/retrieval/search.py`): global top-10 → route (α·classifier prob + (1−α)·centroid cosine, α 0.6 by default, 0.75 as tuned in `thresholds.json` `route_alpha`; top-2 queues, or top-1 if ≥ 0.80) → filtered KNN k=5 → global fallback if routed top-1 is below `min_top1_similarity` or > 0.05 under global top-1.
- **queried_count:** atomic `HINCRBY` on returned chunks and their queue nodes, only with `count=True`. Eval, benchmark and golden runs use `count=False` (`UPDATE_QUERIED_COUNT=false`). Telemetry only, no ranking effect.

## Results (ML-18)

Holdout of **8,034** tickets (20% of 40,167 de-duplicated rows; KB 32,133, of which 3,214 are `kb_val`). Reproduce with steps 1, 3 and 7 above (no API key needed); `qa/audit_leakage.py` then checks the split. Classifier only (`blend_weight` 0); the neighbour-vote blend needs the embedded KB.

| Target | Macro-F1 | Accuracy | ECE |
|---|---|---|---|
| type (4) | 0.859 (blend: **0.894**) | 0.849 (0.891) | 0.008 (0.059) |
| priority (3) | 0.592 (blend: **0.704**) | 0.605 (0.718) | 0.015 (0.113) |
| queue (10) | 0.528 (blend: **0.639**) | 0.531 (0.655) | 0.012 (0.129) |

**High-priority incident recall** (1,462 true high-priority incidents):

| Rule | Recall | Precision | Share of tickets flagged |
|---|---|---|---|
| Gate default: argmax type = Incident and P(high) >= 0.26 | 0.760 (blend: **0.870**) | 0.514 (0.534) | 26.9% (29.7%) |
| Recall-tuned: P(Incident) >= 0.15 and P(high) >= 0.26 (`gate_incident_rule: true`) | 0.858 (blend: **0.934**) | 0.438 (0.436) | 35.7% (39.0%) |

Thresholds are tuned on `kb_val` (recall target 0.90; the tuned rule reached 0.904 there). Per-class F1: type Request 0.99, Change 0.97, Incident 0.82, Problem 0.66; priority high 0.64, medium 0.61, low 0.52. Queue labels overlap heavily, which is why low confidence goes to a person.

**Method:** TF-IDF on word and character n-grams of subject + body, one logistic regression per head, temperature scaling on `kb_val` (ECE on kb_val before → after: queue 0.057 → 0.022, priority 0.020 → 0.012, type 0.014 → 0.012). Offline latency on a laptop (300 tickets, p50): language 2.6 ms, classify 9.0 ms.
