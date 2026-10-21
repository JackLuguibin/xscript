"""Per-run performance counters printed as one summary line when a run ends."""

import time

_state = {"start": 0.0, "captures": 0, "capture_s": 0.0}


def reset():
    _state.update(start=time.monotonic(), captures=0, capture_s=0.0)


def record_capture(seconds):
    _state["captures"] += 1
    _state["capture_s"] += max(0.0, seconds)


def peak_memory_mb():
    """Peak resident memory of this process in MB (VmHWM), or None when unknown."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) / 1024.0
    except Exception:
        pass
    try:
        import resource
        import sys
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return rss / (1024.0 * 1024.0) if sys.platform == "darwin" else rss / 1024.0
    except Exception:
        return None


def summary(now=None, peak_mb=None):
    """'xscript: 运行统计 用时 12.3s · 截图 45 次（平均 38ms）· 峰值内存 210MB'"""
    took = (time.monotonic() if now is None else now) - _state["start"]
    parts = ["用时 %.1fs" % max(0.0, took)]
    n = _state["captures"]
    if n:
        parts.append("截图 %d 次（平均 %dms）" % (n, round(_state["capture_s"] * 1000 / n)))
    else:
        parts.append("截图 0 次")
    if peak_mb is None:
        peak_mb = peak_memory_mb()
    if peak_mb:
        parts.append("峰值内存 %dMB" % round(peak_mb))
    return "xscript: 运行统计 " + " · ".join(parts)
