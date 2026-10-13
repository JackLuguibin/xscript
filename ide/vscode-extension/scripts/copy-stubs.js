// Copies ../python-stubs/{xscript,ascript} into ./stubs so the packaged extension ships
// the same .pyi files that scripts/gen_stubs.py generates from android/python-runtime.
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "..", "..", "python-stubs");
const dest = path.resolve(__dirname, "..", "stubs");

fs.rmSync(dest, { recursive: true, force: true });
for (const pkg of ["xscript", "ascript"]) {
  const from = path.join(src, pkg);
  if (!fs.existsSync(from)) {
    console.error("missing stubs: " + from + " (run scripts/gen_stubs.py)");
    process.exit(1);
  }
  fs.cpSync(from, path.join(dest, pkg), {
    recursive: true,
    filter: (p) => !p.includes("__pycache__"),
  });
}
console.log("stubs copied to " + path.relative(process.cwd(), dest));
