"""Credential store (design §5.2 SecretStore, §6).

Values go to the OS keyring (Windows Credential Manager through the ``keyring`` package;
macOS Keychain). Tests inject ``MemoryBackend``. A slot's *name* is remembered in
``slot-index.json`` next to the database so the settings page can list them.

The value is never written to SQLite, never written to the index file, never returned
from an RPC, and never placed in an exception message.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

SERVICE = "xscript"
MAX_SLOTS = 64
MAX_VALUE = 4096
_ENV = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_DEVICE = re.compile(r"^(?:adb|lan|relay):[A-Za-z0-9_.:@\[\]-]{1,180}$")


class SecretError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def redact(message: str, secret: str) -> str:
    if secret:
        message = message.replace(secret, "***")
    return message[:300]


class SecretBackend(Protocol):
    def get(self, service: str, user: str) -> str | None: ...
    def set(self, service: str, user: str, value: str) -> None: ...
    def delete(self, service: str, user: str) -> bool: ...


class MemoryBackend:
    """Process-local stand-in. The real app swaps in ``KeyringBackend`` after startup."""

    def __init__(self) -> None:
        self.data: dict[tuple[str, str], str] = {}

    def get(self, service: str, user: str) -> str | None:
        return self.data.get((service, user))

    def set(self, service: str, user: str, value: str) -> None:
        self.data[(service, user)] = value

    def delete(self, service: str, user: str) -> bool:
        return self.data.pop((service, user), None) is not None


class KeyringBackend:
    """OS credential store. Imported lazily so unit tests never touch the login keychain."""

    def get(self, service: str, user: str) -> str | None:
        keyring = _keyring()
        try:
            return keyring.get_password(service, user)
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), "")) from None

    def set(self, service: str, user: str, value: str) -> None:
        keyring = _keyring()
        try:
            keyring.set_password(service, user, value)
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), value)) from None

    def delete(self, service: str, user: str) -> bool:
        keyring = _keyring()
        from keyring.errors import PasswordDeleteError

        try:
            keyring.delete_password(service, user)
            return True
        except PasswordDeleteError:
            return False
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), "")) from None


def _keyring():
    try:
        import keyring
    except ImportError as e:  # pragma: no cover - declared dependency
        raise SecretError("secret.unavailable", "未安装 keyring") from e
    return keyring


class NameIndex:
    """Slot names only (``kind<TAB>name``). ``path is None`` keeps them in memory (tests, --selftest)."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._mem: list[str] = []

    def load(self) -> list[str]:
        if self.path is None:
            return list(self._mem)
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        return [x for x in data if isinstance(x, str)]

    def save(self, rows: list[str]) -> None:
        if self.path is None:
            self._mem = list(rows)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(rows, ensure_ascii=False)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(self.path)


@dataclass(frozen=True)
class Slot:
    kind: str
    name: str

    @property
    def user(self) -> str:
        return "%s:%s" % (self.kind, self.name)

    def to_row(self) -> str:
        return "%s\t%s" % (self.kind, self.name)


def normalize(kind: str, name: str) -> Slot:
    if kind == "env":
        if not _ENV.fullmatch(name or ""):
            raise ValueError("env secret name must be an identifier")
        return Slot("env", name)
    if kind == "device":
        if not _DEVICE.fullmatch(name or ""):
            raise ValueError("device secret name must look like adb:<serial> or lan:<host>:<port>")
        return Slot("device", name)
    if kind == "backend":
        return Slot("backend", _backend_url(name))
    raise ValueError("secret kind must be env, device, or backend")


def _backend_url(value: str) -> str:
    parts = urlsplit((value or "").strip())
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("backend address must be an origin, with no path, user, or query")
    host = (parts.hostname or "").lower()
    if parts.scheme == "https":
        pass
    elif parts.scheme == "http" and host in ("localhost", "127.0.0.1", "::1"):
        pass
    else:
        raise ValueError("backend address must be https, or http on localhost")
    if not host or any(c in host for c in " \t\r\n"):
        raise ValueError("backend address has no host")
    port = parts.port
    default = (parts.scheme == "https" and port == 443) or (parts.scheme == "http" and port == 80)
    if ":" in host:
        netloc = "[%s]" % host
    else:
        netloc = host
    if port and not default:
        netloc = "%s:%d" % (netloc, port)
    return "%s://%s" % (parts.scheme, netloc)


def _check_value(value: str) -> None:
    if not isinstance(value, str) or value == "" or "\0" in value or len(value) > MAX_VALUE:
        raise ValueError("secret value must be 1–%d characters and contain no NUL" % MAX_VALUE)


class SecretStore:
    def __init__(self, backend: SecretBackend, index: NameIndex) -> None:
        self.backend = backend
        self.index = index

    def _slots(self) -> list[Slot]:
        out: list[Slot] = []
        for row in self.index.load():
            kind, sep, name = row.partition("\t")
            if not sep:
                continue
            try:
                out.append(normalize(kind, name))
            except ValueError:
                continue
        return out

    def set(self, kind: str, name: str, value: str) -> dict[str, object]:
        slot = normalize(kind, name)
        _check_value(value)
        current = [s for s in self._slots() if s.user != slot.user]
        if len(current) >= MAX_SLOTS:
            raise SecretError("secret.full", "最多保存 %d 条凭据" % MAX_SLOTS)
        try:
            prior = self.backend.get(SERVICE, slot.user)
        except SecretError:
            raise
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), value)) from None
        try:
            self.backend.set(SERVICE, slot.user, value)
        except SecretError:
            raise
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), value)) from None
        try:
            self.index.save([s.to_row() for s in current + [slot]])
        except Exception:
            if prior is None:
                try:
                    self.backend.delete(SERVICE, slot.user)
                except Exception:
                    pass
            raise SecretError("secret.unavailable", "无法记下凭据名称") from None
        return {"ok": True, "kind": slot.kind, "name": slot.name}

    def reveal(self, kind: str, name: str) -> str | None:
        """The stored value, for in-process use only (e.g. a device pairing code). Never returned over RPC."""
        slot = normalize(kind, name)
        try:
            return self.backend.get(SERVICE, slot.user)
        except SecretError:
            raise
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), "")) from None

    def delete(self, kind: str, name: str) -> dict[str, object]:
        slot = normalize(kind, name)
        try:
            removed = self.backend.delete(SERVICE, slot.user)
        except SecretError:
            raise
        except Exception as e:
            raise SecretError("secret.unavailable", redact(str(e), "")) from None
        self.index.save([s.to_row() for s in self._slots() if s.user != slot.user])
        return {"deleted": bool(removed)}

    def has(self, kind: str, name: str) -> dict[str, object]:
        slot = normalize(kind, name)
        try:
            present = self.backend.get(SERVICE, slot.user) is not None
        except SecretError:
            raise
        except Exception:
            raise SecretError("secret.unavailable", "系统凭据库不可用") from None
        return {"present": present}

    def list_slots(self) -> dict[str, object]:
        live: list[Slot] = []
        changed = False
        for slot in self._slots():
            try:
                present = self.backend.get(SERVICE, slot.user) is not None
            except Exception:
                present = True  # a keychain hiccup must not forget the name
            if present:
                live.append(slot)
            else:
                changed = True
        if changed:
            self.index.save([s.to_row() for s in live])
        return {"slots": [{"kind": s.kind, "name": s.name} for s in live]}
