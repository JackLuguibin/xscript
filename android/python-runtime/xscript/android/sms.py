"""Read-only Android SMS API; shares the AScript compatibility implementation."""
from ascript.android.sms import (
    TYPE_INBOX, TYPE_SENT, TYPE_DRAFT, Sms, SmsClass,
    has_permission, request_permission, get_first, get_first_inbox, get_first_sent,
    get_recent, get_recent_inbox, get_inbox_recent, get_by_address, query,
    get_range, debug_info,
)
