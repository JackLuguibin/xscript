"""Natural-language screen vision on any OpenAI-compatible chat endpoint.

    from xscript.android import ai, screen
    ai.config(BASE_URL, model="qwen2.5-vl-7b")   # BASE_URL ends with /v1; key from XSCRIPT_AI_KEY
    hit = screen.ai_find("红色的关闭按钮")        # {"text", "rect", "center_x", "center_y", "confidence"} or None
    screen.ai_ask("当前是不是登录页？")           # plain text answer

Nothing is contacted until config() and a call. The key is never stored on
disk by this module; pass it in or set XSCRIPT_AI_KEY. Requests go to
{base_url}/chat/completions with one text part and one image_url data URL.
Boxes the model returns are read as pixels of the uploaded image by default;
coords="norm1000" (Qwen2-VL style 0..1000) and "ratio" (0..1) are also
accepted, and "auto" picks ratio when every value is <= 1.
"""
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

__all__ = ["AiError", "config", "status", "find", "find_all", "ask", "exists", "wait", "click"]

_COORDS = ("pixel", "norm1000", "ratio", "auto")
_lock = threading.RLock()
_cfg = None

FIND_PROMPT = (
    "You locate UI elements in a phone screenshot that is {w}x{h} pixels. "
    "Find: {target}. Reply with JSON only, no prose: "
    '{{"results": [{{"label": "<short text>", "box": [x1, y1, x2, y2], "confidence": 0.0-1.0}}]}} '
    "with at most {limit} results, best first, boxes in image pixels. "
    'If nothing matches reply {{"results": []}}.')
ASK_SYSTEM = "You answer questions about a phone screenshot briefly and accurately."


