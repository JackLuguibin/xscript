// docs/images/desktop-projects-search-*.png: 工程页 → 每日签到 → 在工程中搜索 "ocr_click" → open the second result.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (pred) => [...document.querySelectorAll("button")].find(pred);
  const wait = async (pred) => {
    for (let i = 0; i < 60 && !pred(); i++) await sleep(150);
    return pred();
  };
  const nav = btn((b) => b.querySelector(".label") && /工程|Projects/.test(b.querySelector(".label").textContent));
  nav?.click();
  (await wait(() => btn((b) => b.textContent.trim().startsWith("每日签到"))))?.click();
  const box = await wait(() => document.querySelector('input[type="search"]'));
  if (!box) return;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(box, "ocr_click");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(100);
  box.form?.requestSubmit();
  const hits = await wait(() => {
    const all = document.querySelectorAll(".search-hit");
    return all.length > 1 ? all : null;
  });
  hits?.[1]?.click();
})();
