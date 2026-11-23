# DA-11: TriageAI architecture diagrams

**Owner:** Data Analyst. Numbers come from `python -m ml.evaluate` and `qa/audit_leakage.py`; see the root README.

---

## 1. End-to-end system

<p align="center">
  <img src="media/architecture.svg" alt="TriageAI architecture: a ticket goes from the React console to the public Go gateway, which validates it, rate-limits and masks PII, then to the private Python engine. The engine runs seven stages (detect language, embed, classify, route, draft, validate, gate) using Redis vector search and OpenAI or Gemini. The gate returns ESCALATE_ONCALL, HUMAN_REVIEW or AUTO_DRAFT with reason codes and citations." width="880">
</p>

| Stage | What it does | Code |
| :--- | :--- | :--- |
| Gateway | Validates the request against contract v1, rate-limits per client, masks emails, phones, IPs, IBANs, cards and account numbers, adds a request ID and timing. 12 s engine timeout. | [`backend/internal/`](../backend/internal) |
| 1. Detect | Language detection (langdetect + stopword fallback). Only `en` and `de` are supported. | [`engine/app/analyze/language.py`](../engine/app/analyze/language.py) |
| 2. Embed | Embeds the ticket once and runs an unfiltered global top-10 search in Redis. | [`engine/app/stages_live.py`](../engine/app/stages_live.py) |
| 3. Classify | TF-IDF + logistic regression per head (type, queue, priority), temperature-calibrated, blended 50/50 with a similarity-weighted vote over the global top-10. | [`engine/app/analyze/classify.py`](../engine/app/analyze/classify.py) |
| 4. Route | Scores queues (75% classifier probability, 25% queue-centroid similarity), runs kNN (k = 5) inside the top 2 queues. Falls back to the global top 5 when the routed top-1 trails the global top-1 by more than 0.05. | [`engine/app/retrieval/search.py`](../engine/app/retrieval/search.py) |
| 5. Draft | Grounded reply that cites `[TKT-xxxxx]`. OpenAI `gpt-5.4-mini`, then Gemini; an extractive draft if both fail; a holding reply (no LLM call) when there are no precedents. | [`engine/app/generate/llm.py`](../engine/app/generate/llm.py) |
| 6. Validate | Checks citations, numbers and language; one retry with the issues fed back. | [`engine/app/generate/validator.py`](../engine/app/generate/validator.py) |
| 7. Gate | 11 rules plus the outage burst detector; see section 3. | [`engine/app/policy/gate.py`](../engine/app/policy/gate.py) |

Redis holds 42,675 tickets: the 32,133-ticket KB (the only answers ever indexed) plus 10,542 German topic rows
without answers, and one node per queue. Embeddings come from a single provider per index
(OpenAI `text-embedding-3-small` at 768 dimensions, or Gemini `gemini-embedding-2` without an OpenAI key); only drafts
fail over between providers.

The draft is always produced, then held when the gate decides on a person: on-call escalation and human review never send it.

In the hackathon deployment, Cloudflare R2 held the trained classifier, its thresholds and a Redis snapshot; running
locally does not need it.

---

## 2. Data split and leakage controls (ML-03, QA-09)

<p align="center">
  <img src="media/data-split.svg" alt="Data split: the pinned dataset is de-duplicated to 40,167 tickets, shuffled with seed 42 and split 80/20. 32,133 KB tickets feed the Redis index and classifier training (last 10% for calibration and thresholds). 8,034 holdout tickets: inputs go to inference, labels without answers are read only by ml/evaluate.py. Holdout macro-F1: type 0.894, priority 0.704, queue 0.639." width="880">
</p>

The split, row counts and file hashes are recorded in `ml/artifacts/splits/v1/split_manifest.json`
([`ml/split.py`](../ml/split.py)). The leakage audit is [`qa/LEAKAGE_AUDIT.md`](../qa/LEAKAGE_AUDIT.md).

---

## 3. Escalation gate (DA-06, DA-07)

<p align="center">
  <img src="media/escalation-gate.svg" alt="Escalation gate: any P1 reason (HIGH_PRIORITY_INCIDENT, SECURITY_INCIDENT, ACTIVE_OUTAGE) gives ESCALATE_ONCALL. Otherwise any P2 reason (PROMPT_INJECTION, LEGAL_OR_COMPLIANCE, UNSUPPORTED_REQUEST, LOW_CONFIDENCE, NO_PRECEDENT, UNGROUNDED_DRAFT, UNSUPPORTED_LANGUAGE, ENGINE_DEGRADED) gives HUMAN_REVIEW. No reasons gives AUTO_DRAFT." width="880">
</p>

Where the thresholds come from:

| Threshold | Value | Source |
| :--- | :--- | :--- |
| P(high) for `HIGH_PRIORITY_INCIDENT` | 0.26 | `priority_high_threshold` in the model's `thresholds.json`, tuned for 0.9 recall on `kb_val` |
| `LOW_CONFIDENCE` floor | 0.42 | gate default ([`gate.py`](../engine/app/policy/gate.py)) |
| `NO_PRECEDENT` top-1 similarity | 0.35 | `no_precedent_threshold`, default in [`stages_live.py`](../engine/app/stages_live.py) |
| `ACTIVE_OUTAGE` burst | 3 distinct tickets in 5 min | `BURST_MIN_TICKETS` / `BURST_WINDOW_S` ([`burst.py`](../engine/app/policy/burst.py)) |

Reason codes and their wording are frozen in [`contracts/reason_codes.md`](../contracts/reason_codes.md).

---

## 4. Demo outline

The full script is [`demo-script.md`](demo-script.md).

| Time | Segment | On screen |
|---|---|---|
| 0:00-0:30 | Problem and architecture | Overview |
| 0:30-1:30 | German hospital VPN outage → on-call, German draft held | Live triage |
| 1:30-2:20 | English password reset → grounded auto-draft | Live triage |
| 2:20-3:00 | Refund + prompt injection → human review, nothing promised | Live triage |
| 3:00-3:30 | Simulate an outage → major-incident banner | Overview |
| 3:30-4:30 | Holdout metrics, leakage audit | Reports |
| 4:30-5:00 | Safeguards and close | |
