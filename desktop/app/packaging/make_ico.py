"""Render resources/icon.svg into a multi-size Windows .ico (PNG-compressed entries; any OS, needs PySide6)."""
import struct
import sys
from pathlib import Path

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, Qt
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

ICON = Path(__file__).resolve().parents[1] / "xscript_desktop" / "resources" / "icon.svg"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def _png(renderer: QSvgRenderer, px: int) -> bytes:
    img = QImage(px, px, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    p = QPainter(img)
    renderer.render(p)
    p.end()
    data = QByteArray()
    buf = QBuffer(data)
    buf.open(QIODevice.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return bytes(data)


def make_ico(out: Path) -> Path:
    QGuiApplication.instance() or QGuiApplication([])
    renderer = QSvgRenderer(str(ICON))
    images = [(px, _png(renderer, px)) for px in SIZES]
    header = struct.pack("<HHH", 0, 1, len(images))  # reserved, type 1 = icon, count
    offset = len(header) + 16 * len(images)
    entries, blobs = b"", b""
    for px, png in images:
        side = 0 if px >= 256 else px  # 0 means 256 in an ICONDIRENTRY
        entries += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(header + entries + blobs)
    return out


if __name__ == "__main__":
    print(make_ico(Path(sys.argv[1] if len(sys.argv) > 1 else "XScript.ico")))
