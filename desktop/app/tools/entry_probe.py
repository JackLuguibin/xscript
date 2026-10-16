#!/usr/bin/env python3
"""P0 investigation (docs/桌面端设计.md §10.2): how does the device execute a project's entry point?

Uploads small throw-away probe projects (names `xsprobe_*`) to a device through the device HTTP API, runs them, reads the
run log, and prints what the interpreter reported about itself. Only touches projects it creates itself; it deletes them
afterwards (use --keep to leave them). It never installs/uninstalls anything and never clears logs or app data.

    python tools/entry_probe.py --device localhost:19860
    python tools/entry_probe.py --device localhost:19861 --json out.json
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xscript_desktop.services.device_client import DeviceClient, DeviceError, DeviceTarget  # noqa: E402

REC = "def rec(k, v):\n    print('XSPROBE\\t%s\\t%s' % (k, json.dumps(v, ensure_ascii=False, default=str)))\n"

ENTRY = '''import json, os, sys, threading
''' + REC + '''
rec("__name__", __name__)
rec("__package__", __package__)
rec("__file__", __file__)
rec("__spec__.name", getattr(__spec__, "name", None))
rec("is_package(__path__)", [p for p in getattr(sys.modules[__name__], "__path__", [])])
rec("cwd", os.getcwd())
rec("sys.path[:4]", sys.path[:4])
rec("sys.argv", sys.argv)
rec("sys.modules['__main__'].__file__", getattr(sys.modules.get("__main__"), "__file__", None))
rec("thread", [threading.current_thread().name, type(threading.current_thread()).__name__, threading.current_thread() is threading.main_thread()])
rec("python", sys.version.split()[0])

from . import helper
rec("relative import (from . import helper)", helper.VALUE)
import helper as helper_abs
rec("absolute import of sibling (import helper) is same module object", helper_abs is helper)
rec("helper.__name__ via relative / absolute", [helper.__name__, helper_abs.__name__])

from flows.daily import main as flow_main
rec("design stub: from flows.daily import main; main()", flow_main())
from .flows import daily as daily_rel
rec("relative subpackage import (from .flows import daily)", [daily_rel.__name__, daily_rel.__file__])
import flows.daily as daily_abs
rec("flows.daily absolute is a different module object than relative", daily_abs is not daily_rel)
from xscript.android import system
rec("xscript.runtime params()", __import__("xscript.runtime.runner", fromlist=["params"]).params())
rec("builtins has launch param 'probe_param'", hasattr(__import__("builtins"), "probe_param"))
rec("open('res/hello.txt') relative to cwd", open("res/hello.txt", encoding="utf-8").read().strip())
rec("trace marker round trip", "x")
print("\\x1fXF\\tenter\\tbtn\\t1")
if __name__ == "__main__":
    rec("__main__ guard executed", True)
else:
    rec("__main__ guard executed", False)
rec("done", True)
'''

FILES_ENTRY = {
    "__init__.py": ENTRY,
    "helper.py": "VALUE = 'helper-ok'\n",
    "flows/__init__.py": "",
    "flows/daily.py": "def main():\n    return 'flow-main-ran'\nWHO = __name__\n",
    "res/hello.txt": "你好 res\n",
}

# error inside flows/daily.py on a known line, to check traceback format (source map / error → node, design §8.8.3)
FILES_ERR = {
    "__init__.py": "from flows.daily import main\nmain()\n",
    "flows/__init__.py": "",
    "flows/daily.py": "def main():\n    x = 1\n    raise ValueError('boom at line 3')\n",
}
FILES_EXIT = {"__init__.py": "import sys\nprint('before exit')\nsys.exit(3)\n"}
# namespace package (no flows/__init__.py) and `def main()` defined but never called by the entry
FILES_NS = {"__init__.py": "from flows.daily import main\nprint('ns:' + main())\n", "flows/daily.py": "def main():\n    return 'namespace-ok'\n"}
FILES_NOCALL = {"__init__.py": "def main():\n    print('main() was called')\nprint('module body ran; main not called')\n"}
# Thread lifecycle: the runner joins only NON-daemon threads, and a Thread created from the (dummy) runner thread
# inherits daemon=True, so a plain Thread(...) is killed when the entry returns; daemon=False is waited for.
_THREAD = "import threading, time\ndef w():\n    time.sleep(1.5); print('worker finished')\nt = threading.Thread(target=w%s)\nt.start()\nprint('entry returned; daemon=%%s' %% t.daemon)\n"
FILES_THREAD_DEFAULT = {"__init__.py": _THREAD % ""}
FILES_THREAD_NONDAEMON = {"__init__.py": _THREAD % ", daemon=False"}
# trace-line transport: control chars and a burst of lines (R12: how big is the log window?)
FILES_BURST = {"__init__.py": "for i in range(%d):\n    print('XSBURST %%05d ' %% i + 'x' * 100)\nprint('XSBURST-END')\n"}


def make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


async def run_and_collect(c: DeviceClient, name: str, files: dict[str, str], params: dict | None = None, wait: float = 20.0) -> dict:
    """Upload, run, wait until /status.running is false, then read every log entry written since the run started."""
    await c.upload_zip(name, make_zip(files))
    since = (await c.logs(0)).get("next", 0)
    if params:
        raise NotImplementedError  # launch params go through the cloud app_run/scheme link, not the HTTP run endpoint
    started = await c.run_project(name)
    deadline = asyncio.get_event_loop().time() + wait
    await asyncio.sleep(0.5)
    while asyncio.get_event_loop().time() < deadline:
        st = await c.status()
        if not st.get("running"):
            break
        await asyncio.sleep(0.4)
    await asyncio.sleep(0.8)  # let the last log lines flush
    entries: list[dict] = []
    cursor = since
    while True:
        page = await c.logs(cursor)
        got = page.get("entries") or []
        entries.extend(got)
        if not got or page.get("next", cursor) == cursor:
            break
        cursor = page["next"]
    return {"started": started, "since": since, "lines": [e["line"].rstrip("\n") for e in entries], "streams": [e["stream"] for e in entries]}


def probes(lines: list[str]) -> dict[str, object]:
    out: dict[str, object] = {}
    for ln in lines:
        if ln.startswith("XSPROBE\t"):
            _, k, v = ln.split("\t", 2)
            out[k] = json.loads(v)
    return out


async def main_async(args: argparse.Namespace) -> int:
    target = DeviceTarget.parse(args.device)
    c = DeviceClient(target, timeout=20)
    result: dict[str, object] = {"device": args.device}
    created: list[str] = []
    try:
        st = await c.status()
        result["status"] = {k: st.get(k) for k in ("model", "sdk", "release", "version", "run_mode", "channel", "running")}
        if st.get("running"):
            print("a script is already running on the device; not starting probes", file=sys.stderr)
            return 2

        async def case(label: str, name: str, files: dict[str, str]) -> dict:
            created.append(name)
            r = await run_and_collect(c, name, files, wait=180.0 if label == "burst" else 20.0)
            result[label] = r
            return r

        r = await case("entry", "xsprobe_entry", FILES_ENTRY)
        result["entry_probes"] = probes(r["lines"])
        await case("error", "xsprobe_err", FILES_ERR)
        await case("exit3", "xsprobe_exit", FILES_EXIT)
        await case("namespace", "xsprobe_ns", FILES_NS)
        await case("nocall", "xsprobe_nocall", FILES_NOCALL)
        await case("thread_default", "xsprobe_thr_default", FILES_THREAD_DEFAULT)
        await case("thread_nondaemon", "xsprobe_thr_nondaemon", FILES_THREAD_NONDAEMON)
        if args.burst:
            await case("burst", "xsprobe_burst", {"__init__.py": FILES_BURST["__init__.py"] % args.burst})
            lines = result["burst"]["lines"]  # type: ignore[index]
            nums = [int(x.split()[1]) for x in lines if x.startswith("XSBURST ") and x.split()[1].isdigit()]
            result["burst_summary"] = {"requested": args.burst, "received": len(nums), "first": nums[0] if nums else None,
                                       "last": nums[-1] if nums else None, "end_marker": any(x == "XSBURST-END" for x in lines)}
    except DeviceError as e:
        print("device error: %s" % e, file=sys.stderr)
        return 1
    finally:
        if not args.keep:
            for name in created:
                try:
                    await c.delete_project(name)
                except DeviceError:
                    pass
        await c.aclose()
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json:
        Path(args.json).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--device", default="localhost:19860", help="device API address (adb forward tcp:19860 tcp:9860)")
    p.add_argument("--keep", action="store_true", help="leave the xsprobe_* projects on the device")
    p.add_argument("--burst", type=int, default=0, help="also print N lines to measure how many survive in /logs (R12)")
    p.add_argument("--json", help="write the result to this file")
    return asyncio.run(main_async(p.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
