// usage: node capture.js <cdp-port> <shot-dir> <name>...   Takes each screenshot (<shot-dir>/<name>.png) when driver.js signals
// ready-<name>: Page.captureScreenshot of the VS Code window through --remote-debugging-port (no Screen Recording permission).
const fs = require("fs");
const path = require("path");
const [port, dir, ...names] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let target;
  for (let i = 0; i < 120 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && /workbench/.test(t.url)); } catch {}
    if (!target) await sleep(500);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let n = 0; const waiting = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  const W = 1280, H = 800;
  await call("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const name of names) {
    for (let i = 0; i < 600 && !fs.existsSync(path.join(dir, "ready-" + name)); i++) await sleep(500);
    // the harness label "[Extension Development Host]" is not part of the product: drop it from the title bar text
    await call("Runtime.evaluate", { expression: `document.querySelectorAll('.window-title, .titlebar-center .window-title').forEach(e => { e.textContent = e.textContent.replace('[Extension Development Host] ', ''); })` });
    const r = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(r.data, "base64"));
    fs.writeFileSync(path.join(dir, "done-" + name), "");
    console.log("captured " + name);
  }
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
