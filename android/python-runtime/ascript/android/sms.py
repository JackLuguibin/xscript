"""Read-only SMS compatibility API.

Rows match AScript: id, thread_id, address, body, date, date_sent, type,
read, subject, status. Dates are Unix milliseconds; read is boolean. Missing
numbers default to zero and missing or null strings to an empty string.
"""

import json

from xscript.runtime.bridge import bridge

TYPE_INBOX = 1
TYPE_SENT = 2
TYPE_DRAFT = 3


def has_permission():
    return str(bridge.system("sms_has_permission", {})).lower() == "true"


def request_permission():
    from ascript.android.system import permission
    permission.request(permission.READ_SMS)


def _integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(name + " must be an integer")
    if not -2147483648 <= value <= 2147483647:
        raise ValueError(name + " must be a 32-bit integer")
    return value


def query(sms_type=None, address=None, limit=0, order_desc=True, offset=0):
    """Filter by address substring/type and order by date.

    SQL LIKE wildcards in address retain their usual meaning. Nonpositive
    limits mean all matching rows; negative offsets become zero. Missing
    READ_SMS permission or a provider failure yields an empty list.
    """
    limit = _integer(limit, "limit")
    offset = max(0, _integer(offset, "offset"))
    if address is not None and not isinstance(address, str):
        raise TypeError("address must be a string or None")
    if not isinstance(order_desc, bool):
        raise TypeError("order_desc must be a boolean")
    if not has_permission():
        return []
    raw = bridge.system("sms_query", {
        "sms_type": sms_type if type(sms_type) is int and sms_type in (1, 2, 3) else 0,
        "address": address or None, "limit": limit,
        "order_desc": order_desc, "offset": offset,
    })
    try:
        result = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if isinstance(result, dict) and result.get("error") == "permission_denied":
        return []
    if not isinstance(result, list):
        return []
    return result


def get_first():
    rows = query(limit=1)
    return rows[0] if rows else None


def get_first_inbox():
    rows = query(sms_type=TYPE_INBOX, limit=1)
    return rows[0] if rows else None


def get_first_sent():
    rows = query(sms_type=TYPE_SENT, limit=1)
    return rows[0] if rows else None


def get_recent(count=10):
    return query(limit=count)


def get_recent_inbox(count=10):
    return query(sms_type=TYPE_INBOX, limit=count)


get_inbox_recent = get_recent_inbox


def get_by_address(address, limit=100):
    return query(address=address, limit=limit)


def get_range(start, end, sms_type=None, address=None):
    """Return inclusive 1-based range; invalid ranges yield an empty list."""
    if type(start) is not int or type(end) is not int:
        raise TypeError("start and end must be integers")
    if start < 1 or end < start:
        return []
    _integer(start, "start")
    _integer(end, "end")
    return query(sms_type, address, end - start + 1, True, start - 1)


def debug_info():
    try:
        return json.loads(bridge.system("sms_debug", {}))
    except (TypeError, ValueError):
        return {"client_available": False, "permission": False}


class SmsClass:
    TYPE_INBOX = TYPE_INBOX
    TYPE_SENT = TYPE_SENT
    TYPE_DRAFT = TYPE_DRAFT
    has_permission = staticmethod(has_permission)
    request_permission = staticmethod(request_permission)
    get_first = staticmethod(get_first)
    get_first_inbox = staticmethod(get_first_inbox)
    get_first_sent = staticmethod(get_first_sent)
    get_recent = staticmethod(get_recent)
    get_recent_inbox = staticmethod(get_recent_inbox)
    get_inbox_recent = get_recent_inbox
    get_by_address = staticmethod(get_by_address)
    query = staticmethod(query)
    get_range = staticmethod(get_range)
    debug_info = staticmethod(debug_info)


Sms = SmsClass
