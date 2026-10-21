(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (pred) => [...document.querySelectorAll("button")].find(pred);
  const waitBtn = async (pred) => { for (let i = 0; i < 60 && !btn(pred); i++) await sleep(150); return btn(pred); };
  const findInp = () => [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("192.168"));
  for (let i = 0; i < 80 && !findInp(); i++) await sleep(150);
  const inp = [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("192.168"));
  if (inp) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, "127.0.0.1:9871");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    const f = inp.closest("form");
    if (f) f.requestSubmit(); else inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await sleep(4000);
  (await waitBtn((b) => b.querySelector(".label") && /工程|Projects/.test(b.querySelector(".label").textContent)))?.click();
  (await waitBtn((b) => b.textContent.trim().startsWith("每日签到")))?.click();
  (await waitBtn((b) => b.textContent.trim().startsWith("lib/tasks.py")))?.click();
  for (let i = 0; i < 60 && !document.querySelector(".recent-runs li"); i++) await sleep(150);
  await sleep(300);
  // open the failed run's log: shows 复制日志 and 跳到出错行 (the mock device's log has a traceback there)
  document.querySelector(".recent-runs li button")?.click();
  await sleep(1500);
  document.querySelector(".recent-runs")?.scrollIntoView({ block: "center" });
})();
