#!/usr/bin/env python3
"""P1 design verification (docs/桌面端设计.md §10.2): can ANOTHER project's top-level package shadow the `flows` package the
generated entry stub imports?  The device puts `<files>/projects` first on sys.path and the project dir second, so a sibling
project directory named like our `flows` package may win.  Creates `xsprobe_victim` (stub: `import flows.daily`), `xsprobe_relative` (`from .flows import daily`), `xsprobe_unique` (own package `xf_flows`) and
`flows` (a different project, with its own daily.py), runs the victim, reports which `flows` was imported; deletes both.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from entry_probe import run_and_collect  # noqa: E402
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget  # noqa: E402

VICTIM = {"__init__.py": "import flows.daily as d\nprint('SHADOW victim imported flows from %s' % d.__file__)\nprint('SHADOW result=%s' % d.main())\n",
          "flows/__init__.py": "", "flows/daily.py": "def main():\n    return 'OWN flows package'\n"}
SIBLING = {"__init__.py": "", "daily.py": "def main():\n    return 'SIBLING project named flows'\n"}
RELATIVE = {"__init__.py": "from .flows import daily as d\nprint('SHADOW relative imported %s from %s' % (d.__name__, d.__file__))\nprint('SHADOW result=%s' % d.main())\n",
            "flows/__init__.py": "", "flows/daily.py": "def main():\n    return 'OWN flows package (relative import)'\n"}
UNIQUE = {"__init__.py": "import xf_flows.daily as d\nprint('SHADOW unique imported from %s' % d.__file__)\nprint('SHADOW result=%s' % d.main())\n",
          "xf_flows/__init__.py": "", "xf_flows/daily.py": "def main():\n    return 'OWN xf_flows package'\n"}


async def main_async(a: argparse.Namespace) -> int:
    c = DeviceClient(DeviceTarget.parse(a.device), timeout=20)
    out: dict = {"device": a.device}
    created: list[str] = []
    try:
        if (await c.status()).get("running"):
            print("a script is already running; not starting", file=sys.stderr)
            return 2
        existing = {p["name"] for p in await c.projects()}
        if "flows" in existing:
            print("a project named 'flows' already exists on the device; refusing to touch it", file=sys.stderr)
            return 2
        from entry_probe import make_zip
        created.append("flows")
        await c.upload_zip("flows", make_zip(SIBLING))
        for name, files in (("xsprobe_victim", VICTIM), ("xsprobe_relative", RELATIVE), ("xsprobe_unique", UNIQUE)):
            created.append(name)
            r = await run_and_collect(c, name, files, wait=20.0)
            out[name] = [x for x in r["lines"] if x.startswith("SHADOW") or x.startswith("Traceback") or "Error" in x][:6]
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
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--device", default="localhost:19860")
    p.add_argument("--json")
    return asyncio.run(main_async(p.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
