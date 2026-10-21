// docs/images/desktop-connect-check-*.png: 设备页 → 连接 ADB 设备（手机上的 XScript 未打开）→ 「逐项检查连接」停在「XScript App 在响应」.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (pred) => {
    for (let i = 0; i < 80 && !pred(); i++) await sleep(150);
    return pred();
  };
  const nav = [...document.querySelectorAll("button")].find((b) => b.querySelector(".label") && /设备|Devices/.test(b.querySelector(".label").textContent));
  nav?.click();
  const btn = await wait(() => [...document.querySelectorAll("button")].find((b) => /^(连接|Connect) /.test(b.getAttribute("aria-label") || "")));
  btn?.click();
  await wait(() => document.querySelector(".connect-check .check-step.bad"));
  document.querySelector(".connect-check")?.scrollIntoView({ block: "center" });
})();
