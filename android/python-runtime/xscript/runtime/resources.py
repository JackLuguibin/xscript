"""Release per-run Android subscriptions in both script and reusable eval hosts."""
import sys
import traceback


def cleanup():
    # Never import a module here: cleanup must not initialize hardware or permissions.
    for name in ("ascript.android.sensor", "ascript.android.location"):
        module = sys.modules.get(name)
        shutdown = getattr(module, "_shutdown", None) if module is not None else None
        if callable(shutdown):
            try:
                shutdown()
            except Exception:
                traceback.print_exc()
    try:
        from xscript.runtime.bridge import bridge
        bridge.system("device_resources_close", {})
    except Exception:
        traceback.print_exc()
