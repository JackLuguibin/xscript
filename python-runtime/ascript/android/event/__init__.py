"""Key / touch / notification event listeners: not supported by XScript."""

from ascript._compat import unsupported


class KeyEvent:
    @classmethod
    def on(cls, key_code=None):
        unsupported("KeyEvent.on")

    @classmethod
    def stop(cls):
        return None


class TouchEvent(KeyEvent):
    @classmethod
    def on(cls, action=None):
        unsupported("TouchEvent.on")


class NotificationEvent(KeyEvent):
    @classmethod
    def on(cls, package=None):
        unsupported("NotificationEvent.on")
