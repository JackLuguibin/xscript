# XScript native API smoke test. Run on the device (Settings or any screen works).
import time

from xscript.android import action, node, screen, system, ui

print("status:", system.status().get("channel"), system.device().get("model"))
print("current app:", system.current_app())

# UI tree + selector
tree = node.dump(0)
print("roots:", len(tree.get("roots", [])))
clickables = node.Selector().clickable(True).find_all()
print("clickable nodes:", len(clickables))
if clickables:
    print("first:", clickables[0])

# Capture + color + OCR
img = screen.capture_cv()
print("frame:", None if img is None else img.shape)
if img is not None:
    h, w = img.shape[:2]
    print("center color:", screen.get_color(w // 2, h // 2))
    t = time.time()
    lines = screen.ocr()
    print("ocr lines: %d in %.2fs" % (len(lines), time.time() - t))
    for r in lines[:5]:
        print("  ", r.text, r.rect, round(r.confidence, 2))

# KeyValue round trip
system.KeyValue.save("smoke", {"n": 1, "s": "中文"})
print("kv:", system.KeyValue.get("smoke"))

# Overlay canvas
if ui.can_overlay():
    c = ui.Canvas().show()
    c.rect(100, 300, 500, 500, label="xscript", duration=1500)
    time.sleep(1.6)
    c.close()
    print("canvas ok")
print("shell:", system.shell("id").out.strip())
print("smoke done")
