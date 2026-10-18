"""Saved devices and the application database (design §14.5).

SQLite on one worker thread: schema v1, WAL, upgrade backup, no downgrade, corrupt-file quarantine,
and the rule that an adb row stores the serial — never the auto-assigned forward port. No secrets.
"""
from __future__ import annotations

import json
import sqlite3
import threading

import pytest

from xscript_desktop.context import AppContext
from xscript_desktop.services.adb import AdbService
from xscript_desktop.services.device_client import DeviceClient, DeviceTarget
from xscript_desktop.services.store import SCHEMA_VERSION, AppStore, StoreError

from .conftest import FakeAdb

SHA = "a" * 40


def _ctx(fake: FakeAdb, data_dir) -> AppContext:
    ctx = AppContext(adb=AdbService(runner=fake), poll_interval=60, data_dir=data_dir)

    def factory(target: DeviceTarget) -> DeviceClient:
        port = getattr(fake, "target_for", {}).get(target.port, target.port)
        return DeviceClient(DeviceTarget(target.host, port))

    ctx.devices._factory = factory
    return ctx


async def rpc(ctx: AppContext, method: str, **params):
    return json.loads(await ctx.dispatcher.handle(json.dumps({"id": 1, "method": method, "params": params})))


def test_fresh_file_is_wal_with_schema_v1_and_no_backup(tmp_path):
    """A new desktop.db is WAL, foreign keys on, user_version 2 (devices + run history), and is not backed up (nothing to keep)."""
    store = AppStore(tmp_path / "desktop.db")
    try:
        assert store.user_version == SCHEMA_VERSION == 2
        assert store.pragma("journal_mode") == "wal"
        assert store.pragma("foreign_keys") == 1
        assert store.pragma("quick_check") == "ok"
        assert store.notice == ""
        assert list(tmp_path.glob("*.bak-v*")) == []
        cols = " ".join(store.columns("devices") + store.columns("settings") + store.columns("sync_cache"))
        assert "secret" not in cols and "token" not in cols and "password" not in cols
    finally:
        store.close()


def test_queries_run_on_the_store_thread_not_the_caller(tmp_path):
    """Design §14.5: the GUI / caller thread never touches the connection."""
    store = AppStore(tmp_path / "desktop.db")
    try:
        assert store.worker_ident() != threading.get_ident()
        with pytest.raises(RuntimeError):
            store._list_devices()
    finally:
        store.close()


async def test_async_queries_use_the_same_worker(tmp_path):
    store = AppStore(tmp_path / "desktop.db")
    try:
        ident = await store.aexec(lambda: threading.get_ident())
        assert ident == store.worker_ident() != threading.get_ident()
    finally:
        store.close()


def test_memory_store_for_tests_without_a_data_dir():
    store = AppStore(None)
    try:
        assert store.path is None and store.pragma("journal_mode") == "memory" and store.user_version == SCHEMA_VERSION
        saved = store.remember("lan:127.0.0.1:9860", "lan", "127.0.0.1:9860", "uid", "m", 1.5)
        assert saved.address == "127.0.0.1:9860" and store.list_devices()[0].id == saved.id
    finally:
        store.close()


def test_existing_empty_database_is_backed_up_before_upgrade(tmp_path):
    """user_version 0 on a file that already exists → desktop.db.bak-v0, then schema v1."""
    path = tmp_path / "desktop.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE legacy (x)")  # a write, so the file is a real database (user_version still 0)
    conn.commit()
    conn.close()
    store = AppStore(path)
    try:
        bak = tmp_path / "desktop.db.bak-v0"
        assert bak.is_file()
        bak_conn = sqlite3.connect(bak)
        assert bak_conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert bak_conn.execute("SELECT name FROM sqlite_master WHERE name='legacy'").fetchone() is not None
        bak_conn.close()
        assert store.user_version == SCHEMA_VERSION and store.pragma("quick_check") == "ok"
    finally:
        store.close()
    conn = sqlite3.connect(path)
    names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert "legacy" in names and "devices" in names


def test_newer_user_version_opens_read_only_and_does_not_downgrade(tmp_path):
    """A database from a newer app is readable and not rewritten (design §14.5)."""
    path = tmp_path / "desktop.db"
    store = AppStore(path)
    store.remember("adb:emulator-5554", "adb", "emulator-5554", "uid", "Pixel", 2.0)
    store.exec_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    store.close()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()
    again = AppStore(path)
    try:
        assert again.read_only and again.notice == "db.newer" and again.user_version == 3
        assert again.pragma("query_only") == 1
        assert again.list_devices()[0].model == "Pixel"
        with pytest.raises(StoreError) as err:
            again.update("adb:emulator-5554", {"name": "nope"})
        assert err.value.code == "db.newer"
        assert sqlite3.connect(path).execute("PRAGMA user_version").fetchone()[0] == 3
    finally:
        again.close()


