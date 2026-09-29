# Third-party notices

## ascript-tip 1.3.0 (MIT)

The `ascript.android.*` compatibility package in `python-runtime/ascript/` mirrors the public API of
[ascript-tip](https://pypi.org/project/ascript-tip/) 1.3.0, which is published under the MIT License.
The template-matching strategy in `python-runtime/xscript/android/image.py` (grayscale / H+S matching,
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
| Pillow 9.2.0 | HPND |
| PyYAML | MIT |
| requests | Apache-2.0 |
| OkHttp 4.12.0 | Apache-2.0 |
| Google ML Kit Text Recognition (Chinese) | ML Kit Terms of Service |
