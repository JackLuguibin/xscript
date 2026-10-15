#!/usr/bin/env bash
# Reproducible release flow: App (APK) and VS Code extension (vsix) ship together under one version / one tag.
#
#   scripts/release.sh check                 versions agree (android versionName == extension version); used by verify.sh
#   scripts/release.sh prepare X.Y.Z         bump android versionName (+ versionCode + 1), extension package.json / lock,
#                                            the README download link, and turn CHANGELOG "未发布" into "vX.Y.Z（date）".
#                                            Edits files only; review, then commit (chore(release): vX.Y.Z) and push.
#   scripts/release.sh build [--skip-apk]    dist/release/: xscript-vX.Y.Z-release.apk (signed with keys/release.properties,
#                                            via android/build.sh), xscript-vscode-X.Y.Z.vsix, SHA256SUMS covering both
#   scripts/release.sh publish [--yes]       tag vX.Y.Z on the pushed HEAD and `gh release create` with the three files and the
#                                            CHANGELOG section as notes. Without --yes it only prints what it would do.
#
# Version policy: the extension version is the App release version (same tag, same Release page), so a vsix named
# xscript-vscode-0.2.5.vsix always belongs to Release v0.2.5. The extension is not published to the VS Code Marketplace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GRADLE=android/app/build.gradle.kts
EXT=ide/vscode-extension
DIST=dist/release

app_version() { sed -n 's/.*versionName = if (packed) packProp("version_name", "[^"]*") else "\([^"]*\)".*/\1/p' "$GRADLE"; }
ext_version() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$EXT/package.json"; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
need_version() { [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 prepare X.Y.Z" >&2; exit 2; }; }

cmd="${1:-}"; shift || true
case "$cmd" in
check)
  A="$(app_version)"; E="$(ext_version)"
  [ -n "$A" ] || { echo "release: cannot read versionName from $GRADLE" >&2; exit 1; }
  if [ "$A" != "$E" ]; then
    echo "release: extension version $E != App versionName $A (they ship together; see scripts/release.sh)" >&2; exit 1
  fi
  echo "release versions agree: $A"
  ;;
prepare)
  V="${1:-}"; need_version "$V"
  [ "$V" != "$(app_version)" ] || { echo "already at $V" >&2; exit 1; }
  python3 - "$V" "$GRADLE" <<'PY'
import re, sys
v, path = sys.argv[1:3]
s = open(path, encoding="utf-8").read()
s, n1 = re.subn(r'(packProp\("version_name", "[^"]*"\) else )"[^"]*"', r'\1"%s"' % v, s)
m = re.search(r'(packProp\("version_code", "1"\)\.toInt\(\) else )(\d+)', s)
s, n2 = re.subn(r'(packProp\("version_code", "1"\)\.toInt\(\) else )\d+', lambda _: m.group(1) + str(int(m.group(2)) + 1), s)
assert n1 == 1 and n2 == 1, "versionName / versionCode pattern not found"
open(path, "w", encoding="utf-8").write(s)
PY
  (cd "$EXT" && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
  python3 - "$V" <<'PY'
import datetime, re, sys
v = sys.argv[1]
s = open("README.md", encoding="utf-8").read()
s, n = re.subn(r"\[GitHub Release v\d+\.\d+\.\d+\]\(([^)]*)/releases/tag/v\d+\.\d+\.\d+\) 下载 `xscript-v\d+\.\d+\.\d+-release\.apk`",
               lambda m: "[GitHub Release v%s](%s/releases/tag/v%s) 下载 `xscript-v%s-release.apk`" % (v, m.group(1), v, v), s)
assert n == 1, "README download link not found"
open("README.md", "w", encoding="utf-8").write(s)
c = open("CHANGELOG.md", encoding="utf-8").read()
assert "\n## 未发布\n" in c, "CHANGELOG has no 未发布 section"
c = c.replace("\n## 未发布\n", "\n## 未发布\n\n## v%s（%s）\n" % (v, datetime.date.today().isoformat()), 1)
open("CHANGELOG.md", "w", encoding="utf-8").write(c)
PY
  echo "prepared v$V: $GRADLE, $EXT/package.json(+lock), README.md, CHANGELOG.md. Review (git diff), then: git commit -am 'chore(release): v$V' && git push"
  ;;
build)
  SKIP_APK=0; [ "${1:-}" = "--skip-apk" ] && SKIP_APK=1
  bash "$0" check
  V="$(app_version)"
  grep -q "^## v${V}（" CHANGELOG.md || { echo "CHANGELOG.md has no '## v${V}（日期）' section (run: $0 prepare $V)" >&2; exit 1; }
  rm -rf "$DIST"; mkdir -p "$DIST"
  (cd "$EXT" && { [ -d node_modules ] || npm ci --silent; } && rm -f xscript-vscode-*.vsix && npm run --silent package >/dev/null)
  cp "$EXT/xscript-vscode-$V.vsix" "$DIST/"
  if [ "$SKIP_APK" = 0 ]; then
    [ -f keys/release.properties ] || { echo "keys/release.properties missing: cannot sign the release APK (use --skip-apk to build only the vsix)" >&2; exit 1; }
    XSCRIPT_GRADLE_TASK=:app:assembleRelease bash android/build.sh >/dev/null
    cp android/app/build/outputs/apk/release/app-release.apk "$DIST/xscript-v$V-release.apk"
  fi
  (cd "$DIST" && sha256 xscript-* > SHA256SUMS && cat SHA256SUMS)
  echo "built $DIST/"
  ;;
publish)
  bash "$0" check
  V="$(app_version)"; TAG="v$V"
  FILES=("$DIST/xscript-v$V-release.apk" "$DIST/xscript-vscode-$V.vsix" "$DIST/SHA256SUMS")
  for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "missing $f (run: $0 build)" >&2; exit 1; }; done
  (cd "$DIST" && sha256 -c SHA256SUMS >/dev/null) || { echo "SHA256SUMS does not match the files in $DIST" >&2; exit 1; }
  NOTES="$(mktemp)"
  awk -v h="## ${TAG}（" 'index($0,h)==1{p=1;next} /^## /{p=0} p' CHANGELOG.md > "$NOTES"
  [ -s "$NOTES" ] || { echo "empty CHANGELOG section for $TAG" >&2; exit 1; }
  if [ "${1:-}" != "--yes" ]; then
    echo "dry run (add --yes to do it): tag $TAG on $(git rev-parse --short HEAD), then"
    echo "  gh release create $TAG --title 'XScript $TAG' --notes-file <CHANGELOG $TAG section, $(wc -l < "$NOTES" | tr -d ' ') lines> ${FILES[*]}"
    exit 0
  fi
  [ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 1; }
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "HEAD is not origin/main: push first" >&2; exit 1; }
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "tag $TAG already exists" >&2; exit 1; }
  gh release create "$TAG" --target "$(git rev-parse HEAD)" --title "XScript $TAG" --notes-file "$NOTES" "${FILES[@]}"
  ;;
*)
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2
  ;;
esac
