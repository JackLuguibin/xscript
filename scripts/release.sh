#!/usr/bin/env bash
# Release flow: App (APK) and VS Code extension (vsix) ship together under one version / one tag / one GitHub Release.
#
# PRIMARY PATH = CI: bump with `prepare`, commit + push, wait for the CI run on main to go green, then push the annotated tag
# vX.Y.Z; .github/workflows/release.yml re-verifies, builds the signed APK (GitHub Secrets) and the vsix, writes SHA256SUMS,
# checks the signing certificate and 16 KB alignment, and creates the Release. See docs/发布.md.
#
#   scripts/release.sh check                 versions agree (android versionName == extension version == runtime __version__ == desktop app version); used by verify.sh and CI
#   scripts/release.sh prepare X.Y.Z         bump android versionName (+ versionCode + 1), runtime __version__, extension package.json / lock,
#                                            the README / README.en.md download link, and turn CHANGELOG "未发布" into "vX.Y.Z（date）".
#                                            Edits files only; review, then commit (chore(release): vX.Y.Z) and push.
#   scripts/release.sh build [--skip-apk]    dist/release/: xscript-vX.Y.Z-release.apk (arm64-v8a + x86_64, signed with
#                                            keys/release.properties, or the file in $XSCRIPT_SIGNING_FILE, via android/build.sh),
#                                            xscript-vX.Y.Z-release-arm64-v8a.apk (phones only, about half the size),
#                                            xscript-vscode-X.Y.Z.vsix, SHA256SUMS covering all of them. Each APK is verified
#                                            (verify-apk) before it is accepted.
#   scripts/release.sh verify-apk <apk> [version] [package]   signature valid, signer cert == the known release cert, versionName (and
#                                            16 KB readiness via check_16kb.py). Cert: $XSCRIPT_EXPECT_CERT_SHA256 or the default below.
#   scripts/release.sh notes [vX.Y.Z]        prints the CHANGELOG section (the Release notes)
#   scripts/release.sh publish [--yes]       LOCAL FALLBACK (CI normally does this): tag vX.Y.Z on the pushed HEAD and
#                                            `gh release create` with the three files. Without --yes it only prints what it would do.
#
# Version policy: the extension version is the App release version (same tag, same Release page), so a vsix named
# xscript-vscode-0.2.5.vsix always belongs to Release v0.2.5. The extension is not published to the VS Code Marketplace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GRADLE=android/app/build.gradle.kts
EXT=ide/vscode-extension
DIST=dist/release
# SHA-256 of the release signing certificate (public value; `keytool -list` / `apksigner verify --print-certs`)
KNOWN_CERT_SHA256=e04b22c87fb67b47f1651f078f6e0640f30a555d63d59fbe8d2b86eb504829ac

