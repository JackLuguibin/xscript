(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (pred) => [...document.querySelectorAll("button")].find(pred);
  const waitBtn = async (pred) => { for (let i = 0; i < 60 && !btn(pred); i++) await sleep(150); return btn(pred); };
  const findInp = () => [...document.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("192.168"));
  for (let i = 0; i < 80 && !findInp(); i++) await sleep(150);
  const inp = findInp();
  if (inp) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, "127.0.0.1:9871");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);
    inp.closest("form")?.requestSubmit();
  }
  await sleep(4000);
  (await waitBtn((b) => b.querySelector(".label") && /工程|Projects/.test(b.querySelector(".label").textContent)))?.click();
  (await waitBtn((b) => b.textContent.trim().startsWith("每日签到")))?.click();
  (await waitBtn((b) => b.textContent.trim().startsWith("res/ui/settings.ui.json")))?.click();
  (await waitBtn((b) => b.textContent.trim() === "+ 复选框"))?.click();
  await sleep(500);
  const label = [...document.querySelectorAll(".ui-designer .props label")].find((l) => /标题|Label/.test(l.textContent));
  const li = label?.querySelector("input");
  if (li) { li.value = "完成后通知"; li.dispatchEvent(new Event("input", { bubbles: true })); li.dispatchEvent(new Event("change", { bubbles: true })); }
  await sleep(500);
  if (window.__XS_SAVE__ !== false) btn((b) => b.textContent.trim() === "保存")?.click();
  await sleep(2500);
  document.querySelector(".ui-designer")?.parentElement?.scrollIntoView({ block: "start" });
})();
