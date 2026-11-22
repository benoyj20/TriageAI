# SentinelDesk: 5-hour build plan (historical)

The plan the team built from. For what was built, how to run it and the results, see the [root README](../README.md).

Multilingual (EN/DE) incident triage, escalation gate and precedent-grounded reply drafts, built on the `Tobi-Bueck/customer-support-tickets` dataset.

## Stack (locked)

| Part | Choice |
|---|---|
| Frontend | React + Vite (JavaScript), Tailwind, Recharts |
| Gateway | Go 1.22+ (stdlib `ServeMux`): validation, PII masking, timing |
| Engine | Python FastAPI: language detection, classify, retrieve, gate, draft, validate |
| Vector DB | **Redis** with the Query Engine (RediSearch), self-hosted in Docker on the AWS EC2 box. HNSW cosine index over chunk hashes (level 2) plus queue-node hashes (level 1). Fallback: FAISS loaded from the embeddings parquet |
| Retrieval | **Hierarchical RAG**: queue first, then chunks inside it, with a global fallback when routing is unsure |
| Embeddings | **OpenAI** `text-embedding-3-small` at 768 dims (Gemini `gemini-embedding-2` if there is no OpenAI key). One provider per index, same settings for KB and live queries |
| Draft model | **OpenAI** `gpt-5.4-mini` first (`OPENAI_GEN_MODEL`), Gemini `gemini-3.1-flash-lite` (`GEN_MODEL`) if OpenAI fails or has no key |
| Classifier | TF-IDF + logistic regression, blended with retrieval votes, temperature-calibrated |
| Storage | Cloudflare R2 for raw CSV, splits, embeddings, models, Redis RDB snapshot, reports |
| Deploy | AWS EC2 + docker-compose. **Hriday only** |

Why Redis:
- One container, the same on laptops and on EC2. Only the Python engine and the ML jobs talk to it; the Go gateway never does.
- Each chunk is a hash with TAG fields (queue, type, language), so the level-2 search is one filtered KNN query inside the routed queues.
- `HINCRBY` makes the `queried_count` update atomic.
- An RDB snapshot goes to R2 and restores by dropping the file in the data folder.
- RedisInsight (shipped in the `redis/redis-stack` image) is the debugging dashboard.
- Trade-offs: everything lives in memory (about 150 MB of raw vectors for the ~49k chunks; budget under 1 GB with the HNSW graph and text, which a t3.large handles easily), and the port must never be public.

## Flow

React console → Go gateway (validate, mask PII) → Python engine → language → embed query → classify → level-1 route to queue(s) → level-2 chunk search inside them (global fallback) → gate → grounded draft → validate citations and numbers → final gate + burst check.

## Hierarchical RAG

Not a flat index. **Level 1** is the queue, **level 2** is the ticket chunks inside it.

```
Knowledge base (about 49,400 chunks)
├── Queue "Technical Support"   node = centroid vector + chunk count
│   ├── chunk TKT-00012         queue, type, priority, subject, body, tags,
│   ├── chunk TKT-00047         language, answer, queried_count, vector_embedding
│   └── …
├── Queue "Billing and Payments"
├── Queue "IT Support"
└── … (queue list comes from the data)
```

**Chunk fields**

| Field | Redis hash field, index | Notes |
|---|---|---|
| ticket_id | `ticket_id`, TAG (the key is `chunk:<ticket_id>`) | Added to the list: drafts must cite `[TKT-xxxxx]` |
| queue | `queue`, TAG | Level-1 parent, routing and filter key |
| type | `type`, TAG | Incident, Request, Problem, Change |
| priority | `priority`, TAG | high, medium, low |
| subject | `subject`, not indexed | Empty string when missing, never null |
| body | `body`, not indexed | Cleaned text; about 6,000 characters embedded |
| tags | `tags`, TAG, comma-separated | Redis hashes are flat, so tag_1..tag_8 (nulls removed) are stored as `a,b,c` |
| language | `language`, TAG | en or de |
| answer | `answer`, not indexed | KB tickets only, never the test split |
| queried_count | `queried_count`, NUMERIC | Starts at 0, +1 (atomic `HINCRBY`) each time returned as a precedent. Telemetry only; not used for ranking in the MVP; frozen during evaluation |
| vector_embedding | `vector_embedding`, VECTOR HNSW, FLOAT32, 768, COSINE | Embedding of subject + body, never the answer. Stored as raw float32 bytes |

