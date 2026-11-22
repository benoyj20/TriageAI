# SentinelDesk Master Test Plan & Bug Tracker (QA-01 & QA-03)

**Author:** QA Lead  
**Scope:** Full-stack SentinelDesk Pipeline (Console ↔ Go Gateway ↔ Python Engine ↔ Redis Vector Store)  
**Contract Version:** API v1 (Frozen)  
**Status:** Living Document  

---

## 🎯 1. Quality Objectives & Quality Gates

The SentinelDesk platform must meet the following strict non-negotiable quality gates before hackathon submission:

| Quality Gate | Metric / Invariant | Threshold | Validation Method |
| :--- | :--- | :--- | :--- |
| **P1 On-Call Recall** | High Priority Incidents escalated | **≥ 98.0%** | `qa/run_golden_set.py` |
| **Zero PII Leakage** | Plaintext PII leaving perimeter | **0 occurrences** | Gateway unit tests & regex audit |
| **Zero Data Leakage** | Holdout test set contamination in KB | **0% overlap** | `qa/audit_leakage.py` |
| **End-to-End Latency** | Pipeline P95 response time | **< 400 ms** | `ml/latency.py` & gateway telemetry |
| **Hallucination Bound** | Unverified claims in Auto-Drafts | **0 ungrounded** | Hallucination rubric (`QA-06`) |
| **Null-Safety** | Missing / empty / whitespace subjects | **Zero 500 crashes** | Golden set tickets `GOLD-15`..`GOLD-20` |

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
- `area:engine`: Python FastAPI, classification pipeline, Gemini embeddings, or prompt synthesis.
- `area:retrieval`: Redis hierarchical KNN search, vector indexing, or centroid distance.
- `area:frontend`: React console, triage dashboard, telemetry capsule, or keyboard hotkeys.
- `area:contract`: Schema drift or field mismatches against `contracts/schema/`.

---

## 🧪 3. Test Suites & Execution Plan (QA-03)

### Suite A: Security & PII Sanitization
- **Owner:** Full-stack Dev + QA Lead
- **Target:** Go gateway (`backend/internal/pii/`)
- **Key Assertions:**
  1. Credit card numbers (Luhn-compliant & raw sequences) masked to `[CARD_1]`.
  2. Social Security Numbers and IBAN numbers masked to `[ACCOUNT_1]` / `[IBAN_1]`.
  3. IP addresses (IPv4 & IPv6) and email addresses masked to `[IP_1]` and `[EMAIL_1]`.
  4. Numbering is consistently shared across `subject` and `body`.
  5. The Python engine never receives unmasked credentials or personal tokens.

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
  3. When top-1 similarity < 0.28, global fallback triggers; if still below floor, `NO_PRECEDENT` fires with holding mode draft.

### Suite D: End-to-End Golden Set Runner (`QA-07`)
- **Target:** 30 curated unseen tickets (`qa/golden_test_set.json`)
- **Execution Command:**
  ```bash
  python3 qa/run_golden_set.py --target http://localhost:8080/api/v1/triage
  ```
- **Passing Threshold:** 30/30 (100%) correct gate decisions (`ESCALATE_ONCALL` vs `HUMAN_REVIEW` vs `AUTO_DRAFT`).

---

## 📊 4. Test Execution Matrix

| Test Suite | Total Cases | Target Pass Rate | Automated? | Runner / Location |
| :--- | :---: | :---: | :---: | :--- |
| Frontend React Unit Tests | 15 | 100% | Yes | `cd frontend && npm test` |
| Gateway PII & Server Tests | 18 | 100% | Yes | `cd backend && go test ./...` |
| Python Engine Contract Tests | 12 | 100% | Yes | `pytest engine/tests/` |
| ML Retrieval Quality Suite | 8 | 100% | Yes | `pytest ml/tests/` |
| Golden Set End-to-End Suite | 30 | 100% | Yes | `python3 qa/run_golden_set.py` |
| Hallucination Rubric Audit | 15 | Score ≥ 4.5/5 | Manual | `qa/hallucination_rubric.md` |
| Data Leakage Audit Sign-off | 1 | 0% Contamination | Automated | `python3 qa/audit_leakage.py` |
