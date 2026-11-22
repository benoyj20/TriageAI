# DA-11: SentinelDesk architecture diagrams

**Owner:** Data Analyst. Numbers come from `python -m ml.evaluate` and `qa/audit_leakage.py`; see the root README.

---

## 1. End-to-end system

```mermaid
flowchart TD
    subgraph Client ["Console"]
        UI["React + Vite operator console"]
    end

    subgraph Gateway ["Go gateway :8080 (only public service)"]
        GW["Contract validation, rate limit, IDs, timing"]
        PII["PII guardrail<br>emails, phones, IPs, IBANs, cards, accounts"]
        GW --> PII
    end

    subgraph Engine ["Python engine :8000 (private)"]
        LANG["1. Language detection (en / de)"]
        SEARCH["2. Embed query, global top-10"]
        CLS["3. Classify type, queue, priority<br>TF-IDF + LR, calibrated, + neighbour vote"]
        ROUTE["4. Route to top queues, KNN k=5 inside them<br>global fallback when weak"]
        DRAFT["5. Grounded draft, cites [TKT-xxxxx]"]
        VAL["6. Validate citations, numbers, language<br>one retry with feedback"]
        GATE["7. Escalation gate (11 rules) + burst detector"]
        LANG --> SEARCH --> CLS --> ROUTE --> DRAFT --> VAL --> GATE
    end

    subgraph Data ["Data"]
        REDIS["Redis Query Engine (private)<br>32,133 KB tickets, HNSW cosine<br>queue nodes + chunks"]
        LLM["OpenAI gpt-5.4-mini<br>then Gemini, then extractive fallback"]
        R2["Cloudflare R2<br>splits, embeddings, models, Redis snapshot"]
    end

    UI -->|"POST /api/v1/triage"| GW
    PII -->|"masked ticket"| LANG
    SEARCH <--> REDIS
    ROUTE <--> REDIS
    DRAFT <--> LLM
    GATE -->|"ESCALATE_ONCALL / HUMAN_REVIEW / AUTO_DRAFT<br>+ precedents, draft, latency"| GW --> UI
```

The draft is always produced, then held when the gate decides on a person: on-call escalation and human review never send it.

---

## 2. Data split and leakage controls (ML-03, QA-09)

```mermaid
flowchart LR
    RAW["HF dataset, pinned revision<br>primary + 20k file, de-duplicated<br>40,167 tickets"] --> SPLIT["sample(frac=1.0, random_state=42)<br>IDs TKT-00000.., first 80% = KB"]
    SPLIT --> KB["KB: 32,133<br>(last 10% = kb_val for calibration + thresholds)"]
    SPLIT --> TEST["Holdout: 8,034"]
    KB --> INDEX["Redis index + answers<br>(the only answers ever indexed)"]
    KB --> TRAIN["Classifier training"]
    TEST --> INPUTS["test_inputs.csv<br>ticket_id, subject, body only"]
    TEST --> LABELS["test_labels.csv<br>no answer column; read only by ml/evaluate.py"]
    INPUTS --> EVAL["Holdout report<br>type 0.894, priority 0.704, queue 0.639 macro-F1"]
    LABELS --> EVAL
```

---

## 3. Escalation gate (DA-06, DA-07)

Any P1 reason → `ESCALATE_ONCALL`. Otherwise any P2 reason → `HUMAN_REVIEW`. No reasons → `AUTO_DRAFT`. All reasons are returned.

```mermaid
stateDiagram-v2
    [*] --> CheckP1
    CheckP1 --> ESCALATE_ONCALL : HIGH_PRIORITY_INCIDENT (Incident and P(high) at or above the tuned threshold)
    CheckP1 --> ESCALATE_ONCALL : SECURITY_INCIDENT (ransomware, breach, gehackt...)
    CheckP1 --> ESCALATE_ONCALL : ACTIVE_OUTAGE (3+ related tickets in 10 min)
    CheckP1 --> CheckP2 : no P1 reason
    CheckP2 --> HUMAN_REVIEW : PROMPT_INJECTION / LEGAL_OR_COMPLIANCE / UNSUPPORTED_REQUEST
    CheckP2 --> HUMAN_REVIEW : LOW_CONFIDENCE (below 0.42) / NO_PRECEDENT (top-1 similarity below threshold)
    CheckP2 --> HUMAN_REVIEW : UNGROUNDED_DRAFT / UNSUPPORTED_LANGUAGE / ENGINE_DEGRADED
    CheckP2 --> AUTO_DRAFT : no reason
    ESCALATE_ONCALL --> [*]
    HUMAN_REVIEW --> [*]
    AUTO_DRAFT --> [*]
```

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
