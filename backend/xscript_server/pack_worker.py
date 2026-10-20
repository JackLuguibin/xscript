"""打包机: build APKs for an XScript server on a separate machine.

    export XSCRIPT_WORKER_TOKEN=xsw_…            # from 后台「APK 打包 → 打包机 → 添加」, shown once
    python -m xscript_server pack-worker --server https://xscript.example.com

The server runs with XSCRIPT_PACK_MODE=remote. This machine needs what local builds need (the Android
toolchain of the full Docker image or a dev setup). It claims one job at a time, downloads the project,
runs xscript_pack.py, streams the build log back with each heartbeat (every few seconds; the reply
says when the job was cancelled) and uploads the APK. Release signing uses this machine's own
XSCRIPT_KEYSTORE / XSCRIPT_STORE_PASS; jobs that need it only go to workers that have it.
Standard library only: nothing extra to install beyond the backend package.
"""

from __future__ import annotations

import codecs
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .packer import pack_command, redacted_command, safe_extract

TOKEN_ENV = "XSCRIPT_WORKER_TOKEN"
LOG_CHUNK = 512 * 1024


class AuthError(RuntimeError):
    """The token was refused (wrong, deleted or the worker is disabled): retrying will not help."""


class Api:
    def __init__(self, server: str, token: str, timeout: float = 60.0):
        self.base = server.rstrip("/") + "/api/pack-worker"
        self.token, self.timeout = token, timeout

    def request(self, method: str, path: str, body: Any = None, *, data=None, headers: dict[str, str] | None = None,
                save_to: Path | None = None) -> tuple[int, Any]:
        h = {"Authorization": "Bearer " + self.token, "User-Agent": "xscript-pack-worker/" + __version__}
        h.update(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                if save_to is not None:
                    with open(save_to, "wb") as f:
                        shutil.copyfileobj(r, f, 1024 * 1024)
                    return r.status, None
                raw = r.read()
                return r.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}").get("error", "")
            except ValueError:
                detail = ""
            if e.code in (401, 403):
                raise AuthError(detail or "打包机令牌被拒绝（%d）" % e.code) from None
            return e.code, {"error": detail or e.reason}

    def upload(self, path: str, fields: dict[str, str], file_field: str = "", file: Path | None = None) -> tuple[int, Any]:
        """multipart/form-data from a temp file, so a large APK is never held in memory."""
        boundary = "xsw" + uuid.uuid4().hex
        with tempfile.TemporaryFile() as body:
            for k, v in fields.items():
                body.write(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                            % (boundary, k, v)).encode("utf-8"))
            if file is not None:
                body.write(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\n'
                            "Content-Type: application/vnd.android.package-archive\r\n\r\n"
                            % (boundary, file_field, file.name)).encode("utf-8"))
                with open(file, "rb") as f:
                    shutil.copyfileobj(f, body, 1024 * 1024)
                body.write(b"\r\n")
            body.write(("--%s--\r\n" % boundary).encode("ascii"))
            size = body.tell()
            body.seek(0)
            return self.request("POST", path, data=body, headers={
                "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": str(size)})


