(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (pred) => [...document.querySelectorAll("button")].find(pred);
  const nav = btn((b) => b.querySelector(".label") && /工程|Projects/.test(b.querySelector(".label").textContent));
  nav?.click();
  for (let i = 0; i < 40 && !btn((b) => b.textContent.trim().startsWith("每日签到")); i++) await sleep(150);
  btn((b) => b.textContent.trim().startsWith("每日签到"))?.click();
  for (let i = 0; i < 40 && !btn((b) => b.textContent.trim().startsWith("lib/tasks.py")); i++) await sleep(150);
  btn((b) => b.textContent.trim().startsWith("lib/tasks.py"))?.click();
})();
