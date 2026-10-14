"""Standard-library transport; the caller must select their own service URL."""
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from ._errors import NetworkError, NotReadyError, ProtocolError, from_response

DEFAULT_BASE_URL = None
DEFAULT_TIMEOUT = 60


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward the configured credential to a redirect destination.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class Client:
    api_key: str = field(repr=False)
    base_url: str
    timeout: float = DEFAULT_TIMEOUT

    def __post_init__(self):
        if not self.api_key or not self.base_url:
            raise NotReadyError("Call asai.init(api_key=..., base_url=...) with your own vision service")
        url = urllib.parse.urlsplit(self.base_url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("base_url must be an HTTP(S) URL without credentials, query or fragment")
        if not math.isfinite(float(self.timeout)) or float(self.timeout) <= 0:
            raise ValueError("timeout must be positive and finite")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))

    def _post(self, route, payload):
        req = urllib.request.Request(self.base_url + route,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.api_key,
                     "User-Agent": "xscript-ascript-compat/1"})
        try:
            with urllib.request.build_opener(_NoRedirect).open(req, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read())
            except (ValueError, UnicodeError):
                detail = None
            try:
                retry = float(exc.headers.get("Retry-After", ""))
            except (ValueError, TypeError):
                retry = None
            raise from_response(exc.code, detail, exc.headers.get("X-Request-Id"), retry) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise NetworkError("Vision request failed: %s" % exc) from None
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ProtocolError("Vision response is not valid JSON") from None
        if not isinstance(result, dict):
            raise ProtocolError("Vision response must be a JSON object")
        if result.get("error"):
            raise from_response(200, result)
        return result

    def locate(self, frame, target, limit=1, coord_space=None, hint=None):
        data = dict(image=frame.data_url(), width=frame.net_w, height=frame.net_h,
                    target=target, limit=limit)
        if coord_space:
            data["coord_space"] = coord_space
        if hint:
            data["hint"] = hint
        return self._post("/vision/locate", data)

    def ask(self, frame, question, fmt="text", fields=None, hint=None):
        data = dict(image=frame.data_url(), width=frame.net_w, height=frame.net_h,
                    question=question, format=fmt)
        if fields:
            data["fields"] = fields
        if hint:
            data["hint"] = hint
        return self._post("/vision/ask", data)
