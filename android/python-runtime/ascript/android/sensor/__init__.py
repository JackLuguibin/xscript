"""Sensors: not supported by XScript."""

from ascript._compat import unsupported


def __getattr__(name):
    unsupported("sensor." + name)
