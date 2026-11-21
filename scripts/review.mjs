/**
 * 全面走查：截图 + 布局体检 + 交互可用性。
 *
 *   npm run dev
 *   node scripts/review.mjs [outDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const outDir = process.argv[2] || "D:/tmp/sylk-review";
const port = process.env.CDP_PORT || "9222";
const base = process.env.APP_URL || "http://127.0.0.1:1420/";
mkdirSync(outDir, { recursive: true });

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json());
// Edge 可能弹出同步确认之类的内部页面，按地址挑出真正的那一页
const page =
  targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost|tauri/.test(item.url)) ??
  targets.find((item) => item.type === "page" && !item.url.startsWith("edge://") && !item.url.startsWith("devtools"));
if (!page) {
  console.error("没有 page target");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
const errors = [];

socket.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

await new Promise((r, j) => {
  socket.once("open", r);
  socket.once("error", j);
});
await send("Page.enable");
await send("Runtime.enable");

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 300));
  return result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const setViewport = (w, h) =>
  send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: false,
  });

const shot = async (name) => {
  await wait(420);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`  shot → ${name}.png`);
};

/** 几何 + 可访问性体检 */
const audit = () =>
  evaluate(String.raw`(() => {
    const issues = [];
    const vw = innerWidth, vh = innerHeight;
    if (document.documentElement.scrollWidth > vw + 1) {
      issues.push({ t: "page-overflow-x", v: document.documentElement.scrollWidth });
    }
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const s = getComputedStyle(el);
      if (s.position === "fixed") continue;
      if (r.right > vw + 2) issues.push({ t: "over-right", el: String(el.className).slice(0, 34), v: Math.round(r.right) });
      if (r.left < -2) issues.push({ t: "over-left", el: String(el.className).slice(0, 34), v: Math.round(r.left) });
      if (r.bottom > vh + 2) {
        let n = el.parentElement, scroll = false;
        while (n) { if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) { scroll = true; break; } n = n.parentElement; }
        if (!scroll) issues.push({ t: "over-bottom", el: String(el.className).slice(0, 34), v: Math.round(r.bottom) });
      }
    }
    for (const el of document.querySelectorAll("body *")) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasText) continue;
      const s = getComputedStyle(el);
      if (s.overflow === "visible") continue;
      if (s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none") continue;
      if (el.scrollWidth > el.clientWidth + 2) {
        issues.push({ t: "text-clip", el: String(el.className).slice(0, 34), text: el.textContent.trim().slice(0, 24) });
      }
    }
    const unnamed = [...document.querySelectorAll("button")].filter((b) => {
      if (!b.getBoundingClientRect().width) return false;
      const n = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
      return !n;
    }).length;
    if (unnamed) issues.push({ t: "unnamed-buttons", v: unnamed });

    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    return {
      vw, vh,
      issueCount: issues.length,
      issues: issues.slice(0, 8),
      layout: {
        rail: box(".rail"),
        conv: box(".conv-pane"),
        main: box(".main"),
        detail: box(".detail"),
        player: box(".player"),
        toolbar: box(".toolbar"),
        bulkbar: box(".bulk-bar"),
      },
      counts: {
        rows: document.querySelectorAll(".voice-row").length,
        segs: document.querySelectorAll(".seg").length,
        chips: document.querySelectorAll(".chip").length,
        statCards: document.querySelectorAll(".stat-card").length,
      },
    };
  })()`);

const clickText = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
    if (el) { el.click(); return true; }
    return false;
  })()`);

/* ------------------------------------------------------------ 1440 主界面 ---- */

await setViewport(1440, 900);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await send("Page.navigate", { url: base });
await wait(2600);

console.log("\n▸ 1440 主界面");
let report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues, counts: report.counts }));
await shot("01-main-1440");

/* --------------------------------------------------------------- 时间筛选 ---- */

console.log("\n▸ 点击「近 7 天」");
await evaluate(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '近 7 天');
  if (seg) seg.click();
  return !!seg;
})()`);
await wait(700);
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues, counts: report.counts }));
await shot("02-range-week");

console.log("\n▸ 清除筛选");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '清除筛选');
  if (b) b.click();
  return !!b;
})()`);
await wait(600);

/* ------------------------------------------------------------------ 多选 ---- */

console.log("\n▸ 进入多选");
await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(500);
await evaluate(`(() => {
  const rows = document.querySelectorAll('.voice-row');
  if (rows[0]) rows[0].click();
  if (rows[2]) rows[2].click();
  return rows.length;
})()`);
await wait(400);
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues, bulkbar: report.layout.bulkbar }));
await shot("03-bulk-select");

console.log("\n▸ 退出多选");
await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(400);

/* ---------------------------------------------------------- 详情折叠 ---- */

console.log("\n▸ 选中一条语音后折叠详情");
await evaluate(`(() => {
  const rows = document.querySelectorAll('.voice-row');
  if (rows[1]) rows[1].click();
  return rows.length;
})()`);
await wait(600);
await shot("04-detail-open");

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.detail .icon-btn')].find(x => /收起面板/.test(x.getAttribute('aria-label') || ''));
  if (b) b.click();
  return !!b;
})()`);
await wait(600);
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, detail: report.layout.detail, main: report.layout.main }));
await shot("05-detail-closed");

console.log("\n▸ 展开回来");
await evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); return true; })()`);
await wait(600);

/* ------------------------------------------------------------- 窄窗口 ---- */

console.log("\n▸ 1100 宽");
await setViewport(1100, 820);
await wait(700);
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues, layout: report.layout }));
await shot("06-narrow-1100");

console.log("\n▸ 960 宽");
await setViewport(960, 760);
await wait(700);
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues }));
await shot("07-narrow-960");

/* ------------------------------------------------------------- 统计页 ---- */

await setViewport(1440, 900);
await wait(500);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.rail-btn')][1];
  if (b) b.click();
  return !!b;
})()`);
await wait(900);
console.log("\n▸ 统计页");
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues, cards: report.counts.statCards }));
await shot("08-stats");

await setViewport(1100, 820);
await wait(600);
report = await audit();
console.log("\n▸ 统计页 1100");
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues }));
await shot("09-stats-narrow");

/* ------------------------------------------------------------- 登录页 ---- */

await setViewport(1440, 900);
await evaluate(`localStorage.setItem('sylk.preview.login','0'); location.reload(); true`);
await wait(2600);
console.log("\n▸ 登录页");
report = await audit();
console.log(JSON.stringify({ issueCount: report.issueCount, issues: report.issues }));
await shot("10-login");

console.log("\n▸ 控制台错误", errors.length ? errors.slice(0, 5) : "无");
await evaluate(`localStorage.removeItem('sylk.preview.login'); true`);

socket.close();