**Redis layout**

```
# Level 2: one hash per ticket
HSET chunk:TKT-00012 ticket_id TKT-00012 queue "Technical Support" type Incident priority high
     subject "..." body "..." tags "vpn,network" language de answer "..." queried_count 0
     vector_embedding <768 float32 bytes>

FT.CREATE idx:chunks ON HASH PREFIX 1 chunk: SCHEMA
  ticket_id TAG  queue TAG  type TAG  priority TAG  language TAG
  tags TAG SEPARATOR ","  queried_count NUMERIC SORTABLE
  vector_embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 768 DISTANCE_METRIC COSINE

# Level 1: one hash per queue (a handful; loaded into memory at boot, no index needed)
HSET queue:technical_support queue "Technical Support" chunk_count 9120
     type_mix "{...}" top_tags "..." vector_embedding <centroid float32 bytes>

# Level 2 search inside the routed queues
FT.SEARCH idx:chunks "(@queue:{Technical\ Support|IT\ Support})=>[KNN 5 @vector_embedding $q AS dist]"
  PARAMS 2 q <query bytes>  SORTBY dist  DIALECT 2

# Global search (fallback and classifier votes)
FT.SEARCH idx:chunks "*=>[KNN 10 @vector_embedding $q AS dist]" PARAMS 2 q <query bytes> SORTBY dist DIALECT 2
```

**Redis gotchas**
- Redis returns cosine **distance**. Similarity = 1 − dist. The thresholds in `policy.yaml` are similarity values.
- Spaces and punctuation in TAG filter values must be escaped (`Technical\ Support`). Write one `tag_escape()` helper in `retrieval/search.py` with a unit test.
- When tuning on kb_val, ask for k+1 results and drop the ticket's own ID in Python.
- Run the `redis/redis-stack` image (or Redis 8 with the Query Engine), pinned to one version, with `requirepass`, on the Docker network only. Port 6379 is never opened in the EC2 security group.

**Retrieval flow per ticket**

1. Embed the query once (same model and settings as the KB).
2. Global top-10 search over all chunks. Feeds the classifier's neighbour vote and is the fallback result.
3. Classify (TF-IDF + neighbour vote) to get queue probabilities.
4. **Level 1, route:** score each queue as 0.6 × classifier probability + 0.4 × cosine to the queue centroid (starting weights, tuned on kb_val). Keep the top 2 queues, or only the top 1 if it scores at least 0.80.
5. **Level 2, search:** Redis KNN search filtered to the routed queues (`@queue:{...}`), k = 5.
6. **Fallback:** if the routed top-1 similarity is below `min_top1_similarity`, or more than 0.05 under the global top-1, use the global results and set `fallback_global`. If those are weak too, the gate adds NO_PRECEDENT.
7. After the response, `HINCRBY chunk:<id> queried_count 1` on the returned chunks, pipelined, in the background.

**Decisions**
- One chunk is one ticket (bodies are short, no splitting).
- Queue centroids are built from KB chunks only.
- Queue votes use the unfiltered search, since filtered results only echo the routed queue.
- ML reports flat vs hierarchical agreement@5, routing accuracy and latency. It answers "why hierarchical?" in Q&A.
- Evaluation runs with `UPDATE_QUERIED_COUNT=false`.

## Team and folders

| Person | Role | Owns |
|---|---|---|
| Hriday | Lead, Python engine API, RAG drafting, **all deploys** | `contracts/`, `infra/`, `engine/app/{main,pipeline,common,generate}` |
| Full-stack dev | React console, Go gateway, PII guardrail | `frontend/`, `backend/` |
| Data analyst | EDA, escalation policy, burst detection, Insights charts | `analytics/`, `engine/app/policy/`, `frontend/src/features/insights/` |
| ML engineer | Split, classifiers, hierarchical RAG index and retrieval, evaluation | `ml/`, `engine/app/{analyze,retrieval}/` |
| QA | Test plan, golden set, audits, demo script (no code) | `qa/`, `docs/demo-script.md` |

Rules:
- Commit only inside your own folders.
- `git pull --rebase` every 30 minutes; push small commits.
- Contract changes go through Hriday. The API contract (v1, frozen) is in [`contracts/`](../contracts/README.md).
- Never commit `.env`, data or model files. They live in R2.
- Run Python from the repo root and import engine code from there, for example `from engine.app.common.gemini import embed_texts`. Tests: `python -m pytest`.

