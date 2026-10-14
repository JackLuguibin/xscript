# Android debugger dependency

`debugpy-1.8.22-py2.py3-none-any.whl` is an upstream universal wheel built from
Microsoft's unmodified debugpy 1.8.22 source distribution, with optional Cython
build disabled. The upstream MIT license and ThirdPartyNotices are included in
the wheel. Runtime uses pure Python pydevd, disables frame-eval, and runs the
adapter in the script process; no desktop adapter subprocess is launched.

Source: https://pypi.org/project/debugpy/1.8.22/

Source SHA-256: `e489c7268e1c7b41e13b438d9c533d2a7af73fb59bf8cd30fead8286c1c39c4e`

Bundled wheel SHA-256: `e27e1181f6aec399d72cfa71bb234036e8f96776bef44cb88cef40f779231689`

To rebuild, unpack the verified source into a temporary directory, install
`setuptools` and `wheel` in a build environment, then run from the source root:

```sh
SKIP_CYTHON_BUILD=1 python setup.py bdist_wheel --universal
```

Wheel timestamps/build-tool metadata can change its hash when rebuilding;
verify the source digest and record any replacement wheel's digest here.
This wheel does not add remote attach-to-process support on Android.
