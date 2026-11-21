/**
 * 通过 CDP 对运行中的界面做一次结构化体检：溢出、重叠、文本截断、控制台报错。
 * 用法：CDP_PORT=9225 node scripts/audit.mjs <url>
 */

import WebSocket from "ws";

const url = process.argv[2] || "http://127.0.0.1:1420/";
const port = process.env.CDP_PORT || "9222";

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
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

const consoleErrors = [];
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.text ?? "exception");
  }
});

await send("Page.navigate", { url });
await new Promise((resolve) => setTimeout(resolve, 2500));

const expression = String.raw`(() => {
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const issues = [];
  const all = [...document.querySelectorAll("body *")];

  // 1. 横向溢出
  if (document.documentElement.scrollWidth > viewport.w + 1) {
    issues.push({ type: "page-overflow-x", detail: document.documentElement.scrollWidth + " > " + viewport.w });
  }

  // 2. 元素超出视口
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.position === "fixed") continue;
    if (rect.right > viewport.w + 2) {
      issues.push({ type: "outside-right", selector: path(el), right: Math.round(rect.right), w: Math.round(rect.width) });
    }
    if (rect.bottom > viewport.h + 2 && !closestScrollable(el)) {
      issues.push({ type: "outside-bottom", selector: path(el), bottom: Math.round(rect.bottom) });
    }
    if (rect.left < -2) {
      issues.push({ type: "outside-left", selector: path(el), left: Math.round(rect.left) });
    }
  }

  // 3. 文本截断但没省略号
  for (const el of all) {
    if (!el.childNodes.length) continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const style = getComputedStyle(el);
    if (style.overflow === "visible") continue;
    if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") continue;
    if (el.scrollWidth > el.clientWidth + 2) {
      issues.push({ type: "text-clipped", selector: path(el), scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent.trim().slice(0, 40) });
    }
    if (el.scrollHeight > el.clientHeight + 2 && style.overflowY !== "auto" && style.overflowY !== "scroll") {
      issues.push({ type: "text-clipped-y", selector: path(el), scroll: el.scrollHeight, client: el.clientHeight, text: el.textContent.trim().slice(0, 40) });
    }
  }

  // 4. 关键区块是否重叠
  const blocks = [".rail", ".conv-pane", ".main", ".detail", ".player"].map((sel) => {
    const el = document.querySelector(sel);
    return el ? { sel, rect: el.getBoundingClientRect() } : null;
  }).filter(Boolean);
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i], b = blocks[j];
      if (a.sel === ".player" || b.sel === ".player") continue;
      const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (overlapX > 2 && overlapY > 2) {
        issues.push({ type: "overlap", a: a.sel, b: b.sel, overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) });
      }
    }
  }

  // 5. 无名称的交互元素
  for (const el of document.querySelectorAll("button, [role=button]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    if (!name) issues.push({ type: "unnamed-button", selector: path(el) });
  }

  // 6. 颜色对比抽查：正文与背景
  const bodyColor = getComputedStyle(document.body).color;
  const htmlTheme = document.documentElement.dataset.theme;

  return {
    viewport,
    theme: htmlTheme,
    bodyColor,
    counts: {
      rail: document.querySelectorAll(".rail").length,
      convItems: document.querySelectorAll(".conv-item").length,
      voiceRows: document.querySelectorAll(".voice-row").length,
      statCards: document.querySelectorAll(".stat-card").length,
      toasts: document.querySelectorAll(".toast").length,
    },
    docHeight: document.documentElement.scrollHeight,
    issues: issues.slice(0, 60),
    issueCount: issues.length,
  };

  function closestScrollable(el) {
    let node = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function path(el) {
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node !== document.body && guard < 4) {
      let name = node.tagName.toLowerCase();
      if (node.className && typeof node.className === "string") {
        name += "." + node.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      parts.unshift(name);
      node = node.parentElement;
      guard += 1;
    }
    return parts.join(" > ");
  }
})()`;

const { result } = await send("Runtime.evaluate", { expression, returnByValue: true });
console.log(JSON.stringify({ ...result.value, consoleErrors }, null, 2));
socket.close();
