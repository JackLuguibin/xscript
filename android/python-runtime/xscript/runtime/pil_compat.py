"""Pillow names that AScript-era scripts use but Pillow 10 removed (the APK ships Pillow 11).

Scripts written for older Pillow call `Image.ANTIALIAS`, `ImageDraw.textsize()` and `font.getsize()`; on Pillow 10+
those raise AttributeError. `install()` puts the old names back as thin wrappers over the current API, only where
they are missing, and only once the PIL module that owns them is imported, so a script that never touches PIL pays
nothing. The sizes follow the old semantics: getsize/textsize were the right/bottom edge of the text drawn at (0, 0).
"""
from __future__ import annotations

import importlib.abc
import sys

_TARGETS = ("PIL.Image", "PIL.ImageDraw", "PIL.ImageFont")


def _alias(obj, name, value):
    if not hasattr(obj, name):
        setattr(obj, name, value)


def _patch_image(m):
    r = getattr(m, "Resampling", None)
    if r is None:
        return
    _alias(m, "ANTIALIAS", r.LANCZOS)
    _alias(m, "LINEAR", r.BILINEAR)
    _alias(m, "CUBIC", r.BICUBIC)


def _patch_draw(m):
    d = m.ImageDraw

    def textsize(self, text, font=None, spacing=4, direction=None, features=None, language=None, stroke_width=0):
        if "\n" in (text if isinstance(text, str) else text.decode("latin-1", "replace")):
            return self.multiline_textsize(text, font, spacing, direction, features, language, stroke_width)
        box = self.textbbox((0, 0), text, font, direction=direction, features=features, language=language, stroke_width=stroke_width)
        return box[2], box[3]

    def multiline_textsize(self, text, font=None, spacing=4, direction=None, features=None, language=None, stroke_width=0):
        box = self.multiline_textbbox((0, 0), text, font, spacing=spacing, direction=direction, features=features,
                                      language=language, stroke_width=stroke_width)
        return box[2], box[3]

    _alias(d, "textsize", textsize)
    _alias(d, "multiline_textsize", multiline_textsize)


def _patch_font(m):
    def getsize(self, text, *args, **kwargs):
        box = self.getbbox(text, *args, **kwargs)
        return box[2], box[3]

    def getoffset(self, text):
        box = self.getbbox(text)
        return box[0], box[1]

    def getsize_multiline(self, text, direction=None, spacing=4, features=None, language=None, stroke_width=0):
        from PIL import Image, ImageDraw

        draw = ImageDraw.Draw(Image.new("L", (1, 1)))
        box = draw.multiline_textbbox((0, 0), text, self, spacing=spacing, direction=direction, features=features,
                                      language=language, stroke_width=stroke_width)
        return box[2], box[3]

    for cls in (getattr(m, "FreeTypeFont", None), getattr(m, "ImageFont", None), getattr(m, "TransposedFont", None)):
        if cls is not None and hasattr(cls, "getbbox"):
            _alias(cls, "getsize", getsize)
    ft = getattr(m, "FreeTypeFont", None)
    if ft is not None:
        _alias(ft, "getoffset", getoffset)
        _alias(ft, "getsize_multiline", getsize_multiline)


_PATCHES = {"PIL.Image": _patch_image, "PIL.ImageDraw": _patch_draw, "PIL.ImageFont": _patch_font}


def _apply(name):
    m = sys.modules.get(name)
    if m is None or getattr(m, "_xscript_pil_compat", False):
        return
    try:
        _PATCHES[name](m)
    except Exception:  # never break `import PIL...` over a compatibility nicety
        pass
    m._xscript_pil_compat = True


class _Loader(importlib.abc.Loader):
    def __init__(self, inner, name):
        self._inner, self._name = inner, name

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        self._inner.exec_module(module)
        _apply(self._name)


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname not in _TARGETS:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = _Loader(spec.loader, fullname)
                return spec
        return None


def install():
    """Idempotent. Patches PIL modules already imported and hooks the ones imported later."""
    for name in _TARGETS:
        _apply(name)
    if not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())
