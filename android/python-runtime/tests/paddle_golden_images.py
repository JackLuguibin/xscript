"""Deterministic test images for the PaddleOCR golden-output test (no image files in git)."""

import numpy as np

try:
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None

_F = cv2.FONT_HERSHEY_SIMPLEX if cv2 is not None else 0


def _text(img, s, x, y, scale, thick=2, color=(30, 30, 30)):
    cv2.putText(img, s, (x, y), _F, scale, color, thick, cv2.LINE_AA)


def images():
    """name -> BGR uint8 image."""
    out = {}

    # Settings-style list, 1080x2400, mixed with a header and a short button.
    a = np.full((2400, 1080, 3), 248, np.uint8)
    a[:160] = (200, 120, 40)
    _text(a, "Settings", 40, 110, 2.0, 4, (255, 255, 255))
    for i in range(10):
        y = 260 + i * 170
        cv2.line(a, (0, y + 50), (1080, y + 50), (225, 225, 225), 2)
        _text(a, "Option %02d enabled" % i, 60, y, 1.4, 3)
        _text(a, "%d%%" % (i * 11), 900, y, 1.2, 2, (90, 90, 90))
    cv2.rectangle(a, (380, 2150), (700, 2270), (60, 160, 60), -1)
    _text(a, "OK", 500, 2235, 2.0, 4, (255, 255, 255))
    out["list"] = a

    # Small dialog crop with the smoke-test string.
    b = np.full((200, 600, 3), 255, np.uint8)
    _text(b, "HELLO 2026", 60, 120, 2.0, 4)
    out["hello"] = b

    # Dense multi-column text with different sizes on a light gradient.
    c = np.tile(np.linspace(230, 255, 1080, dtype=np.uint8)[None, :, None], (1200, 1, 3))
    words = ["alpha", "beta", "gamma", "delta", "score 1024", "level 7", "gold 350", "exit"]
    for r in range(6):
        for k in range(2):
            _text(c, words[(r * 2 + k) % len(words)], 60 + k * 520, 120 + r * 180, 1.0 + 0.3 * k, 2)
    out["grid"] = c

    # Dark theme with light text and a long line.
    d = np.full((800, 1080, 3), 28, np.uint8)
    _text(d, "Battery 87% remaining", 50, 150, 1.5, 3, (235, 235, 235))
    _text(d, "Next run at 14:30", 50, 350, 1.3, 2, (180, 220, 255))
    _text(d, "v0.3.0", 50, 600, 0.9, 2, (200, 200, 200))
    out["dark"] = d
    return out
