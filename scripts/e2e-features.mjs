/**
 * 验证 0.2.0 新增的筛选与批量操作确实作用于数据库，而不只是界面状态。
 *
 *   SYLK_CDP_PORT=9333 npm run app:open   # 另开终端
 *   npm run e2e:features
 */

import { mkdirSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const port = process.env.CDP_PORT || "9333";
const outDir = process.env.OUT_DIR || "D:/tmp/sylk-feat";
mkdirSync(outDir, { recursive: true });

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
// Edge 可能弹出同步确认之类的内部页面，按地址挑出真正的那一页
const page =
  targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost|tauri/.test(item.url)) ??
  targets.find((item) => item.type === "page" && !item.url.startsWith("edge://") && !item.url.startsWith("devtools"));
if (!page) {
  console.error("没有应用页面");
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
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 400));
  return result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (cmd, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
};

const ui = () =>
  evaluate(`(() => ({
    rows: document.querySelectorAll('.voice-row').length,
    count: (document.querySelector('.filter-bar__count') || {}).textContent || '',
    bulk: document.querySelector('.bulk-bar__count') ? document.querySelector('.bulk-bar__count').textContent : '',
    detail: !!document.querySelector('.detail'),
    filterTag: (document.querySelector('.filter-tag') || {}).textContent || '',
  }))()`);

/* ------------------------------------------------------------ 准备状态 ---- */

await send("Page.reload", { ignoreCache: true });
await wait(3200);

// 统计页没有语音行，先确保在语音视图
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.rail-btn')][0];
  if (b) b.click();
  return !!b;
})()`);
await wait(600);

let state = await ui();
if (state.rows === 0) {
  console.log("语音为空，先回溯一次");
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('.conv-item')];
    const t = items.find(i => /示例技术群/.test(i.textContent)) || items[0];
    if (t) t.click();
    return !!t;
  })()`);
  await wait(800);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '回溯');
    if (b) b.click();
    return !!b;
  })()`);
  for (let i = 0; i < 30; i += 1) {
    await wait(2000);
    const now = await ui();
    if (now.rows > 0) break;
  }
}

// 确保在「全部」时间范围
await evaluate(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '全部');
  if (seg) seg.click();
  return !!seg;
})()`);
await wait(700);
const base = await ui();
console.log("\n▸ 基线", base);
check("有可验证的语音", base.rows > 0, `${base.rows} 条`);

/* ------------------------------------------------------------ 时间筛选 ---- */

console.log("\n▸ 时间筛选");
for (const [label, expectLess] of [["今天", true], ["近 7 天", true], ["近 30 天", false]]) {
  await evaluate(`(() => {
    const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
    if (seg) seg.click();
    return !!seg;
  })()`);
  await wait(650);
  const now = await ui();
  const ok = expectLess ? now.rows <= base.rows : now.rows >= 0;
  console.log(`  ${label}: ${now.rows} 条 (${now.count.trim()})`);
}

// 今天的必须严格小于全部（mock 数据的语音分布在过去 26 天）
await evaluate(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '今天');
  if (seg) seg.click();
  return true;
})()`);
await wait(650);
const today = await ui();
check("「今天」确实过滤掉了历史语音", today.rows < base.rows, `${today.rows} < ${base.rows}`);

await evaluate(`(() => {
  const seg = [...document.querySelectorAll('.seg')].find(b => b.textContent.trim() === '全部');
  if (seg) seg.click();
  return true;
})()`);
await wait(650);
const backToAll = await ui();
check("切回「全部」恢复完整列表", backToAll.rows === base.rows, `${backToAll.rows} / ${base.rows}`);

/* ---------------------------------------------------------- 发送者筛选 ---- */

console.log("\n▸ 发送者筛选");
// 选中第一条，从详情面板点漏斗
await evaluate(`(() => {
  const row = document.querySelectorAll('.voice-row')[0];
  if (row) row.click();
  return !!row;
})()`);
await wait(500);
const targetSender = await evaluate(`(() => {
  const el = document.querySelector('.detail [style*="font-weight: 600"], .detail div');
  const nameEl = document.querySelectorAll('.detail div');
  for (const d of nameEl) {
    const s = d.getAttribute('style') || '';
    if (s.includes('font-weight: 600') && d.textContent.trim()) return d.textContent.trim();
  }
  return '';
})()`);
const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll('.detail .icon-btn')].find(x => /只看这个人/.test(x.getAttribute('aria-label') || ''));
  if (b) { b.click(); return true; }
  return false;
})()`);
await wait(800);
const filtered = await ui();
console.log(`  发送者「${targetSender}」→ ${filtered.rows} 条，筛选标签：${filtered.filterTag.trim()}`);
check("发送者筛选生效", clicked && filtered.rows > 0 && filtered.rows < backToAll.rows, `${filtered.rows} < ${backToAll.rows}`);
check("筛选条显示当前发送者", filtered.filterTag.includes("发送者"), filtered.filterTag.trim());
await shot("01-sender-filter");

