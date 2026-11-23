# TriageAI Master Test Plan & Bug Tracker (QA-01 & QA-03)

**Author:** QA Lead  
**Scope:** Full-stack TriageAI Pipeline (Console ↔ Go Gateway ↔ Python Engine ↔ Redis Vector Store)  
**Contract Version:** API v1 (Frozen)  
**Status:** Living Document  

---

## 🎯 1. Quality Objectives & Quality Gates

The TriageAI platform is held to the following quality gates. Where a script measures the value, the measured result is shown:

| Quality Gate | Metric / Invariant | Threshold / Measured | Validation Method |
| :--- | :--- | :--- | :--- |
| **P1 On-Call Recall** | High-priority incidents escalated on the 8,034-ticket holdout | Measured **0.870** recall at 0.534 precision (default rule); 0.934 with the recall-tuned rule | `python -m ml.evaluate --blend` |
| **Golden-Set Decisions** | Each golden ticket gets its expected gate decision | **30 / 30** | `qa/run_golden_set.py --endpoint <url>` |
| **Zero PII Leakage** | Plaintext PII leaving perimeter | **0 occurrences** | Gateway unit tests & regex audit |
| **Zero Data Leakage** | Holdout test set contamination in KB | **0% overlap** | `qa/audit_leakage.py` |
| **Model Latency** | Offline p95 per ticket (n = 300) | Measured **4.2 ms** language detection, **10.9 ms** classification | `python -m ml.latency` |
| **End-to-End Latency** | Per-stage and total time for every request | Reported in `latency_ms` on each response (the LLM draft dominates) | Gateway + engine telemetry |
| **Hallucination Bound** | Unverified claims in Auto-Drafts | **0 ungrounded** | Hallucination rubric (`QA-06`) |
| **Null-Safety** | Missing / empty / whitespace subjects | **Zero 500 crashes** | Golden set tickets `GOLD-15`..`GOLD-19` |

---

## 🏷️ 2. Bug Tracker Taxonomy & Severity Labels (QA-01)

All issues identified during testing are tracked with standardized GitHub labels:

### Severity Hierarchy
- `sev:p1-blocker`: Pipeline crash, P1 incident missed by escalation gate, plaintext PII leak, or API 500 error.
- `sev:p2-critical`: Gate misclassification (e.g., prompt injection auto-drafted), language detection failure, or broken citation link.
- `sev:p3-moderate`: Queue misroute with low confidence, minor UI layout jitter, or suboptimal draft tone.
- `sev:p4-cosmetic`: Minor typo, non-critical latency bump, or styling polish.

### Domain Labels
- `area:gateway`: Go gateway proxy, PII masking, token bucket rate limiter, or HTTP routing.
- `area:engine`: Python FastAPI, classification pipeline, embeddings (OpenAI, or Gemini without an OpenAI key), or prompt synthesis.
- `area:retrieval`: Redis hierarchical KNN search, vector indexing, or centroid distance.
- `area:frontend`: React console, triage dashboard, telemetry capsule, or keyboard hotkeys.
- `area:contract`: Schema drift or field mismatches against `contracts/schema/`.

---

## 🧪 3. Test Suites & Execution Plan (QA-03)

### Suite A: Security & PII Sanitization
- **Owner:** Full-stack Dev + QA Lead
- **Target:** Go gateway (`backend/internal/pii/`)
- **Key Assertions:**
  1. Credit card numbers (Luhn-valid, or grouped like a card) masked to `[CARD_1]`.
  2. IBANs masked to `[IBAN_1]`; account, customer and contract numbers that follow a label (e.g. "account number", "Kundennummer") masked to `[ACCOUNT_1]`.
  3. IP addresses (IPv4 & IPv6), email addresses and phone numbers masked to `[IP_1]`, `[EMAIL_1]` and `[PHONE_1]`.
  4. Numbering is consistently shared across `subject` and `body`.
  5. The Python engine never receives the unmasked values of these six types (EMAIL, PHONE, IP, IBAN, CARD, ACCOUNT). Passwords and API tokens are not masked.

### Suite B: Escalation Gate Policy & Adversarial Robustness
- **Owner:** Data Analyst + QA Lead
- **Target:** Policy gate (`engine/app/policy/gate.py`)
- **Key Assertions:**
  1. Any P1 reason (`HIGH_PRIORITY_INCIDENT`, `SECURITY_INCIDENT`, `ACTIVE_OUTAGE`) strictly produces `ESCALATE_ONCALL`.
  2. Prompt injections (*"Ignore previous instructions"*, *"System prompt"*) strictly produce `HUMAN_REVIEW` via `PROMPT_INJECTION`.
  3. Legal, GDPR, and compensation demands produce `HUMAN_REVIEW`.
  4. Unsupported languages divert to `HUMAN_REVIEW` with `UNSUPPORTED_LANGUAGE`.

### Suite C: Hierarchical Vector Retrieval & Grounding
- **Owner:** ML Engineer + QA Lead
- **Target:** Redis indexer & query router (`ml/indexing/`, `engine/app/retrieval/`)
- **Key Assertions:**
  1. Level 1 routes to top 2 candidate queues based on ensemble score (classifier probability + centroid cosine).
  2. Level 2 filters Redis KNN search to routed queues (`@queue:{...}`).
  3. When the routed search finds nothing, or its top-1 is more than 0.05 below the global top-1 (`fallback_margin`), the global result is used; if the final top-1 similarity is below 0.35, `NO_PRECEDENT` fires.

### Suite D: End-to-End Golden Set Runner (`QA-07`)
- **Target:** 30 curated unseen tickets (`qa/golden_test_set.json`)
- **Execution Command:**
  ```bash
  python3 qa/run_golden_set.py --endpoint http://localhost:8080/api/v1/triage
  ```
- **Passing Threshold:** 30/30 (100%) correct gate decisions (`ESCALATE_ONCALL` vs `HUMAN_REVIEW` vs `AUTO_DRAFT`).

---

## 📊 4. Test Execution Matrix

| Test Suite | Total Cases | Target Pass Rate | Automated? | Runner / Location |
| :--- | :---: | :---: | :---: | :--- |
| Frontend React Unit Tests | 15 | 100% | Yes | `cd frontend && npm test` |
| Gateway PII & Server Tests | 29 | 100% | Yes | `cd backend && go test ./...` |
| Python Engine Tests | 135 | 100% | Yes | `pytest engine/` (126 in `engine/tests/`, 9 in `engine/app/policy/test_gate.py`) |
| ML Pipeline & Search Suite | 11 | 100% (1 skipped without Redis) | Yes | `pytest ml/tests/` |
| Golden Set End-to-End Suite | 30 | 100% | Yes | `python3 qa/run_golden_set.py --endpoint <url>` |
| Hallucination Rubric Audit | 15 | Score ≥ 4.5/5 | Manual | `qa/hallucination_rubric.md` |
| Data Leakage Audit Sign-off | 7 | 0% Contamination | Automated | `python3 qa/audit_leakage.py` |
