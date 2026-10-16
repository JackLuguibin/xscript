from PySide6.QtWidgets import QApplication

from xscript_desktop.main import ICON_PATH, app_icon


def test_icon_file_is_packaged_svg():
    assert ICON_PATH.is_file()
    assert ICON_PATH.read_text().lstrip().startswith("<svg")


def test_app_icon_renders():
    QApplication.instance() or QApplication([])
    icon = app_icon()
    assert not icon.isNull()
    assert not icon.pixmap(64, 64).isNull()
