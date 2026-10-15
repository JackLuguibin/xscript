# Sourced by vscode-host-test.sh / vscode-no-prompt-check.sh. Sets up a throw-away VS Code profile that can never ask
# for a login and never touches the user's accounts, keychain or ~/.vscode. Variables set: T (temp dir), BIN, CLI,
# and the arrays VSC_FLAGS (flags for the editor) / VSC_ENV (environment for it).
#
# What used to prompt (diagnosed from the profile logs + the editor's DOM, see docs/DEBUGGING.md):
#  1. Welcome page + the built-in Copilot Chat panel ("Sign in to use GitHub Copilot / Continue with GitHub");
#  2. the built-in GitHub Authentication extension reading "sessions from keychain" at startup, which makes VS Code
#     create / read the macOS login-keychain item "Code Safe Storage" (this is what can pop the keychain dialog);
#  3. "Prompting to enable cloud changes" (Edit Sessions / Continue On) and a ~/.vscode + Application Support write
#     into the real home directory.
# Fixes: a temp HOME (so ~/.vscode, ~/Library never get touched), the auth/GitHub/Copilot built-ins disabled,
# settings.json with AI features, welcome, cloud changes, telemetry, updates and trust turned off, --use-mock-keychain
# (the macOS Chromium switch; --password-store=basic is the Linux one and is passed too, harmlessly).
BIN="${1:-}"
if [ -z "$BIN" ]; then
  # Real VS Code only (stable build from https://code.visualstudio.com/Download; unzip it anywhere and point
  # XS_VSCODE at ".../Visual Studio Code.app/Contents/MacOS/Code").
  for c in "${XS_VSCODE:-}" "/tmp/vscode-real/Visual Studio Code.app/Contents/MacOS/Code" "/Applications/Visual Studio Code.app/Contents/MacOS/Code"; do
    [ -n "$c" ] && [ -x "$c" ] && BIN="$c" && break
  done
fi
[ -x "$BIN" ] || { echo "no VS Code binary found: download it (curl -L -o vscode.zip https://update.code.visualstudio.com/latest/darwin-arm64/stable), unzip, and pass the Contents/MacOS/Code path or set XS_VSCODE"; exit 2; }
APP="$(cd "$(dirname "$BIN")/../.." && pwd)"
# a freshly downloaded copy may carry the Gatekeeper quarantine flag (-> "downloaded from the Internet" dialog on first launch)
if [ "${APP#/Applications/}" = "$APP" ] && xattr "$APP" 2>/dev/null | grep -q com.apple.quarantine; then
  xattr -dr com.apple.quarantine "$APP"
fi
CLI="$(cd "$(dirname "$BIN")/../Resources/app/bin" 2>/dev/null && pwd)/code"
[ -x "$CLI" ] || { echo "no CLI wrapper at $CLI"; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T=$(mktemp -d); mkdir -p "$T/ud/User" "$T/ext" "$T/ws" "$T/home"
cp "$HERE/host-test/settings.json" "$T/ud/User/settings.json"
echo 'print("hi")' > "$T/ws/__init__.py"
# adb keeps using the real key directory (read by the adb server only); everything else lives under the temp HOME
VSC_ENV=(HOME="$T/home" ANDROID_USER_HOME="${ANDROID_USER_HOME:-$HOME/.android}")
VSC_FLAGS=(--user-data-dir "$T/ud" --extensions-dir "$T/ext" --disable-workspace-trust --disable-gpu
  --use-mock-keychain --password-store=basic --disable-telemetry --disable-updates --skip-welcome --skip-release-notes
  --disable-extension vscode.github-authentication --disable-extension vscode.github --disable-extension vscode.microsoft-authentication
  --disable-extension GitHub.copilot --disable-extension GitHub.copilot-chat)
