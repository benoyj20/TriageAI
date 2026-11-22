# Data leakage audit (QA-09)

**Run:** 2026-11-21 19:10 UTC, by `python qa/audit_leakage.py`
**Dataset:** `Tobi-Bueck/customer-support-tickets` at revision `ddf1c81a5475`, files: `aa_dataset-tickets-multi-lang-5-2-50-version.csv`, `dataset-tickets-multi-lang-4-20k.csv`, `dataset-tickets-german_normalized_50_5_2.csv`
**Rows after de-duplicating on normalised body:** 40,167
**Result:** all checks pass

## Checks

| Check | Detail | Result |
|---|---|---|
| KB and holdout ticket IDs are disjoint | 0 shared IDs | Pass |
| Every row lands in exactly one split | 32,133 KB + 8,034 holdout = 40,167 rows | Pass |
| 80/20 split with random_state=42 | 80.0% / 20.0%, seed 42 | Pass |
| Inference inputs hold only ticket_id, subject, body | columns: ticket_id, subject, body | Pass |
| No holdout `answer` is saved anywhere | none | Pass |
| No holdout body appears verbatim in the KB | 0 duplicated bodies | Pass |
| Files match the checksums recorded at split time | all match | Pass |

## Split files

| File | Rows | Use | SHA-256 |
|---|---:|---|---|
| `kb_train.csv` | 32,133 | 80% knowledge base: training, calibration (last 10% = kb_val) and RAG index | `208042e032240c4b34e51332a322506a01bd9d0dd32672a7984046eebd31dea7` |
| `test_inputs.csv` | 8,034 | 20% holdout, inference inputs only | `5a72975e9cea3bbe1a336062abcc0d1300392a89fa6f185c957148abcc9b8938` |
| `test_labels.csv` | 8,034 | 20% holdout labels, read only by `ml/evaluate.py` for scoring | `ff726822022a29e89fd4d13cffdff482170830bb611a9283df496bed5372ca1b` |

The split follows the brief exactly: `df.sample(frac=1.0, random_state=42)`, IDs `TKT-{i:05d}`, first 80% is the KB.
The German topic file (no answers) is split the same way and only its 80% is indexed, never as a citable precedent.
