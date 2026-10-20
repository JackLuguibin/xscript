"""后台 AI 写脚本: describe a task, get a runnable 小程序 entry (__init__.py) from an OpenAI-compatible model.

Model config is the one device scripts use (xscript.android.ai.config):
    XSCRIPT_AI_BASE_URL   endpoint incl. the API prefix, e.g. https://api.example.com/v1
    XSCRIPT_AI_MODEL      model name
    XSCRIPT_AI_KEY        bearer key (optional for local servers)
系统设置 may override the base URL and model; the key is read from the environment only, never stored in
the database, logged or returned. Requests go to {base_url}/chat/completions, redirects are refused so the
key never follows one. The model is grounded on api_catalog.json, the same API list the MCP server serves
(tests keep the two copies identical).
"""

from __future__ import annotations

import ast
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from functools import lru_cache
from pathlib import Path
from typing import Any

CATALOG = Path(__file__).with_name("api_catalog.json")
ENTRY = "__init__.py"
TIMEOUT = 120.0
MAX_REPLY = 2 * 1024 * 1024
URL_RE = r"^(|https?://[^\s/?#@]+(:\d+)?(/[^\s?#]*)?)$"


class AiError(Exception):
    """status: HTTP status for the console (400 not configured, 502 upstream, 504 timeout)."""

    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def resolve(settings: dict[str, Any]) -> dict[str, Any]:
    """Effective config: 系统设置 first, then the XSCRIPT_AI_* environment. Includes the key: never return it."""
    base = (settings.get("ai_base_url") or os.environ.get("XSCRIPT_AI_BASE_URL") or "").strip().rstrip("/")
    model = (settings.get("ai_model") or os.environ.get("XSCRIPT_AI_MODEL") or "").strip()
    if base and not re.match(URL_RE, base):
        base = ""  # an invalid env value reads as not configured instead of being sent anywhere
    return {"base_url": base, "model": model, "api_key": os.environ.get("XSCRIPT_AI_KEY", "")}


def public_status(settings: dict[str, Any]) -> dict[str, Any]:
    cfg = resolve(settings)
    return {"configured": bool(cfg["base_url"] and cfg["model"]), "base_url": cfg["base_url"],
            "model": cfg["model"], "key_set": bool(cfg["api_key"]),
            "source": "settings" if settings.get("ai_base_url") or settings.get("ai_model") else "env"}


@lru_cache(maxsize=1)
def api_reference() -> str:
    """Compact API list for the system prompt: module, one-line description, signatures."""
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    out = ["Notes:"] + ["- " + n for n in cat.get("notes", [])]
    for mod in cat["modules"]:
        if mod["name"].startswith("ascript."):
            continue  # same APIs as xscript.android.*; generated code uses the native names
        out.append("\n## %s — %s" % (mod["name"], mod["description"]))
        for fn in mod.get("functions", []):
            doc = fn.get("doc", "")
            out.append("- %s%s" % (fn["signature"], "  # " + doc if doc else ""))
        for cls in mod.get("classes", []):
            out.append("- class %s: %s" % (cls["name"], cls.get("doc", "")))
            out.extend("    .%s" % m for m in cls.get("methods", []))
    return "\n".join(out)


SYSTEM = """You write automation scripts for the XScript Android app (AScript-compatible, Python 3.10 on the device).
The script is the project's entry file __init__.py; it runs top to bottom when the 小程序 starts.
Rules:
- Use only the APIs listed below (import from xscript.android.*), the Python standard library and the bundled packages.
- Wait for UI with selectors / find calls that have timeouts; never assume coordinates unless the user gives them.
- Use print() for progress; it shows in the device log. Loops must have an exit condition or a counter.
- Never hard-code passwords, API keys or tokens; read them from params or ask the user to fill a constant.
Reply with exactly one ```python fenced block containing the whole file, then at most five short lines in Chinese
explaining what to adjust (selectors, coordinates, package names) before running.

API reference:
"""


def build_messages(prompt: str, code: str = "") -> list[dict[str, str]]:
    user = prompt.strip()
    if code.strip():
        user = "Current __init__.py:\n```python\n%s\n```\n\nChange it as follows:\n%s" % (code.rstrip(), user)
    return [{"role": "system", "content": SYSTEM + api_reference()}, {"role": "user", "content": user}]


_FENCE = re.compile(r"```(?:python|py)?[ \t]*\n(.*?)```", re.S | re.I)