def test_corrupt_file_is_renamed_and_replaced(tmp_path):
    path = tmp_path / "desktop.db"
    path.write_bytes(b"this is not a sqlite database")
    store = AppStore(path)
    try:
        assert store.notice == "db.corrupt" and store.notice_detail.startswith("desktop.db.corrupt-")
        assert (tmp_path / store.notice_detail).is_file()
        assert store.user_version == SCHEMA_VERSION and store.list_devices() == []
        store.remember("lan:10.0.0.2:9860", "lan", "10.0.0.2:9860", "", "", 1)
        assert store.pragma("quick_check") == "ok"
    finally:
        store.close()


def test_check_and_unique_constraints_and_relay_transport(tmp_path):
    store = AppStore(tmp_path / "desktop.db")
    try:
        store.exec_sql("INSERT INTO devices (id, transport, address, created_at) VALUES ('relay:abc','relay','abc',1)")
        assert store.get("relay:abc").transport == "relay"
        with pytest.raises(sqlite3.IntegrityError):
            store.exec_sql("INSERT INTO devices (id, transport, address, created_at) VALUES ('x','ftp','a',1)")
        with pytest.raises(sqlite3.IntegrityError):
            store.exec_sql("INSERT INTO devices (id, transport, address, created_at) VALUES ('adb:other','adb','emulator-1',1),"
                           "('adb:dup','adb','emulator-1',1)")
        store.exec_sql("INSERT INTO devices (id, transport, address, created_at) VALUES ('adb:emulator-1','adb','emulator-1',1)")
        with pytest.raises(sqlite3.IntegrityError):
            store.exec_sql("INSERT INTO devices (id, transport, address, created_at) VALUES ('adb:emulator-1b','adb','emulator-1',1)")
        with pytest.raises(sqlite3.IntegrityError):
            store.exec_sql("INSERT INTO devices (id, transport, address, auto_connect, created_at) VALUES ('lan:h:9','lan','h:9',2,1)")
        with pytest.raises(StoreError) as err:
            store.remember("adb:127.0.0.1:41000", "adb", "127.0.0.1:41000", "", "", 1)
        assert err.value.code == "db.bad_params"
    finally:
        store.close()


def test_settings_reject_secret_keys_and_sync_cache_round_trips(tmp_path):
    legacy = tmp_path / "sync-cache.json"
    legacy.write_text(json.dumps({
        "phone:proj": {"a.py": SHA, "../evil.py": SHA, "nope": "not-a-sha"},
        "not a key": {"a.py": SHA},
    }))
    store = AppStore(tmp_path / "desktop.db", legacy)
    try:
        assert store.cache_entries("phone", "proj") == [("a.py", SHA, 0)]
        assert not legacy.exists() and (tmp_path / "sync-cache.json.migrated").is_file()
        store.cache_put("phone", "proj", {"b.py": SHA}, {"b.py": 12})
        assert store.cache_get("phone", "proj") == {"b.py": SHA}
        assert store.cache_entries("phone", "proj") == [("b.py", SHA, 12)]
        with pytest.raises(StoreError):
            store.cache_put("phone", "proj", {"../x.py": SHA}, {})
        with pytest.raises(StoreError) as err:
            store.set_setting("api_token", "sekret")
        assert err.value.code == "db.secret"
        store.set_setting("adbPath", "/opt/adb")
        assert store.get_setting("adbPath") == "/opt/adb"
        store.delete_setting("adbPath")
        assert store.get_setting("adbPath") is None
    finally:
        store.close()


def test_update_preserves_identity_and_rejects_bad_text(tmp_path):
    store = AppStore(tmp_path / "desktop.db")
    try:
        store.remember("adb:emulator-5554", "adb", "emulator-5554", "uid", "Pixel", 1)
        saved = store.update("adb:emulator-5554", {"name": "实验室", "grp": "甲", "note": "门口", "auto_connect": True, "sort_order": 3})
        assert saved.name == "实验室" and saved.grp == "甲" and saved.note == "门口" and saved.auto_connect == 1 and saved.sort_order == 3
        assert saved.address == "emulator-5554"  # update must not invent a forward port
        again = store.remember("adb:emulator-5554", "adb", "emulator-5554", "uid2", "Pixel2", 9)
        assert again.name == "实验室" and again.device_id == "uid2" and again.model == "Pixel2" and again.auto_connect == 1
        with pytest.raises(StoreError) as err:
            store.update("adb:emulator-5554", {"name": "n" * 81})
        assert err.value.code == "db.bad_params"
        with pytest.raises(StoreError) as err:
            store.update("adb:missing", {"name": "x"})
        assert err.value.code == "db.not_found"
    finally:
        store.close()


