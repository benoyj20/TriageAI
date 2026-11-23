# Gate reason codes (contract v1)

The gate lives in `engine/app/policy/gate.py` (data analyst). The engine calls it once per ticket, after the draft is validated, and copies its output into `gate` and `burst`.

**Decision rule:** any P1 reason → `ESCALATE_ONCALL`. Otherwise any P2 reason → `HUMAN_REVIEW`. No reasons → `AUTO_DRAFT`. Every matching reason is returned, in the order the gate checks them, each with a `detail` sentence written for the operator.

| Code | Severity | Fires when | Threshold or list owned by |
|---|---|---|---|
| `HIGH_PRIORITY_INCIDENT` | P1 | Predicted type is Incident and `classification.priority.p_high` ≥ the recall-tuned threshold (0.26 today, `priority_high_threshold` in the model's `thresholds.json`; 0.38 if none is loaded) | ML engineer (ML-13) |
| `SECURITY_INCIDENT` | P1 | Breach, ransomware, hacked, malware and similar terms, English or German | Data analyst (DA-04) |
| `ACTIVE_OUTAGE` | P1 | The ticket joins a burst: at least 3 distinct tickets sharing an outage term in a 5-minute window. `burst` is then filled in | Data analyst (DA-05) |
| `LEGAL_OR_COMPLIANCE` | P2 | Lawyer, lawsuit, court, GDPR / DSGVO, right to be forgotten | Data analyst (DA-04) |
| `PROMPT_INJECTION` | P2 | “Ignore previous instructions”, “system prompt” and similar, English or German | Data analyst (DA-04) |
| `NO_PRECEDENT` | P2 | `retrieval.top_similarity` (after the global fallback) is below the threshold (0.35 today), including when there are no precedents | ML engineer (ML-14) |
| `LOW_CONFIDENCE` | P2 | min(type confidence, priority confidence) is below the floor (0.42 today). Queue confidence is not included | ML engineer (ML-12) |
| `UNSUPPORTED_REQUEST` | P2 | Full refund, compensation, payouts, SLA guarantees and similar demands; also added by the engine when the LLM lists a request the precedents can't support | Data analyst (DA-04) |
| `UNGROUNDED_DRAFT` | P2 | A `generated` draft still fails validation after one retry | Benoy (H-11) |
| `UNSUPPORTED_LANGUAGE` | P2 | Detected language is not `en` or `de`. The draft is then written in English | ML engineer (ML-06) |
| `ENGINE_DEGRADED` | P2 | The LLM failed (timeout or error) and the extractive fallback was used, or the gate itself failed | Benoy (H-12) |

## How the engine fills the gate's inputs

| Gate parameter | Comes from |
|---|---|
| `text` | `subject + "\n\n" + body` (PII-masked); just `body` when there is no subject |
| `detected_language` | `language.code` |
| `pred_type`, `pred_queue` | `classification.type.label`, `classification.queue.label` |
| `prob_high_priority` | `classification.priority.p_high` |
| `overall_confidence` | min(`classification.type.confidence`, `classification.priority.confidence`) |
| `top_precedent_similarity` | `retrieval.top_similarity` |
| `is_ungrounded` | `draft.mode == "generated"` and `draft.validation.passed` is false |
| `engine_degraded` | the draft stage failed or the LLM timed out |

## Rules that tie the codes to the rest of the response

- `burst` is an object exactly when `ACTIVE_OUTAGE` is present, and `null` otherwise.
- `draft.mode == "extractive"` always comes with `ENGINE_DEGRADED`.
- `draft.mode == "holding"` (no precedents to ground a reply) is never `AUTO_DRAFT`. In practice `NO_PRECEDENT` fires.
- `UNGROUNDED_DRAFT` is only for generated drafts. A holding or extractive draft can't be ungrounded, because the LLM didn't write it.
- `UNSUPPORTED_LANGUAGE` fires exactly when `language.supported` is false.
- If the gate module raises, the engine returns `HUMAN_REVIEW` with a single `ENGINE_DEGRADED` reason. A crash never auto-sends a draft.

The console's copy of this table is `frontend/src/lib/constants.js`. `engine/tests/test_contract.py` fails if the code list or severities drift apart between this file, the gate module, the contract models and the console.
