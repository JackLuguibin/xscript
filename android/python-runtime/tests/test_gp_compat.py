"""Behavioral GP checks using actual OpenCV images, no Android device required."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import cv2
import numpy as np

from ascript.android.screen import gp, gp_tasks

PREFIX = "ascript.android.screen.gp_tasks."


def task(name, params=""):
    return {"id": PREFIX + name, "type": "OpenCV工具", "data": {"params": params}}


class GPCompatTest(unittest.TestCase):
    def setUp(self):
        self.image = np.zeros((60, 80, 3), dtype=np.uint8)
        self.image[20:40, 30:50] = 255

    def test_exported_json_crops_thresholds_and_recognizes_contours(self):
        jobs = [task("Crop", "20, 10, 60, 50"), task("GrayImage"), task("Threshold", "128"),
                task("Canny", "blur=0, draw=Canny.DRAW_NONE, area_range=[200, 0], approx=0.04, detect_shape=True")]
        result = gp.GPStack.run_json(json.dumps(jobs), self.image)
        self.assertEqual((result.offset_x, result.offset_y), (20, 10))
        self.assertEqual(result.image.shape, (40, 40, 3))
        self.assertEqual(len(result.data), 1)
        box = result.data[0]
        self.assertEqual(box["shape"], "square")
        self.assertTrue(8 <= box["x"] <= 10)
        self.assertTrue(18 <= box["w"] <= 22)
        self.assertEqual(set(np.unique(result.image)), {0, 255})

    def test_task_boundary_normalizes_channels_and_preserves_data(self):
        observed = []
        marker = {"recognized": True}

        class Recognize(gp.GPTask):
            def run(self, image, offset_x=0, offset_y=0, data=None):
                observed.append((image.shape, offset_x, offset_y, data))
                return gp.Result(image, offset_x, offset_y, marker)

        class Consume(gp.GPTask):
            def run(self, image, offset_x=0, offset_y=0, data=None):
                self_data = data
                return gp.Result(image, offset_x, offset_y, self_data)

        result = (gp.GPStack(self.image).add(gp_tasks.Crop(20, 10, 60, 50))
                  .add(gp_tasks.Threshold(128)).add(Recognize()).add(gp_tasks.Resize(width=20)).add(Consume()).run())
        self.assertEqual(observed, [((40, 40, 3), 20, 10, None)])
        self.assertIs(result.data, marker)
        self.assertEqual(result.image.shape, (20, 20, 3))

    def test_screen_recognition_task_receives_processed_pixels(self):
        jobs = [task("Crop", "20, 10, 60, 50"), task("Threshold", "128"),
                {"id": "ascript.android.screen.Colors", "data": {"params": "'FFFFFF'"}}]
        result = gp.GPStack.run_json(jobs, self.image)
        self.assertEqual(result.data, 400)
        self.assertEqual((result.offset_x, result.offset_y), (20, 10))

    def test_screenshot_fallback_and_structured_arguments(self):
        with patch("ascript.android.screen.bitmap_to_cvimage", return_value=self.image) as capture:
            result = gp.GPStack.run_json([{"id": PREFIX + "Crop", "args": [20, 10, 60, 50]}])
        capture.assert_called_once_with()
        self.assertEqual(result.image.shape, (40, 40, 3))

    def test_plain_directory_and_zip_gp_without_executing_python(self):
        jobs = json.dumps([task("Threshold", "128, inv=True")])
        with tempfile.TemporaryDirectory() as directory:
            plain = Path(directory) / "data.gp"
            plain.write_text(jobs)
            packed = Path(directory) / "export.gp"
            with zipfile.ZipFile(packed, "w") as archive:
                archive.writestr("as_gp_export/data.gp", jobs)
                archive.writestr("as_gp_export/__init__.py", "raise RuntimeError('must not execute')")
            for path in (plain, directory, packed):
                result = gp.run(path, self.image)
                self.assertEqual(result.image.ndim, 2)
                self.assertEqual(int(result.image[0, 0]), 255)
                self.assertEqual(int(result.image[25, 35]), 0)

    def test_unsupported_and_executable_inputs_raise(self):
        for jobs, error in [([{"id": "unknown.Task"}], NotImplementedError),
                            ([dict(task("Crop"), nv="plugin:1")], NotImplementedError),
                            ([task("Threshold", "__import__('os').getcwd()")], ValueError),
                            ([task("Threshold", "**{}")], ValueError),
                            ([task("Threshold", "100, inv=True, inv=False")], ValueError),
                            ([task("Crop", "-1, 0, 20, 20")], ValueError),
                            ([task("Canny", "algo='unknown'")], ValueError)]:
            with self.subTest(jobs=jobs), self.assertRaises(error):
                gp.GPStack.run_json(jobs, self.image)

    def test_archive_rejects_ambiguous_data_or_package_without_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            packed = Path(directory) / "bad.gp"
            for members in ({"__init__.py": "pass"}, {"a/data.gp": "[]", "b/data.gp": "[]"}):
                with zipfile.ZipFile(packed, "w") as archive:
                    for name, content in members.items():
                        archive.writestr(name, content)
                with self.assertRaises(ValueError):
                    gp.run(packed, self.image)

    def test_contour_algorithms_and_filters(self):
        for algo in ("canny", "sobel", "laplacian", "adaptive"):
            with self.subTest(algo=algo):
                detector = gp_tasks.Canny(algo=algo, blur=0, draw=gp_tasks.Canny.DRAW_NONE,
                                          width_range=[15, 35], height_range=[15, 35])
                result = detector.run(self.image)
                self.assertEqual(len(result.data), 1)
                self.assertTrue(25 <= result.data[0]["cx"] <= 45)
                np.testing.assert_array_equal(result.image, self.image)
                self.assertEqual(gp_tasks.Canny(algo=algo, area_range=[2000, 0]).run(self.image).data, [])

    def test_resize_aspect_ratio_and_rotation_canvas(self):
        self.assertEqual(gp_tasks.Resize(width=40).run(self.image).image.shape[:2], (30, 40))
        self.assertEqual(gp_tasks.Rotate(90, expand=False).run(self.image).image.shape, self.image.shape)
        self.assertEqual(gp_tasks.Rotate(90).run(self.image).image.shape[:2], (80, 60))
        expanded = gp_tasks.Rotate(45).run(self.image).image
        self.assertGreater(expanded.shape[0], self.image.shape[0])
        self.assertGreater(expanded.shape[1], self.image.shape[1])

    def test_empty_pipeline_and_invalid_task_return(self):
        self.assertIs(gp.GPStack.run_json([], self.image).image, self.image)
        class Broken:
            def run(self, *args):
                return None
        with self.assertRaises(TypeError):
            gp.GPStack(self.image).add(Broken()).run()


if __name__ == "__main__":
    unittest.main()
