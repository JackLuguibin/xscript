"""Passwords (scrypt), opaque tokens (stored as SHA-256) and a login throttle."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time

ROLES = {"viewer": 0, "operator": 1, "admin": 2}
MIN_PASSWORD = 8

_N, _R, _P = 2 ** 14, 8, 1


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return "scrypt$%d$%d$%d$%s$%s" % (_N, _R, _P, _b64(salt), _b64(dk))


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), n=int(n), r=int(r),
                             p=int(p), dklen=len(base64.b64decode(dk)))
        return hmac.compare_digest(got, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


# Verifying against this keeps the response time the same for unknown usernames.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def check_password_policy(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise ValueError("密码至少 %d 位" % MIN_PASSWORD)


def new_secret(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginLimiter:
    """After `limit` failures for one ip+username, refuse attempts for `lock_s` seconds."""

    def __init__(self, limit: int = 5, lock_s: int = 300):
        self.limit, self.lock_s = limit, lock_s
        self._fails: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def blocked(self, key: str) -> int:
        with self._lock:
            count, until = self._fails.get(key, (0, 0.0))
            left = until - time.time()
            return int(left) + 1 if count >= self.limit and left > 0 else 0

    def fail(self, key: str) -> None:
        with self._lock:
            count, until = self._fails.get(key, (0, 0.0))
            if until and until < time.time():
                count = 0
            count += 1
            self._fails[key] = (count, time.time() + self.lock_s)
            if len(self._fails) > 10000:
                self._fails.clear()

    def reset(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)
