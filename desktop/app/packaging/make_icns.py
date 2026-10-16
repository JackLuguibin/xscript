"""Render resources/icon.svg into an .icns file (macOS, needs PySide6 + iconutil)."""
import subprocess
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

ICON = Path(__file__).resolve().parents[1] / "xscript_desktop" / "resources" / "icon.svg"


def make_icns(out: Path) -> Path:
    QGuiApplication.instance() or QGuiApplication([])
    renderer = QSvgRenderer(str(ICON))
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "XScript.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                img = QImage(px, px, QImage.Format_ARGB32)
                img.fill(Qt.transparent)
                p = QPainter(img)
                renderer.render(p)
                p.end()
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                img.save(str(iconset / name))
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
    return out


if __name__ == "__main__":
    print(make_icns(Path(sys.argv[1] if len(sys.argv) > 1 else "XScript.icns")))
