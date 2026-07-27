#!/usr/bin/env python3
"""Regenerate the deterministic Python envelope fixture. Run from repo root."""

import base64
import hashlib
import hmac
import json
from pathlib import Path


def base64url_unpadded(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


secret = "test-secret"
nonce = "3b241101-e2bb-4255-8caf-4136c566a962"
timestamp = 1700000000
payload = {
    "action": "create_transaction",
    "idempotencyKey": nonce,
    "transaction": {
        "type": "支出",
        "date": "2026-07-26",
        "time": "12:30",
        "amount": 260,
        "currency": "TWD",
        "account": "現金",
        "category": "食-外食",
        "payee": "路易莎",
        "description": "午餐",
    },
}

payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
payload_b64 = base64url_unpadded(payload_json.encode("utf-8"))
signing_input = f"{timestamp}.{nonce}.{payload_b64}"
signature = hmac.new(
    secret.encode("utf-8"),
    signing_input.encode("utf-8"),
    hashlib.sha256,
).digest()
envelope = {
    "ts": timestamp,
    "nonce": nonce,
    "payload": payload_b64,
    "sig": base64url_unpadded(signature),
}
output = {"secret": secret, "input": payload, "envelope": envelope}

output_path = Path("tests/fixtures/create-envelope.json")
output_path.parent.mkdir(parents=True, exist_ok=True)
output_path.write_text(
    json.dumps(output, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(f"wrote {output_path}")
