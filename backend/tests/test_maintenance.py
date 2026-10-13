"""Migrations, backup / restore, retention and alert payloads (no server needed)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xscript_server import maintenance, migrate  # noqa: E402
from xscript_server.alerts import RateLimiter, build_request  # noqa: E402
from xscript_server.config import Config  # noqa: E402
from xscript_server.db import Database  # noqa: E402
from xscript_server.models import AuditLog, DeviceLog, PackJob, ShareLink, User  # noqa: E402


def fresh_cfg() -> Config:
    cfg = Config.load(tempfile.mkdtemp())
    cfg.ensure_dirs()
    return cfg


class MigrateTest(unittest.TestCase):
    def test_upgrades_old_schema(self):
        cfg = fresh_cfg()
        # A 0.3 database: devices without last_run, script_versions without downloads, user_version 0.
        con = sqlite3.connect(cfg.db_path)
        con.executescript(
            "CREATE TABLE devices (id VARCHAR(200) PRIMARY KEY, device_id VARCHAR(128), app VARCHAR(128),"
            " model VARCHAR(128), brand VARCHAR(64), reported_group VARCHAR(64), group_override VARCHAR(64),"
            " note VARCHAR(255), status JSON, data JSON, remote VARCHAR(64), key_id INTEGER,"
            " first_seen INTEGER, last_seen INTEGER);"
            "INSERT INTO devices (id, device_id) VALUES ('d1', 'd1');"
            "CREATE TABLE script_versions (id INTEGER PRIMARY KEY, script_id INTEGER, version VARCHAR(32),"
            " version_code INTEGER, notes TEXT, sha256 VARCHAR(64), size INTEGER, files INTEGER,"
            " created_by VARCHAR(64), created_at INTEGER);")
        con.commit()
        con.close()
        db = Database(cfg.db_path)
        db.create_all()
        with db.engine.connect() as c:
            self.assertEqual(migrate.current(c), migrate.LATEST)
        cols = {r[1] for r in sqlite3.connect(cfg.db_path).execute("PRAGMA table_info(devices)")}
        self.assertIn("last_run", cols)
        cols = {r[1] for r in sqlite3.connect(cfg.db_path).execute("PRAGMA table_info(script_versions)")}
        self.assertIn("downloads", cols)
        # Idempotent, and the old row survived.
        db.create_all()
        self.assertEqual(sqlite3.connect(cfg.db_path).execute("SELECT id FROM devices").fetchall(), [("d1",)])

    def test_refuses_newer_database(self):
        cfg = fresh_cfg()
        con = sqlite3.connect(cfg.db_path)
        con.execute("PRAGMA user_version = %d" % (migrate.LATEST + 5))
        con.commit()
        con.close()
        with self.assertRaises(RuntimeError):
            Database(cfg.db_path).create_all()


class BackupTest(unittest.TestCase):
    def test_round_trip(self):
        cfg = fresh_cfg()
        db = Database(cfg.db_path)
        db.create_all()
        with db.session() as s:
            s.add(User(username="alice", password_hash="x", role="admin"))
            s.commit()
        cfg.key_path.parent.mkdir(parents=True, exist_ok=True)
        cfg.key_path.write_text("KEY")
        src = cfg.scripts_dir / "1" / "2"
        src.mkdir(parents=True)
        (src / "source.zip").write_bytes(b"zip")
        (src / "bundle.zip").write_bytes(b"rebuilt on demand")
        path = maintenance.create_backup(cfg)
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")

        target = fresh_cfg()
        with self.assertRaises(ValueError):  # existing db needs --force
            Database(target.db_path).create_all()
            maintenance.restore_backup(target, path)
        maintenance.restore_backup(target, path, force=True)
        with Database(target.db_path).session() as s:
            self.assertEqual(s.query(User).one().username, "alice")
        self.assertEqual(target.key_path.read_text(), "KEY")
        self.assertTrue((target.scripts_dir / "1" / "2" / "source.zip").is_file())
        self.assertFalse((target.scripts_dir / "1" / "2" / "bundle.zip").exists())

    def test_prune_backups(self):
        cfg = fresh_cfg()
        cfg.backup_dir.mkdir(parents=True)
        for i in range(5):
            (cfg.backup_dir / ("xscript-2026010%d-000000.tar.gz" % i)).write_bytes(b"x")
        self.assertEqual(maintenance.prune_backups(cfg, 2), 3)
        self.assertEqual(sorted(p.name for p in cfg.backup_dir.iterdir()),
                         ["xscript-20260103-000000.tar.gz", "xscript-20260104-000000.tar.gz"])


class RetentionTest(unittest.TestCase):
    def test_policy(self):
        cfg = fresh_cfg()
        db = Database(cfg.db_path)
        db.create_all()
        now = time.time()
        with db.session() as s:
            for i in range(4):
                j = PackJob(status="succeeded", app_id="com.a", apk_file="a.apk", apk_size=1)
                s.add(j)
                s.flush()
                (cfg.pack_dir / str(j.id) / "out").mkdir(parents=True)
                (cfg.pack_dir / str(j.id) / "out" / "a.apk").write_bytes(b"x")
            s.add(PackJob(status="running", app_id="com.b"))
            s.add(AuditLog(time=int(now - 400 * 86400), action="old"))
            s.add(AuditLog(time=int(now), action="new"))
            s.add(ShareLink(job_id=1, token="t1", expires_at=int(now - 30 * 86400)))
            s.add(ShareLink(job_id=1, token="t2", expires_at=None))
            s.add(DeviceLog(device="d1", seq=1, ts=int((now - 8 * 86400) * 1000), line="old"))
            s.add(DeviceLog(device="d1", seq=2, ts=int(now * 1000), line="new"))
            s.commit()
        res = maintenance.run_retention(cfg, db, {"keep_pack_jobs": 2, "audit_days": 180, "device_log_days": 7}, now)
        self.assertEqual((res["apks"], res["audit"], res["shares"], res["device_logs"]), (2, 1, 1, 1))
        self.assertFalse((cfg.pack_dir / "1").exists())
        self.assertTrue((cfg.pack_dir / "4").exists())
        with db.session() as s:
            self.assertIsNone(s.get(PackJob, 1).apk_file)
            self.assertEqual(s.get(PackJob, 4).apk_file, "a.apk")
            self.assertEqual([a.action for a in s.query(AuditLog)], ["new"])
            self.assertEqual([l.token for l in s.query(ShareLink)], ["t2"])
            self.assertEqual([l.line for l in s.query(DeviceLog)], ["new"])
        # 0 keeps everything.
        self.assertEqual(maintenance.run_retention(cfg, db, {"keep_pack_jobs": 0, "audit_days": 0}, now)["apks"], 0)


class AlertFormatTest(unittest.TestCase):
    def test_payloads(self):
        url, body = build_request({"kind": "wecom", "url": "https://qyapi.weixin.qq.com/x?key=k"}, "T", "body")
        self.assertEqual(json.loads(body)["msgtype"], "text")
        self.assertIn("body", json.loads(body)["text"]["content"])

        url, body = build_request({"kind": "dingtalk", "url": "https://oapi.dingtalk.com/robot/send?access_token=a",
                                   "secret": "S"}, "T", "b", now=1700000000.0)
        ts = "1700000000000"
        sig = base64.b64encode(hmac.new(b"S", ("%s\nS" % ts).encode(), hashlib.sha256).digest()).decode()
        self.assertIn("timestamp=%s" % ts, url)
        from urllib.parse import quote_plus

        self.assertIn("sign=" + quote_plus(sig), url)

        url, body = build_request({"kind": "feishu", "url": "https://open.feishu.cn/x", "secret": "S"}, "T", "b",
                                  now=1700000000.0)
        j = json.loads(body)
        self.assertEqual(j["msg_type"], "text")
        expect = base64.b64encode(hmac.new(b"1700000000\nS", b"", hashlib.sha256).digest()).decode()
        self.assertEqual((j["timestamp"], j["sign"]), ("1700000000", expect))

        url, body = build_request({"kind": "generic", "url": "https://example.com/hook"}, "T", "b")
        self.assertEqual(json.loads(body)["title"], "T")

    def test_rate_limiter(self):
        rl = RateLimiter(2, 60)
        self.assertEqual([rl.allow("ip") for _ in range(3)], [True, True, False])
        self.assertTrue(rl.allow("other"))


if __name__ == "__main__":
    unittest.main()
