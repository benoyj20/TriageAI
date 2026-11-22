"""Cloudflare R2 access (S3 API) and the startup artifact sync (task H-06).

``sync_artifacts`` pulls everything the engine needs into a local cache folder:

    models/<version>/      classifiers, labels, calibration, thresholds   (ML engineer)
    policy/<version>/      policy.yaml overrides                           (optional)

Files already in the cache with the same size are skipped, so restarts are quick.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from engine.app.settings import Settings, get_settings

log = logging.getLogger("sentineldesk.r2")


class ArtifactError(RuntimeError):
    pass


def make_client(settings: Settings | None = None) -> Any:
    s = settings or get_settings()
    if not s.r2_configured:
        raise ArtifactError("R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.")
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=s.r2_endpoint,
        aws_access_key_id=s.r2_access_key_id,
        aws_secret_access_key=s.r2_secret_access_key,
        region_name="auto",
    )


def list_keys(client: Any, bucket: str, prefix: str) -> list[tuple[str, int]]:
    keys: list[tuple[str, int]] = []
    token = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        page = client.list_objects_v2(**kwargs)
        keys += [(o["Key"], o["Size"]) for o in page.get("Contents", []) if not o["Key"].endswith("/")]
        if not page.get("IsTruncated"):
            return keys
        token = page["NextContinuationToken"]


@dataclass
class SyncReport:
    version: str
    downloaded: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.downloaded) + len(self.skipped)


def sync_prefix(client: Any, bucket: str, prefix: str, dest: Path) -> tuple[list[str], list[str]]:
    downloaded, skipped = [], []
    for key, size in list_keys(client, bucket, prefix):
        target = dest / key[len(prefix) :]
        if target.exists() and target.stat().st_size == size:
            skipped.append(key)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".part")
        client.download_file(bucket, key, str(tmp))
        tmp.replace(target)
        downloaded.append(key)
    return downloaded, skipped


def sync_artifacts(settings: Settings | None = None, client: Any = None) -> SyncReport:
    """Download models/<version>/ into <cache>/models/. Raises ArtifactError with a clear message."""
    s = settings or get_settings()
    client = client or make_client(s)
    prefix = f"models/{s.artifact_version}/"
    try:
        downloaded, skipped = sync_prefix(client, s.r2_bucket, prefix, s.artifact_cache / "models")
    except Exception as exc:  # noqa: BLE001
        raise ArtifactError(f"Could not sync {prefix} from bucket {s.r2_bucket}: {type(exc).__name__}: {exc}") from exc
    report = SyncReport(version=s.artifact_version, downloaded=downloaded, skipped=skipped)
    if report.total == 0:
        raise ArtifactError(f"No artifacts found under {prefix} in bucket {s.r2_bucket}. The ML engineer uploads them (ML-05).")
    log.info("artifacts %s: %d downloaded, %d cached", s.artifact_version, len(downloaded), len(skipped))
    return report


def upload_dir(local: Path, prefix: str, settings: Settings | None = None, client: Any = None) -> list[str]:
    """Upload every file under ``local`` to ``prefix`` in the bucket. Returns the keys written."""
    s = settings or get_settings()
    client = client or make_client(s)
    keys = []
    for f in sorted(p for p in Path(local).rglob("*") if p.is_file()):
        key = prefix.rstrip("/") + "/" + f.relative_to(local).as_posix()
        client.upload_file(str(f), s.r2_bucket, key)
        keys.append(key)
    return keys


def main(argv: list[str] | None = None) -> int:
    """python -m engine.app.common.r2 upload <local_dir> <prefix> | put <file> <key> | get <key> <file>"""
    import sys

    args = argv if argv is not None else sys.argv[1:]
    s = get_settings()
    c = make_client(s)
    if len(args) == 3 and args[0] == "upload":
        for k in upload_dir(Path(args[1]), args[2], s, c):
            print("uploaded", k)
    elif len(args) == 3 and args[0] == "put":
        c.upload_file(args[1], s.r2_bucket, args[2])
        print("uploaded", args[2])
    elif len(args) == 3 and args[0] == "get":
        Path(args[2]).parent.mkdir(parents=True, exist_ok=True)
        c.download_file(s.r2_bucket, args[1], args[2])
        print("downloaded", args[1], "->", args[2])
    else:
        print(main.__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
