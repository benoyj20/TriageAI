"""Wait for the stack to be ready, then send two warm-up tickets (loads models, opens the Gemini connection).

    python infra/warmup.py http://localhost            # through the gateway
    python infra/warmup.py http://localhost:8000 --engine

Run it after every deploy so the first judge ticket isn't a cold start. Exit code 1 if the
stack never became ready or a ticket failed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

TICKETS = [
    {"subject": "Password reset link not arriving", "body": "I requested a password reset three times but the email never arrives."},
    {"subject": "VPN ausgefallen", "body": "Seit heute früh können sich unsere Standorte nicht mit dem VPN verbinden. Bitte dringend prüfen."},
]


def call(url: str, payload: dict | None = None, timeout: float = 30) -> tuple[int, dict]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="Gateway or engine base URL")
    ap.add_argument("--engine", action="store_true", help="Talk to the engine directly (/healthz, /v1/triage)")
    ap.add_argument("--wait", type=int, default=120, help="Seconds to wait for readiness")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    health, triage = ("/readyz", "/v1/triage") if args.engine else ("/api/v1/health", "/api/v1/triage")

    deadline = time.monotonic() + args.wait
    while True:
        try:
            status, body = call(base + health, timeout=5)
            if status == 200:
                print(f"ready: {body}")
                break
        except (urllib.error.URLError, OSError, ValueError):
            pass
        if time.monotonic() > deadline:
            print(f"FAIL  {base}{health} not ready after {args.wait}s")
            return 1
        time.sleep(2)

    ok = True
    for ticket in TICKETS:
        t0 = time.monotonic()
        # WARMUP- IDs keep these out of the live burst window (the engine's demo window takes them).
        status, body = call(base + triage, {**ticket, "ticket_id": f"WARMUP-{int(time.time())}-{TICKETS.index(ticket)}"})
        ms = (time.monotonic() - t0) * 1000
        if status == 200:
            print(f"OK    {ms:7.0f} ms  {body['gate']['decision']:<16} draft={body['draft']['mode']:<10} {ticket['subject']}")
        else:
            ok = False
            print(f"FAIL  {status} {body.get('error', body)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
