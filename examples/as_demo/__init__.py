# AScript-compatible demo: every import below is the AScript API, running on XScript.
# Works on any screen; open Android Settings first for the Selector section to find items.
import time

from ascript.android import action, system
from ascript.android.node import Selector
from ascript.android.screen import CompareColors, FindColors, FindImages, Ocr, capture, get_color
from ascript.android.system import Device, KeyValue, R
from ascript.android.ui import Canvas, Dialog

print("device:", Device.display().widthPixels, "x", Device.display().heightPixels)
app = Device.current_appinfo()
print("current app:", app.packageName, app.activity)

# ---- node selector (AScript chain style)
nodes = Selector().clickable(True).find_all()
print("clickable:", 0 if nodes is None else len(nodes))
first_text = Selector().type("TextView").text(".+").find()
if first_text:
    print("first text node:", first_text.text, first_text.rect)

# ---- capture: AScript returns an android Bitmap
bmp = capture()
print("bitmap:", bmp.getWidth(), bmp.getHeight())
c = get_color(bmp.getWidth() // 2, bmp.getHeight() // 2)
print("center color:", c)

# ---- colors: build a 2-point pattern from the live screen, then find/compare it
from ascript.android import screen

img = screen.bitmap_to_cvimage(bmp)
bmp.recycle()
x, y = 200, 400
b0, g0, r0 = [int(v) for v in img[y, x]]
b1, g1, r1 = [int(v) for v in img[y + 20, x + 30]]
pattern = "%d,%d,#%02X%02X%02X|%d,%d,#%02X%02X%02X" % (x, y, r0, g0, b0, x + 30, y + 20, r1, g1, b1)
print("compare self:", CompareColors.compare(pattern, image=img))
hit = FindColors.find(pattern, rect=[0, 0, img.shape[1], img.shape[0]])
print("find colors:", hit)

# ---- template: crop a patch and find it again
import cv2

import os

patch_path = R.res("demo_patch.png")
os.makedirs(os.path.dirname(patch_path), exist_ok=True)
cv2.imwrite(patch_path, img[300:380, 40:360])
found = FindImages.find_template(patch_path, confidence=0.9)
print("template:", None if not found else (found["center_x"], found["center_y"], round(found["confidence"], 3)))

# ---- OCR
t = time.time()
res = Ocr.find_all()
print("ocr: %d items in %.2fs" % (0 if res is None else len(res), time.time() - t))
for r in (res or [])[:3]:
    print("   ", r["text"], r["rect"], r["center_x"], r["center_y"])  # AScript returns dicts
hit = Ocr.find("设置")
if hit:
    print("ocr find 设置 at", hit["center_x"], hit["center_y"])

# ---- KeyValue
KeyValue.save("as_demo_runs", int(KeyValue.get("as_demo_runs", 0) or 0) + 1)
print("runs:", KeyValue.get("as_demo_runs"))

# ---- overlay canvas
cv = Canvas()
rid = cv.draw_rect(100, 600, 700, 800, color="#FF3366", stroke_width=6, duration=0, label="as_demo")
cv.draw_text(120, 560, "ascript on xscript", color="#FF3366", font_size=20, duration=1500)
time.sleep(1.5)
cv.remove(rid)
cv.close()
print("canvas ok")

Dialog.toast("as_demo done")
print("shell:", system.shell("id").res.strip())
print("as_demo done")
