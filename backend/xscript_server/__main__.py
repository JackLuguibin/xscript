"""xscript-server CLI.

    python -m xscript_server init --data ./xscript-data            # create the first admin (prompts)
    python -m xscript_server serve --data ./xscript-data --port 8765
    python -m xscript_server device-key --data ./xscript-data --name 默认
    python -m xscript_server import-legacy --data ./xscript-data \\
        --token OLD_TOKEN --state xscript_cloud_state.json --licenses licenses.db --key keys/private.pem
    python -m xscript_server reset-password --data ./xscript-data admin
    python -m xscript_server backup --data ./xscript-data [--out file.tar.gz]
    python -m xscript_server restore --data ./xscript-data file.tar.gz [--force]
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

from . import licensing
from .audit import audit
from .config import Config
from .db import Database
from .hub import validate_daily
from .models import Card, Device, DeviceKey, Task, User
from .security import check_password_policy, hash_password, new_secret, token_hash


def _db(cfg: Config) -> Database:
    cfg.ensure_dirs()
    db = Database(cfg.db_path)
    db.create_all()
    return db


def _password(prompt_user: str) -> str:
    pw = os.environ.get("XSCRIPT_ADMIN_PASSWORD")
    if pw:
        check_password_policy(pw)
        return pw
    while True:
        pw = getpass.getpass("%s 的密码: " % prompt_user)
        try:
            check_password_policy(pw)
        except ValueError as e:
            print(e, file=sys.stderr)
            continue
        if getpass.getpass("再输一次: ") == pw:
            return pw
        print("两次输入不一致", file=sys.stderr)


def cmd_init(cfg: Config, a) -> int:
    db = _db(cfg)
    with db.session() as s:
        if a.if_missing and s.query(User).filter(User.role == "admin").first():
            return 0  # container restarts: the first admin already exists
        if s.query(User).filter(User.username == a.username).first():
            print("用户 %s 已存在" % a.username, file=sys.stderr)
            return 1
        s.add(User(username=a.username, password_hash=hash_password(_password(a.username)), role="admin"))
        audit(s, "cli", "user.create", a.username, {"role": "admin"})
        s.commit()
    print("已创建管理员 %s（数据目录 %s）" % (a.username, cfg.data_dir))
    return 0


def cmd_reset_password(cfg: Config, a) -> int:
    db = _db(cfg)
    with db.session() as s:
        u = s.query(User).filter(User.username == a.username).first()
        if u is None:
            print("用户不存在", file=sys.stderr)
            return 1
        detail = {"password": "reset"}
        if a.totp_only:
            detail = {"totp": "reset"}
        else:
            u.password_hash, u.disabled = hash_password(_password(a.username)), False
        if a.totp_only or a.reset_totp:
            u.totp_enabled, u.totp_secret, u.totp_last_step = False, None, None
            detail["totp"] = "reset"
        audit(s, "cli", "user.update", a.username, detail)
        s.commit()
    print("已重置 %s 的%s" % (a.username, "两步验证" if a.totp_only else "密码" + ("和两步验证" if a.reset_totp else "")))
    return 0


def cmd_reset_allowlist(cfg: Config, a) -> int:
    """Back door when the 登录 IP 白名单 locks everyone out."""
    from .audit import set_setting

    db = _db(cfg)
    with db.session() as s:
        set_setting(s, "login_ip_allowlist", [])
        audit(s, "cli", "settings.update", "login_ip_allowlist", {"login_ip_allowlist": []})
        s.commit()
    print("已清空登录 IP 白名单，所有 IP 都可以登录")
    return 0


def cmd_device_key(cfg: Config, a) -> int:
    db = _db(cfg)
    value = new_secret("xsd_")
    with db.session() as s:
        s.add(DeviceKey(name=a.name, token_hash=token_hash(value), hint=value[:4] + "…" + value[-4:], created_by="cli"))
        audit(s, "cli", "device_key.create", a.name)
        s.commit()
    print(value)
    print("设备端填写: ws://<服务器>:<端口>/ws?token=%s" % value, file=sys.stderr)
    return 0


def cmd_import_legacy(cfg: Config, a) -> int:
    """Move data from the old single-file server (xscript_cloud.py + xscript_license.py)."""
    db = _db(cfg)
    if a.key:
        src = licensing.load_private(a.key)
        if cfg.key_path.is_file():
            if licensing.public_b64(licensing.load_private(cfg.key_path)) != licensing.public_b64(src):
                print("数据目录里已有不同的签名密钥 %s。已打包的 App 内嵌旧公钥，只能用旧私钥。"
                      "先删除新密钥（确认没有用它打包过 App）再导入。" % cfg.key_path, file=sys.stderr)
                return 1
        else:
            cfg.key_path.parent.mkdir(parents=True, exist_ok=True)
            licensing.write_private(src, cfg.key_path)
        print("签名密钥: %s" % cfg.key_path)
    with db.session() as s:
        if a.token:
            h = token_hash(a.token)
            if not s.query(DeviceKey).filter(DeviceKey.token_hash == h).first():
                s.add(DeviceKey(name="旧服务端 token", token_hash=h, hint=a.token[:4] + "…" + a.token[-4:],
                                created_by="import"))
            print("设备密钥: 旧 token 已导入，设备不用改地址")
        if a.state:
            with open(a.state, encoding="utf-8") as f:
                state = json.load(f)
            for dev_id, group in (state.get("groups") or {}).items():
                d = s.get(Device, dev_id)
                if d is None:
                    device_id, _, app = dev_id.partition("@")
                    d = Device(id=dev_id, device_id=device_id, app=app or "com.xscript.app", first_seen=int(time.time()),
                               last_seen=0)
                    s.add(d)
                d.group_override = group
            n = 0
            for t in state.get("tasks") or []:
                daily = validate_daily(t["daily"]) if t.get("daily") else None
                s.add(Task(name=str(t.get("id", "")), target=t.get("target", "all"), command=t.get("command") or {},
                           daily=daily, every=t.get("every"), enabled=bool(t.get("enabled", True)),
                           last_run=float(t.get("last") or time.time()), created_by="import"))
                n += 1
            print("分组: %d 条，定时任务: %d 条" % (len(state.get("groups") or {}), n))
        if a.licenses:
            con = sqlite3.connect(a.licenses)
            con.row_factory = sqlite3.Row
            added = skipped = 0
            for r in con.execute("SELECT * FROM cards"):
                if s.get(Card, r["card"]) is not None:
                    skipped += 1
                    continue
                s.add(Card(card=r["card"], batch="import", days=float(r["days"] or 0), app=r["app"] or "*",
                           note=r["note"] or "", created_at=int(r["created"] or time.time()), device=r["device"],
                           model=r["model"], activated_at=r["activated"], expires_at=r["expires"],
                           revoked=bool(r["revoked"])))
                added += 1
            con.close()
            print("卡密: 导入 %d 张，跳过已存在 %d 张" % (added, skipped))
        audit(s, "cli", "import.legacy", "", {"token": bool(a.token), "state": bool(a.state),
                                              "licenses": bool(a.licenses), "key": bool(a.key)})
        s.commit()
    return 0


def cmd_backup(cfg: Config, a) -> int:
    from .maintenance import create_backup

    _db(cfg)
    path = create_backup(cfg, Path(a.out).resolve() if a.out else None)
    print("备份: %s（%.1f MB）" % (path, path.stat().st_size / 1e6))
    print("里面有卡密签名私钥，请放到安全的地方。", file=sys.stderr)
    return 0


def cmd_restore(cfg: Config, a) -> int:
    from .maintenance import restore_backup

    meta = restore_backup(cfg, Path(a.file).resolve(), force=a.force)
    print("已恢复 %s 的备份（版本 %s）到 %s" % (time.strftime("%Y-%m-%d %H:%M", time.localtime(meta["created_at"])),
                                       meta.get("version"), cfg.data_dir))
    return 0


def cmd_serve(cfg: Config, a) -> int:
    import uvicorn

    from .app import create_app

    db = _db(cfg)
    with db.session() as s:
        if s.query(User).count() == 0:
            print("还没有管理员账号。先运行: python -m xscript_server init --data %s" % cfg.data_dir, file=sys.stderr)
            return 1
    if a.host not in ("127.0.0.1", "localhost", "::1") and not a.behind_proxy:
        print("注意: 监听 %s。公网部署请在前面加 HTTPS 反向代理（nginx / Caddy），并传 --behind-proxy。" % a.host,
              file=sys.stderr)
    uvicorn.run(create_app(cfg), host=a.host, port=a.port, proxy_headers=a.behind_proxy, ws="websockets-sansio",
                forwarded_allow_ips=a.forwarded_allow_ips if a.behind_proxy else None,
                ws_max_size=64 * 1024 * 1024, ws_ping_interval=30, ws_ping_timeout=30, log_level=a.log_level)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="xscript-server", description="XScript 管理后台（云控 / 卡密 / 打包）")
    ap.add_argument("--data", help="数据目录（数据库、签名密钥、打包产物），默认 $XSCRIPT_DATA 或 ./xscript-data")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", help="启动服务")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--web", help="前端构建目录，默认 backend/web/dist")
    sv.add_argument("--behind-proxy", action="store_true", help="信任反向代理的 X-Forwarded-* 头")
    sv.add_argument("--forwarded-allow-ips", default="127.0.0.1")
    sv.add_argument("--log-level", default="info")

    i = sub.add_parser("init", help="创建第一个管理员")
    i.add_argument("--username", default="admin")
    i.add_argument("--if-missing", action="store_true", help="已有管理员时什么都不做（容器启动脚本用）")

    rp = sub.add_parser("reset-password", help="重置用户密码（忘记密码时）")
    rp.add_argument("username")
    rp.add_argument("--reset-totp", action="store_true", help="同时关闭两步验证")
    rp.add_argument("--totp-only", action="store_true", help="只关闭两步验证（手机丢失时），不改密码")

    ra = sub.add_parser("reset-allowlist", help="清空登录 IP 白名单（白名单把自己锁在外面时）")

    dk = sub.add_parser("device-key", help="生成设备连接密钥")
    dk.add_argument("--name", default="默认")

    il = sub.add_parser("import-legacy", help="从旧版 xscript_cloud.py / licenses.db 导入")
    il.add_argument("--token", help="旧服务端 --token（导入后设备不用改地址）")
    il.add_argument("--state", help="旧 xscript_cloud_state.json（分组、定时任务）")
    il.add_argument("--licenses", help="旧 licenses.db（卡密）")
    il.add_argument("--key", help="旧 private.pem（已打包的 App 依赖它）")

    bk = sub.add_parser("backup", help="备份数据库、签名密钥和小程序（服务运行时也可以）")
    bk.add_argument("--out", help="输出文件，默认 <数据目录>/backups/xscript-<时间>.tar.gz")

    rs = sub.add_parser("restore", help="从备份恢复（先停止服务）")
    rs.add_argument("file")
    rs.add_argument("--force", action="store_true", help="覆盖已有的数据库")

    # --data is accepted before or after the subcommand.
    for p in (sv, i, rp, ra, dk, il, bk, rs):
        p.add_argument("--data", default=argparse.SUPPRESS, help=argparse.SUPPRESS)

    a = ap.parse_args(argv)
    cfg = Config.load(getattr(a, "data", None), getattr(a, "web", None))
    handlers = {"serve": cmd_serve, "init": cmd_init, "reset-password": cmd_reset_password, "reset-allowlist": cmd_reset_allowlist,
                "device-key": cmd_device_key, "import-legacy": cmd_import_legacy, "backup": cmd_backup,
                "restore": cmd_restore}
    try:
        return handlers[a.cmd](cfg, a)
    except (ValueError, RuntimeError) as e:
        print("错误: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