class AiError(RuntimeError):
    """Endpoint, protocol or configuration failure. status is the HTTP code or None."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward the key to a redirect target.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def config(base_url=None, api_key=None, model=None, timeout=60, coords="pixel",
           image_tokens=1024, json_mode=False, headers=None):
    """Select the endpoint. base_url includes the API prefix, e.g. .../v1.

    Defaults come from XSCRIPT_AI_BASE_URL / XSCRIPT_AI_KEY / XSCRIPT_AI_MODEL.
    api_key may be empty for local servers that need none. json_mode adds
    response_format={"type": "json_object"} to find requests.
    """
    base_url = base_url or os.environ.get("XSCRIPT_AI_BASE_URL")
    model = model or os.environ.get("XSCRIPT_AI_MODEL")
    api_key = os.environ.get("XSCRIPT_AI_KEY", "") if api_key is None else api_key
    if not base_url or not model:
        raise AiError("ai.config needs base_url and model (or XSCRIPT_AI_BASE_URL / XSCRIPT_AI_MODEL)")
    url = urllib.parse.urlsplit(base_url)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password \
            or url.query or url.fragment:
        raise ValueError("base_url must be an http(s) URL without credentials, query or fragment")
    if coords not in _COORDS:
        raise ValueError("coords must be one of " + ", ".join(_COORDS))
    if isinstance(timeout, bool) or not math.isfinite(float(timeout)) or float(timeout) <= 0:
        raise ValueError("timeout must be positive")
    if isinstance(image_tokens, bool) or int(image_tokens) != image_tokens or image_tokens <= 0:
        raise ValueError("image_tokens must be a positive integer")
    global _cfg
    with _lock:
        _cfg = dict(base_url=base_url.rstrip("/"), api_key=str(api_key or ""), model=str(model),
                    timeout=float(timeout), coords=coords, image_tokens=int(image_tokens),
                    json_mode=bool(json_mode), headers=dict(headers or {}))


def reset():
    global _cfg
    with _lock:
        _cfg = None


def status():
    """{"configured", "base_url", "model", "coords"}; never includes the key."""
    with _lock:
        c = _cfg
    return dict(configured=c is not None, base_url=c and c["base_url"], model=c and c["model"],
                coords=c["coords"] if c else None)


def _require():
    with _lock:
        if _cfg is None:
            try:
                config()
            except AiError:
                raise AiError("Call ai.config(base_url, model=...) first") from None
        return dict(_cfg)


def _chat(cfg, messages, json_mode=False):
    body = dict(model=cfg["model"], messages=messages, temperature=0, stream=False)
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    headers = {"Content-Type": "application/json", "User-Agent": "xscript-ai/1"}
    headers.update(cfg["headers"])
    if cfg["api_key"]:
        headers["Authorization"] = "Bearer " + cfg["api_key"]
    req = urllib.request.Request(cfg["base_url"] + "/chat/completions", method="POST",
                                 data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers=headers)
    try:
        with urllib.request.build_opener(_NoRedirect).open(req, timeout=cfg["timeout"]) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            err = json.loads(exc.read()).get("error")
            detail = err.get("message", "") if isinstance(err, dict) else str(err or "")
        except (ValueError, AttributeError, UnicodeError):
            pass
        raise AiError("AI endpoint returned HTTP %d%s" % (exc.code, ": " + detail if detail else ""),
                      exc.code) from None
    except (urllib.error.URLError, OSError) as exc:
        raise AiError("AI endpoint unreachable: %s" % getattr(exc, "reason", exc)) from None
    try:
        reply = json.loads(raw)
        content = reply["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError, UnicodeError):
        raise AiError("AI endpoint reply is not a chat completion") from None
    if isinstance(content, list):  # some servers return content parts
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not isinstance(content, str):
        raise AiError("AI endpoint reply has no text content")
    return content


def _frame(image, rect, cfg):
    from ascript.android.vlm import _frame as frames
    return frames.prepare(image, rect, cfg["image_tokens"])


def _message(frame, text, system=None):
    msgs = [dict(role="system", content=system)] if system else []
    msgs.append(dict(role="user", content=[
        dict(type="text", text=text),
        dict(type="image_url", image_url=dict(url=frame.data_url()))]))
    return msgs


def _json_payload(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    for opener in "{[":
        start = text.find(opener)
        if start < 0:
            continue
        try:
            return json.JSONDecoder().raw_decode(text[start:])[0]
        except ValueError:
            continue
    raise AiError("AI reply is not JSON: %s" % text[:120])


def _boxes(payload):
    if isinstance(payload, dict):
        for key in ("results", "items", "objects", "boxes"):
            if isinstance(payload.get(key), list):
                return payload[key]
        if any(k in payload for k in ("box", "bbox", "bbox_2d", "rect")):
            return [payload]
        return []
    if isinstance(payload, list):
        return payload
    raise AiError("AI reply JSON must be an object or list")


def _scale(box, coords, w, h):
    if coords == "auto":
        coords = "ratio" if all(abs(v) <= 1 for v in box) else "pixel"
    if coords == "ratio":
        return [box[0] * w, box[1] * h, box[2] * w, box[3] * h]
    if coords == "norm1000":
        return [box[0] * w / 1000, box[1] * h / 1000, box[2] * w / 1000, box[3] * h / 1000]
    return box


def _hits(payload, frame, coords):
    out = []
    for item in _boxes(payload):
        if not isinstance(item, dict):
            continue
        box = next((item[k] for k in ("box", "bbox", "bbox_2d", "rect") if k in item), None)
        try:
            box = [float(v) for v in box]
            if len(box) != 4 or not all(math.isfinite(v) for v in box):
                raise ValueError
            conf = float(item.get("confidence", item.get("score", 1.0)))
        except (TypeError, ValueError):
            continue
        box = _scale(box, coords, frame.net_w, frame.net_h)
        hit = frame.remap(dict(rect=box, confidence=max(0.0, min(1.0, conf)),
                               text=str(item.get("label", item.get("text", "")))))
        if hit["rect"][2] > hit["rect"][0] and hit["rect"][3] > hit["rect"][1]:
            out.append(hit)
    return out


def find_all(target, rect=None, image=None, limit=5, confidence=0.0):
    """Every match as dicts like OCR results: text, rect, center_x, center_y, confidence."""
    if not isinstance(target, str) or not target.strip():
        raise ValueError("target must be a nonempty string")
    if isinstance(limit, bool) or int(limit) != limit or limit < 1:
        raise ValueError("limit must be a positive integer")
    cfg = _require()
    frame = _frame(image, rect, cfg)
    prompt = FIND_PROMPT.format(w=frame.net_w, h=frame.net_h, target=target.strip(), limit=int(limit))
    payload = _json_payload(_chat(cfg, _message(frame, prompt), cfg["json_mode"]))
    hits = [h for h in _hits(payload, frame, cfg["coords"]) if h["confidence"] >= confidence]
    return hits[:int(limit)]


def find(target, rect=None, image=None, confidence=0.0):
    """Best match or None."""
    hits = find_all(target, rect, image, 1, confidence)
    return hits[0] if hits else None


def ask(question, rect=None, image=None, system=None):
    """Free-text answer about the screen (or rect / image)."""
    if not isinstance(question, str) or not question.strip():
        raise ValueError("question must be a nonempty string")
    cfg = _require()
    text = _chat(cfg, _message(_frame(image, rect, cfg), question.strip(), system or ASK_SYSTEM))
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def exists(target, rect=None, image=None, confidence=0.0):
    return find(target, rect, image, confidence) is not None


def wait(target, timeout=30, interval=1.0, rect=None, confidence=0.0):
    """Poll until found or timeout seconds pass; returns the hit or None."""
    deadline = time.monotonic() + timeout
    while True:
        hit = find(target, rect, None, confidence)
        if hit or time.monotonic() >= deadline:
            return hit
        time.sleep(max(0.0, min(interval, deadline - time.monotonic())))


def click(target, timeout=0, rect=None, confidence=0.0):
    hit = wait(target, timeout, rect=rect, confidence=confidence) if timeout > 0 \
        else find(target, rect, None, confidence)
    if hit is None:
        return False
    from xscript.android import action
    return bool(action.click(hit["center_x"], hit["center_y"]))