## Timeline

| Time | Phase | Check-in |
|---|---|---|
| 0:00–0:25 | Kickoff and contracts | Repo, contract, keys, local Redis exist |
| 0:25–1:30 | Foundations | **Sync 1 (1:30):** mock UI through Go, split in R2, KB embedded and hierarchy loaded in Redis, first macro-F1, skeleton live on AWS |
| 1:30–3:00 | Core build | **Sync 2 (3:00):** real pipeline end to end |
| 3:00–4:00 | Integrate, evaluate, bonus | **Sync 3 (4:00):** deployed v2, golden-set pass rate, holdout metrics, cut scope |
| 4:00–4:30 | Harden and freeze | Final deploy by 4:15, **code freeze 4:20** |
| 4:30–5:00 | Demo prep | Rehearsal 1 at 4:30, rehearsal 2 at 4:45, demo at 5:00 |

## Tasks

### Everyone
- [ ] ALL-01 Kickoff: walk the plan, the contract and folder ownership (**critical**) · 0:00–0:25
- [ ] ALL-02 Code freeze at 4:20 (**critical**) · 4:00–4:30
- [ ] ALL-03 Rehearsal 1 at 4:30, timed (**critical**) · 4:30–5:00
- [ ] ALL-04 Rehearsal 2 at 4:45, then submit (**critical**) · 4:30–5:00

### Hriday
- [ ] H-01 Create the repo and folder skeleton · 0:00–0:25
- [ ] H-02 Freeze API contract v1 (**critical**) · 0:00–0:25
- [ ] H-03 API keys, billing and the R2 bucket (**critical**) · 0:00–0:25
- [ ] H-04 Local Redis (Redis Stack) via docker-compose · 0:00–0:25
- [ ] H-05 Engine skeleton and pipeline stubs (**critical**) · 0:25–1:30
- [ ] H-06 Engine settings, Pydantic schemas and R2 artifact loader (**critical**) · 0:25–1:30
- [ ] H-07 Shared Gemini client (embed and generate) (**critical**) · 0:25–1:30
- [ ] H-08 Walking-skeleton deploy on AWS (deploy, Hriday only) · 0:25–1:30
- [ ] H-09 Draft generation with Gemini (**critical**) · 1:30–3:00
- [ ] H-10 Grounding prompt (**critical**) · 1:30–3:00
- [ ] H-11 Draft validator (**critical**) · 1:30–3:00
- [ ] H-12 Degraded mode when the LLM fails · 1:30–3:00
- [ ] H-13 Wire the real pipeline: orchestration, timeouts, per-stage timing (**critical**) · 1:30–3:00
- [ ] H-14 Engine health, readiness and structured logs · 1:30–3:00
- [ ] H-15 Deploy v2 with the real pipeline (**critical**, deploy, Hriday only) · 3:00–4:00
- [ ] H-16 Run the 3:00 integration sync and cut scope · 3:00–4:00
- [ ] H-17 queried_count tracking and most-queried endpoint · 3:00–4:00
- [ ] H-18 Engine tests (pytest) · 3:00–4:00
- [ ] H-19 Final production deploy (**critical**, deploy, Hriday only) · 4:00–4:30
- [ ] H-20 Top-level README · 4:00–4:30

### Full-stack dev
- [ ] FS-01 Scaffold the React app · 0:00–0:25
- [ ] FS-02 Go gateway skeleton (**critical**) · 0:25–1:30
- [ ] FS-03 Mock mode so the UI is never blocked · 0:25–1:30
- [ ] FS-04 App shell with a health indicator · 0:25–1:30
- [ ] FS-05 Ticket input panel · 0:25–1:30
- [ ] FS-06 API client with timeouts and readable errors · 0:25–1:30
- [ ] FS-07 Classification cards and the escalation badge · 0:25–1:30
- [ ] FS-08 Point the gateway at the real engine (**critical**) · 1:30–3:00
- [ ] FS-09 Precedents panel with routing path · 1:30–3:00
- [ ] FS-10 Draft panel · 1:30–3:00
- [ ] FS-11 Latency strip · 1:30–3:00
- [ ] FS-12 Integrate with the real gateway (**critical**) · 1:30–3:00
- [ ] FS-13 Major-incident banner and ‘Simulate outage’ button (bonus) · 3:00–4:00
- [ ] FS-14 History drawer · 3:00–4:00
- [ ] FS-15 PII guardrail in the Go gateway (bonus) · 3:00–4:00
- [ ] FS-16 Go: serve the built frontend and the Insights JSON · 3:00–4:00
- [ ] FS-17 Go: rate limit on the triage endpoint (bonus) · 3:00–4:00
- [ ] FS-18 Insights tab shell and shared chart components · 3:00–4:00
- [ ] FS-19 Polish and edge states · 4:00–4:30

