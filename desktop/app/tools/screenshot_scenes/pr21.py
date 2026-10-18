"""PR #21 feat/desktop-error-feedback: mapped error banner + 详情, success toast, per-item busy, device-card error."""
import asyncio


def mapped_error(ui):
    """LAN connect to a closed port: 「连不上设备」 + what to do; raw message and code behind 详情 / 复制."""
    ui.type_into("device address", "127.0.0.1:1")
    ui.click("连接地址")
    ui.wait_text("连不上设备", 15000)
    ui.click("详情")
    ui.wait_text("[device.unreachable]")
    ui.settle()
    ui.shot("01-error-banner-details")


def before_raw_error(ui):
    """main: the same failure as raw `message [code]`."""
    ui.type_into("device address", "127.0.0.1:1")
    ui.click("连接地址")
    ui.wait_text("device.unreachable", 15000)
    ui.settle()
    ui.shot("before-raw-error")


def success_toast(ui):
    """Run a project: auto-dismissing 「已启动 demo」 toast."""
    ui.seed_project("demo")
    ui.connect()
    ui.goto("工程")
    ui.click_starting("demo")
    ui.click_starting("__init__.py")
    ui.wait_js("document.querySelector('.monaco-host[data-ready=true]')", 20000)
    ui.click("保存并运行")
    ui.wait_text("已启动 demo")
    ui.settle(250)
    ui.shot("02-toast-started")


def per_item_busy(ui):
    """One adb device is still connecting (spinner); the other device, LAN connect and scan stay clickable."""
    ui.add_adb("phone-slow")
    ui.add_adb("phone-fast", port=ui.extra_mock())
    orig = ui.ctx.devices.connect_adb

    async def slow(serial, *a, **k):
        if serial == "phone-slow":
            await asyncio.sleep(3)
        return await orig(serial, *a, **k)

    ui.ctx.devices.connect_adb = slow
    ui.click("刷新")
    ui.click("连接 phone-slow", 10000)
    ui.wait_js("[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '连接 phone-slow' && b.disabled)")
    ui.type_into("device address", "192.168.1.20:9860")
    ui.settle(200)
    ui.shot("03-per-item-busy")
    ui.sleep(3200)  # let the slow connect finish before teardown


def device_card_error(ui):
    """A device that dropped off: the card's raw error goes through the same mapping."""
    ui.connect()
    rec = ui.ctx.devices.list()[0].to_dict()
    rec.update(state="offline", error="cannot reach 127.0.0.1:41000: [Errno 111] Connection refused", errorCode="device.unreachable")
    ui.ctx.dispatcher.emit("device.state", rec)
    ui.wait_text("连不上设备")
    ui.settle()
    ui.shot("04-device-card-error")


SCENES = [mapped_error, success_toast, per_item_busy, device_card_error, before_raw_error]