app_version() { sed -n 's/.*versionName = if (packed) packProp("version_name", "[^"]*") else "\([^"]*\)".*/\1/p' "$GRADLE"; }
RUNTIME_INIT=android/python-runtime/xscript/__init__.py
STUB_INIT=ide/python-stubs/xscript/__init__.pyi   # IDE stubs mirror the runtime __version__
runtime_version() { sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$RUNTIME_INIT"; }
PYCHARM_PROPS=ide/pycharm-plugin/gradle.properties   # PyCharm plugin: pluginVersion = App version too
pycharm_version() { sed -n 's/^pluginVersion=//p' "$PYCHARM_PROPS"; }
DESKTOP_PY=desktop/app/pyproject.toml                 # desktop app: same version (release.yml checks it against the tag)
DESKTOP_INIT=desktop/app/xscript_desktop/__init__.py
DESKTOP_FE=desktop/frontend
desktop_version() { sed -n 's/^version = "\(.*\)"/\1/p' "$DESKTOP_PY"; }
ext_version() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$EXT/package.json"; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sdk_tool() { # newest build-tools binary: sdk_tool apksigner | aapt2 | zipalign
  local sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}" f
  f="$(ls -d "$sdk"/build-tools/*/"$1" 2>/dev/null | sort -V | tail -1)"
  [ -n "$f" ] || { echo "release: $1 not found under $sdk/build-tools (set ANDROID_HOME)" >&2; return 1; }
  echo "$f"
}
verify_apk() { # verify_apk <apk> [expected versionName] [expected package]
  local apk="$1" want="${2:-}" want_pkg="${3:-}" signer out fp name pkg
  [ -f "$apk" ] || { echo "release: no such APK: $apk" >&2; return 1; }
  signer="$(sdk_tool apksigner)"
  out="$("$signer" verify --print-certs "$apk")" || { echo "release: apksigner verify failed (unsigned or tampered APK?)" >&2; return 1; }
  # apksigner <= 36.0 prints "Signer #1 certificate SHA-256 digest: <hex>", newer ones "V2 Signer: certificate SHA-256 digest: <hex>"
  # (one line per signature scheme): every line must be the release certificate, and there must be at least one.
  fp="$(printf '%s\n' "$out" | sed -n 's/^.*certificate SHA-256 digest: *\([0-9a-fA-F]*\).*$/\1/p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  [ "$fp" = "${XSCRIPT_EXPECT_CERT_SHA256:-$KNOWN_CERT_SHA256}" ] \
    || { echo "release: APK signer certificate '$fp' is not the release certificate; apksigner said:" >&2; printf '%s\n' "$out" | grep -i 'certificate\|signer\|Verifies' >&2; return 1; }
  if [ -n "$want" ]; then
    name="$("$(sdk_tool aapt2)" dump badging "$apk" | sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p" | head -1)"
    [ "$name" = "$want" ] || { echo "release: APK versionName '$name' != '$want'" >&2; return 1; }
  fi
  if [ -n "$want_pkg" ]; then
    pkg="$("$(sdk_tool aapt2)" dump badging "$apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
    [ "$pkg" = "$want_pkg" ] || { echo "release: APK package '$pkg' != '$want_pkg'" >&2; return 1; }
  fi
  python3 scripts/check_16kb.py "$apk" >/dev/null || { echo "release: APK is not 16 KB ready (scripts/check_16kb.py)" >&2; return 1; }
  echo "apk ok: signed by the release certificate ($fp)${want:+, versionName $want}, 16 KB ready"
}
need_version() { [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 prepare X.Y.Z" >&2; exit 2; }; }

cmd="${1:-}"; shift || true
case "$cmd" in
check)
  A="$(app_version)"; E="$(ext_version)"
  [ -n "$A" ] || { echo "release: cannot read versionName from $GRADLE" >&2; exit 1; }
  if [ "$A" != "$E" ]; then
    echo "release: extension version $E != App versionName $A (they ship together; see scripts/release.sh)" >&2; exit 1
  fi
  P="$(pycharm_version)"
  if [ "$A" != "$P" ]; then
    echo "release: PyCharm plugin version $P ($PYCHARM_PROPS) != App versionName $A (they ship together)" >&2; exit 1
  fi
  D="$(desktop_version)"
  if [ "$A" != "$D" ]; then
    echo "release: desktop app version $D ($DESKTOP_PY) != App versionName $A (the dmg / setup.exe ship in the same Release)" >&2; exit 1
  fi
  R="$(runtime_version)"
  if [ "$A" != "$R" ]; then
    echo "release: runtime __version__ $R ($RUNTIME_INIT) != App versionName $A" >&2; exit 1
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
  sed -i.bak 's/^__version__ = "[^"]*"/__version__ = "'"$V"'"/' "$RUNTIME_INIT" && rm -f "$RUNTIME_INIT.bak"
  sed -i.bak "s/^__version__ = '[^']*'/__version__ = '$V'/" "$STUB_INIT" && rm -f "$STUB_INIT.bak"
  (cd "$EXT" && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
  sed -i.bak "s/^pluginVersion=.*/pluginVersion=$V/" "$PYCHARM_PROPS" && rm -f "$PYCHARM_PROPS.bak"
  sed -i.bak 's/^version = "[^"]*"/version = "'"$V"'"/' "$DESKTOP_PY" && rm -f "$DESKTOP_PY.bak"
  sed -i.bak 's/^__version__ = "[^"]*"/__version__ = "'"$V"'"/' "$DESKTOP_INIT" && rm -f "$DESKTOP_INIT.bak"
  (cd "$DESKTOP_FE" && npm version "$V" --no-git-tag-version --allow-same-version >/dev/null)
  python3 - "$V" <<'PY'
import datetime, os, re, sys
v = sys.argv[1]
s = open("README.md", encoding="utf-8").read()
s, n = re.subn(r"\[GitHub Release v\d+\.\d+\.\d+\]\(([^)]*)/releases/tag/v\d+\.\d+\.\d+\) 下载 `xscript-v\d+\.\d+\.\d+-release\.apk`",
               lambda m: "[GitHub Release v%s](%s/releases/tag/v%s) 下载 `xscript-v%s-release.apk`" % (v, m.group(1), v, v), s)
assert n == 1, "README download link not found"
open("README.md", "w", encoding="utf-8").write(s)
en = "README.en.md"   # English README: same download link (optional file)
if os.path.exists(en):
    t = open(en, encoding="utf-8").read()
    t, n = re.subn(r"download `xscript-v\d+\.\d+\.\d+-release\.apk` from \[GitHub Release v\d+\.\d+\.\d+\]\(([^)]*)/releases/tag/v\d+\.\d+\.\d+\)",
                   lambda m: "download `xscript-v%s-release.apk` from [GitHub Release v%s](%s/releases/tag/v%s)" % (v, v, m.group(1), v), t)
    assert n == 1, "README.en.md download link not found"
    open(en, "w", encoding="utf-8").write(t)
c = open("CHANGELOG.md", encoding="utf-8").read()
assert "\n## 未发布\n" in c, "CHANGELOG has no 未发布 section"
c = c.replace("\n## 未发布\n", "\n## 未发布\n\n## v%s（%s）\n" % (v, datetime.date.today().isoformat()), 1)
open("CHANGELOG.md", "w", encoding="utf-8").write(c)
PY
  echo "prepared v$V: $GRADLE, $RUNTIME_INIT, $EXT/package.json(+lock), $PYCHARM_PROPS, $DESKTOP_PY, $DESKTOP_INIT, $DESKTOP_FE/package.json(+lock), README.md, CHANGELOG.md. Review (git diff), then: git commit -am 'chore(release): v$V' && git push"
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
    SIGN="${XSCRIPT_SIGNING_FILE:-$ROOT/keys/release.properties}"
    [ -f "$SIGN" ] || { echo "release signing file missing ($SIGN): refusing to build an unsigned APK (use --skip-apk to build only the vsix)" >&2; exit 1; }
    rm -f android/app/build/outputs/apk/release/*.apk
    XSCRIPT_GRADLE_TASK=:app:assembleRelease bash android/build.sh "-Pxscript.signingFile=$SIGN" --console=plain >&2
    cp android/app/build/outputs/apk/release/app-release.apk "$DIST/xscript-v$V-release.apk"
    verify_apk "$DIST/xscript-v$V-release.apk" "$V"
    # Phones only need arm64-v8a: a second APK without the x86_64 (PC emulator) libraries, about half the size.
    rm -f android/app/build/outputs/apk/release/*.apk
    XSCRIPT_GRADLE_TASK=:app:assembleRelease bash android/build.sh "-Pxscript.signingFile=$SIGN" -Pxscript.abis=arm64-v8a --console=plain >&2
    cp android/app/build/outputs/apk/release/app-release.apk "$DIST/xscript-v$V-release-arm64-v8a.apk"
    verify_apk "$DIST/xscript-v$V-release-arm64-v8a.apk" "$V"
  fi
  (cd "$DIST" && sha256 xscript-* > SHA256SUMS && cat SHA256SUMS)
  echo "built $DIST/"
  ;;
verify-apk)
  verify_apk "${1:?usage: $0 verify-apk <apk> [version] [package]}" "${2:-}" "${3:-}"
  ;;
notes)
  TAG="${1:-v$(app_version)}"
  awk -v h="## ${TAG}（" 'index($0,h)==1{p=1;next} /^## /{p=0} p' CHANGELOG.md | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' | sed '1{/^$/d;}'
  ;;
publish)
  bash "$0" check
  V="$(app_version)"; TAG="v$V"
  FILES=("$DIST/xscript-v$V-release.apk" "$DIST/xscript-v$V-release-arm64-v8a.apk" "$DIST/xscript-vscode-$V.vsix" "$DIST/SHA256SUMS")
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
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 2
  ;;
esac
