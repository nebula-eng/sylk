/**
 * 产出 docs/screenshots 里用的正式截图。
 *
 *   npm run dev        # 或 tauri dev（两者都能被浏览器访问）
 *   node scripts/final-shots.mjs
 *
 * 需要 CDP：msedge --headless=new --remote-debugging-port=9222 --user-data-dir=… about:blank
 */

import { mkdirSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const port = process.env.CDP_PORT || "9222";
const base = process.env.APP_URL || "http://127.0.0.1:1420/";
const out = process.env.OUT_DIR || "docs/screenshots";
mkdirSync(out, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json());
// Edge 可能弹出同步确认之类的内部页面，按地址挑出真正的那一页
const page =
  targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost|tauri/.test(item.url)) ??
  targets.find((item) => item.type === "page" && !item.url.startsWith("edge://") && !item.url.startsWith("devtools"));
if (!page) {
  console.error("没有可用的 page target");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 920,
  deviceScaleFactor: 2,
  mobile: false,
});
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
});

const evaluate = async (expression) => {
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hideDemoBanner = () =>
  evaluate(`(() => {
    document.querySelector('.demo-banner')?.remove();
    // 浏览器扩展（如豆包）会往页面注入悬浮头像，截图前清掉，避免拍到用户自己的内容。
    document.querySelectorAll('doubao-ai-csui, [id^="doubao-ai"], [class*="doubao-ai"]').forEach((el) => el.remove());
    return true;
  })()`);
const shot = async (name) => {
  await wait(450);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = `${out}/${name}.png`;
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  ${file}`);
};

const clickRail = (index) =>
  evaluate(`(() => { const b=[...document.querySelectorAll('.rail-btn')]; if(b[${index}]) b[${index}].click(); return !!b[${index}]; })()`);
const closeOverlay = () =>
  evaluate(`(() => { const b=document.querySelector('.overlay .icon-btn[aria-label="关闭"]'); if(b) b.click(); return !!b; })()`);

/** 文档配图不要暗角：把遮罩背景临时设成透明，截图后恢复 */
const lightenOverlay = () =>
  evaluate(`(() => {
    const el = document.querySelector('.overlay');
    if (!el) return false;
    el.dataset.prevBg = el.style.background || '';
    el.style.background = 'rgba(10,13,19,0.06)';
    return true;
  })()`);

/* 登录页 */
await send("Page.navigate", { url: base });
await wait(1200);
await evaluate(`localStorage.setItem('sylk.preview.login','0'); location.reload(); true`);
await wait(1800);
await hideDemoBanner();
await wait(2600);
console.log("登录页");
await shot("01-login-light");

/* 主界面 */
await evaluate(`localStorage.removeItem('sylk.preview.login'); location.reload(); true`);
await wait(2600);
await hideDemoBanner();
console.log("主界面");
await shot("02-main-light");

/* 语音详情 */
await evaluate(`(() => { const rows=document.querySelectorAll('.voice-row'); if(rows[1]) rows[1].click(); return rows.length; })()`);
await wait(600);
console.log("详情");
await shot("03-detail-light");

/* 时间筛选 */
await evaluate(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '近 7 天');
  if (seg) seg.click();
  return !!seg;
})()`);
await wait(700);
console.log("筛选");
await shot("11-range-week");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '清除筛选');
  if (b) b.click();
  return !!b;
})()`);
await wait(500);

/* 多选 */
await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(400);
await evaluate(`(() => {
  const rows = document.querySelectorAll('.voice-row');
  [0, 2, 3].forEach(i => rows[i] && rows[i].click());
  return rows.length;
})()`);
await wait(400);
console.log("多选");
await shot("12-bulk");
await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(400);

/* 统计 */
await clickRail(1);
await wait(800);
console.log("统计");
await shot("04-stats-light");

/* 任务 */
await clickRail(2);
await wait(700);
console.log("任务");
await shot("05-jobs-light");

/* 设置 · 引擎 */
await evaluate(`(() => { const b=[...document.querySelectorAll('.rail-btn')]; b[b.length-1].click(); return true; })()`);
await wait(700);
await evaluate(`(() => { const t=[...document.querySelectorAll('.settings__tab')][0]; if(t) t.click(); return !!t; })()`);
await wait(500);
await lightenOverlay();
console.log("设置 · 引擎");
await shot("06-settings-engine");

/* 设置 · 转写 */
await evaluate(`(() => { const t=[...document.querySelectorAll('.settings__tab')][3]; if(t) t.click(); return !!t; })()`);
await wait(400);
console.log("设置 · 转写");
await shot("07-settings-asr");

/* 搜索 */
await closeOverlay();
await wait(300);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); true`);
await wait(400);
await evaluate(`(() => {
  const input = document.querySelector('.palette__field input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '日志');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await wait(800);
await lightenOverlay();
console.log("搜索");
await shot("08-search-light");

/* 深色 */
await closeOverlay();
await wait(300);
await clickRail(0);
await wait(500);
await evaluate(`document.documentElement.dataset.theme='dark'; true`);
await wait(500);
console.log("深色主界面");
await shot("09-main-dark");

await evaluate(`localStorage.setItem('sylk.preview.login','0'); location.reload(); true`);
await wait(2600);
await hideDemoBanner();
await evaluate(`document.documentElement.dataset.theme='dark'; true`);
await wait(500);
await shot("10-login-dark");
await evaluate(`localStorage.removeItem('sylk.preview.login'); true`);

console.log("完成");
socket.close();
