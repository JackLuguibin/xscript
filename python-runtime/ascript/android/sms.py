"""短信: not supported by XScript. Calls raise NotImplementedError."""

from ascript._compat import unsupported


def has_permission(*args, **kwargs):
    unsupported('sms.has_permission')


def request_permission(*args, **kwargs):
    unsupported('sms.request_permission')


def get_first(*args, **kwargs):
    unsupported('sms.get_first')


def get_first_inbox(*args, **kwargs):
    unsupported('sms.get_first_inbox')


def get_first_sent(*args, **kwargs):
    unsupported('sms.get_first_sent')


def get_recent(*args, **kwargs):
    unsupported('sms.get_recent')


def get_recent_inbox(*args, **kwargs):
    unsupported('sms.get_recent_inbox')


def get_by_address(*args, **kwargs):
    unsupported('sms.get_by_address')


def query(*args, **kwargs):
    unsupported('sms.query')


def get_range(*args, **kwargs):
    unsupported('sms.get_range')


def debug_info(*args, **kwargs):
    unsupported('sms.debug_info')


TYPE_INBOX = 1
TYPE_SENT = 2
TYPE_DRAFT = 3


class SmsClass:
    def __getattr__(self, name):
        unsupported('sms.' + name)


Sms = SmsClass()
