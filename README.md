<div align="center">

<img src="docs/media/demo.gif" alt="SentinelDesk live triage: a German hospital VPN-outage ticket is masked, classified as an incident, matched to five past tickets, gated, and escalated to on-call with a held German draft" width="880">

# SentinelDesk

**Incident triage that explains itself.** Every incoming support ticket is classified, gated, matched against
resolved precedents and answered with a drafted reply that cites the past tickets it used. It works in English
and German, and a human sees why each decision was made.

[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](engine)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](engine/app)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go&logoColor=white)](backend)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](frontend)
[![Redis](https://img.shields.io/badge/Redis-HNSW%20vector%20search-DC382D?logo=redis&logoColor=white)](engine/app/retrieval)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](infra)
[![Leakage audit](https://img.shields.io/badge/leakage%20audit-7%2F7%20checks-0b6b5e)](qa/LEAKAGE_AUDIT.md)
[![2nd place](https://img.shields.io/badge/%F0%9F%A5%88%202nd%20place-GDG%20Cloud%20Boston%20x%20Northeastern%20Hackathon-6b7280)](#award)

🥈 **Second prize** at the
[GDG Cloud Boston x Northeastern University Hackathon](https://gdg.community.dev/events/details/google-gdg-boston-presents-gdg-cloud-boston-x-northeastern-university-hackathon/)

**[Watch the demo video](https://youtu.be/UBkSEnIPQRM)** &nbsp;·&nbsp; **[Try the live app](https://gdg-sentinal.vercel.app/)** &nbsp;·&nbsp; **[Run it locally](#run-it-locally)**

</div>

---

## Award

SentinelDesk won **second prize** at the
[GDG Cloud Boston x Northeastern University Hackathon](https://gdg.community.dev/events/details/google-gdg-boston-presents-gdg-cloud-boston-x-northeastern-university-hackathon/).
The brief: build a multilingual triage and escalation system on the public
[`Tobi-Bueck/customer-support-tickets`](https://huggingface.co/datasets/Tobi-Bueck/customer-support-tickets)
dataset, scored on an untouched 20% holdout.

---

## The problem

Support teams get a flood of tickets in several languages. The urgent ones (an outage, a security incident) sit in
the same queue as "how do I reset my password". Automated replies are risky too: a model that invents a policy or
quotes a number that is not in any record does more harm than no reply at all.

**SentinelDesk triages first, then answers only from evidence.** For every ticket (subject optional, body required):

1. **Classify and prioritise.** Type, queue and priority, each with a calibrated confidence.
2. **Gate it.** Escalate to on-call, send to human review, or mark the draft ready, and say why.
3. **Retrieve precedents.** The 5 most similar resolved tickets from the 80% knowledge base.
4. **Draft a grounded reply** in the customer's language that cites the tickets it used as `[TKT-xxxxx]`, then
   validate the draft before anyone sees it.

## Results

Every number is on the **20% holdout (8,034 tickets)** that was never used for training, tuning or indexing.

| Target | Macro-F1 (deployed) | Accuracy | ECE | Macro-F1 (classifier alone) |
| :--- | ---: | ---: | ---: | ---: |
| Type (4 classes) | **0.894** | 0.891 | 0.059 | 0.859 |
| Priority (3 classes) | **0.704** | 0.718 | 0.113 | 0.592 |
| Queue (10 classes) | **0.639** | 0.655 | 0.129 | 0.528 |

The deployed engine blends the classifier with the votes of the 5 nearest past tickets (`blend_weight` 0.5, tuned on
`kb_val`). The neighbour vote lifts every head by 4 to 11 points.

**High-priority incident recall** (1,462 true high-priority incidents in the holdout):

| Gate rule | Recall | Precision | Sent to on-call |
| :--- | ---: | ---: | ---: |
| Live: predicted Incident and P(high) ≥ 0.26 | **0.870** | 0.534 | 29.7% |
| Recall-tuned: P(Incident) ≥ 0.15 and P(high) ≥ 0.26 | **0.934** | 0.436 | 39.0% |

The recall-tuned rule is one setting away (`"gate_incident_rule": true` in `thresholds.json`). Thresholds are tuned
on `kb_val`, never on the holdout.

**Latency:** 2.6 ms language detection and 9.0 ms classification per ticket (p50, offline, one laptop). The console
shows the real time of every stage on every ticket.

## See it in action

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/media/triage-pipeline.png" alt="Live triage: language detected as German, classified as an incident, the phone number hidden before any model sees it"><br>
      <b>Live triage.</b> Language, type, queue and priority with confidence. The phone number is masked first.
    </td>
    <td width="50%" valign="top">
      <img src="docs/media/safety-gate.png" alt="Five similar past tickets retrieved and the safety gate showing a high-priority incident rule fired"><br>
      <b>Precedents and gate.</b> Five similar resolved tickets, and the rule that fired, in plain words.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/media/escalation.png" alt="A German draft reply citing two past tickets, a draft check passing, and an Escalated to on-call banner"><br>
      <b>Grounded draft.</b> The reply cites real tickets, passes the check, and waits for a person.
    </td>
    <td width="50%" valign="top">
      <img src="docs/media/pii-masking.png" alt="A ticket with card number, IBAN, email and phone; the gateway reports four pieces of personal data hidden"><br>
      <b>PII guardrail.</b> Card, IBAN, email and phone are masked before the engine sees anything.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/media/auto-send.png" alt="A routine password-reset ticket where all eleven rules pass, shown as Ready to send"><br>
      <b>Routine, handled.</b> All eleven rules pass and the reply is ready to send untouched.
    </td>
    <td width="50%" valign="top">
      <img src="docs/media/outage-overview.png" alt="Overview with a red major-incident banner and several escalated VPN tickets in English and German"><br>
      <b>Outage burst.</b> Similar incidents in two languages trigger a major-incident banner.
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/insights.png" alt="Reports page: of 100 real high-priority tickets, 85 go on-call and 15 are missed, with type, priority and language breakdowns" width="880"><br>
  <sub><b>Reports.</b> Of 100 real high-priority incidents, 85 are escalated. The console shows the trade-off openly.</sub>
</p>

## What makes it different

**Safe by construction.** The Go gateway masks emails, phones, IPs, IBANs, cards and account numbers *before* the
engine or any LLM sees the text. A draft is rejected if it cites a ticket that was not retrieved, contains a number
that is not in the evidence, or is in the wrong language. It gets one retry, then falls back to an extractive answer.

**It knows when not to answer.** The gate escalates or holds a ticket for human review on a high-priority incident,
low confidence, no precedent, an unsupported request, a security, outage or legal signal, a prompt-injection attempt,
or a degraded engine. Every decision carries a reason code ([`contracts/reason_codes.md`](contracts/reason_codes.md)).

**Evidence over generation.** Precedent search is hierarchical: route by queue, run KNN inside the routed queues,
fall back to a global search. Past answers are translated into the customer's language when needed, so a German
customer can be helped by an English precedent.

**Outage detection.** A burst of similar incidents raises a major-incident banner automatically.

**No leakage, proven.** [`qa/audit_leakage.py`](qa/audit_leakage.py) checks the real split: no shared ticket IDs or
text between KB and holdout, inference inputs hold only `ticket_id, subject, body`, no holdout answer is saved
anywhere, and files match the checksums recorded at split time. Result: [`qa/LEAKAGE_AUDIT.md`](qa/LEAKAGE_AUDIT.md).

## Two roles, one console

| Role | What they get |
| :--- | :--- |
| **Ticket creators** (`#/help`) | Submit a ticket, follow its status, and see *Similar issues, already solved*, translated into their language |
| **Incident managers** | Overview, Kanban board, ticket detail, a Funnel with pivots, Reports, and **Live triage** (`#/lab`) for pasting any ticket and watching every stage run |

Keyboard friendly: `/` focuses search, `Esc` closes dialogs, `←` `→` step through precedents.

## Architecture

```mermaid
flowchart LR
    U([Ticket creator / incident manager]) --> F["<b>Console</b><br/>React · Vite · Tailwind"]
    F --> G["<b>Gateway</b> :8080<br/>Go · validate · rate limit<br/>PII masking · timing"]
    G --> E["<b>Engine</b> :8000 (private)<br/>Python · FastAPI<br/>language → embed → classify<br/>→ route + search → draft<br/>→ validate → gate + burst"]
    E --> R[("<b>Redis</b><br/>KB index · HNSW cosine")]
    E -. "embeddings + drafts" .-> L["OpenAI → Gemini<br/>→ extractive fallback"]
    E --> O[["Decision: escalate · review · ready<br/>+ reason codes + citations"]]
```

| Part | Choice |
| :--- | :--- |
| Console | React 19, Vite, Tailwind CSS 4, Recharts |
| Gateway | Go 1.22, standard library only |
| Engine | Python, FastAPI |
| Classifier | TF-IDF + logistic regression per head, temperature-calibrated |
| Vector store | Redis Query Engine, HNSW cosine, 768 dimensions |
| Embeddings | OpenAI `text-embedding-3-small` (Gemini `gemini-embedding-2` without an OpenAI key) |
| Drafts | OpenAI `gpt-5.4-mini`, then Gemini, then an extractive fallback |
| Deploy | Docker Compose on AWS EC2, Caddy for TLS, artifacts in Cloudflare R2 |

The private engine and Redis are never exposed; only the gateway is public.
More detail: [`docs/architecture-diagram.md`](docs/architecture-diagram.md),
[`docs/system-architecture-and-stack-guide.md`](docs/system-architecture-and-stack-guide.md) and the frozen API
contract in [`contracts/`](contracts/README.md).

## How the brief maps to the code

| Requirement | Where |
| :--- | :--- |
| Multi-task triage with confidence | [`engine/app/analyze/classify.py`](engine/app/analyze/classify.py), trained by [`ml/train.py`](ml/train.py) |
| Holdout Macro-F1 and high-priority incident recall | [`ml/evaluate.py`](ml/evaluate.py), the only code that reads holdout labels |
| Exact 80/20 split, no leakage | [`ml/split.py`](ml/split.py) (`random_state=42`), audited by [`qa/audit_leakage.py`](qa/audit_leakage.py) |
| Missing subjects | Treated as empty everywhere, covered by tests and [`contracts/examples/triage_request.no_subject.json`](contracts/examples/triage_request.no_subject.json) |
| Automatic language detection | [`engine/app/analyze/language.py`](engine/app/analyze/language.py) |
| Escalation and safety gate | [`engine/app/policy/gate.py`](engine/app/policy/gate.py) |
| Top-k precedent retrieval | [`engine/app/retrieval/search.py`](engine/app/retrieval/search.py) |
| Grounded reply, no invented policies | [`engine/app/generate/prompt.py`](engine/app/generate/prompt.py), [`engine/app/generate/validator.py`](engine/app/generate/validator.py) |
| Bonus: cross-lingual precedents | Multilingual embeddings, evidence translated into the reply language |
| Bonus: outage burst detection | [`engine/app/policy/burst.py`](engine/app/policy/burst.py) and the major-incident banner |
| Bonus: PII guardrail | [`backend/internal/pii`](backend/internal/pii) |

## Tested like it matters

| Number | What it measures |
| ---: | :--- |
| **8,034** | holdout tickets behind every reported metric |
| **7 / 7** | leakage-audit checks passing on the real split |
| **30** | golden tickets with expected gate decisions, run through the live pipeline |
| **15** | frontend tests, plus Python (engine and ML) and Go gateway suites |
| **3** | independent LLM providers in the fallback chain, ending in a model-free answer |

The pre-freeze checklist is in [`qa/final_regression.md`](qa/final_regression.md).

## Run it locally

Needs **Node 20+**, **Go 1.22+**, **Python 3.11+** and **Docker** (for Redis).

**Console and gateway, no keys.** The gateway answers with the contract's example responses:

```bash
git clone https://github.com/benoyj20/TriageAI.git && cd TriageAI
cd frontend && npm install && npm run build
cd ../backend && go run ./cmd/api          # http://localhost:8080
```

**Full pipeline:**

```bash
cp infra/env.template .env                 # fill in OPENAI_API_KEY and REDIS_PASSWORD
pip install -r requirements.txt
docker compose --env-file .env -f infra/docker-compose.dev.yml up -d     # Redis Stack
python -m ml.split                         # download the pinned dataset revision, make the 80/20 split
python -m ml.train                         # classifier, calibration, thresholds
python -m ml.indexing.embed                # embed the knowledge base
python -m ml.indexing.build_index --url redis://:<REDIS_PASSWORD>@localhost:6379
uvicorn engine.app.main:app --port 8000 --workers 1
cd backend && MOCK_ENGINE=false go run ./cmd/api
```

**Evaluate and test:**

```bash
python -m ml.evaluate --blend              # writes ml/artifacts/reports/v1/metrics.json
python qa/audit_leakage.py                 # writes qa/LEAKAGE_AUDIT.md
python -m pytest                           # engine + ML
cd backend && go test ./...
cd frontend && npm test
```

Production deploy: [`infra/README.md`](infra/README.md) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Repository

| Folder | What |
| :--- | :--- |
| `frontend/` | React console |
| `backend/` | Go gateway, PII guardrail, rate limit |
| `engine/` | Python engine: pipeline, generation, gate |
| `ml/` | Split, training, indexing, evaluation |
| `analytics/` | EDA and Reports data |
| `contracts/` | API contract v1 (frozen) |
| `infra/` | Docker, deploy, Redis |
| `qa/` | Test plan, golden set, leakage audit |
| `docs/` | Architecture, demo script, build plan |

## Data

Built on [`Tobi-Bueck/customer-support-tickets`](https://huggingface.co/datasets/Tobi-Bueck/customer-support-tickets)
(CC BY-NC 4.0). The dataset, splits, embeddings and models are never committed; they live in `ml/artifacts/`
(gitignored) and in Cloudflare R2.

<sub>Built by a team at the GDG Cloud Boston x Northeastern University Hackathon. Licensed under MIT, see
[LICENSE](LICENSE).</sub>
