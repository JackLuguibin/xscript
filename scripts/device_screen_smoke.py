#!/usr/bin/env python3
"""Check GET /screen (and ?max= / ?format=jpg scaling) against a real device or emulator.

    adb forward tcp:19860 tcp:9860
    scripts/emulator_grant_capture.sh <serial>          # once: grants the screen-capture permission
    python3 scripts/device_screen_smoke.py http://127.0.0.1:19860

Exits non-zero when a size is wrong. Needs `capture: true` in /status.
"""
import json
import os
import struct
import sys
import urllib.request
import devauth  # scripts/devauth.py: pairing code (XSCRIPT_TOKEN or adb)

os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:9860").rstrip("/")


def get(path):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers=devauth.headers(base)), timeout=30) as r:
        return r.headers.get("Content-Type", ""), r.read()


def size(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        if data[i + 1] in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    raise SystemExit("not a PNG/JPEG")


status = json.loads(get("/status")[1])
if not status.get("capture"):
    raise SystemExit("capture is off (%s): grant the permission first" % status.get("capture_source"))
ct, full = get("/screen")
W, H = size(full)
print("full frame", ct, (W, H), len(full), "bytes")
failures = []


def check(query, want_ct, want_size):
    ctype, data = get("/screen" + query)
    got = size(data)
    ok = ctype == want_ct and all(abs(a - b) <= 1 for a, b in zip(got, want_size))
    print("%-34s %-10s %-12s %7d bytes  %s" % (query, ctype, got, len(data), "ok" if ok else "FAIL want %s %s" % (want_ct, want_size)))
    if not ok:
        failures.append(query)
    return len(data)


def scaled(limit):
    s = min(1.0, limit / max(W, H))
    return (max(1, int(W * s)), max(1, int(H * s)))


check("?max=540", "image/png", scaled(540))
check("?max=100", "image/png", scaled(100))
check("?max=10", "image/png", scaled(64))        # clamped up to 64
check("?max=9999", "image/png", (W, H))          # never upscales
check("?max=abc", "image/png", (W, H))           # junk is ignored
check("?format=jpg", "image/jpeg", (W, H))
small = check("?format=jpg&max=720&quality=50", "image/jpeg", scaled(720))
big = check("?format=jpg&quality=95", "image/jpeg", (W, H))
if not small < big:
    failures.append("quality/size ordering")
    print("FAIL: scaled low-quality JPEG is not smaller than the full-size one")
if failures:
    raise SystemExit("FAILED: %s" % failures)
print("screen smoke ok")
