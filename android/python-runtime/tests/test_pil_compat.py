"""xscript.runtime.pil_compat: AScript-era Pillow names on Pillow 10+ (the APK ships Pillow 11.0.0).

Each case runs in a fresh interpreter so "PIL imported before / after install()" is real, not leftover sys.modules."""
import os
import subprocess
import sys
import textwrap
import unittest

try:
    import PIL  # noqa: F401
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(code):
    env = dict(os.environ, PYTHONPATH=ROOT + os.pathsep + os.environ.get("PYTHONPATH", ""))
    p = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], env=env, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return p.stdout.strip()


@unittest.skipUnless(HAVE_PIL, "Pillow not installed")
class PilCompatTest(unittest.TestCase):
    def test_constants_after_install_then_import(self):
        out = run("""
            from xscript.runtime import pil_compat
            pil_compat.install()
            from PIL import Image
            assert Image.ANTIALIAS == Image.Resampling.LANCZOS
            assert Image.LINEAR == Image.Resampling.BILINEAR and Image.CUBIC == Image.Resampling.BICUBIC
            print(Image.new("RGB", (40, 20)).resize((10, 5), Image.ANTIALIAS).size)
        """)
        self.assertEqual(out, "(10, 5)")

    def test_pil_imported_before_install_is_patched_too(self):
        out = run("""
            from PIL import Image, ImageDraw, ImageFont
            from xscript.runtime import pil_compat
            pil_compat.install()
            print(Image.ANTIALIAS == Image.Resampling.LANCZOS, hasattr(ImageDraw.ImageDraw, "textsize"), hasattr(ImageFont.FreeTypeFont, "getsize"))
        """)
        self.assertEqual(out, "True True True")

    def test_textsize_and_getsize_match_the_old_semantics(self):
        """Old getsize/textsize = right/bottom edge of the text drawn at the origin."""
        out = run("""
            from xscript.runtime import pil_compat
            pil_compat.install()
            from PIL import Image, ImageDraw, ImageFont
            font = ImageFont.load_default()
            draw = ImageDraw.Draw(Image.new("RGB", (200, 80)))
            l, t, r, b = draw.textbbox((0, 0), "Hello 42", font=font)
            assert draw.textsize("Hello 42", font=font) == (r, b), (draw.textsize("Hello 42", font=font), (r, b))
            fb = font.getbbox("Hello 42")
            assert font.getsize("Hello 42") == (fb[2], fb[3])
            ml = draw.multiline_textbbox((0, 0), "a\\nbb", font=font)
            assert draw.textsize("a\\nbb", font=font) == (ml[2], ml[3])
            assert draw.multiline_textsize("a\\nbb", font=font) == (ml[2], ml[3])
            if isinstance(font, ImageFont.FreeTypeFont):
                assert font.getsize_multiline("a\\nbb") == (ml[2], ml[3])
                assert font.getoffset("Hello") == font.getbbox("Hello")[:2]
            print("ok", r > 0 and b > 0)
        """)
        self.assertEqual(out, "ok True")

    def test_truetype_font(self):
        out = run("""
            import glob
            from xscript.runtime import pil_compat
            pil_compat.install()
            from PIL import ImageFont, ImageDraw, Image
            import PIL
            fonts = glob.glob(PIL.__path__[0] + "/../**/*.ttf", recursive=True) + glob.glob("/System/Library/Fonts/*.ttf") + glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
            if not fonts:
                print("skip"); raise SystemExit
            f = ImageFont.truetype(fonts[0], 24)
            b = f.getbbox("Ag")
            assert f.getsize("Ag") == (b[2], b[3])
            assert f.getoffset("Ag") == (b[0], b[1])
            d = ImageDraw.Draw(Image.new("L", (10, 10)))
            mb = d.multiline_textbbox((0, 0), "A\\ng", f)
            assert f.getsize_multiline("A\\ng") == (mb[2], mb[3])
            print("ok")
        """)
        self.assertIn(out, ("ok", "skip"))

    def test_install_is_idempotent_and_keeps_existing_names(self):
        out = run("""
            import sys
            from PIL import ImageDraw
            sentinel = lambda self, *a, **k: "mine"
            ImageDraw.ImageDraw.textsize = sentinel
            from xscript.runtime import pil_compat
            pil_compat.install(); pil_compat.install()
            print(sum(isinstance(f, pil_compat._Finder) for f in sys.meta_path), ImageDraw.ImageDraw.textsize is sentinel)
        """)
        self.assertEqual(out, "1 True")

    def test_other_imports_are_untouched(self):
        out = run("""
            from xscript.runtime import pil_compat
            pil_compat.install()
            import json, PIL, PIL.ImageOps
            print(type(PIL.ImageOps.__loader__).__name__ != "_Loader")
        """)
        self.assertEqual(out, "True")

    def test_runner_and_eval_install_it(self):
        out = run("""
            import sys
            from xscript.runtime import eval_runner, pil_compat
            r = eval_runner.run("from PIL import Image\\n_result = Image.ANTIALIAS == Image.Resampling.LANCZOS")
            print(r, any(isinstance(f, pil_compat._Finder) for f in sys.meta_path))
        """)
        self.assertEqual(out, "{'ok': True, 'result': 'true'} True")


if __name__ == "__main__":
    unittest.main()
