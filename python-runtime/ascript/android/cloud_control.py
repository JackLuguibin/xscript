"""AScript 云控: not supported by XScript. Calls raise NotImplementedError."""

from ascript._compat import unsupported


def connect_to_as(*args, **kwargs):
    unsupported('cloud_control.connect_to_as')


def connect_to_ws(*args, **kwargs):
    unsupported('cloud_control.connect_to_ws')


def send(*args, **kwargs):
    unsupported('cloud_control.send')


def close(*args, **kwargs):
    unsupported('cloud_control.close')


def channel(*args, **kwargs):
    unsupported('cloud_control.channel')
