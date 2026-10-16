#!/usr/bin/env python3
"""P1 design verification (docs/桌面端设计.md §3.4 / §11.1): behaviour of `GET /screen/stream` on a real device.

Measures, read-only: response headers, the first frame (`X-Screen-Size` part header), frame rate with one and two viewers, what a
3rd viewer gets while 2 are open (expected 429), and how long a slot takes to come back after the viewers close. Only opens GET
streams; never installs, uninstalls or clears anything.

    adb forward tcp:19860 tcp:9860 && python tools/stream_probe.py --device localhost:19860 --json out.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx

BOUNDARY = b"--xscriptframe"


def open_stream(base: str, qs: str = "fps=15&scale=0.4&quality=40", read_timeout: float = 6.0) -> tuple[httpx.Response, httpx.Client]:
    client = httpx.Client(base_url=base, timeout=httpx.Timeout(10.0, read=read_timeout), trust_env=False)
    resp = client.send(client.build_request("GET", "/screen/stream?" + qs), stream=True)
    return resp, client


def _take(it, seconds: float):
    t0 = time.time()
    for chunk in it:
        yield chunk
        if time.time() - t0 >= seconds:
            return


def read_frames(resp: httpx.Response, seconds: float) -> dict:
    it = getattr(resp, "_it", None)
    if it is None:
        it = resp._it = resp.iter_raw()  # type: ignore[attr-defined]  # a response can only be iterated once: keep the iterator
    t0 = time.time()
    try:
        chunks = list(_take(it, seconds))
    except httpx.ReadTimeout:
        return {"frames": 0, "seconds": round(time.time() - t0, 2), "fps": 0, "firstFrameAfterSec": None, "screenSizes": [],
                "note": "status 200 but no data within the read timeout"}
    buf, frames, sizes = b"", 0, set()
    for chunk in chunks:
        buf += chunk
    while True:
        i = buf.find(BOUNDARY)
        j = buf.find(BOUNDARY, i + len(BOUNDARY)) if i >= 0 else -1
        if i < 0 or j < 0:
            break
        part, buf = buf[i:j], buf[j:]
        m = re.search(rb"X-Screen-Size:\s*(\d+x\d+)", part)
        if m:
            sizes.add(m.group(1).decode())
        frames += 1
    el = time.time() - t0
    return {"frames": frames, "seconds": round(el, 2), "fps": round(frames / el, 2) if el else 0, "screenSizes": sorted(sizes)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="localhost:19860")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--json")
    a = ap.parse_args()
    base = "http://" + a.device
    out: dict = {"device": a.device}
    r1, c1 = open_stream(base)
    out["first"] = {"status": r1.status_code, "contentType": r1.headers.get("content-type", ""), "cacheControl": r1.headers.get("cache-control", "")}
    if r1.status_code != 200:
        out["first"]["body"] = r1.read().decode("utf-8", "replace")[:200]
        _done(out, a.json)
        return 1
    out["rate_one_viewer"] = read_frames(r1, a.seconds)
    r2, c2 = open_stream(base)
    out["second"] = {"status": r2.status_code}
    r3, c3 = open_stream(base)
    out["third"] = {"status": r3.status_code, "contentType": r3.headers.get("content-type", ""), "retryAfter": r3.headers.get("retry-after"),
                    "body": r3.read().decode("utf-8", "replace")[:200] if r3.status_code != 200 else ""}
    c3.close()
    out["rate_two_viewers_first"] = read_frames(r1, a.seconds) if r2.status_code == 200 else None
    r2.close(); c2.close(); r1.close(); c1.close()
    t0, freed_after, statuses = time.time(), None, []
    while time.time() - t0 < 15:  # slot release latency after the client closed its sockets
        r4, c4 = open_stream(base)
        statuses.append(r4.status_code)
        if r4.status_code == 200:
            freed_after = round(time.time() - t0, 2)
            r4.close(); c4.close()
            break
        r4.read(); c4.close()
        time.sleep(0.25)
    out["slot_release_after_closing_both"] = {"freedAfterSec": freed_after, "statusesSeen": statuses}
    _done(out, a.json)
    return 0


def _done(out: dict, path: str | None) -> None:
    text = json.dumps(out, ensure_ascii=False, indent=1)
    print(text)
    if path:
        Path(path).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
