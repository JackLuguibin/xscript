# UI screenshot scenes

One file per PR (`prNN.py`). Each defines `SCENES = [fn, ...]`; every `fn(ui)` gets a fresh window against
`scripts/mock_device.py` and saves one or more PNGs with `ui.shot("NN-what")`. Run with
`desktop/app/tools/ui_screenshot.py` (see its docstring), usually against a `git worktree` of the PR branch:

```sh
git worktree add /tmp/shots/pr22 origin/feat/desktop-mirror-ux
ln -s "$PWD/desktop/frontend/node_modules" /tmp/shots/pr22/desktop/frontend/node_modules
xvfb-run -a -s "-screen 0 1600x1000x24" .venv-desktop/bin/python desktop/app/tools/ui_screenshot.py \
  --app /tmp/shots/pr22/desktop/app --build \
  --scenes desktop/app/tools/screenshot_scenes/pr22.py --out /tmp/shots/pr22/desktop/docs/screenshots/pr-22
```

Conventions
- Names: `NN-short-english.png`, numbered in the order the PR description shows them; `before-*.png` for the
  same view on `main` (run the `before_*` scenes with `--app <main checkout> --only before_...`).
- Default window 1200×760 (CSS px, DPR 1): readable in a PR body, ~100–300 KB per PNG.
- Commit the PNGs to the PR branch under `desktop/docs/screenshots/pr-NN/` and embed them in the PR body with
  commit-pinned `https://raw.githubusercontent.com/<owner>/<repo>/<sha>/desktop/docs/screenshots/pr-NN/<file>.png` URLs
  (pinned to a commit, they keep rendering after the branch is merged and deleted).
- The tool refuses to save a blank (single-colour) grab; still open the PNGs and look at them before posting.
