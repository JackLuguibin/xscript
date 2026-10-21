#!/usr/bin/env python3
"""Keep one GitHub issue in step with the weekly external-link check (.github/workflows/docs-weekly.yml).

    GH_TOKEN=... python3 scripts/docs_link_issue.py broken.md

`broken.md` is check_docs.py's --external-report (empty when every external link answered). With broken links: open
the issue titled TITLE, or comment the current list on the open one. With none: comment and close the open issue.
Nothing happens when there is nothing broken and no issue is open. Uses the `gh` CLI (GH env: GH_TOKEN, GH_REPO).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

TITLE = "文档外部链接失效（每周检查）"


def gh(*args: str) -> str:
    return subprocess.run([os.environ.get("GH_BIN", "gh"), *args], capture_output=True, text=True, check=True).stdout


def open_issue() -> int | None:
    found = json.loads(gh("issue", "list", "--state", "open", "--search", "in:title " + TITLE, "--json", "number,title", "--limit", "20") or "[]")
    return next((i["number"] for i in found if i["title"] == TITLE), None)


def body(report: str) -> str:
    run = os.environ.get("RUN_URL", "")
    return ("每周文档检查（`scripts/check_docs.py --external`）发现以下外部链接访问失败。可能只是对方网站暂时不可用；"
            "确认失效后请改掉或删掉链接，下次检查通过时这个 issue 会自动关闭。\n\n" + report +
            ("\n检查记录：" + run + "\n" if run else ""))


def main() -> int:
    report = ""
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            report = f.read().strip()
    report = report + "\n" if report else ""
    number = open_issue()
    if report and number is None:
        gh("issue", "create", "--title", TITLE, "--body", body(report))
        print("opened an issue for the broken links")
    elif report:
        gh("issue", "comment", str(number), "--body", body(report))
        print("commented on issue #%d" % number)
    elif number is not None:
        gh("issue", "close", str(number), "--comment", "本周检查时所有外部链接都可以访问，自动关闭。")
        print("closed issue #%d" % number)
    else:
        print("no broken external links, no open issue")
    return 0


if __name__ == "__main__":
    sys.exit(main())
