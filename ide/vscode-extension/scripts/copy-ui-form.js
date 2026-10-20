// Copies the UI designer core shared with the Web IDE (android/app/src/main/assets/tools/ui-form.js) to
// out/ui-form-core.js, where src/uiForm.ts requires it. One source, so the two designers generate the same files.
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "..", "..", "..", "android", "app", "src", "main", "assets", "tools", "ui-form.js");
const dest = path.resolve(__dirname, "..", "out", "ui-form-core.js");
if (!fs.existsSync(src)) {
  console.error("missing UI designer core: " + src);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log("ui-form core copied to " + path.relative(process.cwd(), dest));
