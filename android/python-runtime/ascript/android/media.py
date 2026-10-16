"""ascript.android.media: volume, vibrate, TTS, e-mail drafts. Audio recording is not supported."""

from ascript._compat import warn_once
from xscript.android import system as _xs
from xscript.runtime.bridge import bridge


def volume(percent, type=3):
    return bridge.system("volume", {"v": int(percent), "type": int(type)}) == "true"


def get_volume(type=3):
    return int(bridge.system("get_volume", {"type": int(type)}) or 0)


def get_max_volume(type=3):
    return int(bridge.system("max_volume", {"type": int(type)}) or 0)


def brightness(percent):
    return bridge.system("brightness", {"v": int(int(percent) * 255 / 100)}) == "true"


def get_brightness():
    v = int(bridge.system("get_brightness") or -1)
    return -1 if v < 0 else int(v * 100 / 255)


def vibrate(time=200):
    _xs.vibrate(time)


def cancel_vibrate():
    bridge.system("cancel_vibrate")


def talk(msg):
    return _xs.speak(msg)


def play(path, callback=None):
    try:
        from android.media import MediaPlayer

        mp = MediaPlayer()
        mp.setDataSource(str(path))
        mp.prepare()
        mp.start()
        return mp
    except Exception as e:
        print("media.play failed: %s" % e)
        return None


def recode(path, time=None):
    warn_once("recode", "media.recode is not supported by XScript")


def send_email(to=None, subject=None, body=None, cc=None):
    """Open the mail app with a pre-filled draft (the user taps send). `to`/`cc`: "a@x.com, b@y.com" or a list.

    Returns True when a mail app (or the chooser) was opened; raises ValueError on an invalid address.
    """
    def _addrs(v):
        if v is None:
            return []
        items = v if isinstance(v, (list, tuple, set)) else str(v).replace(";", ",").split(",")
        out = [str(x).strip() for x in items if str(x).strip()]
        for a in out:
            if "@" not in a or any(c in a for c in " <>"):
                raise ValueError("invalid email address: %s" % a)
        return out

    arg = {"to": _addrs(to), "cc": _addrs(cc), "subject": "" if subject is None else str(subject), "body": "" if body is None else str(body)}
    return bridge.system("send_email", arg) == "true"


def image_to_gallery(file_path):
    r = _xs.shell("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://%s" % file_path)
    return r.ok


class AliTts:
    def __init__(self, *a, **k):
        raise NotImplementedError("AliTts is not supported by XScript; use media.talk()")


AliTtsCosyVoice = AliTts
