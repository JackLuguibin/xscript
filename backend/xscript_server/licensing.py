"""卡密 token crypto (ECDSA P-256 / SHA-256), shared with the app's LicenseToken.kt.

Token: base64url(payload JSON) "." base64url(DER signature). Payload keys: card, device, app,
iat, exp (0 = permanent). The app embeds only the public key (base64 SubjectPublicKeyInfo DER).
Only depends on `cryptography`, so the CLI tools can import it without FastAPI.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_private():
    from cryptography.hazmat.primitives.asymmetric import ec

    return ec.generate_private_key(ec.SECP256R1())


def private_pem(key) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def load_private_pem(data: bytes):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("signing key must be an EC P-256 private key")
    return key


def load_private(path: str | os.PathLike):
    with open(path, "rb") as f:
        return load_private_pem(f.read())


def write_private(key, path: str | os.PathLike) -> None:
    """Write with mode 0600; refuses to overwrite (replacing a key breaks every shipped app)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(private_pem(key))


def public_b64(private_key) -> str:
    """Base64 SubjectPublicKeyInfo DER, the format BuildConfig.LICENSE_PUBKEY expects."""
    from cryptography.hazmat.primitives import serialization

    der = private_key.public_key().public_bytes(serialization.Encoding.DER,
                                                serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(der).decode("ascii")


def keygen(out_dir: str | os.PathLike) -> tuple[str, str]:
    """private.pem + public.b64 in out_dir. Exits if a key already exists."""
    priv_path = os.path.join(out_dir, "private.pem")
    if os.path.exists(priv_path):
        raise SystemExit("%s exists; refusing to overwrite a signing key" % priv_path)
    key = generate_private()
    write_private(key, priv_path)
    pub = public_b64(key)
    with open(os.path.join(out_dir, "public.b64"), "w") as f:
        f.write(pub + "\n")
    return priv_path, pub


def sign(private_key, payload: dict[str, Any]) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = private_key.sign(body, ec.ECDSA(hashes.SHA256()))
    return b64url(body) + "." + b64url(sig)


def verify(public_key_b64: str, token: str) -> dict[str, Any] | None:
    """Payload if the signature is valid (no device / expiry checks), else None."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        pub = serialization.load_der_public_key(base64.b64decode(public_key_b64))
        body_s, sig_s = token.strip().split(".")
        body = b64url_decode(body_s)
        pub.verify(b64url_decode(sig_s), body, ec.ECDSA(hashes.SHA256()))
        payload = json.loads(body.decode("utf-8"))
        return payload if isinstance(payload, dict) else None
    except (ValueError, TypeError, InvalidSignature):
        return None


def new_card(prefix: str = "XS") -> str:
    groups = ["".join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(4)]
    return prefix + "-" + "-".join(groups)


def issue(private_key, device: str, days: float = 0, app: str = "*", card: str | None = None,
          now: float | None = None) -> tuple[str, dict[str, Any]]:
    """Offline token for one device (or "*" for any device)."""
    now = int(now or time.time())
    payload = {
        "card": card or new_card(),
        "device": device or "*",
        "app": app or "*",
        "iat": now,
        "exp": now + int(days * 86400) if days else 0,
    }
    return sign(private_key, payload), payload
