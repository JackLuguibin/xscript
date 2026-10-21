#!/usr/bin/env python3
"""Run a test command N times and report per-test flake rates from its JUnit XML (used by .github/workflows/flake-rate.yml).

    python3 scripts/flake_rate.py --name "desktop (Windows)" --runs 5 --out flake.json -- \
        python -m pytest -q -n 4 --junitxml={junit}

`{junit}` in the command is replaced by a fresh path for every run. A test that fails in some runs but not all is
flaky; one that fails in every run is broken (a real failure, not a flake). The command's own exit code is recorded
too, so a run that crashes before writing XML still counts. Writes JSON (--out) and a Markdown table (stdout, and
$GITHUB_STEP_SUMMARY when set). Exits 0 unless --max-flaky is given and exceeded: this is a report, not a gate.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict


def parse_junit(path):
    """{test id: "pass" | "fail" | "skip"} from one JUnit XML file (pytest, vitest and node --test all write this)."""
    out = OrderedDict()
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return out
    for case in root.iter("testcase"):
        cls = case.get("classname") or case.get("file") or ""
        name = case.get("name") or "?"
        tid = (cls + "::" + name) if cls else name
        if case.find("failure") is not None or case.find("error") is not None:
            state = "fail"
        elif case.find("skipped") is not None:
            state = "skip"
        else:
            state = "pass"
        # the same id twice in one file (parametrised or nested): a failure wins
        if out.get(tid) != "fail":
            out[tid] = state
    return out


def summarize(name, runs):
    """`runs`: [{"exit": int, "seconds": float, "tests": {id: state}}] -> report dict."""
    n = len(runs)
    fails, seen = {}, {}
    for r in runs:
        for tid, st in r["tests"].items():
            if st == "skip":
                continue
            seen[tid] = seen.get(tid, 0) + 1
            if st == "fail":
                fails[tid] = fails.get(tid, 0) + 1
    flaky = sorted(((t, c, seen[t]) for t, c in fails.items() if c < seen[t]), key=lambda x: (-x[1] / x[2], x[0]))
    broken = sorted(t for t, c in fails.items() if c == seen[t])
    failed_runs = sum(1 for r in runs if r["exit"] != 0)
    return {
        "name": name,
        "runs": n,
        "failed_runs": failed_runs,
        "run_failure_rate": round(failed_runs / n, 3) if n else 0.0,
        "tests": len(seen),
        "flaky": [{"test": t, "failed": c, "of": s, "rate": round(c / s, 3)} for t, c, s in flaky],
        "broken": broken,
        "no_xml_runs": sum(1 for r in runs if not r["tests"]),
        "seconds": [round(r["seconds"], 1) for r in runs],
    }


def markdown(rep):
    lines = ["### Flake rate: %s" % rep["name"], "",
             "%d run(s), %d failed (%.0f%%), %d test(s)%s." % (
                 rep["runs"], rep["failed_runs"], rep["run_failure_rate"] * 100, rep["tests"],
                 ", %d run(s) wrote no JUnit XML" % rep["no_xml_runs"] if rep["no_xml_runs"] else "")]
    if rep["flaky"]:
        lines += ["", "| flaky test | failed | rate |", "|---|---|---|"]
        lines += ["| `%s` | %d / %d | %.0f%% |" % (f["test"], f["failed"], f["of"], f["rate"] * 100) for f in rep["flaky"]]
    else:
        lines += ["", "No flaky tests."]
    if rep["broken"]:
        lines += ["", "Failing in every run (broken, not flaky): " + ", ".join("`%s`" % t for t in rep["broken"])]
    return "\n".join(lines) + "\n"


def run_all(cmd, runs, workdir=None):
    results = []
    tmp = tempfile.mkdtemp(prefix="flake-")
    for i in range(runs):
        junit = os.path.join(tmp, "run%d.xml" % (i + 1))
        argv = [a.replace("{junit}", junit) for a in cmd]
        env = dict(os.environ, FLAKE_RUN=str(i + 1))
        t0 = time.time()
        code = subprocess.call(argv, cwd=workdir, env=env)
        results.append({"exit": code, "seconds": time.time() - t0, "tests": parse_junit(junit)})
        print("[flake_rate] run %d/%d exit %d" % (i + 1, runs, code), file=sys.stderr, flush=True)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--name", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", help="write the JSON report here")
    ap.add_argument("--cwd", help="run the command in this directory")
    ap.add_argument("--max-flaky", type=int, help="exit 1 when more tests than this are flaky (default: never fail)")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd or a.runs < 1:
        ap.error("give --runs >= 1 and a command after --")
    rep = summarize(a.name, run_all(cmd, a.runs, a.cwd))
    md = markdown(rep)
    sys.stdout.write(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2, ensure_ascii=False)
    return 1 if a.max_flaky is not None and len(rep["flaky"]) > a.max_flaky else 0


if __name__ == "__main__":
    sys.exit(main())
