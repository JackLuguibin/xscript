#!/usr/bin/env python3
"""Speed of image matching on the golden scene (tests/data/golden), with generous budgets for CI.

    PYTHONPATH=android/python-runtime python3 android/python-runtime/tests/bench_matching.py          # report
    PYTHONPATH=android/python-runtime python3 android/python-runtime/tests/bench_matching.py --check  # exit 1 over budget

Each case runs a few times after a warm-up (templates are cached) and the median is compared with its budget. The
budgets are several times what a laptop needs (see BUDGET_MS) so a slow CI runner passes; a matching change that makes
a path several times slower does not. Scale them with XS_BENCH_FACTOR (e.g. 2 on a slow machine).
"""
import json
import os
import statistics
import sys
import tempfile
import time

import cv2

from xscript.android import screen

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "golden")
RUNS = 7
# budget ms. Comments: median on an M-series Mac / on the GitHub ubuntu runner (CI), with the phone pins (numpy
# 1.23.3, OpenCV 4.5.4). Each budget is at least 3x the CI median: room for a slower runner, not for a path that got
# several times slower. SIFT (feature) is ~4x slower on the runner than on the Mac, hence its larger budget.
BUDGET_MS = {
    "template: find every template": 150,              # 22 / 33
    "template: find_all coins": 40,                    # 5 / 9
    "template: rgb find_all coins": 50,                # 7 / 13
    "multiscale: find on a 0.8x screen": 150,          # 18 / 23
    "multiscale: find_all coins on a 1.25x screen": 450,  # 63 / 84
    "feature: rotated 10 degrees": 600,                # 45 / 179
    "auto: 90 degree screenshot": 200,                 # 25 / 48
}


def main():
    exp = json.load(open(os.path.join(GOLDEN, "expected.json")))
    scene = os.path.join(GOLDEN, "scene.png")
    img = cv2.imread(scene)
    h, w = img.shape[:2]
    tmp = tempfile.mkdtemp()

    def variant(name, im):
        p = os.path.join(tmp, name)
        cv2.imwrite(p, im)
        return p

    small = variant("x08.png", cv2.resize(img, None, fx=0.8, fy=0.8, interpolation=cv2.INTER_AREA))
    big = variant("x125.png", cv2.resize(img, None, fx=1.25, fy=1.25, interpolation=cv2.INTER_CUBIC))
    rot = variant("r10.png", cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2.0, h / 2.0), 10, 1.0), (w, h),
                                            borderValue=(236, 232, 228)))
    r90 = variant("r90.png", cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE))
    t = lambda n: os.path.join(GOLDEN, n)  # noqa: E731
    cases = {
        "template: find every template": lambda: [screen.find_image(t(n), image=scene) for n in exp["templates"]],
        "template: find_all coins": lambda: screen.find_all_images(t("coin.png"), image=scene),
        "template: rgb find_all coins": lambda: screen.find_all_images(t("coin.png"), image=scene, rgb=True),
        "multiscale: find on a 0.8x screen": lambda: screen.find_image(t("title.png"), image=small, confidence=0.6,
                                                                       method="multiscale", scale_range=(0.6, 1.6)),
        "multiscale: find_all coins on a 1.25x screen": lambda: screen.find_all_images(
            t("coin.png"), image=big, confidence=0.8, method="multiscale", scale_range=(0.6, 1.6)),
        "feature: rotated 10 degrees": lambda: screen.find_image(t("title.png"), image=rot, confidence=0.5, method="feature"),
        "auto: 90 degree screenshot": lambda: screen.find_image(t("btn_shop.png"), image=r90, confidence=0.5, method="auto"),
    }
    factor = float(os.environ.get("XS_BENCH_FACTOR", "1"))
    over = []
    print("%-46s %9s %9s" % ("case", "median ms", "budget"))
    for name, fn in cases.items():
        fn()  # warm-up: template cache, OpenCV's first-call setup
        times = []
        for _ in range(RUNS):
            s = time.perf_counter()
            fn()
            times.append((time.perf_counter() - s) * 1000)
        med, budget = statistics.median(times), BUDGET_MS[name] * factor
        print("%-46s %9.1f %9.0f%s" % (name, med, budget, "  OVER" if med > budget else ""))
        if med > budget:
            over.append(name)
    for n in os.listdir(tmp):
        os.remove(os.path.join(tmp, n))
    os.rmdir(tmp)
    if over:
        print("over budget: " + ", ".join(over))
    return 1 if over and "--check" in sys.argv else 0


if __name__ == "__main__":
    sys.exit(main())
