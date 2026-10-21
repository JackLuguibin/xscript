"""React Flow inside the real Qt shell (design §14.10). Offscreen + --disable-gpu.

S4/S5's pass bars are for a real window. This file records the offscreen numbers and
checks the things that do not depend on a GPU: the page renders, CSP holds, a bad
connection is refused, the attribution is visible, and bridge events do not throw.
"""
from __future__ import annotations

import pytest

pytest.importorskip("PySide6.QtWebEngineWidgets")

from PySide6.QtCore import QUrl

from xscript_desktop.scheme import RESOURCES

from .harness import build_shell, close_shell, have_build

pytestmark = [pytest.mark.qt, pytest.mark.skipif(not have_build() or not (RESOURCES / "spike.html").is_file(), reason="spike.html is not built")]


@pytest.fixture(scope="module")
def spike(qapp):
    sh = build_shell(size=(1100, 760))
    yield sh
    close_shell(sh)


def open_spike(sh, qtbot) -> None:
    """Load a fresh spike.html in every test. Under pytest-xdist the tests of this module can run on different
    workers, so a test cannot count on an earlier one having opened the page (it waited 20 s for a page nobody
    loaded). The marker only lives on the previous document, so the wait cannot pass before the navigation."""
    sh._eval(qtbot, "window.__xsBeforeLoad = 1; 0")
    sh.win.view.load(QUrl("xsapp://app/spike.html"))
    sh.wait_js(qtbot, "!window.__xsBeforeLoad && window.__spike && window.__spike.ready", timeout=20000)


def test_spike_renders_nodes_under_csp_and_refuses_a_bad_edge(spike, qtbot):
    sh = spike
    open_spike(sh, qtbot)
    assert sh.js(qtbot, "window.__spike.nodes()") == 2
    assert "React Flow" in sh.js(qtbot, "window.__spike.attribution()")
    blocked = sh.js(qtbot, "(async () => { try { await fetch('https://example.com/'); return false; } catch (e) { return true; } })()")
    assert blocked is True
    assert sh.js(qtbot, "window.__spike.connect('n0','exec-out','n1','exec-in')") is True
    assert sh.js(qtbot, "window.__spike.edges()") == 1
    assert sh.js(qtbot, "window.__spike.connect('n0','exec-out','n1','data-in')") is False
    assert sh.js(qtbot, "window.__spike.edges()") == 1
    label = sh._eval(qtbot, "(() => { const n = document.querySelector('.xnode'); n.focus(); return n.getAttribute('aria-label'); })()")
    assert isinstance(label, str) and label.startswith("节点")
    # Offscreen Qt does not deliver QTest clicks into the page, and d3-drag ignores
    # synthetic PointerEvents. Node drag on a real window is recorded by tools/reactflow_probe.py.
    box = sh.js(qtbot, "(() => { const r = document.querySelector('.react-flow__node').getBoundingClientRect(); return r.width; })()")
    assert box > 2


def test_spike_pan_samples_and_bridge_events(spike, qtbot):
    sh = spike
    open_spike(sh, qtbot)
    small = sh.js(qtbot, "window.__spike.measure(200, 300)", timeout=20000)
    # offscreen + --disable-gpu frame counts are recorded, not graded (S4/S5 bars are for a real window): the Windows
    # runner managed 7 frames in 300 ms once. Only require that the pan animation advanced.
    assert small["count"] == 200 and small["frames"] >= 2 and small["firstRenderMs"] > 0
    large = sh.js(qtbot, "window.__spike.measure(1000, 300)", timeout=30000)
    assert large["count"] == 1000 and large["firstRenderMs"] < 15000
    for i in range(100):
        sh.ctx.dispatcher.emit("spike.tick", {"n": i})
    qtbot.waitUntil(lambda: sh.js(qtbot, "window.__spike.bridgeEvents()") >= 100, timeout=8000)
    during = sh.js(qtbot, "window.__spike.measure(200, 300)", timeout=20000)
    print("REACTFLOW_SPIKE", {"offscreen_disable_gpu": {"n200": small, "n1000": large, "n200_after_bridge": during}})