async def test_connect_saves_the_serial_and_disconnect_keeps_an_offline_card(mock_device, tmp_path):
    """Connecting writes the row; disconnect closes the forward but the card stays. A failed connect writes nothing."""
    fake = FakeAdb([("emulator-5554", "device", mock_device), ("R5", "unauthorized", mock_device)])
    ctx = _ctx(fake, tmp_path)
    try:
        refused = await rpc(ctx, "device.connect", transport="adb", serial="R5")
        assert refused["error"]["code"] == "adb.not_ready" and ctx.store.list_devices() == []
        con = await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
        assert con["ok"] and con["result"]["saved"] is True and con["result"]["forwardPort"] == 41000
        assert ctx.store.get("adb:emulator-5554").address == "emulator-5554"
        assert "41000" not in ctx.store.dump_devices() and "127.0.0.1" not in ctx.store.dump_devices()
        renamed = await rpc(ctx, "device.update", id="adb:emulator-5554", name="实验室", group="甲", autoConnect=False)
        assert renamed["result"]["name"] == "实验室" and renamed["result"]["group"] == "甲"
        gone = await rpc(ctx, "device.disconnect", id="adb:emulator-5554")
        assert gone["result"]["removed"] is True and gone["result"]["device"]["state"] == "offline"
        assert fake.forwards == {} and ctx.devices.list() == []
        listed = (await rpc(ctx, "device.list"))["result"]["devices"]
        assert listed[0]["state"] == "offline" and listed[0]["name"] == "实验室" and listed[0]["forwardPort"] == 0
        assert (await rpc(ctx, "device.forget", id="adb:emulator-5554"))["result"]["forgotten"] is True
        assert (await rpc(ctx, "device.list"))["result"]["devices"] == []
    finally:
        await ctx.shutdown()


async def test_auto_connect_runs_only_for_flagged_rows_and_reallocates_the_forward(mock_device, tmp_path):
    """First connect opts a device in to auto-reconnect (design §14.5): the next start forwards by serial again.
    Turning it off for that device keeps it an offline card across restarts."""
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    ctx = _ctx(fake, tmp_path)
    await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
    await rpc(ctx, "device.update", id="adb:emulator-5554", name="实验室")
    assert ctx.store.get("adb:emulator-5554").auto_connect == 1
    await ctx.shutdown()
    assert fake.forwards == {}

    ctx2 = _ctx(fake, tmp_path)
    try:
        got = await ctx2.connect_saved()
        assert got[0]["state"] == "online" and got[0]["name"] == "实验室" and got[0]["autoConnect"] is True
        assert fake.forwards and ctx2.store.get("adb:emulator-5554").address == "emulator-5554"
        assert "41000" not in ctx2.store.dump_devices()
        await rpc(ctx2, "device.update", id="adb:emulator-5554", autoConnect=False)
    finally:
        await ctx2.shutdown()
    assert fake.forwards == {}

    ctx3 = _ctx(fake, tmp_path)
    try:
        assert await ctx3.connect_saved() == []
        assert ctx3.devices.list() == [] and fake.forwards == {}
        offline = (await rpc(ctx3, "device.list"))["result"]["devices"][0]
        assert offline["state"] == "offline" and offline["name"] == "实验室" and offline["autoConnect"] is False
        # reconnecting by hand does not flip the user's choice back on (only a NEW row gets the default)
        await rpc(ctx3, "device.connect", transport="adb", serial="emulator-5554")
        assert ctx3.store.get("adb:emulator-5554").auto_connect == 0
    finally:
        await ctx3.shutdown()
    assert fake.forwards == {}


