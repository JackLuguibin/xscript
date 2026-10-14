"""Opt-in, process-local DAP listener for an explicitly requested project run."""
import os
import threading


def start(timeout=120.0):
    # Android cannot use debugpy's normal child adapter or desktop C extensions.
    os.environ["PYDEVD_USE_CYTHON"] = "NO"
    os.environ["PYDEVD_USE_FRAME_EVAL"] = "NO"
    os.environ["PYDEVD_DISABLE_FILE_VALIDATION"] = "1"
    import debugpy

    debugpy.configure(subProcess=False)
    debugpy.listen(("127.0.0.1", 5678), in_process_debug_adapter=True)
    print("xscript: debugger listening on 127.0.0.1:5678; waiting for IDE")
    expired = threading.Event()

    def cancel():
        expired.set()
        debugpy.wait_for_client.cancel()

    timer = threading.Timer(timeout, cancel)
    timer.daemon = True
    timer.start()
    try:
        debugpy.wait_for_client()
        if expired.is_set() or not debugpy.is_client_connected():
            raise TimeoutError("debugger attach timed out; project was not executed")
        # The runner is called on a Java-created thread, rather than threading.Thread.
        debugpy.debug_this_thread()
        print("xscript: debugger attached")
    finally:
        timer.cancel()
