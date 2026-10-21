// Copies the Web IDE's basic checks (android/app/src/main/assets/tools/editor-{parse,symbols,docs}.js) into
// out/web-ide/, where src/lint.ts requires them. One source, so VS Code's Problems show what the Web IDE shows.
const fs = require("fs");
const path = require("path");

const tools = path.resolve(__dirname, "..", "..", "..", "android", "app", "src", "main", "assets", "tools");
const dest = path.resolve(__dirname, "..", "out", "web-ide");
fs.mkdirSync(dest, { recursive: true });
for (const name of ["editor-parse.js", "editor-symbols.js", "editor-docs.js"]) {
  const src = path.join(tools, name);
  if (!fs.existsSync(src)) {
    console.error("missing shared Web IDE file: " + src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(dest, name));
}
console.log("Web IDE checks copied (out/web-ide/editor-{parse,symbols,docs}.js)");
