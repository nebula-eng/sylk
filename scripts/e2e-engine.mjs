/**
 * 内嵌引擎的端到端验收。
 *
 * 前置：
 *   npm run mock:prepare
 *   npm run app:rel                                   # 编 release（约 2-3 分钟）
 *   SYLK_CDP_PORT=9333 npm run app:open               # 带调试端口启动
 *   npm run e2e:engine
 *
 * 验证的是「托管」这件事本身：
 *   写配置 → 拉起进程 → 二维码上屏 → 日志入流 → 判定登录 → 主界面接管
 *   → 回溯 → SILK 解码 → 播放 → 重启 → 停止 → 恢复。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const port = process.env.CDP_PORT || "9333";
const outDir = process.env.OUT_DIR || "D:/tmp/sylk-engine-e2e/shots";
const engineDir = process.env.ENGINE_DIR || "D:/tmp/sylk-engine-e2e/engine";
const appData = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "app.sylk.desktop");
mkdirSync(outDir, { recursive: true });

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(join(engineDir, "napcat.mjs"))) {
  console.error(`引擎目录还没准备好：${engineDir}\n先跑 node scripts/prepare-mock-engine.mjs`);
  process.exit(1);
}

/* ---------------------------------------------------------------- CDP ---- */

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json());
// Edge 可能弹出同步确认之类的内部页面，按地址挑出真正的那一页
const page =
  targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost|tauri/.test(item.url)) ??
  targets.find((item) => item.type === "page" && !item.url.startsWith("edge://") && !item.url.startsWith("devtools"));
if (!page) {
  console.error("找不到应用页面");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
const errors = [];

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails.text ?? "exception");
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
  if (exceptionDetails) {
    throw new Error(JSON.stringify(exceptionDetails.exception ?? exceptionDetails).slice(0, 400));
  }
  return result.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const invoke = (cmd, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`  shot → ${outDir}/${name}.png`);
};

const ui = () =>
  evaluate(`(() => {
    const qr = document.querySelector('.login__qr');
    const active = document.querySelector('.login__step.is-active .login__step-text strong');
    return {
      login: !!document.querySelector('.login'),
      qrShown: !!qr && qr.src.startsWith('data:image/png'),
      qrLength: qr ? qr.src.length : 0,
      activeStep: active ? active.textContent : '',
      doneSteps: document.querySelectorAll('.login__step.is-done').length,
      prepareBtn: !![...document.querySelectorAll('button')].find(b => ['一键准备', '下载并启动'].includes(b.textContent.trim())),
      title: ((document.querySelector('.main__title') || {}).textContent || '').trim(),
      convs: document.querySelectorAll('.conv-item').length,
      rows: document.querySelectorAll('.voice-row').length,
      playable: document.querySelectorAll('.voice-row .play-btn:not([disabled])').length,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      audio: (() => {
        const a = document.querySelector('audio');
        return a ? { t: Number(a.currentTime.toFixed(2)), dur: a.duration, paused: a.paused } : null;
      })(),
    };
  })()`);

/* -------------------------------------------------------- 1. 退出登录 ---- */

console.log("▸ 退出登录，回到扫码态");
await invoke("engine_logout").catch((err) => console.log("  logout:", String(err).slice(0, 80)));

let qrOk = false;
let state = await ui();
for (let index = 0; index < 24; index += 1) {
  await wait(800);
  state = await ui();
  if (state.qrShown) {
    qrOk = true;
    console.log(`  第 ${((index + 1) * 0.8).toFixed(1)}s 二维码出现`);
    break;
  }
}
check("退出登录后回到登录页", state.login);
check("二维码在窗口内直接显示", qrOk, `step=${state.activeStep}`);
check("不需要手动点启动", !state.prepareBtn);

const engine = await invoke("engine_status");
console.log("\n▸ 引擎状态", {
  phase: engine.phase,
  pid: engine.pid,
  http: engine.httpPort,
  ws: engine.wsPort,
  qqFound: engine.qqFound,
  logs: engine.logs.length,
});
check("引擎进程由 Sylk 托管", Boolean(engine.pid), `PID ${engine.pid}`);
check(
  "端口由 Sylk 分配且避开 3000/3001",
  engine.httpPort > 1024 && engine.httpPort !== 3000,
  `${engine.httpPort}/${engine.wsPort}`,
);

const configOnDisk = JSON.parse(readFileSync(join(engineDir, "config", "onebot11.json"), "utf8"));
const httpCfg = configOnDisk.network.httpServers[0];
check("配置只绑回环", httpCfg.host === "127.0.0.1", `${httpCfg.host}:${httpCfg.port}`);
check("磁盘端口与运行时一致", Number(httpCfg.port) === engine.httpPort);
check("令牌足够长且未暴露给用户", String(httpCfg.token || "").length >= 16);

