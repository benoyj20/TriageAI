"""ML-02 / ML-04: load the exact dataset files, clean text, normalise labels, dedupe."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from engine.app.analyze.textproc import clean_text  # shared with serving
from ml import config as C



def fetch(filename: str, dest: Path = C.RAW_DIR) -> Path:
    """Download one CSV from the pinned HF revision (public, no auth)."""
    from huggingface_hub import hf_hub_download

    dest.mkdir(parents=True, exist_ok=True)
    return Path(hf_hub_download(C.HF_REPO, filename, repo_type="dataset",
                                revision=C.HF_REVISION, local_dir=dest))


def norm_key(s) -> str:
    """Dedupe key: lowercased, whitespace-collapsed body."""
    return clean_text(s).lower()


def norm_priority(p) -> str | None:
    if p is None or (isinstance(p, float) and pd.isna(p)):
        return None
    return C.PRIORITY_MAP.get(str(p).strip().lower().replace("-", "_"), None)


def normalise(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    for col in ("subject", "body"):
        df[col] = df[col].map(clean_text) if col in df else ""
    if "priority" in df:
        df["priority_raw"] = df["priority"]
        df["priority"] = df["priority"].map(norm_priority)
    for col in ("type", "queue", "language", "answer"):
        if col in df:
            df[col] = df[col].map(lambda v: clean_text(v) or None)
    return df


def load_main(primary: Path | None = None, extra: Path | None = None,
              use_extra: bool = True) -> pd.DataFrame:
    """Primary CSV plus the unique rows of the 20k CSV, deduped on normalised body."""
    primary = primary or fetch(C.PRIMARY_FILE)
    frames = [normalise(pd.read_csv(primary))]
    if use_extra:
        extra = extra or fetch(C.EXTRA_FILE)
        frames.append(normalise(pd.read_csv(extra)))
    df = pd.concat(frames, ignore_index=True, sort=False)
    df = df[df["body"].str.len() > 0]
    df = df.loc[~df["body"].map(norm_key).duplicated(keep="first")]
    df = df.dropna(subset=["queue", "priority", "type"]).reset_index(drop=True)
    return df


def load_german(path: Path | None = None) -> pd.DataFrame:
    """German topic file: subject/body/queue/priority/language only. Miscellaneous branch, never a precedent."""
    path = path or fetch(C.GERMAN_FILE)
    df = normalise(pd.read_csv(path))
    df = df[df["body"].str.len() > 0]
    df = df.loc[~df["body"].map(norm_key).duplicated(keep="first")].reset_index(drop=True)
    return df


def label_report(df: pd.DataFrame) -> dict:
    """ML-02: label inspection that goes into the manifest."""
    rep = {"rows": int(len(df))}
    for t in C.TARGETS:
        if t in df:
            rep[t] = {k: int(v) for k, v in df[t].value_counts().items()}
    if "language" in df:
        rep["language"] = {k: int(v) for k, v in df["language"].value_counts().items()}
    if "subject" in df:
        rep["empty_subject"] = int((df["subject"] == "").sum())
    return rep
