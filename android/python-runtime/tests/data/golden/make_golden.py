"""Writes the golden image-matching fixtures in this folder. Run once; the committed PNGs and expected.json ARE the
reference. Re-running it is only for intentionally changing the fixtures (review the diff of expected.json).

    python android/python-runtime/tests/data/golden/make_golden.py
"""
import json
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 540, 960


def scene():
    rng = np.random.RandomState(20261020)
    img = np.full((H, W, 3), (236, 232, 228), np.uint8)
    # header: smooth gradient with soft noise (photos / banners)
    noise = cv2.GaussianBlur(rng.randint(0, 255, (24, 54, 3)).astype(np.uint8), (0, 0), 1.2)
    img[0:180] = cv2.resize(noise, (W, 180), interpolation=cv2.INTER_CUBIC)
    cv2.putText(img, "XScript Quest", (24, 110), cv2.FONT_HERSHEY_DUPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
    # three buttons with labels
    for i, (label, color) in enumerate([("START", (60, 160, 60)), ("SHOP", (200, 120, 40)), ("MAIL", (60, 60, 200))]):
        x, y = 40 + i * 165, 220
        cv2.rectangle(img, (x, y), (x + 140, y + 60), color, -1)
        cv2.rectangle(img, (x, y), (x + 140, y + 60), (30, 30, 30), 2)
        cv2.putText(img, label, (x + 22, y + 42), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
    # list rows with a coin icon each
    for r in range(6):
        y = 330 + r * 90
        cv2.rectangle(img, (20, y), (W - 20, y + 76), (250, 250, 250), -1)
        cv2.rectangle(img, (20, y), (W - 20, y + 76), (200, 200, 200), 1)
        cv2.putText(img, "Reward %d  x%d" % (r + 1, (r + 3) * 7), (110, y + 48), cv2.FONT_HERSHEY_SIMPLEX, 0.9,
                    (40, 40, 40), 2, cv2.LINE_AA)
        if r % 2 == 0:  # coins on rows 0, 2, 4
            c = (62, y + 38)
            cv2.circle(img, c, 24, (0, 190, 250), -1)
            cv2.circle(img, c, 24, (0, 120, 180), 3)
            cv2.putText(img, "$", (c[0] - 10, c[1] + 11), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 90, 140), 2, cv2.LINE_AA)
        else:  # gems on rows 1, 3, 5
            cx, cy = 62, y + 38
            pts = np.array([[cx, cy - 24], [cx + 20, cy], [cx, cy + 24], [cx - 20, cy]], np.int32)
            cv2.fillPoly(img, [pts], (200, 60, 160))
    # a distinctive textured badge (unique)
    badge = rng.randint(0, 255, (60, 60, 3)).astype(np.uint8)
    img[870:930, 440:500] = cv2.GaussianBlur(badge, (0, 0), 0.8)
    cv2.rectangle(img, (438, 868), (501, 931), (20, 20, 20), 2)
    # a colour marker for multi-point colour search: four solid squares
    for dx, dy, col in [(0, 0, (0, 0, 255)), (12, 0, (0, 255, 0)), (0, 12, (255, 0, 0)), (12, 12, (0, 255, 255))]:
        img[880 + dy:888 + dy, 40 + dx:48 + dx] = col
    return img


def write_masked_coin(coin):
    """coin_masked.png: the coin with alpha 0 outside its inscribed circle (radius 2px inside the crop)."""
    h, w = coin.shape[:2]
    a = np.zeros((h, w), np.uint8)
    cv2.circle(a, (w // 2, h // 2), min(w, h) // 2 - 2, 255, -1)
    cv2.imwrite(os.path.join(HERE, "coin_masked.png"), np.dstack([coin, a]))


def main():
    img = scene()
    cv2.imwrite(os.path.join(HERE, "scene.png"), img)
    boxes = {  # name: [left, top, right, bottom] cut from the scene
        "btn_shop.png": [205, 220, 346, 281],
        "coin.png": [36, 342, 89, 395],
        "badge.png": [438, 868, 502, 932],
        "title.png": [20, 70, 330, 125],
    }
    for name, (l, t, r, b) in boxes.items():
        cv2.imwrite(os.path.join(HERE, name), img[t:b, l:r])
    write_masked_coin(img[342:395, 36:89])
    # a template that is NOT in the scene: same style, other content
    absent = np.random.RandomState(99).randint(0, 255, (64, 64, 3)).astype(np.uint8)
    cv2.imwrite(os.path.join(HERE, "absent.png"), cv2.GaussianBlur(absent, (0, 0), 0.8))
    coin_tops = [342 + 180 * k for k in range(3)]
    expected = {
        "size": [W, H],
        "templates": {name: box for name, box in boxes.items()},
        "coin_rects": [[36, t, 89, t + 53] for t in coin_tops],
        "marker": {"colors": "40,880,#FF0000|52,880,#00FF00|40,892,#0000FF|52,892,#FFFF00", "at": [40, 880]},
    }
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(expected, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
