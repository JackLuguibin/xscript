"""插件: not supported by XScript. Calls raise NotImplementedError."""

from ascript._compat import unsupported


def load(*args, **kwargs):
    unsupported('plug.load')


def load_module_dynamically(*args, **kwargs):
    unsupported('plug.load_module_dynamically')


def load_apk(*args, **kwargs):
    unsupported('plug.load_apk')


def inject(*args, **kwargs):
    unsupported('plug.inject')


def load_apk_dir(*args, **kwargs):
    unsupported('plug.load_apk_dir')
