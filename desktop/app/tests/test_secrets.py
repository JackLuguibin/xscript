"""SecretStore: names can be listed, values cannot leave the backend (design §5.2)."""
from __future__ import annotations

import json

import pytest

from xscript_desktop.services.secrets import (
    KeyringBackend, MemoryBackend, NameIndex, SecretError, SecretStore, redact,
)
from xscript_desktop.services.store import AppStore
from xscript_desktop.services.tool_pages import classify_navigation, tool_url


SECRET = "super-secret-value"


def test_redact_replaces_every_copy():
    assert redact("nope " + SECRET + " / " + SECRET, SECRET) == "nope *** / ***"
    assert SECRET not in redact("x", "")


def test_round_trip_lists_names_only():
    store = SecretStore(MemoryBackend(), NameIndex(None))
    assert store.set("env", "API_TOKEN", SECRET) == {"ok": True, "kind": "env", "name": "API_TOKEN"}
    listed = json.dumps(store.list_slots())
    assert SECRET not in listed
    assert store.list_slots()["slots"] == [{"kind": "env", "name": "API_TOKEN"}]
    assert store.has("env", "API_TOKEN") == {"present": True}
    assert store.backend.get("xscript", "env:API_TOKEN") == SECRET  # the backend still has it
    assert store.set("backend", "HTTPS://Example.COM/ ", "tok")["name"] == "https://example.com"
    assert store.delete("env", "API_TOKEN") == {"deleted": True}
    assert store.has("env", "API_TOKEN") == {"present": False}
    assert store.backend.get("xscript", "env:API_TOKEN") is None


def test_value_is_absent_from_the_database_and_the_name_index(tmp_path):
    db = AppStore(tmp_path / "desktop.db")
    secrets = SecretStore(MemoryBackend(), NameIndex(tmp_path / "slot-index.json"))
    secrets.set("env", "API_TOKEN", SECRET)
    secrets.set("device", "adb:emulator-5554", SECRET + "-device")
    db.close()
    blob = b"".join(p.read_bytes() for p in tmp_path.iterdir() if p.is_file())
    assert SECRET.encode() not in blob
    assert b"API_TOKEN" in blob  # the name is not a secret
    again = NameIndex(tmp_path / "slot-index.json")
    assert "env\tAPI_TOKEN" in again.load()


def test_rejected_names_and_values():
    store = SecretStore(MemoryBackend(), NameIndex(None))
    with pytest.raises(ValueError):
        store.set("env", "has-dash", SECRET)
    with pytest.raises(ValueError):
        store.set("backend", "http://10.0.0.8", SECRET)
    with pytest.raises(ValueError):
        store.set("backend", "https://ok.example/path", SECRET)
    with pytest.raises(ValueError):
        store.set("device", "adb:", SECRET)
    with pytest.raises(ValueError):
        store.set("nope", "API_TOKEN", SECRET)
    with pytest.raises(ValueError):
        store.set("env", "API_TOKEN", "")
    with pytest.raises(ValueError):
        store.set("env", "API_TOKEN", "x" * 4097)
    assert store.list_slots()["slots"] == []


def test_backend_failure_does_not_keep_the_value_or_report_it():
    class Boom(MemoryBackend):
        def set(self, service, user, value):
            raise RuntimeError("disk full " + value)

    store = SecretStore(Boom(), NameIndex(None))
    with pytest.raises(SecretError) as ei:
        store.set("env", "API_TOKEN", SECRET)
    assert ei.value.code == "secret.unavailable"
    assert SECRET not in ei.value.message
    assert store.list_slots()["slots"] == []


def test_index_failure_rolls_back_a_new_secret(tmp_path):
    class BadIndex(NameIndex):
        def save(self, rows):
            raise OSError("read only")

    backend = MemoryBackend()
    store = SecretStore(backend, BadIndex(None))
    with pytest.raises(SecretError):
        store.set("env", "API_TOKEN", SECRET)
    assert backend.get("xscript", "env:API_TOKEN") is None


def test_list_drops_a_name_whose_value_was_removed():
    backend = MemoryBackend()
    store = SecretStore(backend, NameIndex(None))
    store.set("env", "API_TOKEN", SECRET)
    backend.delete("xscript", "env:API_TOKEN")
    assert store.list_slots()["slots"] == []


def test_slot_cap():
    store = SecretStore(MemoryBackend(), NameIndex(None))
    for i in range(64):
        store.set("env", "K%d" % i, "v")
    with pytest.raises(SecretError) as ei:
        store.set("env", "OVERFLOW", "v")
    assert ei.value.code == "secret.full"
    store.set("env", "K0", "replaced")  # updating an existing slot is not a new one
    assert store.backend.get("xscript", "env:K0") == "replaced"


def test_keyring_backend_redacts_the_value(monkeypatch):
    import sys
    import types

    mod = types.ModuleType("keyring")

    def set_password(service, user, value):
        raise RuntimeError("denied " + value)

    mod.set_password = set_password
    mod.get_password = lambda service, user: None
    errors = types.ModuleType("keyring.errors")
    errors.PasswordDeleteError = type("PasswordDeleteError", (Exception,), {})
    monkeypatch.setitem(sys.modules, "keyring", mod)
    monkeypatch.setitem(sys.modules, "keyring.errors", errors)
    with pytest.raises(SecretError) as ei:
        KeyringBackend().set("xscript", "env:API_TOKEN", SECRET)
    assert SECRET not in ei.value.message


def test_tool_url_ignores_anything_but_the_device_origin():
    assert tool_url("127.0.0.1", 41000, "color") == "http://127.0.0.1:41000/tools/ui/color.html"
    assert tool_url("::1", 9860, "home") == "http://[::1]:9860/tools/"
    with pytest.raises(ValueError):
        tool_url("127.0.0.1", 41000, "editor")
    assert classify_navigation("http", "127.0.0.1", 41000, False, "127.0.0.1", 41000) == "allow"
    assert classify_navigation("data", "", -1, False, "127.0.0.1", 41000) == "allow"
    assert classify_navigation("https", "example.com", 443, True, "127.0.0.1", 41000) == "external"
    assert classify_navigation("file", "", -1, False, "127.0.0.1", 41000) == "block"
    assert classify_navigation("http", "evil.test", 41000, False, "127.0.0.1", 41000) == "block"
    assert classify_navigation("http", "127.0.0.1", 9, False, "127.0.0.1", 41000) == "block"
