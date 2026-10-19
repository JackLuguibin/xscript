#!/usr/bin/env python3
"""Run scripts/bench/algo_bench.py on this PC and/or on a device, print a table, save JSON.

    .venv-rt/bin/python scripts/bench_algo.py --pc                      # PC part (numpy / cv2 / onnxruntime)
    python3 scripts/bench_algo.py --device http://127.0.0.1:19860      # device: uploaded and run as a project
    python3 scripts/bench_algo.py --pc --out bench.json --only image. colors.

The device run is a normal script process (`xs_bench` project), so the ML Kit / ONNX / capture paths
and the Python<->Kotlin bridge are measured as scripts see them. Needs the 图色 permission for capture.*.
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _http(base, method, path, data=None, ctype="application/json"):
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": ctype})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def run_pc(only, repeat, paddle):
    sys.path[:0] = [os.path.join(ROOT, "android", "python-runtime"), os.path.join(HERE, "bench")]
    import algo_bench

    return algo_bench.run(only=only, repeat=repeat, paddle=paddle)


def _lines(node):
    """Every "line" string in the /logs JSON, in order."""
    if isinstance(node, dict):
        if isinstance(node.get("line"), str):
            yield node["line"]
        for v in node.values():
            if isinstance(v, (dict, list)):
                yield from _lines(v)
    elif isinstance(node, list):
        for v in node:
            yield from _lines(v)


def run_device(base, only, repeat, paddle, timeout=900):
    src = open(os.path.join(HERE, "bench", "algo_bench.py"), encoding="utf-8").read()
    main = (
        "import json\nfrom . import algo_bench\n"
        "r = algo_bench.run(only=%r, repeat=%r, paddle=%r)\n"
        "print('XSBENCH_ENV ' + json.dumps(r['env']))\n"
        "for x in r['results']:\n    print('XSBENCH ' + json.dumps(x, ensure_ascii=False))\n"
        "print('XSBENCH_DONE')\n" % (only, repeat, paddle)
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("__init__.py", main)
        z.writestr("algo_bench.py", src)
    _http(base, "PUT", "/projects/xs_bench/zip", buf.getvalue(), "application/zip")
    _http(base, "DELETE", "/logs")
    _http(base, "POST", "/projects/xs_bench/run", b"{}")
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        text = "".join(_lines(json.loads(_http(base, "GET", "/logs"))))
        if "XSBENCH_DONE" in text or "finished xs_bench" in text:
            break
    env, results = {}, []
    for ln in text.splitlines():
        if ln.startswith("XSBENCH_ENV "):
            env = json.loads(ln[12:])
        elif ln.startswith("XSBENCH "):
            results.append(json.loads(ln[8:]))
    if not results:
        raise SystemExit("no results; log tail:\n" + text[-3000:])
    return {"env": env, "results": results}


def run_dispatch(base, n=10):
    """Script start/finish latency seen from the host: POST run -> 'finished' in the log, for an empty script."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("__init__.py", "print('xs_nop')\n")
    _http(base, "PUT", "/projects/xs_nop/zip", buf.getvalue(), "application/zip")
    ts = []
    for _ in range(n + 1):
        _http(base, "DELETE", "/logs")
        t0 = time.perf_counter()
        _http(base, "POST", "/projects/xs_nop/run", b"{}")
        while time.perf_counter() - t0 < 30:
            if "finished xs_nop" in "".join(_lines(json.loads(_http(base, "GET", "/logs")))):
                break
            time.sleep(0.02)
        ts.append(time.perf_counter() - t0)
        time.sleep(0.5)
    t = sorted(ts[1:])
    return {"name": "script.run_empty_roundtrip", "n": len(t), "median_ms": round(t[len(t) // 2] * 1000, 1),
            "p95_ms": round(t[-1] * 1000, 1), "first_ms": round(ts[0] * 1000, 1)}


def table(rep):
    rows = ["| path | n | median ms | p95 ms | check |", "| --- | ---: | ---: | ---: | --- |"]
    for r in rep["results"]:
        if "profile" in r:
            continue
        if "error" in r:
            rows.append("| %s | | | | error: %s |" % (r["name"], r["error"][:80]))
            continue
        chk = {k: v for k, v in r.items() if k not in ("name", "n", "median_ms", "p95_ms")}
        rows.append("| %s | %d | %.2f | %.2f | %s |" % (r["name"], r["n"], r["median_ms"], r["p95_ms"],
                                                     json.dumps(chk, ensure_ascii=False)[:90] if chk else ""))
    return "\n".join(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pc", action="store_true")
    ap.add_argument("--device", metavar="BASE_URL")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--repeat", type=int)
    ap.add_argument("--no-paddle", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    reps = {}
    if a.pc:
        reps["pc"] = run_pc(a.only, a.repeat, not a.no_paddle)
    if a.device:
        reps["device"] = run_device(a.device.rstrip("/"), a.only, a.repeat, not a.no_paddle)
        if not a.only or "script." in a.only:
            reps["device"]["results"].append(run_dispatch(a.device.rstrip("/")))
    for k, rep in reps.items():
        print("## %s %s\n" % (k, json.dumps(rep["env"])))
        print(table(rep) + "\n")
        for r in rep["results"]:
            if "profile" in r:
                print("### %s\n```\n%s\n```" % (r["name"], r["profile"]))
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(reps, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
