"""两步验证: TOTP (RFC 6238, SHA-1, 6 digits, 30 s), compatible with Google Authenticator,
Microsoft Authenticator, 1Password, 腾讯身份验证器 and similar apps. Stdlib only."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
import urllib.parse

STEP = 30
DIGITS = 6
WINDOW = 1  # accept the previous / next code too (clock drift)


def new_secret() -> str:
    """160-bit secret, base32 without padding (what authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, step: int) -> str:
    mac = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    n = struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF
    return str(n % 10 ** DIGITS).zfill(DIGITS)


def verify(secret: str, code: str, last_step: int | None = None, now: float | None = None) -> int | None:
    """Matched time step, or None. Steps at or before `last_step` are refused (no replay)."""
    code = (code or "").strip().replace(" ", "")
    if not (len(code) == DIGITS and code.isdigit()):
        return None
    current = int((now if now is not None else time.time()) // STEP)
    for step in range(current - WINDOW, current + WINDOW + 1):
        if last_step is not None and step <= last_step:
            continue
        if hmac.compare_digest(code_at(secret, step), code):
            return step
    return None


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    label = urllib.parse.quote("%s:%s" % (issuer, account))
    q = urllib.parse.urlencode({"secret": secret, "issuer": issuer, "digits": DIGITS, "period": STEP})
    return "otpauth://totp/%s?%s" % (label, q)
