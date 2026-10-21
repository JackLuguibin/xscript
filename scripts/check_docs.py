#!/usr/bin/env python3
"""Check the Markdown docs: relative links and images, #anchors, unused screenshots, and (optionally) external URLs.

    python3 scripts/check_docs.py              # repo-local checks; exits 1 on a problem
    python3 scripts/check_docs.py --external   # also HEAD/GET every http(s) link (report only, never fails)
    python3 scripts/check_docs.py --external --external-report broken.md   # + the unreachable ones as a Markdown list

Checked: every tracked *.md file (git ls-files). A relative link or image must point at a file or folder in the repo;
`#anchor` / `file.md#anchor` must match a heading there (GitHub's slug rules) or an explicit <a id/name>. Every file in
docs/images must be referenced from some tracked file (Markdown, HTML, code), so stale screenshots do not pile up.
Links inside fenced code blocks and inline code are ignored.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LINK = re.compile(r"!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
REF = re.compile(r"^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$", re.M)
HTML = re.compile(r"""<(?:img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["']""", re.I)
IDS = re.compile(r"""<a\b[^>]*?\b(?:id|name)=["']([^"']+)["']""", re.I)
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$", re.M)


def tracked(*patterns: str) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", *patterns], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [p for p in out.split("\0") if p]


def strip_code(text: str) -> str:
    """Blank out fenced blocks and inline code, keeping line numbers."""
    out, fence = [], None
    for line in text.split("\n"):
        m = re.match(r"^[ \t]*(`{3,}|~{3,})", line)
        if fence is None and m:
            fence = m.group(1)
            out.append("")
        elif fence is not None:
            if re.match(r"^[ \t]*" + re.escape(fence[0]) + "{%d,}[ \t]*$" % len(fence), line):
                fence = None
            out.append("")
        else:
            out.append(line)
    text = "\n".join(out)
    return re.sub(r"`[^`\n]+`", "``", text)


def slug(heading: str) -> str:
    """GitHub's heading anchor: lower-case, drop punctuation (keep letters/digits of any script, '-', '_'), spaces -> '-'."""
    h = re.sub(r"<[^>]+>", "", heading)
    h = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", h)  # [text](url) -> text
    h = h.replace("`", "").strip().lower()
    out = []
    for ch in h:
        cat = unicodedata.category(ch)
        if ch in "-_" or cat[0] in "LN" or cat == "Mn":
            out.append(ch)
        elif ch == " ":
            out.append("-")
    return "".join(out)


def read(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


_anchors: dict[str, set[str]] = {}


def anchors(rel: str) -> set[str]:
    if rel not in _anchors:
        text = strip_code(read(rel))
        seen: dict[str, int] = {}
        out = set(IDS.findall(text))
        for _, title in HEADING.findall(text):
            s = slug(title)
            n = seen.get(s, 0)
            seen[s] = n + 1
            out.add(s if n == 0 else "%s-%d" % (s, n))
        _anchors[rel] = out
    return _anchors[rel]


def links(text: str) -> list[tuple[int, str]]:
    found = []
    for rx in (LINK, REF, HTML):
        for m in rx.finditer(text):
            found.append((text.count("\n", 0, m.start()) + 1, m.group(1)))
    return found


def check_local(md_files: list[str]) -> tuple[list[str], list[tuple[str, int, str]]]:
    problems, external = [], []
    for rel in md_files:
        text = strip_code(read(rel))
        for line, url in links(text):
            if re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I):
                if url.lower().startswith(("http://", "https://")):
                    external.append((rel, line, url))
                continue  # mailto:, vscode:, ...
            path, _, frag = url.partition("#")
            path = urllib.parse.unquote(path.split("?")[0])
            if path:
                base = ROOT if path.startswith("/") else os.path.dirname(os.path.join(ROOT, rel))
                target = os.path.normpath(os.path.join(base, path.lstrip("/")))
                if not target.startswith(ROOT) or not os.path.exists(target):
                    problems.append("%s:%d: missing %s" % (rel, line, url))
                    continue
                target_rel = os.path.relpath(target, ROOT)
            else:
                target_rel = rel
            if frag and target_rel.endswith(".md") and urllib.parse.unquote(frag).lower() not in anchors(target_rel):
                problems.append("%s:%d: no heading for #%s in %s" % (rel, line, urllib.parse.unquote(frag), target_rel))
    return problems, external


def unused_images() -> list[str]:
    images = tracked("docs/images")
    corpus = []
    for rel in tracked():
        full = os.path.join(ROOT, rel)
        # symlinks and missing paths (a deleted-but-staged file) are skipped, like anything large or binary
        if rel.startswith("docs/images/") or os.path.islink(full) or not os.path.isfile(full) or os.path.getsize(full) > 2_000_000:
            continue
        try:
            corpus.append(read(rel))
        except (UnicodeDecodeError, OSError):
            continue
    blob = "\n".join(corpus)
    blob += "\n" + urllib.parse.unquote(blob)
    return ["%s: not referenced anywhere" % p for p in images if os.path.basename(p) not in blob]


def probe(url: str) -> str | None:
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": "xscript-docs-check"})
        try:
            with urllib.request.urlopen(req, timeout=20):
                return None
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in (403, 404, 405, 429, 501):
                continue  # some servers only answer GET
            return "HTTP %d" % e.code
        except Exception as e:  # noqa: BLE001 (DNS, TLS, timeout)
            return type(e).__name__
    return None


def arg_value(flag: str) -> str | None:
    """`--flag VALUE` or `--flag=VALUE` from the command line."""
    for i, a in enumerate(sys.argv):
        if a == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith(flag + "="):
            return a.split("=", 1)[1]
    return None


def external_report(external: list[tuple[str, int, str]], bad: dict[str, str]) -> str:
    """Markdown list of the unreachable URLs with where they are linked from ("" when none)."""
    where: dict[str, list[str]] = {}
    for rel, line, u in external:
        if u in bad:
            where.setdefault(u, []).append("`%s:%d`" % (rel, line))
    return "".join("- %s — %s（%s）\n" % (u, bad[u], "、".join(where[u])) for u in sorted(where))


def main() -> int:
    md = tracked("*.md")
    problems, external = check_local(md)
    problems += unused_images()
    for p in problems:
        print(p)
    print("%d Markdown files, %d problem(s)" % (len(md), len(problems)))
    if "--external" in sys.argv:
        urls = sorted({u for _, _, u in external if not re.search(r"//(localhost|127\.|10\.|192\.168\.|<)", u)})
        with ThreadPoolExecutor(8) as pool:
            results = dict(zip(urls, pool.map(probe, urls)))
        bad = {u: r for u, r in results.items() if r}
        for rel, line, u in external:
            if u in bad:
                print("external %s:%d: %s %s" % (rel, line, bad[u], u))
        print("%d external URL(s), %d unreachable (report only)" % (len(urls), len(bad)))
        report = arg_value("--external-report")
        if report:
            with open(report, "w", encoding="utf-8") as f:
                f.write(external_report(external, bad))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