class Worker:
    def __init__(self, api: Api, work_dir: Path, pack_script: Path, *, python: str = sys.executable,
                 signing: tuple[str, str, str, str] | None = None, beat_s: float = 3.0,
                 log: Callable[[str], None] = lambda m: print(m, file=sys.stderr, flush=True)):
        self.api, self.work_dir, self.pack_script, self.python = api, work_dir, pack_script, python
        self.signing, self.beat_s, self.say = signing, beat_s, log
        self.stopping = False

    def capabilities(self) -> dict[str, Any]:
        return {"release": self.signing is not None, "version": __version__, "host": socket.gethostname()[:64]}

    # ------------------------------------------------------------ main loop

    def run(self, once: bool = False, max_wait: float | None = None) -> int:
        """Claim and build jobs until stopped. once: return after one job (or after max_wait seconds idle)."""
        self.work_dir.mkdir(parents=True, exist_ok=True)
        started, backoff = time.monotonic(), 1.0
        self.say("打包机已启动，服务器 %s" % self.api.base.rsplit("/api/", 1)[0])
        while not self.stopping:
            try:
                status, reply = self.api.request("POST", "/claim", {"capabilities": self.capabilities()})
                backoff = 1.0
            except AuthError as e:
                self.say("令牌被拒绝：%s" % e)
                return 2
            except OSError as e:
                self.say("连不上服务器（%s），%d 秒后重试" % (e, backoff))
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue
            job = (reply or {}).get("job") if status == 200 else None
            if job:
                self.build(job)
                if once:
                    return 0
                continue
            if status == 200 and (reply or {}).get("mode") == "local" and backoff == 1.0:
                self.say("服务器是本机打包模式（XSCRIPT_PACK_MODE 不是 remote），先等着")
            if max_wait is not None and time.monotonic() - started > max_wait:
                return 1
            time.sleep(float((reply or {}).get("poll_s") or 5) if status == 200 else 5)
        return 0

    # ------------------------------------------------------------ one job

    def build(self, job: dict[str, Any]) -> str:
        """Run one claimed job to the end and report it. Returns the status sent (or "lost")."""
        jid = int(job["id"])
        d = self.work_dir / ("job-%d" % jid)
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        self.say("开始任务 #%d %s v%s" % (jid, job.get("app_id"), job.get("version")))
        try:
            return self._build(jid, job, d)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def _beat(self, jid: int, text: str = "") -> dict[str, Any] | None:
        """Send output (in chunks). None = the job is no longer ours; {} = the server was unreachable."""
        chunks = [text[i:i + LOG_CHUNK] for i in range(0, len(text), LOG_CHUNK)] or [""]
        reply: dict[str, Any] = {}
        for chunk in chunks:
            try:
                status, r = self.api.request("POST", "/jobs/%d/heartbeat" % jid, {"log": chunk})
            except OSError as e:
                self.say("心跳失败（%s），继续构建" % e)
                return {}
            if status == 409:
                return None
            reply = r or {}
        return reply

    def _report(self, jid: int, status: str, error: str = "", apk: Path | None = None) -> str:
        for attempt in range(5):
            try:
                code, r = self.api.upload("/jobs/%d/result" % jid, {"status": status, "error": error},
                                          "apk" if apk else "", apk)
            except OSError as e:
                self.say("上传结果失败（%s），重试" % e)
                time.sleep(2 * (attempt + 1))
                continue
            if code == 200:
                self.say("任务 #%d：%s" % (jid, status))
                return status
            if code == 409:
                self.say("任务 #%d 已不归这台打包机，结果丢弃" % jid)
                return "lost"
            self.say("上传结果被拒绝（%s）：%s" % (code, (r or {}).get("error")))
            return "lost"
        return "lost"

    def _download(self, jid: int, name: str, dest: Path) -> int:
        status, _ = self.api.request("GET", "/jobs/%d/%s" % (jid, name), save_to=dest)
        return status

    def _build(self, jid: int, job: dict[str, Any], d: Path) -> str:
        if self._download(jid, "project", d / "project.zip") != 200:
            return self._report(jid, "failed", "打包机下载工程失败")
        if job.get("has_icon") and self._download(jid, "icon", d / "icon.png") != 200:
            (d / "icon.png").unlink(missing_ok=True)
        if (job.get("options") or {}).get("release") and self.signing is None:
            return self._report(jid, "failed", "这台打包机没有配置签名证书")
        try:
            project = safe_extract(d / "project.zip", d / "src")
        except (ValueError, zipfile.BadZipFile) as e:
            self._beat(jid, "error: %s\n" % e)
            return self._report(jid, "failed", str(e))
        args, env = pack_command(self.python, self.pack_script, d, job, project, self.signing)
        if self._beat(jid, "".join(line + "\n" for line in redacted_command(args, env))) is None:
            return "lost"
        log_path = d / "build.log"
        with open(log_path, "wb") as logf:
            proc = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, env=env, cwd=str(d),
                                    start_new_session=True)
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        sent, cancelled, lost = 0, False, False
        try:
            while True:
                try:
                    code = proc.wait(timeout=self.beat_s)
                except subprocess.TimeoutExpired:
                    code = None
                with open(log_path, "rb") as f:
                    f.seek(sent)
                    new = f.read()
                sent += len(new)
                reply = self._beat(jid, decoder.decode(new, final=code is not None))
                if reply is None:
                    lost = True
                elif reply.get("cancel") and not cancelled:
                    cancelled = True
                if (lost or cancelled or self.stopping) and code is None:
                    _terminate(proc)
                    continue
                if code is not None:
                    break
        except BaseException:
            _terminate(proc)
            raise
        if lost:
            self.say("任务 #%d 已不归这台打包机（被取消或重新分配），停止构建" % jid)
            return "lost"
        if cancelled:
            return self._report(jid, "cancelled")
        if self.stopping:
            return self._report(jid, "failed", "打包机已停止")
        apks = sorted((d / "out").glob("*.apk")) if (d / "out").is_dir() else []
        if code != 0 or not apks:
            return self._report(jid, "failed", "打包失败（退出码 %s），详见构建日志" % code if code != 0 else "没有生成 APK")
        return self._report(jid, "succeeded", apk=apks[0])


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)  # the whole build (Gradle daemons included)
    except (AttributeError, ProcessLookupError, PermissionError):
        proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (AttributeError, ProcessLookupError, PermissionError):
            proc.kill()


def main(server: str, work_dir: str, once: bool = False, max_wait: float | None = None, beat_s: float = 3.0) -> int:
    from .config import DEFAULT_PACK_SCRIPT, Config

    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        print("先设置环境变量 %s（在后台「APK 打包 → 打包机」添加打包机时显示）" % TOKEN_ENV, file=sys.stderr)
        return 2
    script = Path(os.environ.get("XSCRIPT_PACK_SCRIPT") or DEFAULT_PACK_SCRIPT)
    if not script.is_file():
        print("找不到打包脚本 %s" % script, file=sys.stderr)
        return 2
    cfg = Config.load(work_dir)  # only for the XSCRIPT_KEYSTORE / XSCRIPT_*_PASS environment
    signing = (cfg.keystore, cfg.key_alias, cfg.store_pass, cfg.key_pass) if cfg.release_signing else None
    w = Worker(Api(server, token), Path(work_dir).expanduser().resolve(), script, signing=signing, beat_s=beat_s)

    def stop(*_):
        w.stopping = True

    signal.signal(signal.SIGTERM, stop)
    try:
        return w.run(once=once, max_wait=max_wait)
    except KeyboardInterrupt:
        return 130
