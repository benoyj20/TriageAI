# TriageAI Hallucination & Draft Grounding Rubric (QA-06)

**Purpose:** Provide an objective, reproducible 4-tier rubric to audit and score LLM-generated ticket response drafts for factual grounding, citation integrity, and safety compliance.  
**Target:** 15 sample drafts scored during integration (`QA-08`).  
**Passing Threshold:** Average Score ≥ **4.5 / 5.0** with **0 Hallucination Penalties**.

---

## 📐 The 4-Tier Scoring Dimensions

Each evaluated draft is scored on four orthogonal dimensions:

```
Total Score = (Factuality × 0.35) + (Citation Fidelity × 0.35) + (Tone & Actionability × 0.30) - (Hallucination Penalty)
```

| Dimension | Weight | Scale | Evaluation Criteria |
| :--- | :---: | :---: | :--- |
| **1. Factuality & Grounding** | 35% | 1 – 5 | Does every factual assertion, diagnosis, and instruction originate directly from the cited knowledge base precedents? |
| **2. Citation Fidelity** | 35% | 1 – 5 | Are cited precedents formatted as valid identifiers (`[TKT-XXXXX]`) that link directly to relevant historical runbooks? |
| **3. Tone & Actionability** | 30% | 1 – 5 | Is the response professional, concise, empathetic, and immediately actionable by the customer or operator? |
| **4. Hallucination Penalty** | Deduction | **-5.0** | **Severe automatic penalty** for fabricating non-existent URLs, fake server endpoints, imaginary CLI flags, or unauthorized refund promises. |

---

## 🔬 Detailed Scoring Guidelines

### Dimension 1: Factuality & Grounding (1–5)
- **5 (Exemplary):** 100% of statements are directly grounded in the cited precedent snippets. No speculation.
- **4 (Strong):** Factual content aligns with the precedent; minor benign rephrasing with zero domain drift.
- **3 (Acceptable):** Correct general conclusion, but includes unverifiable generic filler (e.g., *"Our engineers are actively working on this"* when precedent only offers a reboot step).
- **2 (Weak):** Deviates from precedent instructions; suggests steps not found in the runbook.
- **1 (Unacceptable):** Entirely fabricated advice contradictory to internal runbooks.

### Dimension 2: Precedent Citation Fidelity (1–5)
- **5 (Exemplary):** Exact `[TKT-XXXXX]` format used. Precedent cited is directly semantically relevant to the ticket's core issue.
- **4 (Strong):** Proper citation format used; precedent is relevant, though a more specific precedent was available in the top-5 list.
- **3 (Acceptable):** Correct precedent referenced in text, but syntax deviates (e.g., `#TKT-0412` or missing brackets).
- **2 (Weak):** Cites an irrelevant precedent from an unrelated queue (e.g., citing a Hardware ticket for a Billing issue).
- **1 (Unacceptable):** Missing citations entirely or hallucinated invalid ticket IDs (e.g., `[TKT-99999]`).

### Dimension 3: Tone & Actionability (1–5)
- **5 (Exemplary):** Clear step-by-step resolution. Empathetic greeting, concise diagnosis, clear customer next step, professional sign-off.
- **4 (Strong):** Clear and actionable, but slightly wordy.
- **3 (Acceptable):** Actionable, but lacks warmth or clear bullet formatting.
- **2 (Weak):** Confusing language, excessive technical jargon inappropriate for end-users.
- **1 (Unacceptable):** Rude, dismissive, or completely non-actionable response.

### Dimension 4: Critical Hallucination Penalty (-5.0)
An immediate **-5.0 deduction** is applied if the model:
1. Fabricates internal URLs (e.g., `https://triageai.corp/admin/reset`).
2. Invents fake CLI flags or bash commands not grounded in precedent snippets.
3. Promises financial compensation, refunds, or SLA penalty payouts without human sign-off.
4. Hallucinates credentials, mock passwords, or imaginary telephone extensions.

---

## 📋 Audit Worksheet Template

```markdown
### Draft Audit: [TICKET_ID]
- **Ticket Subject:** [Subject]
- **Predicted Queue / Priority:** [Queue] / [Priority]
- **Retrieved Precedent(s):** [Precedent IDs and Snippets]
- **Generated Draft Text:**
  > [Quoted draft]

#### Evaluation Scores:
- Factuality & Grounding (1–5): **[X]**
- Citation Fidelity (1–5): **[X]**
- Tone & Actionability (1–5): **[X]**
- Hallucination Penalty (0 or -5): **[0]**
- **Composite Score:** **[X.XX / 5.0]**
- **Verdict:** [PASS / FAIL]
- **Auditor Notes:** [Observations]
```
