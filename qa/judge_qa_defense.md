# Judge Q&A sheet (QA-12)

Short, accurate answers for the 3-minute Q&A. Every claim here points at code or a script that reproduces it. If a judge asks for a number that isn't on this sheet, say which script produces it rather than guessing.

---

### Q1. What are your holdout metrics?
On the 20% holdout (8,034 tickets, never used for training, tuning or indexing), from `python -m ml.evaluate`:

| Target | Macro-F1 | Accuracy | ECE |
|---|---|---|---|
| type (4 classes) | 0.894 (classifier alone 0.859) | 0.891 | 0.059 (alone 0.008) |
| priority (3) | 0.704 (alone 0.592) | 0.718 | 0.113 (alone 0.015) |
| queue (10) | 0.639 (alone 0.528) | 0.655 | 0.129 (alone 0.012) |

**High-priority incident recall (deployed, with the neighbour-vote blend):** 0.870 at precision 0.534 (1,462 true high-priority incidents in the holdout), using the gate's default rule: predicted type Incident and P(high) ≥ 0.26. The recall-tuned rule, P(Incident) ≥ 0.15 instead of argmax type (switch on with `"gate_incident_rule": true` in `thresholds.json`), reaches 0.934 at precision 0.436 but sends 36% of all tickets to on-call. These are the TF-IDF classifier's numbers alone; the live engine can also blend in the vote of the retrieved neighbours (`blend_weight`, tuned by `python -m ml.tune_blend`).

### Q2. Why is queue F1 so much lower than type?
The queue labels overlap heavily (Technical Support, IT Support and Product Support describe the same tickets) and are noisy. We don't hide it: the confidence is calibrated, low confidence fires `LOW_CONFIDENCE` and a person reviews, and retrieval searches the top two queues and falls back to a global search when the routed match is weak.

### Q3. How do you prove there is no data leakage?
`python qa/audit_leakage.py` checks the split that `ml/split.py` actually writes (result in `qa/LEAKAGE_AUDIT.md`):
1. The split is the brief's: `sample(frac=1.0, random_state=42)`, IDs `TKT-{i:05d}`, first 80% is the KB. After de-duplicating on the normalised body that is 32,133 KB tickets and 8,034 holdout tickets.
2. KB and holdout share no ticket IDs and no ticket body text.
3. The only test file inference reads has exactly `ticket_id, subject, body`. The holdout `answer` column is dropped before anything is saved. Labels are read only by `ml/evaluate.py`, after predictions are made.
4. Calibration and every threshold are tuned on `kb_val`, the last 10% of the KB, never on the holdout.

### Q4. How do you stop the draft from making things up?
Three layers, none of which trusts the model:
1. **Prompt** (`engine/app/generate/prompt.py`): use only the evidence, cite every past ticket used as `[TKT-xxxxx]`, never state prices, refunds, SLA credits, deadlines, legal guarantees or integrations the evidence doesn't contain; the model must list such requests in `unsupported_requests`.
2. **Validator** (`engine/app/generate/validator.py`): every cited ID must be one of the retrieved tickets, at least one must be cited, every number in the reply must appear in the evidence or the customer's own ticket, and the reply must be in the customer's language. On failure the model gets one retry with the reasons.
3. **Gate:** if the retry still fails, `UNGROUNDED_DRAFT` sends the ticket to human review. With no usable precedent the engine writes a holding reply instead of generating.

Known limit: the number check works on digits, so "two business days" written out passes it. The prompt forbids it, and anything not auto-drafted is read by a person.

### Q5. Why hierarchical retrieval instead of flat top-k?
A flat search can return a billing ticket for a network question because they share words. We route first: each queue is scored as 0.6 × classifier probability + 0.4 × cosine to the queue's centroid, the top 2 queues are kept (or 1 if it scores ≥ 0.80), and the KNN search runs inside them. If the routed top match is weak, or more than 0.05 below the global top match, the global result is used instead. `python -m ml.indexing.retrieval_quality` compares flat and hierarchical retrieval (useful@1, agreement@5, routing accuracy); it needs the embedded KB.

### Q6. How do you handle German and English?
Language is detected from the text (`langdetect` with a stopword fallback for short tickets). The embedding model (OpenAI `text-embedding-3-small`, 768 dimensions) is multilingual, so a German ticket can retrieve an English precedent. The prompt tells the model to translate the evidence's meaning and answer in the customer's language, and the validator checks it did. Any other language fires `UNSUPPORTED_LANGUAGE` and goes to a person.

### Q7. What happens to prompt injections and security incidents?
The ticket goes into the prompt inside `<ticket>` tags, marked as untrusted data, with an explicit rule to ignore instructions in it. Separately, the gate matches injection patterns in English and German (`engine/app/policy/keywords.py`) and raises `PROMPT_INJECTION`, so a person reviews whatever was drafted. Ransomware, breach or "gehackt" style terms raise `SECURITY_INCIDENT`, which is P1: on-call is paged and the draft is held.

### Q8. Why a Go gateway in front of a Python engine?
The gateway is the only public service. It validates requests against the contract, rate-limits, and masks emails, phone numbers, IPs, IBANs, card and account numbers before anything reaches the engine, so the engine, its logs and the LLM only see placeholders like `[EMAIL_1]`. The engine and Redis are on the internal Docker network only; Caddy terminates TLS in production.

### Q9. What if the LLM is down or slow?
Generation tries OpenAI, then Gemini (`LLM_TIMEOUT_S`, 10 s by default). If both fail, the engine quotes the best precedent's answer in the customer's language verbatim (extractive mode), or writes a holding reply, and raises `ENGINE_DEGRADED`, so a person checks it. The triage, retrieval and gate still work.

### Q10. How does outage burst detection work?
`engine/app/policy/burst.py` keeps a rolling 10-minute window of tickets. Tickets in related queues that share an outage term ("vpn", "ausfall", "504", ...) form a cluster; from the third ticket on, `ACTIVE_OUTAGE` (P1) fires and the console shows the major-incident banner with the cluster's ticket count. It keeps state in memory, which is why the engine runs with one worker.

### Q11. What is calibration and why does it matter here?
The classifier's probabilities are temperature-scaled on `kb_val`, so a 70% confidence is right about 70% of the time. Holdout expected calibration error is 0.008 to 0.015. The gate's confidence floor and high-priority threshold are probabilities, so they only mean something if the probabilities are calibrated.

### Q12. Why TF-IDF and logistic regression instead of a fine-tuned transformer?
It trains in minutes on a laptop, predicts in milliseconds on CPU, calibrates cleanly, and on this dataset the labels, not the model, are the ceiling (see Q2). The retrieval neighbours add a semantic signal on top.
