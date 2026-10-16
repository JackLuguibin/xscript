#!/usr/bin/env python3
"""P1 design verification (docs/桌面端设计.md §10.2 / §13): what happens when a project is named like a standard-library module?

Creates throw-away projects named `random`, `json` and `colorsys` (stdlib names), runs each, reads the run log, deletes them.
Touches only these projects; never installs/uninstalls anything and never clears logs or app data.
    adb forward tcp:19860 tcp:9860 && python tools/shadow_probe.py --device localhost:19860 --json out.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from entry_probe import make_zip, run_and_collect  # noqa: E402
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget  # noqa: E402

CASES = {
    # name -> (entry source, what it shows)
    "colorsys": "import sys\nprint('SHADOW file=%s' % __file__)\nimport colorsys\nprint('SHADOW same-module=%s' % (colorsys is sys.modules[__name__]))\nprint('SHADOW has-rgb_to_hsv=%s' % hasattr(colorsys, 'rgb_to_hsv'))\n",
    "random": "import sys\nprint('SHADOW file=%s' % __file__)\nimport random\nprint('SHADOW same-module=%s' % (random is sys.modules[__name__]))\nprint('SHADOW has-randint=%s' % hasattr(random, 'randint'))\ntry:\n    import tempfile\n    print('SHADOW tempfile-import=ok')\nexcept Exception as e:\n    print('SHADOW tempfile-import=%s: %s' % (type(e).__name__, e))\n",
    "json": "import sys\nprint('SHADOW file=%s' % __file__)\nimport json\nprint('SHADOW same-module=%s' % (json is sys.modules[__name__]))\nprint('SHADOW has-dumps=%s' % hasattr(json, 'dumps'))\n",
}


async def main_async(a: argparse.Namespace) -> int:
    c = DeviceClient(DeviceTarget.parse(a.device), timeout=20)
    out: dict = {"device": a.device}
    created: list[str] = []
    try:
        st = await c.status()
        out["status"] = {k: st.get(k) for k in ("model", "sdk", "version", "running")}
        if st.get("running"):
            print("a script is already running; not starting", file=sys.stderr)
            return 2
        for name, src in CASES.items():
            created.append(name)
            r = await run_and_collect(c, name, {"__init__.py": src}, wait=20.0)
            out[name] = {"shadow": [x for x in r["lines"] if x.startswith("SHADOW")],
                         "runner": [x for x in r["lines"] if x.startswith("xscript:") or "Error" in x or x.startswith("Traceback")][:8]}
    except DeviceError as e:
        print("device error: %s" % e, file=sys.stderr)
        return 1
    finally:
        for name in created:
            try:
                await c.delete_project(name)
            except DeviceError:
                pass
        await c.aclose()
    text = json.dumps(out, ensure_ascii=False, indent=2)
    print(text)
    if a.json:
        Path(a.json).write_text(text + "\n", encoding="utf-8")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--device", default="localhost:19860")
    p.add_argument("--json")
    return asyncio.run(main_async(p.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
