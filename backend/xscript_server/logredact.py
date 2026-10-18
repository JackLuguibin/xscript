"""Keep secrets that travel in URLs out of the server log.

Devices used to dial ``/ws?token=<device key>`` and older apps still do; uvicorn logs the full path
with its query string (``"WebSocket /ws?token=…" [accepted]`` and the HTTP access log), so the key
would end up in log files and log shippers. The filter masks the value and leaves the rest intact.
"""

from __future__ import annotations

import copy
import logging
import re
from typing import Any

_SECRET_QUERY = re.compile(r"([?&](?:token|access_token)=)[^&\s\"']+", re.IGNORECASE)
MASK = "***"


def redact(text: str) -> str:
    return _SECRET_QUERY.sub(r"\g<1>" + MASK, text)


class RedactSecrets(logging.Filter):
    """Masks ``token=`` query values in the message and its %-args (uvicorn's access formatter reads the args)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
        elif isinstance(record.args, dict):
            record.args = {k: redact(v) if isinstance(v, str) else v for k, v in record.args.items()}
        return True


def uvicorn_log_config() -> dict[str, Any]:
    """uvicorn's default logging config with RedactSecrets on every handler."""
    from uvicorn.config import LOGGING_CONFIG

    cfg = copy.deepcopy(LOGGING_CONFIG)
    cfg.setdefault("filters", {})["redact_secrets"] = {"()": RedactSecrets}
    for handler in cfg.get("handlers", {}).values():
        handler.setdefault("filters", []).append("redact_secrets")
    return cfg
