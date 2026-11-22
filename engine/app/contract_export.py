"""Regenerate contracts/schema/*.json from engine/app/schemas.py.

    python -m engine.app.contract_export

engine/tests/test_contract.py fails when the committed files are out of date.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from engine.app.schemas import (
    EngineHealth,
    EngineTriageRequest,
    EngineTriageResponse,
    ErrorResponse,
    GatewayHealth,
    TriageRequest,
    TriageResponse,
)

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "contracts" / "schema"

SCHEMAS: dict[str, tuple[type[BaseModel], str]] = {
    "triage_request.schema.json": (TriageRequest, "validation"),
    "triage_response.schema.json": (TriageResponse, "serialization"),
    "error.schema.json": (ErrorResponse, "serialization"),
    "health.schema.json": (GatewayHealth, "serialization"),
    "engine_triage_request.schema.json": (EngineTriageRequest, "validation"),
    "engine_triage_response.schema.json": (EngineTriageResponse, "serialization"),
    "engine_health.schema.json": (EngineHealth, "serialization"),
}


def render() -> dict[str, str]:
    out = {}
    for name, (model, mode) in SCHEMAS.items():
        schema = {"$schema": "https://json-schema.org/draft/2020-12/schema", **model.model_json_schema(mode=mode)}
        out[name] = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
    return out


def main() -> None:
    SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in render().items():
        (SCHEMA_DIR / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote contracts/schema/{name}")


if __name__ == "__main__":
    main()
