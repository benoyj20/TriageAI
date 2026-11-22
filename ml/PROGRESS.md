# ML engineer + indexing: progress and what is still blocked

Status as of 2026-11-21. Owner: ML engineer (ML-01..18 in the current README; formerly ML-01..14 + DA-03/04/05).
Everything lives in `ml/` and `engine/app/{analyze,retrieval}/`, and is merged to main. The blockers below were cleared later (the live index uses OpenAI embeddings); final holdout numbers are in [`README.md`](README.md#results-ml-18).

## Why some steps are not done
| Blocker | What it stops |
|---|---|
| No `GEMINI_API_KEY` in the environment | Real embeddings (KB, German rows, test inputs, live queries) and everything downstream that needs vectors |
| No Redis Stack running locally (Docker Desktop is off, image `redis/redis-stack` not pulled) | Loading the index, the live retrieval test, latency of retrieval, the RDB snapshot |

The hash embedder (`EMBED_BACKEND=hash`) is for tests only. It is not semantic, so no retrieval metric from it is reported.

## Done and verified
| Task | What exists | Verified how |
|---|---|---|
| ML-01 environments | `ml/requirements.txt` (pandas, numpy, scikit-learn, joblib, langdetect, huggingface_hub, redis, google-genai, pytest) | Installed in a scratchpad venv, Python 3.14 |
| ML-02 load + inspect | `ml/data.py`, label report in `split_manifest.json` | **Run on real data** (below) |
| ML-03 lock split | `ml/split.py`: `sample(frac=1.0, random_state=42)`, IDs `TKT-{i:05d}`, first 80% KB, last 10% of KB = `is_val` | **Run on real data**; determinism and leak checks in tests |
| ML-04 clean + normalise | `clean_text`, `build_text` (`engine/app/analyze/textproc.py`, shared with serving), priority map to high/medium/low | Tests |
| ML-06 language detection | `engine/app/analyze/language.py` (en / de / other, stopword fallback for short text) | Tests (en, de, fr, empty) |
| ML-11 holdout scorer | `ml/evaluate.py` (only reader of `test_labels.csv`; macro-F1, accuracy, ECE, high-priority incident recall) | **Run on real data** (classifier only; `--blend` needs embeddings) |
| Retriever (ML-10) logic | `engine/app/retrieval/{schema,search}.py`: global top-10, routing 0.6 classifier + 0.4 centroid, top-2 queues or top-1 at >= 0.80, filtered KNN k=5, global fallback, `tag_escape()`, atomic `HINCRBY` | Pure helpers tested. The Redis calls are **untested against a live server** |
| Hierarchy builder (ML-08) logic | `ml/indexing/hierarchy.py` (queue nodes: centroid, chunk_count, type_mix, top_tags), `build_index.py` (FT.CREATE per README, loads chunks, waits for indexing, `BGSAVE`) | Node logic tested; Redis load **untested** |
| Offline retrieval twin | `ml/indexing/offline.py` (numpy flat top-k, vote matrix, `hier_search` with the same routing/fallback rules) | Tests |

### Real-data results so far
- Files (pinned HF revision `ddf1c81a...`): primary 50-version CSV, 20k CSV, German-normalised CSV.
- Unique rows after deduping on normalised body: **40,167** (primary + extra rows from the 20k file).
- Split: **KB 32,133** (of which **kb_val 3,214**), **test 8,034**. German topic file: **10,542** rows kept as the 80% KB (no answers, never precedents).
- **Training finished** (28,919 train / 3,214 val; TF-IDF word+char, logistic regression, temperature-calibrated on kb_val).
- **Holdout (8,034 test tickets, classifier only, no retrieval blend yet):**

| Target | Macro-F1 | Accuracy | ECE |
|---|---|---|---|
| type | **0.859** | 0.849 | 0.008 |
| queue (10 classes) | **0.529** | 0.531 | 0.012 |
| priority | **0.592** | 0.605 | 0.012 |

  Per-class F1: type Request 0.99, Change 0.97, Incident 0.82, Problem 0.66; queue best Billing 0.78, Service Outages 0.66, the rest 0.44-0.56; priority high 0.64, medium 0.61, low 0.52.
- **High-priority incident recall** (true Incident and high priority, 1,462 test tickets): **0.856** at precision 0.438 and a 35.6% flag rate, using the tuned rule P(Incident) >= 0.15 and P(high) >= 0.26. On kb_val the same rule reached 0.902 (target 0.90), so expect about 4-5 points of generalisation gap.
- Calibration works: ECE is 0.008-0.012 on the holdout. Queue and priority are weak because the labels are noisy and overlap heavily. Queue should improve once the retrieval-vote blend is available (it needs embeddings).

### Gate rule finding (for the data analyst, `engine/app/policy/gate.py`)
`gate.py` fires HIGH_PRIORITY_INCIDENT when `pred_type == "incident"` and `P(high) >= 0.38`. With the argmax-type condition, recall on the holdout is only **0.759** at precision 0.514, and no P(high) threshold can reach 0.90 because argmax Incident already misses about 15% of true incidents. Recommended change: fire when `incident_prob >= 0.15` and `P(high) >= 0.26` (both written to `models/v1/thresholds.json` as `incident_threshold` and `priority_high_threshold`, and returned by `Classifier.predict`). I did not edit `gate.py` since it is not an ML file.

## Not done (blocked or waiting)
Run in this order once the blockers are cleared. All commands are in `ml/README.md`.

1. ~~Training and classifier-only holdout evaluation~~ (done above). Re-tune thresholds without retraining via `python -m ml.train --retune-only`.
2. **ML-07 embed KB** (needs `GEMINI_API_KEY`): `python -m ml.indexing.embed`. About 32.1k KB + 10.5k German + 8k test inputs, `gemini-embedding-2`, 768 dims, checkpoint every 2,000 rows, resumable. Turn on Gemini billing first (README risk list).
3. **ML-11 retrieval-vote blend** (needs embeddings): `python -m ml.tune_blend` sets `blend_weight` in `thresholds.json`. Until then it is 0 (classifier only).
4. **ML-14 retrieval quality** (needs embeddings): `python -m ml.indexing.retrieval_quality`. Produces flat vs hierarchical useful@1, agreement@5, routing accuracy, fallback rate, the best routing weight and `min_top1_similarity` (written as `retrieval_threshold`). The gate (DA-03) reads that threshold for NO_PRECEDENT.
5. **ML-08 load Redis + snapshot** (needs embeddings and Redis Stack): start `redis/redis-stack` with `requirepass`, then `python -m ml.indexing.build_index --url redis://:<pw>@localhost:6379 --snapshot`. Check `INFO memory` after loading. Copy `dump.rdb` to R2 as `redis/dump_v1.rdb` (infra step, Benoy).
6. **Live Redis test**: `REDIS_URL=... python -m pytest ml/tests/test_search.py` (currently skipped).
7. **ML-16 latency** (needs key and Redis): `python -m ml.latency`. Retrieval latency is skipped without Redis.
8. **ML-15 final holdout** with blend: `python -m ml.evaluate --blend`.
9. **ML-18**: paste the metrics and method into `ml/README.md`.

ML-09/12/13 (classify stage, temperature calibration, priority/incident thresholds) are implemented in `train.py` / `classify.py` and measured above. ML-17 generation audit needs Benoy's generator and QA. Wiring `Classifier` and `retrieve()` into `engine/app/pipeline` is Benoy's file.

## Design decisions and where they differ from the README
- **Two-level hierarchy only** (queue, chunk) as the README says. Type and priority are TAG fields, not tree levels. This replaces the deeper queue -> type -> priority tree discussed earlier; SX-03 (third level) is the stretch for that.
- **Data:** deduped 40,167 rows, not the README's "about 49,400 chunks" (that figure matches all 61,765 rows concatenated, which double-counts overlapping rows and mixes in German rows with no answers).
- **`precedent` TAG added** to the chunk hash and index. German rows get queue `Miscellaneous`, `precedent=0`; every citation search filters `@precedent:{1}` and routing skips that node. Benoy should know, since it extends the field list in the README.
- **Queue nodes also hold `queried_count`**, bumped with the chunks. Telemetry only.
- **`queried_count`** increments only when `count=True`. Eval, benchmark and golden runs use `count=False` (`UPDATE_QUERIED_COUNT=false`). It does not affect ranking.
- **Shared Gemini client:** the README plans one in `engine/app/common` (H-07). Until it exists, `engine/app/analyze/embedder.py` is the single embedder for KB and live queries (same settings, vectors re-normalised after truncation). The README's `PYTHONPATH=engine` convention may need the imports adjusted when H-07 lands.
- **Leakage rules kept:** `test_inputs.csv` holds only `ticket_id, subject, body`; `test_labels.csv` has no `answer`; calibration and thresholds use `kb_val` only.

## File map
**`ml/`**: `config.py`, `data.py`, `split.py`, `train.py`, `tune_blend.py`, `evaluate.py`, `latency.py`, `metrics.py`, `README.md`, `PROGRESS.md`, `requirements.txt`, `tests/{conftest,test_pipeline,test_search}.py`
**`ml/indexing/`**: `embed.py`, `hierarchy.py`, `build_index.py`, `retrieval_quality.py`, `offline.py`
**`engine/app/analyze/`**: `textproc.py`, `features.py`, `language.py`, `classify.py`, `embedder.py`
**`engine/app/retrieval/`**: `schema.py`, `search.py`
**Repo root**: `.gitignore` (ignores `ml/artifacts/`, `.venv/`)
Artifacts (CSVs, splits, models) are written to `ml/artifacts/` and are never committed; they belong in R2.

## Tests
`python -m pytest ml/tests -q`: 10 pass, 1 skipped (live Redis). Synthetic tickets, hash embeddings, no network.
