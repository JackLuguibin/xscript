// docs/images/desktop-connect-error-*.png: 设备页 → 局域网地址填一个没人监听的端口 → 「连不上设备」提示和排查链接.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (pred) => {
    for (let i = 0; i < 60 && !pred(); i++) await sleep(150);
    return pred();
  };
  const nav = [...document.querySelectorAll("button")].find((b) => b.querySelector(".label") && /设备|Devices/.test(b.querySelector(".label").textContent));
  nav?.click();
  const box = await wait(() => document.querySelector('input[placeholder*="192.168.1.20"]'));
  if (!box) return;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(box, "127.0.0.1:1");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(100);
  box.form?.requestSubmit();
})();
