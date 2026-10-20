import traceback


def run(code):
    """Execute a short snippet. Caller must assign `_result`."""
    scope = {"_result": None, "__name__": "__xscript_eval__"}
    try:
        from xscript.runtime import sitepkgs

        sitepkgs.activate()
        from xscript.runtime import pil_compat

        pil_compat.install()
    except Exception:
        pass
    try:
        exec(code, scope, scope)
        result = scope.get("_result")
        if result is None:
            return {"ok": True, "result": ""}
        if isinstance(result, str):
            return {"ok": True, "result": result}
        try:
            import json

            return {"ok": True, "result": json.dumps(result, ensure_ascii=False, default=str)}
        except Exception:
            return {"ok": True, "result": str(result)}
    except Exception:
        return {"ok": False, "result": "", "error": traceback.format_exc()}
    finally:
        from xscript.runtime.resources import cleanup
        cleanup()