async def test_global_auto_reconnect_switch_off_skips_startup_and_new_devices(mock_device, tmp_path):
    fake = FakeAdb([("emulator-5554", "device", mock_device)])
    ctx = _ctx(fake, tmp_path)
    try:
        assert (await rpc(ctx, "app.settings.get"))["result"]["autoReconnect"] is True
        res = (await rpc(ctx, "app.settings.set", autoReconnect=False))["result"]
        assert res["autoReconnect"] is False and ctx.store.get_setting("autoReconnect") == "0"
        await rpc(ctx, "device.connect", transport="adb", serial="emulator-5554")
        assert ctx.store.get("adb:emulator-5554").auto_connect == 0  # new row while the switch is off: not opted in
        await rpc(ctx, "device.update", id="adb:emulator-5554", autoConnect=True)
    finally:
        await ctx.shutdown()

    ctx2 = _ctx(fake, tmp_path)
    try:
        assert await ctx2.connect_saved() == []  # the per-device flag is set, but the global switch wins
        assert ctx2.devices.list() == []
        await rpc(ctx2, "app.settings.set", autoReconnect=True)
        got = await ctx2.connect_saved()
        assert [d["state"] for d in got] == ["online"]
    finally:
        await ctx2.shutdown()


async def test_read_only_database_is_reported_and_refuses_edits(tmp_path):
    path = tmp_path / "desktop.db"
    store = AppStore(path)
    store.remember("adb:emulator-5554", "adb", "emulator-5554", "", "Pixel", 1)
    store.exec_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    store.close()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()
    ctx = AppContext(poll_interval=60, data_dir=tmp_path)
    try:
        listed = (await rpc(ctx, "device.list"))["result"]
        assert listed["notice"] == "db.newer" and listed["devices"][0]["info"]["model"] == "Pixel"
        assert (await rpc(ctx, "device.update", id="adb:emulator-5554", name="x"))["error"]["code"] == "db.newer"
    finally:
        await ctx.shutdown()


async def test_adb_path_setting_is_reloaded_and_secrets_stay_out(tmp_path):
    ctx = AppContext(poll_interval=60, data_dir=tmp_path)
    await rpc(ctx, "app.settings.set", adbPath="/tmp/xscript-not-a-real-adb")
    assert ctx.adb._configured == "/tmp/xscript-not-a-real-adb"
    await ctx.shutdown()
    ctx2 = AppContext(poll_interval=60, data_dir=tmp_path)
    try:
        assert ctx2.adb._configured == "/tmp/xscript-not-a-real-adb"
        with pytest.raises(StoreError) as err:
            ctx2.store.set_setting("device_token", "sekret")
        assert err.value.code == "db.secret"
        assert "sekret" not in path_text(tmp_path / "desktop.db")
    finally:
        await ctx2.shutdown()


def path_text(path) -> str:
    """Best-effort scan of the db file. A rejected secret must not have been written."""
    try:
        return path.read_bytes().decode("utf-8", "ignore")
    except OSError:
        return ""


async def test_flow_record_run_is_listed_back(tmp_path):
    """Run history (schema v2 `runs`/`run_nodes`): flow.recordRun keeps the node trace, flow.listRuns returns it; a bad status or node list is refused."""
    ctx = AppContext(poll_interval=60, data_dir=tmp_path)
    try:
        saved = await rpc(ctx, "flow.recordRun", flow="daily_signin", startedAt=1, endedAt=2, status="success",
                          nodes=[{"node": "warm", "enter_ms": 10, "summary": "True"}])
        assert saved["result"]["id"]
        listed = await rpc(ctx, "flow.listRuns")
        assert listed["result"]["runs"][0]["flow"] == "daily_signin"
        assert listed["result"]["runs"][0]["nodes"][0]["node"] == "warm"
        assert listed["result"]["runs"][0]["nodes"][0]["summary"] == "True"
        bad_status = await rpc(ctx, "flow.recordRun", flow="f", startedAt=1, endedAt=2, status="weird", nodes=[])
        assert bad_status["error"]["code"] == "db.bad_params"
        bad_nodes = await rpc(ctx, "flow.recordRun", flow="f", startedAt=1, endedAt=2, status="success", nodes=["x"])
        assert bad_nodes["error"]["code"] == "rpc.bad_params"
    finally:
        await ctx.shutdown()
    store = AppStore(tmp_path / "desktop.db")
    try:
        run_id = store.record_run(
            "daily_signin",
            [{"node": "warm", "enter_ms": 10, "exit_ms": None, "summary": "True"}, {"node": "tap", "summary": "missing"}],
            started_at=1, ended_at=2, status="error", error_node="tap",
        )
        rows = store.list_runs()
        assert run_id == rows[0]["id"]
        assert rows[0]["flow"] == "daily_signin" and rows[0]["status"] == "error" and rows[0]["error_node"] == "tap"
        assert [node["node"] for node in rows[0]["nodes"]] == ["warm", "tap"]
        assert rows[0]["nodes"][0]["enter_ms"] == 10 and rows[0]["nodes"][0]["summary"] == "True"
    finally:
        store.close()
