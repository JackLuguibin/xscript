"""定位: not supported by XScript. Calls raise NotImplementedError."""

from ascript._compat import unsupported


def request(*args, **kwargs):
    unsupported('location.request')


def get_last(*args, **kwargs):
    unsupported('location.get_last')


def close(*args, **kwargs):
    unsupported('location.close')