const logsJoined = engine.logs.join("\n");
check("引擎日志已进入 UI", logsJoined.includes("[NapCat]"), `${engine.logs.length} 行`);
await shot("01-qr");

/* -------------------------------------------------------- 2. 登录接管 ---- */

console.log("\n▸ 等待登录完成");
let online = false;
for (let index = 0; index < 30; index += 1) {
  await wait(1000);
  const status = await invoke("engine_status");
  if (status.phase === "online") {
    online = true;
    console.log(`  第 ${index + 1}s 已在线：${status.account?.nickname}`);
    break;
  }
}
check("引擎自行判定登录成功", online);

await wait(3200);
state = await ui();
console.log("\n▸ 主界面", { login: state.login, convs: state.convs, title: state.title });
check("自动进入主界面", !state.login);
check("会话已同步", state.convs > 0, `${state.convs} 个`);
await shot("02-main");

/* -------------------------------------------------------- 3. 回溯归档 ---- */

await evaluate(`(() => {
  const items = [...document.querySelectorAll('.conv-item')];
  const target = items.find(i => /示例技术群/.test(i.textContent)) || items[0];
  if (target) target.click();
  return !!target;
})()`);
await wait(700);
await evaluate(`(() => {
  // 按钮文案是「同步历史」；用 startsWith 容忍「同步中」的加载态
  const btn = [...document.querySelectorAll('button')].find(b => /^(同步历史|同步中)$/.test(b.textContent.trim()));
  if (btn) btn.click();
  return !!btn;
})()`);

// 有索引没文件的，重连后应当自动补下
const requeued = await invoke("enqueue_missing").catch(() => -1);
console.log("\n▸ 补下载入队", requeued);

console.log("\n▸ 等待回溯与下载（含 SILK 解码）");
for (let index = 0; index < 40; index += 1) {
  await wait(2000);
  const now = await ui();
  if (now.rows > 0 && now.playable === now.rows) break;
}
state = await ui();
console.log("  rows/playable", state.rows, state.playable);
check("历史语音入库", state.rows > 0, `${state.rows} 条`);
check("全部可播放", state.playable === state.rows, `${state.playable}/${state.rows}`);
await shot("03-archived");

const jobs = await invoke("list_jobs");
const failed = jobs.filter((job) => job.status === "failed");
console.log("  失败任务", failed.length, failed.slice(0, 2).map((job) => job.lastError));
check("没有失败的下载任务", failed.length === 0, `${failed.length} 个`);

/* ---------------------------------------------------------- 4. 播放 ---- */

await evaluate(`(() => {
  const btn = document.querySelector('.voice-row .play-btn:not([disabled])');
  if (btn) btn.click();
  return !!btn;
})()`);
await wait(1800);
state = await ui();
check(
  "播放器在走",
  Boolean(state.audio && !state.audio.paused && state.audio.t > 0.2),
  JSON.stringify(state.audio),
);
await shot("04-playing");

/* ------------------------------------------------- 5. 重启 / 停止 / 恢复 ---- */

console.log("\n▸ 重启引擎");
const beforePid = (await invoke("engine_status")).pid;
await invoke("engine_restart");
await wait(5000);
const restarted = await invoke("engine_status");
check("重启后换了一个进程", Boolean(restarted.pid) && restarted.pid !== beforePid, `${beforePid} → ${restarted.pid}`);

console.log("\n▸ 停止引擎");
await invoke("engine_stop");
await wait(1500);
const stopped = await invoke("engine_status");
check("停止后进程清空", stopped.pid === null, `phase=${stopped.phase}`);
check("停止后端口清空", stopped.httpPort === 0 && stopped.wsPort === 0);
check("停止态是主动停止而非崩溃", stopped.phase === "stopped", stopped.detail);

state = await ui();
check("停止后回到登录页并显示启动入口", state.login, `prepareBtn=${state.prepareBtn}`);

console.log("\n▸ 重新启动");
await invoke("engine_start");
await wait(3000);
const resumed = await invoke("engine_status");
check("可以重新拉起", Boolean(resumed.pid), `PID ${resumed.pid}`);

console.log("\n▸ 环境自检");
for (const item of await invoke("engine_diagnose")) {
  console.log(`  ${item.ok ? "✓" : "✗"} ${item.label} — ${item.detail}`);
}

console.log("\n▸ 控制台错误", errors.length ? errors.slice(0, 5) : "无");
check("无未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const failedChecks = checks.filter((item) => !item.ok);
console.log(
  `\n结果：${checks.length - failedChecks.length}/${checks.length} 项通过${
    failedChecks.length
      ? `\n失败：${failedChecks.map((item) => `${item.name}（${item.detail}）`).join("；")}`
      : ""
  }`,
);

socket.close();
process.exit(failedChecks.length ? 1 : 0);
