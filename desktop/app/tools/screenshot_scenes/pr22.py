"""PR #22 feat/desktop-mirror-ux: mirror fits the window, landscape stacks, 适应窗口 / 1:1, retry overlay, typing."""


def _mirror(ui):
    ui.connect()
    ui.goto("屏幕")
    img = "document.querySelector('img[alt=\"设备屏幕\"]')"
    ui.wait_js("%s && %s.complete && %s.naturalWidth > 0" % (img, img, img), 15000)
    ui.settle(700)


def portrait_fit(ui):
    """Portrait phone: the whole screen (down to the nav bar) fits the window height."""
    _mirror(ui)
    ui.shot("01-portrait-fit")


def landscape_stacked(ui):
    """Landscape stream: picture on top at full width, tools below."""
    ui.set_frame(2400, 1080)
    _mirror(ui)
    ui.shot("02-landscape-stacked")


def actual_size(ui):
    """1:1: one device pixel per screen pixel, scrolling inside the window height."""
    _mirror(ui)
    ui.click("1:1")
    ui.settle(700)
    ui.shot("03-actual-1to1")


def retry_overlay(ui):
    """「取不到画面」 now has a 重试 button."""
    _mirror(ui)
    ui.click("暂停")
    ui.run_js("(() => { document.querySelector('img[alt=\"设备屏幕\"]').dispatchEvent(new Event('error')); return true; })()")
    ui.wait_text("取不到画面")
    ui.settle()
    ui.shot("04-retry-overlay")


def keyboard_compose(ui):
    """Click the picture and type: the line to send shows on the frame; Enter sends it."""
    _mirror(ui)
    ui.run_js("(() => { const f = document.querySelector('.mirror-frame'); f.focus(); for (const key of [...'hello 你好']) "
              "f.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})); return true; })()")
    ui.wait_js("document.querySelector('.mirror-compose')")
    ui.settle()
    ui.shot("05-keyboard-compose")


def before_portrait(ui):
    """main: the portrait picture is taller than the window."""
    _mirror(ui)
    ui.shot("before-portrait")


def before_landscape(ui):
    """main: a landscape stream squeezed into the 26rem column."""
    ui.set_frame(2400, 1080)
    _mirror(ui)
    ui.shot("before-landscape")


SCENES = [portrait_fit, landscape_stacked, actual_size, retry_overlay, keyboard_compose, before_portrait, before_landscape]
