// Docs screenshot: open the screen (屏幕) page of the connected device, where the 截图状态 card / chip lives.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (pred) => [...document.querySelectorAll("button")].find(pred);
  const nav = () => btn((b) => b.querySelector(".label") && /^(屏幕|Screen)$/.test(b.querySelector(".label").textContent.trim()));
  for (let i = 0; i < 40 && !nav(); i++) await sleep(150);
  nav()?.click();
})();
