"""告警通知: push events to 企业微信 / 钉钉 / 飞书 robots or a generic JSON webhook.

Events are fire-and-forget from the hub, packer and scheduler. Each (event, subject) pair is
throttled so a flapping device or a crash loop does not flood the group chat.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
import urllib.request
from collections import deque
from typing import Any

from starlette.concurrency import run_in_threadpool

from .audit import ALERT_EVENTS, get_settings
from .db import Database

log = logging.getLogger("xscript.alerts")

THROTTLE_S = 600  # same event + subject at most once per 10 minutes


def build_request(hook: dict[str, Any], title: str, text: str, now: float | None = None) -> tuple[str, bytes]:
    """(url, JSON body) in the format each robot expects."""
    kind, url, secret = hook.get("kind", "generic"), hook["url"], hook.get("secret") or ""
    content = "【%s】%s\n%s" % ("XScript", title, text)
    now = now or time.time()
    if kind == "wecom":
        body: dict[str, Any] = {"msgtype": "text", "text": {"content": content}}
    elif kind == "dingtalk":
        body = {"msgtype": "text", "text": {"content": content}}
        if secret:
            ts = str(int(now * 1000))
            sig = base64.b64encode(hmac.new(secret.encode(), ("%s\n%s" % (ts, secret)).encode(),
                                            hashlib.sha256).digest()).decode()
            url += ("&" if "?" in url else "?") + "timestamp=%s&sign=%s" % (ts, urllib.parse.quote_plus(sig))
    elif kind == "feishu":
        body = {"msg_type": "text", "content": {"text": content}}
        if secret:
            ts = str(int(now))
            sig = base64.b64encode(hmac.new(("%s\n%s" % (ts, secret)).encode(), b"", hashlib.sha256).digest()).decode()
            body.update(timestamp=ts, sign=sig)
    else:
        body = {"source": "xscript", "title": title, "text": text, "time": int(now)}
    return url, json.dumps(body, ensure_ascii=False).encode("utf-8")


def _post(url: str, data: bytes, timeout: float = 10) -> tuple[bool, str]:
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json; charset=utf-8",
                                          "User-Agent": "xscript-server"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (admin-configured URL)
            raw = r.read(4096).decode("utf-8", "replace")
    except Exception as e:  # network errors, HTTP 4xx/5xx
        return False, str(e)[:200]
    # The robots answer 200 with an error code in the body.
    try:
        j = json.loads(raw)
    except ValueError:
        return True, ""
    code = j.get("errcode", j.get("code", j.get("StatusCode", 0)))
    return (code in (0, None)), "" if code in (0, None) else str(j.get("errmsg") or j.get("msg") or code)


class Alerts:
    def __init__(self, db: Database):
        self.db = db
        self.last: dict[tuple[str, str], float] = {}
        self.recent: deque[dict[str, Any]] = deque(maxlen=100)

    def _hooks(self, event: str) -> list[dict[str, Any]]:
        with self.db.session() as s:
            hooks = get_settings(s).get("alert_webhooks") or []
        return [h for h in hooks if event in (h.get("events") or [])]

    async def send_one(self, hook: dict[str, Any], title: str, text: str) -> tuple[bool, str]:
        url, data = build_request(hook, title, text)
        return await run_in_threadpool(_post, url, data)

    def emit(self, event: str, subject: str, text: str) -> None:
        """Schedule an alert from inside the event loop. Never raises."""
        now = time.time()
        key = (event, subject)
        if now - self.last.get(key, 0) < THROTTLE_S:
            return
        self.last[key] = now
        if len(self.last) > 5000:
            self.last = {k: v for k, v in self.last.items() if now - v < THROTTLE_S}
        try:
            asyncio.get_running_loop().create_task(self._deliver(event, subject, text))
        except RuntimeError:  # no loop (CLI / tests without a server)
            pass

    async def _deliver(self, event: str, subject: str, text: str) -> None:
        title = "%s · %s" % (ALERT_EVENTS.get(event, event), subject)
        entry = {"time": int(time.time()), "event": event, "subject": subject, "text": text, "sent": 0, "errors": []}
        self.recent.append(entry)
        try:
            hooks = await run_in_threadpool(self._hooks, event)
        except Exception:  # pragma: no cover - db closed during shutdown
            return
        for h in hooks:
            ok, msg = await self.send_one(h, title, text)
            if ok:
                entry["sent"] += 1
            else:
                entry["errors"].append("%s: %s" % (h.get("name") or h.get("kind"), msg))
                log.warning("alert to %s failed: %s", h.get("name") or h.get("kind"), msg)


class RateLimiter:
    """Sliding-window limit per key (client IP) for the public /pub endpoints."""

    def __init__(self, limit: int, window_s: float):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.time()
        q = self.hits.setdefault(key, deque())
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        if len(self.hits) > 20000:
            self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < self.window}
        return True
