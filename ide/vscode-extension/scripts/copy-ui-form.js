// Copies the UI designer files shared with the Web IDE (android/app/src/main/assets/tools/) into the build:
// ui-form.js (generator) -> out/ui-form-core.js, where src/uiForm.ts requires it, and ui-form.js + ui-designer.js
// (designer view) -> media/, which the webview loads. One source, so both designers behave and generate the same.
const fs = require("fs");
const path = require("path");

const tools = path.resolve(__dirname, "..", "..", "..", "android", "app", "src", "main", "assets", "tools");
const ext = path.resolve(__dirname, "..");
const copies = [
  ["ui-form.js", path.join(ext, "out", "ui-form-core.js")],
  ["ui-form.js", path.join(ext, "media", "ui-form.js")],
  ["ui-designer.js", path.join(ext, "media", "ui-designer.js")],
];
for (const [name, dest] of copies) {
  const src = path.join(tools, name);
  if (!fs.existsSync(src)) {
    console.error("missing shared UI designer file: " + src);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
console.log("UI designer files copied (out/ui-form-core.js, media/ui-form.js, media/ui-designer.js)");