### Data analyst
- [ ] DA-01 Pull the raw CSV and open the EDA notebook · 0:00–0:25
- [ ] DA-02 EDA with exports for the Insights tab · 0:25–1:30
- [ ] DA-03 Escalation gate (engine/app/policy/gate.py) (**critical**) · 1:30–3:00
- [ ] DA-04 Keyword lists for injection, money, security and legal (EN + DE) · 1:30–3:00
- [ ] DA-05 Outage burst detector (bonus) · 3:00–4:00
- [ ] DA-06 Insights exports: model and operations · 3:00–4:00
- [ ] DA-07 Insights charts in React (with Full-stack) · 3:00–4:00
- [ ] DA-08 Hierarchy explorer in Insights · 3:00–4:00
- [ ] DA-09 Slide visuals and architecture diagram · 4:00–4:30

### ML engineer
- [ ] ML-01 Python environments for ml/ and engine/ · 0:00–0:25
- [ ] ML-02 Load the exact dataset file and inspect the labels (**critical**) · 0:25–1:30
- [ ] ML-03 Lock the 80/20 split exactly as the brief specifies (**critical**) · 0:25–1:30
- [ ] ML-04 Clean text and normalise labels · 0:25–1:30
- [ ] ML-05 Baseline classifiers for type, queue and priority (**critical**) · 0:25–1:30
- [ ] ML-06 Language detection · 0:25–1:30
- [ ] ML-07 Build the chunks and embed the knowledge base (**critical**) · 0:25–1:30
- [ ] ML-08 Build the hierarchy in Redis (index, queue nodes) and snapshot it (**critical**) · 0:25–1:30
- [ ] ML-09 Engine: real classify stage (**critical**) · 1:30–3:00
- [ ] ML-10 Engine: hierarchical retriever (router and chunk search) (**critical**) · 1:30–3:00
- [ ] ML-11 Retrieval-vote ensemble · 1:30–3:00
- [ ] ML-12 Confidence calibration · 1:30–3:00
- [ ] ML-13 Priority threshold tuned for high-priority recall (**critical**) · 1:30–3:00
- [ ] ML-14 Hierarchical retrieval quality, routing and thresholds (**critical**) · 1:30–3:00
- [ ] ML-15 Holdout evaluation script (**critical**) · 3:00–4:00
- [ ] ML-16 Latency benchmark · 3:00–4:00
- [ ] ML-17 Generation audit sample (with QA) · 3:00–4:00
- [ ] ML-18 README: metrics and method · 4:00–4:30

### QA
- [x] QA-01 Bug tracker, labels and the shared test sheet · 0:00–0:25
- [x] QA-02 Golden test set: 30 unseen tickets with expected outcomes (**critical**) · 0:25–1:30
- [x] QA-03 Test plan · 0:25–1:30
- [x] QA-04 Review the contract from the operator’s side · 0:25–1:30
- [x] QA-05 Test the deployed mock UI · 1:30–3:00
- [x] QA-06 Hallucination audit rubric · 1:30–3:00
- [x] QA-07 Run the golden set on the real pipeline (**critical**) · 3:00–4:00
- [x] QA-08 Score 15 drafts with the hallucination rubric · 3:00–4:00
- [x] QA-09 Leakage audit sign-off · 3:00–4:00
- [x] QA-10 Demo script draft · 3:00–4:00
- [x] QA-11 Final regression and backup video (**critical**) · 4:00–4:30
- [x] QA-12 Judge Q&A sheet · 4:00–4:30

### Stretch (only if ahead)
- [ ] SX-01 Stream results with server-sent events (Hriday)
- [ ] SX-02 Hybrid retrieval (ML engineer)
- [ ] SX-03 Third level and popularity prior (ML engineer)
- [ ] SX-04 Ticket map (Data analyst)
- [ ] SX-05 Operator feedback on drafts (Full-stack)
- [ ] SX-06 Fine-tuned multilingual encoder (ML engineer)
- [ ] SX-07 Cost per ticket (Hriday)

## Escalation gate

