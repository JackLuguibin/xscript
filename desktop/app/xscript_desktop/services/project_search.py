"""Text search across the files of a device project (ProjectsPage 搜索; RPC project.search).

Pure helpers: which files are worth reading, the query pattern, and the matches inside one file. The RPC reads the
files from the device and feeds them through `search_text`.
"""
from __future__ import annotations

import re
from typing import Any

TEXT_EXT = {
    "py", "pyi", "txt", "md", "json", "yml", "yaml", "ini", "cfg", "toml", "csv", "tsv", "xml", "html", "htm",
    "css", "js", "ts", "xflow", "sh", "bat", "properties", "conf", "log", "sql",
}
MAX_FILE_BYTES = 512 * 1024
MAX_MATCHES = 500
MAX_QUERY = 200
CONTEXT = 80  # characters of the line shown on each side of a match


def is_searchable(path: str, size: int) -> bool:
    """Text-like extension (or none, e.g. LICENSE) and not larger than MAX_FILE_BYTES."""
    name = path.rsplit("/", 1)[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return (ext in TEXT_EXT or ext == "") and 0 <= int(size or 0) <= MAX_FILE_BYTES


def compile_query(query: str, regex: bool = False, case_sensitive: bool = False) -> "re.Pattern[str]":
    """The search pattern; ValueError for an empty or too long query or an invalid regular expression."""
    if not query or not query.strip():
        raise ValueError("empty query")
    if len(query) > MAX_QUERY:
        raise ValueError("query longer than %d characters" % MAX_QUERY)
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(query if regex else re.escape(query), flags)
    except re.error as e:
        raise ValueError("invalid regular expression: %s" % e) from None


def _snippet(line: str, start: int, end: int) -> tuple[str, int]:
    """The part of `line` shown for a match at [start, end) and the match's offset inside it."""
    if len(line) <= 2 * CONTEXT + (end - start):
        return line, start
    lo = max(0, start - CONTEXT)
    hi = min(len(line), end + CONTEXT)
    prefix = "…" if lo > 0 else ""
    return prefix + line[lo:hi] + ("…" if hi < len(line) else ""), len(prefix) + start - lo


def search_text(path: str, content: str, pattern: "re.Pattern[str]", limit: int = MAX_MATCHES) -> list[dict[str, Any]]:
    """Matches in one file: {path, line (1-based), column (1-based), length, text, offset} where `text` is the
    (shortened) line and `offset` the match's 0-based position in it. Empty matches (e.g. regex `^`) are skipped."""
    out: list[dict[str, Any]] = []
    for n, line in enumerate(content.splitlines(), 1):
        for m in pattern.finditer(line):
            if m.end() == m.start():
                continue
            text, off = _snippet(line, m.start(), m.end())
            out.append({"path": path, "line": n, "column": m.start() + 1, "length": m.end() - m.start(),
                        "text": text, "offset": off})
            if len(out) >= limit:
                return out
    return out
