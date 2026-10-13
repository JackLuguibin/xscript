# xscript stubs

PC-only `.pyi` stubs for autocomplete and type checking. They cover both `xscript.android.*` and the `ascript.android.*` compatibility package. The real implementation runs only inside the XScript app on the phone.

```bash
pip install -e python-stubs
```

The stubs are generated from `python-runtime/`. Regenerate after changing the runtime:

```bash
python3 scripts/gen_stubs.py          # rewrite
python3 scripts/gen_stubs.py --check  # CI: fail if stale
```
