# Third-party notices

## ascript-tip 1.3.0 (MIT)

The `ascript.android.*` compatibility package in `android/python-runtime/ascript/` mirrors the public API of
[ascript-tip](https://pypi.org/project/ascript-tip/) 1.3.0, which is published under the MIT License.
The template-matching strategy in `android/python-runtime/xscript/android/image.py` (grayscale / H+S matching,
SQDIFF + RMSE scoring for transparent templates, log-spaced scales, coarse-to-fine pass) follows its
`screen.ascv` module.

The package metadata declares `License: MIT` without shipping a license file or a copyright line.
The standard MIT terms apply:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

"AScript" is the name of a separate product (com.aojoy.airscript). XScript is not affiliated with it.

## Bundled runtime components

| Component | License |
| --- | --- |
| Chaquopy (Python on Android) | MIT (since Chaquopy 12; confirm for your version) |
| numpy 1.23.3 | BSD-3-Clause |
| opencv-python 4.5.1.48 | Apache-2.0 (OpenCV 4.5+) |
| Pillow 11.0.0 | HPND (MIT-CMU) |
| PyYAML | MIT |
| requests 2.33.1 | Apache-2.0 |
| packaging 24.2 | Apache-2.0 / BSD-2-Clause |
| OkHttp 4.12.0 | Apache-2.0 |
| Google ML Kit Text Recognition (Chinese) | ML Kit Terms of Service |
| ONNX Runtime Android 1.22.0 | MIT |

## Downloaded at runtime (not in the APK)

| Component | License |
| --- | --- |
| PaddleOCR PP-OCRv5 / PP-OCRv4 models (ONNX exports by RapidOCR, from ModelScope / Hugging Face) | Apache-2.0 |
| Packages installed with `xscript.android.pip` | Their own licenses; check before redistributing a packaged app that bundles them |

YOLO models are supplied by the user. Ultralytics YOLOv8 / YOLO11 weights and code are AGPL-3.0 unless you hold an
Ultralytics Enterprise license. That applies to models you train from their pretrained weights and ship inside a
packaged app.

## Desktop client (`desktop/`)

The desktop client (not part of the APK) depends on these packages; none are vendored into the repository.

- **PySide6 / Qt for Python** (Qt 6, QtWebEngine, QtWebChannel) — LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only (or a commercial license). The
  client is meant to be shipped in directory (not one-file) form with the Qt libraries as separate, replaceable libraries, with the LGPL text and a
  source offer. `qwebchannel.js` (served to the page at runtime) is part of Qt WebChannel. Packaging has not been done yet; see
  `docs/桌面端设计.md` §5.6 / §13-6. This is not legal advice.
- **httpx** — BSD-3-Clause.
- **React**, **react-dom** — MIT. **Vite**, **@vitejs/plugin-react**, **Vitest**, **Testing Library**, **TypeScript** (Apache-2.0) — build/test tooling only.

