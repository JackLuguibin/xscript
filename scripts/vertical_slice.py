#!/usr/bin/env python3
"""Exercise the phase-1 loop: status → tree → upload → run → logs → screenshot.

Against a real phone (XSCRIPT_DEVICE) or the in-repo mock device.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp-server"))
sys.path.insert(0, str(ROOT / "scripts"))

from mock_device import serve  # noqa: E402
from xscript_mcp.client import DeviceClient, DeviceTarget  # noqa: E402

EXAMPLE = (ROOT / "examples" / "settings_search" / "__init__.py").read_text(encoding="utf-8")


def run_slice(client: DeviceClient) -> int:
    status = client.status()
    print("status:", status)
    if not status.get("accessibility"):
        print("accessibility is off — enable XScript on the device")
        return 2

    tree = client.ui_tree(0)
    texts = []

    def walk(nodes):
        for n in nodes or []:
            texts.append(n.get("text") or n.get("desc") or "")
            walk(n.get("children"))

    walk(tree.get("roots"))
    print("ui-tree texts:", [t for t in texts if t][:20])
    if not any(t in ("Search", "搜索") for t in texts):
        print("note: Search/搜索 not in simple tree (open Settings on a real device)")

    up = client.upload_file("settings_search", "__init__.py", EXAMPLE)
    print("upload:", up)
    try:
        print("run:", client.run_project("settings_search"))
    except Exception as exc:
        print("run failed:", exc)
        return 3
    logs = client.logs(0)
    print("logs:", logs)
    png = client.screen_png()
    print("screen bytes:", len(png), "png=", png[:8] == b"\x89PNG\r\n\x1a\n")
    client.stop_project("settings_search")
    print("vertical slice ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default=os.environ.get("XSCRIPT_DEVICE", ""))
    parser.add_argument("--mock", action="store_true", help="force in-process mock device")
    args = parser.parse_args()

    if args.mock or not args.device:
        httpd = serve("127.0.0.1", 0)
        host, port = httpd.server_address[:2]
        client = DeviceClient(DeviceTarget(host=host, port=port))
        try:
            return run_slice(client)
        finally:
            httpd.shutdown()
            httpd.server_close()

    target = DeviceTarget.parse(args.device)
    client = DeviceClient(target)
    try:
        client.status()
    except Exception as exc:
        print("device unreachable at %s: %s" % (target.base_url, exc))
        print("rerun with --mock or set XSCRIPT_DEVICE after adb forward")
        return 1
    return run_slice(client)


if __name__ == "__main__":
    raise SystemExit(main())