def extract(text: str) -> tuple[str, str]:
    """(code, explanation) from a model reply: the longest fenced block, else the whole reply."""
    blocks = _FENCE.findall(text)
    if blocks:
        code = max(blocks, key=len)
        notes = _FENCE.sub("", text).strip()
    else:
        code, notes = text, ""
    return code.strip("\n") + "\n", notes[:4000]


def check_syntax(code: str) -> str:
    """"" if it parses, else 'line N: message'. Never executes anything."""
    try:
        ast.parse(code, filename=ENTRY)
    except SyntaxError as e:
        return "第 %s 行: %s" % (e.lineno, e.msg)
    return ""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # the key must not follow a redirect
        return None


def _redact(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


def chat(cfg: dict[str, Any], messages: list[dict[str, str]], timeout: float | None = None) -> dict[str, Any]:
    """One non-streaming completion. Returns {"text", "usage", "ms"}; raises AiError."""
    timeout = TIMEOUT if timeout is None else timeout
    if not cfg["base_url"] or not cfg["model"]:
        raise AiError(400, "还没有配置模型：在系统设置 → AI 写脚本里填写接口地址和模型，"
                           "或在服务器上设置 XSCRIPT_AI_BASE_URL / XSCRIPT_AI_MODEL（密钥用 XSCRIPT_AI_KEY）")
    body = json.dumps({"model": cfg["model"], "messages": messages, "temperature": 0.2, "stream": False}).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    req = urllib.request.Request(cfg["base_url"] + "/chat/completions", data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(_NoRedirect)
    t0 = time.monotonic()
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read(MAX_REPLY + 1)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            data = json.loads(e.read(65536) or b"{}")
            err = data.get("error")
            detail = (err.get("message") if isinstance(err, dict) else err) or data.get("message") or ""
        except Exception:
            pass
        if 300 <= e.code < 400:
            raise AiError(502, "模型服务返回重定向（%d），已拒绝跟随；请填写最终的接口地址" % e.code) from None
        raise AiError(502, _redact("模型服务返回 %d%s" % (e.code, "：" + str(detail)[:300] if detail else ""),
                                   cfg["api_key"])) from None
    except TimeoutError:
        raise AiError(504, "模型服务 %d 秒内没有返回" % timeout) from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError) or "timed out" in str(reason):
            raise AiError(504, "模型服务 %d 秒内没有返回" % timeout) from None
        raise AiError(502, _redact("连不上模型服务：%s" % reason, cfg["api_key"])) from None
    if len(raw) > MAX_REPLY:
        raise AiError(502, "模型返回内容过大")
    try:
        data = json.loads(raw)
        text = data["choices"][0]["message"]["content"]
        if isinstance(text, list):  # content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
        if not isinstance(text, str) or not text.strip():
            raise ValueError("empty")
    except Exception:
        raise AiError(502, "模型返回的不是有效的对话结果") from None
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    return {"text": text, "usage": {k: usage[k] for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                                    if isinstance(usage.get(k), int)},
            "ms": int((time.monotonic() - t0) * 1000)}


def project_zip(dest: Path, code: str, base: Path | None = None) -> None:
    """Write a project zip whose entry is `code`; other files come from `base` (a version's source.zip)."""
    import tempfile

    from .packer import safe_extract

    with tempfile.TemporaryDirectory(prefix="xs-ai-") as tmp, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        if base is not None:
            root = safe_extract(base, Path(tmp))
            for p in sorted(root.rglob("*")):
                rel = p.relative_to(root).as_posix()
                # A compiled entry (__init__.pyc) would shadow the new source on the device.
                if p.is_file() and rel not in (ENTRY, ENTRY + "c") and "__pycache__" not in p.parts:
                    zf.write(p, rel)
        zf.writestr(ENTRY, code)


def read_entry(source_zip: Path) -> str:
    """The entry file text of a stored version (the project may be wrapped in a top folder)."""
    import tempfile

    from .packer import safe_extract

    with tempfile.TemporaryDirectory(prefix="xs-ai-") as tmp:
        root = safe_extract(source_zip, Path(tmp))
        if not (root / ENTRY).is_file():
            raise AiError(400, "这个版本只有编译后的入口（__init__.pyc），没有可修改的源码")
        data = (root / ENTRY).read_bytes()
    if len(data) > 512 * 1024:
        raise AiError(400, "入口文件超过 512 KB，不适合交给模型修改")
    return data.decode("utf-8", errors="replace")
