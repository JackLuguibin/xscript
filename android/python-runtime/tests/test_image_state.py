"""screen.image_state / wait_image / wait_enabled on the golden scene (enabled, greyed out, recoloured, missing)."""

import os
import unittest
from unittest import mock

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "golden")


@unittest.skipIf(cv2 is None, "cv2/numpy not available")
class ImageStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from xscript.android import screen
        cls.screen = screen
        cls.tpl = os.path.join(GOLDEN, "btn_shop.png")
        cls.scene = cv2.imread(os.path.join(GOLDEN, "scene.png"))
        icon = cv2.imread(cls.tpl)
        h, w = icon.shape[:2]
        # find where the button is, then paint greyed-out / recoloured copies of it into the scene
        hit = screen.find_image(cls.tpl, image=cls.scene)
        l, t = hit["rect"][:2]
        cls.where = (l, t, w, h)
        grey = cv2.cvtColor(cv2.cvtColor(icon, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
        hsv = cv2.cvtColor(icon, cv2.COLOR_BGR2HSV)
        hsv[:, :, 0] = (hsv[:, :, 0].astype(int) + 30) % 180
        cls.greyed = cls._paste(grey)
        cls.recoloured = cls._paste(cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR))
        cls.missing = cls._paste(np.full_like(icon, 228))

    @classmethod
    def _paste(cls, patch):
        l, t, w, h = cls.where
        out = cls.scene.copy()
        out[t:t + h, l:l + w] = patch
        return out

    def test_states(self):
        s = self.screen
        self.assertEqual(s.image_state(self.tpl, image=self.scene), s.IMAGE_ENABLED)
        self.assertEqual(s.image_state(self.tpl, image=self.greyed), s.IMAGE_DISABLED)
        self.assertEqual(s.image_state(self.tpl, image=self.recoloured), s.IMAGE_DISABLED)
        self.assertIsNone(s.image_state(self.tpl, image=self.missing))

    def test_a_dimmed_screen_is_still_enabled(self):
        dim = (self.scene.astype(np.float32) * 0.8).astype(np.uint8)
        self.assertEqual(self.screen.image_state(self.tpl, image=dim, confidence=0.8), self.screen.IMAGE_ENABLED)

    def test_wait_enabled_returns_once_the_button_lights_up(self):
        frames = [self.greyed, self.greyed, self.scene]
        seen = []

        def capture():
            seen.append(1)
            return frames[min(len(seen), len(frames)) - 1]

        with mock.patch.object(self.screen._img, "capture_bgr", capture), mock.patch("time.sleep"):
            hit = self.screen.wait_enabled(self.tpl, timeout=5, interval=0.01)
        self.assertIsNotNone(hit)
        self.assertEqual(len(seen), 3)
        self.assertEqual(tuple(hit["rect"][:2]), self.where[:2])

    def test_wait_enabled_gives_up_while_greyed_out(self):
        with mock.patch.object(self.screen._img, "capture_bgr", lambda: self.greyed):
            self.assertIsNone(self.screen.wait_enabled(self.tpl, timeout=0.05, interval=0.01))

    def test_wait_image_finds_the_greyed_button_too(self):
        with mock.patch.object(self.screen._img, "capture_bgr", lambda rect=None: self.greyed):
            self.assertIsNotNone(self.screen.wait_image(self.tpl, timeout=0.05, interval=0.01))


if __name__ == "__main__":
    unittest.main()
