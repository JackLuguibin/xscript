"""PR #20 fix/desktop-no-data-loss: unsaved marker in the sidebar, in-app confirm dialogs, native close prompt."""

FILES = {"__init__.py": "from xscript.android import action\n\nprint('hello')\n", "utils.py": "def add(a, b):\n    return a + b\n"}


def _dirty(ui):
    ui.seed_project("demo", FILES)
    ui.connect()
    ui.goto("工程")
    ui.click_starting("demo")
    ui.click_starting("__init__.py")
    ui.type_monaco("# 改了，还没保存\n")  # typed at the cursor (start of file)
    ui.wait_text("未保存")


def unsaved_marker(ui):
    """Edited file: 「未保存」 + the dot on the 工程 nav item, also while another page is open."""
    _dirty(ui)
    ui.settle()
    ui.shot("01-unsaved-projects-page")
    ui.goto("设备")
    ui.settle()
    ui.shot("02-unsaved-dot-on-other-page")


def confirm_dialogs(ui):
    """Opening another file with edits / deleting a file: the in-app ConfirmDialog (no window.confirm)."""
    _dirty(ui)
    ui.click_starting("utils.py")
    ui.wait_js("document.querySelector('[role=alertdialog]')")
    ui.settle()
    ui.shot("03-confirm-discard-dialog")
    ui.click("取消")
    ui.wait_js("!document.querySelector('[role=alertdialog]')")
    ui.click("删除 utils.py")
    ui.wait_js("document.querySelector('[role=alertdialog]')")
    ui.settle()
    ui.shot("04-confirm-delete-dialog")
    ui.click("取消")


def close_prompt(ui):
    """Closing the window with unsaved edits: the native prompt (Cancel is the default)."""
    _dirty(ui)
    ui.bot.waitUntil(lambda: ui.ctx.unsaved is True, 5000)
    win = ui.sh.win
    win._unsaved = lambda: (ui.ctx.unsaved, ui.ctx.ui_lang)  # what main.py wires; the test harness leaves it out
    ui.settle()
    ui.shot_modal(lambda: win.close(), "05-close-window-prompt")


SCENES = [unsaved_marker, confirm_dialogs, close_prompt]
