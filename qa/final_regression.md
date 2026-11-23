# TriageAI Final Regression Checklist & Backup Runbook (QA-11)

**Phase:** Harden & Freeze (4:00 – 4:30)  
**Target:** 100% verification across all sub-systems prior to 4:20 code freeze.  
**Auditor:** QA Lead  

---

## 1. Pre-freeze checklist

Status is what was verified on 2026-11-21 on a laptop, without the cloud keys. Rows marked **Run on the stack** need the deployed engine (Redis + LLM) and must be ticked by whoever runs them.

| # | Check | Expected | Command | Status |
| :-: | :--- | :--- | :--- | :-: |
| **1** | Frontend tests | 15/15 pass | `cd frontend && npm test` | ✅ 15/15 |
| **2** | Frontend build | No errors | `cd frontend && npm run build` | ✅ |
| **3** | Python tests (engine + ML) | All pass, 1 skipped without Redis | `python -m pytest` | ✅ |
| **4** | Go gateway tests | All pass | `cd backend && go test ./...` | ✅ |
| **5** | Leakage audit on the real split | 7/7 checks pass | `python -m ml.split && python qa/audit_leakage.py` | ✅ 7/7 |
| **6** | Holdout metrics reproduce | type 0.894, priority 0.704, queue 0.639 macro-F1 (blend); 0.859 / 0.592 / 0.528 classifier alone | `python -m ml.train && python -m ml.tune_blend && python -m ml.evaluate --blend` | ✅ |
| **7** | Golden set against the real pipeline | 30/30 expected gate decisions | `python qa/run_golden_set.py --endpoint <host>/api/v1/triage` | Run on the stack |
| **8** | Cloud access | OpenAI, R2, Redis say OK | `python infra/check_access.py` | Run on the stack |
| **9** | No secrets in git | `.env` and `ml/artifacts/` ignored | `git check-ignore -v .env ml/artifacts/` | ✅ |
| **10** | Outage drill | Banner appears, `ACTIVE_OUTAGE` fires | Overview → "Outage drill" | Run on the stack |
| **11** | Keyboard | `/` focuses search, Esc closes dialogs, ← → step through precedents | In the console | ✅ |

Without `--endpoint`, `run_golden_set.py` only checks the golden set against its own keyword lists, and `score_drafts.py` scores the sample drafts written into the script. Neither exercises the real engine, so neither replaces row 7.

---

## 🛡️ 2. Disaster Recovery & Offline Backup Plan

In live hackathons and high-stakes judge presentations, network drops, rate-limit bans, or port collisions can occur. TriageAI maintains a **4-tier defense-in-depth redundancy**:

### Tier 1: Engine degraded, stack still up
- **When:** OpenAI and Gemini fail, or time out (`LLM_TIMEOUT_S`, 10 s).
- **What happens:** the engine quotes the best precedent verbatim (extractive) or writes a holding reply and raises `ENGINE_DEGRADED`. Triage, retrieval and the gate keep working. Nothing to switch.

### Tier 2: Gateway mock mode (engine or Redis down)
- **Activation:** restart the gateway with `MOCK_ENGINE=true` (`backend/internal/engine/mock.go`).
- **What happens:** the gateway answers with the contract's example responses, picked by keyword, with real IDs, timings and PII masking. The deployed console keeps working.

### Tier 3: In-browser mock engine (no network)
- **Activation:** `cd frontend && npm run dev` (the mock is the default in dev), or build with `VITE_USE_MOCK=true`.
- **What happens:** `frontend/src/api/mockEngine.js` runs the whole contract in the browser, including the sample scenarios and the outage simulation.

### Tier 4: Screen recording
- Record one run of `docs/demo-script.md` on the presenter laptop before the demo. It is not stored in the repo.