Any P1 reason → **ESCALATE_ONCALL**. Else any P2 reason → **HUMAN_REVIEW**. No reasons → **AUTO_DRAFT**. All matching reasons are returned.

| Code | Severity | Fires when |
|---|---|---|
| HIGH_PRIORITY_INCIDENT | P1 | Type is Incident and P(high) is above the recall-tuned threshold |
| SECURITY_INCIDENT | P1 | Breach, ransomware, hacked terms (EN/DE) |
| ACTIVE_OUTAGE | P1 | Ticket joins an active burst cluster |
| LEGAL_OR_COMPLIANCE | P2 | Lawyer, lawsuit, GDPR/DSGVO, deletion requests |
| PROMPT_INJECTION | P2 | Injection patterns in subject or body |
| NO_PRECEDENT | P2 | Top-1 similarity below threshold |
| LOW_CONFIDENCE | P2 | Calibrated confidence below floor |
| UNSUPPORTED_REQUEST | P2 | Refund, compensation, pricing, contract terms, or model flags it |
| UNGROUNDED_DRAFT | P2 | Validator still fails after one retry |
| UNSUPPORTED_LANGUAGE | P2 | Language is not English or German |
| ENGINE_DEGRADED | P2 | LLM failed; extractive fallback used |

## Data and leakage rules

- Use the brief's split exactly: `sample(frac=1.0, random_state=42)`, IDs `TKT-{i:05d}`, first 80% is the KB.
- Only the 80% KB gets indexed or trained on. `kb_val` (last 10% of KB) is used for tuning and calibration.
- The 20% test set keeps only `ticket_id`, `subject`, `body` for inference. Its `answer` column is dropped and never saved. Labels are read only by the final scorer.
- Some dataset copies have 5 priority levels. Map them to high/medium/low and document the mapping.
- Queue centroids and chunks are built from the KB split only. `queried_count` updates are off during evaluation.

## R2 layout

```
sentineldesk-artifacts/
  raw/        original CSV
  splits/v1/  kb_train, test_inputs, test_labels, split_manifest.json
  embeddings/v1/  kb_768, test_768
  models/v1/  classifiers, labels, calibration, thresholds
  redis/      dump_v1.rdb (chunks, queue nodes, index definitions)
  reports/v1/ metrics, latency, insights JSON
```

## Ports

5173 React dev, 8080 Go gateway, 8000 Python engine (private), 6379 Redis (private, password-protected), 8001 RedisInsight (private, reach it through an SSH tunnel).

## Env vars

The full list, with comments, is in [`infra/env.template`](../infra/env.template). Copy it to `.env` in the repo root. `python infra/check_access.py` then checks OpenAI, Gemini, R2 and Redis without printing any secret. Local Redis setup is in [`infra/README.md`](../infra/README.md).

## Top risks

- **Embedding quota:** use the OpenAI key for the KB embed (the Gemini free tier allows only 30,000 tokens a minute); checkpoint every ~2,000 rows. Embeddings never switch provider per call: changing provider means re-embedding the KB, and the engine refuses an index built with a different model.
- **Data leakage:** one split script, QA audit (QA-09).
- **LLM down on stage:** OpenAI first, then Gemini, then the extractive fallback (10 s timeout each), then a backup demo video.
- **Cold start:** load models at boot; warm-up request after every deploy.
- **Merge conflicts:** folder ownership, pull every 30 minutes.
- **Redis exposed or out of memory:** no public 6379, `requirepass`, Docker network only; check `INFO memory` after loading the KB; keep the RDB snapshot in R2 so a rebuild takes minutes, not a re-embed.
- **Wrong queue routing:** search the top 2 queues and fall back to the global search when the routed match is weak.
- **Full-stack overload (React + Go):** Hriday takes the Go PII guardrail and rate limit if sync 1 shows them late; cut bonus tasks first.

## 5-minute demo

| Time | Segment |
|---|---|
| 0:00–0:30 | Problem and architecture |
| 0:30–1:30 | German hospital VPN outage → escalate to on-call, German draft held for review |
| 1:30–2:20 | English password reset → auto-draft with citations and latency |
| 2:20–3:00 | Refund demand with prompt injection → human review, no promised refund |
| 3:00–3:30 | Simulate outage → major-incident banner |
| 3:30–4:30 | Holdout metrics: macro-F1, high-priority incident recall, calibration, latency |
| 4:30–5:00 | Safeguards and next steps |
