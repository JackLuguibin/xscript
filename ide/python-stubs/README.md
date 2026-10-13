# xscript 类型存根

仅在 PC 上使用的 `.pyi` 存根，用于自动补全和类型检查。覆盖 `xscript.android.*` 和 `ascript.android.*` 兼容包。真正的实现只在手机上的 XScript App 内运行。

```bash
pip install -e ide/python-stubs
```

存根由 `android/python-runtime/` 生成。修改运行时后需重新生成（在仓库根目录执行）：

```bash
python3 scripts/gen_stubs.py          # 重新生成
python3 scripts/gen_stubs.py --check  # CI 用：存根过期则失败
```

VS Code 扩展（`ide/vscode-extension`）在构建时会内置一份这些存根。