// 校验后端也是按 sender 过滤的，而不是前端截取
const senderVoices = await invoke("query_voices", {
  query: { keyword: "", onlyStarred: false, onlyTranscribed: false, senderId: "1002", limit: 500 },
});
check(
  "后端按 senderId 过滤（不是前端截取）",
  senderVoices.items.every((v) => v.senderId === "1002"),
  `${senderVoices.items.length} 条，全部来自 1002`,
);

await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '清除筛选');
  if (b) b.click();
  return !!b;
})()`);
await wait(700);

/* -------------------------------------------------------------- 批量 ---- */

console.log("\n▸ 批量星标");
const beforeStar = await invoke("query_voices", {
  query: { keyword: "", onlyStarred: true, onlyTranscribed: false, senderId: "", limit: 500 },
});
console.log(`  批量前星标 ${beforeStar.items.length} 条`);

await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(400);
const picked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.voice-row')];
  const chosen = rows.slice(0, 3).map(r => r.textContent.slice(0, 20));
  rows.slice(0, 3).forEach(r => r.click());
  return chosen;
})()`);
await wait(400);
const bulkState = await ui();
check("多选计数正确", bulkState.bulk.includes("3"), bulkState.bulk);
await shot("02-bulk");

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.bulk-bar button')].find(x => x.textContent.trim() === '星标');
  if (b) b.click();
  return !!b;
})()`);
await wait(1500);
const afterStar = await invoke("query_voices", {
  query: { keyword: "", onlyStarred: true, onlyTranscribed: false, senderId: "", limit: 500 },
});
console.log(`  批量后星标 ${afterStar.items.length} 条`);
check(
  "批量星标写入数据库",
  afterStar.items.length >= beforeStar.items.length + 3,
  `${beforeStar.items.length} → ${afterStar.items.length}`,
);

/* --------------------------------------------------------- 跨会话筛选 ---- */

console.log("\n▸ 跨会话按人筛选");
await evaluate(`(() => { const b=[...document.querySelectorAll('.rail-btn')][1]; if(b) b.click(); return !!b; })()`);
await wait(1000);
const clickedSender = await evaluate(`(() => {
  const row = document.querySelector('.sender-row--link');
  if (!row) return false;
  row.click();
  return true;
})()`);
await wait(1400);
const cross = await ui();
const crossTitle = await evaluate(
  `((document.querySelector('.main__title')||{}).textContent || '').trim()`,
);
check("点统计页发送者能筛出结果", clickedSender && cross.rows > 0, `${cross.rows} 条`);
check("切到跨会话视图", crossTitle.includes("全部会话"), crossTitle.slice(0, 24));

await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '清除筛选');
  if (b) b.click();
  return !!b;
})()`);
await wait(900);
const restored = await evaluate(
  `((document.querySelector('.main__title')||{}).textContent || '').trim()`,
);
check("清除后回到单会话视图", !restored.includes("全部会话"), restored.slice(0, 20));

/* ---------------------------------------------------------- 详情折叠 ---- */

console.log("\n▸ 详情折叠");
await evaluate(`(() => {
  const b = document.querySelector('.icon-btn[aria-label="多选"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(400);

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.detail .icon-btn')].find(x => /收起面板/.test(x.getAttribute('aria-label') || ''));
  if (b) b.click();
  return !!b;
})()`);
await wait(600);
const closed = await ui();
check("折叠后详情消失", !closed.detail);
const hasOpenBtn = await evaluate(
  `!!document.querySelector('.main__actions .icon-btn[aria-label*="展开详情"]')`,
);
check("折叠后有可见的展开入口", hasOpenBtn);

await evaluate(`(() => {
  const b = document.querySelector('.main__actions .icon-btn[aria-label*="展开详情"]');
  if (b) b.click();
  return !!b;
})()`);
await wait(600);
const opened = await ui();
check("能重新展开", opened.detail);

/* ------------------------------------------------------------- 键盘 ---- */

console.log("\n▸ 键盘导航");
await evaluate(`(() => {
  const rows = document.querySelectorAll('.voice-row');
  if (rows[0]) rows[0].click();
  document.body.focus();
  return true;
})()`);
await wait(400);
const before = await evaluate(`document.querySelector('.voice-row.is-active')?.textContent.slice(0,24) || ''`);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await wait(400);
const after = await evaluate(`document.querySelector('.voice-row.is-active')?.textContent.slice(0,24) || ''`);
check("↓ 切换选中条目", before !== after && Boolean(after), `${before.slice(0, 10)} → ${after.slice(0, 10)}`);

/* ------------------------------------------------------------- 收尾 ---- */

console.log("\n▸ 控制台错误", errors.length ? errors.slice(0, 4) : "无");
check("无未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n结果：${checks.length - failed.length}/${checks.length} 项通过${
    failed.length ? `\n失败：${failed.map((f) => `${f.name}（${f.detail}）`).join("；")}` : ""
  }`,
);

socket.close();
process.exit(failed.length ? 1 : 0);
