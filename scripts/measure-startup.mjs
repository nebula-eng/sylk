/**
 * 量真实的启动耗时：从进程拉起，到前端上报首帧。
 *
 *   node scripts/measure-startup.mjs [次数]
 *
 * 不用秒表猜：程序自己在 `report_ready` 里记「从进程启动到界面可点」的毫秒数，
 * 写进日志。这里读那行日志，同时用外部时钟兜一遍，两个数字互相印证。
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rounds = Number(process.argv[2] || 3);
const root = process.cwd();
/** 默认量安装版（用户真正双击的那个）；SYLK_EXE 可以指向别处 */
const exe =
  process.env.SYLK_EXE ||
  join(
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
    "Sylk",
    process.platform === "win32" ? "sylk.exe" : "sylk",
  );
const logDir = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "app.sylk.desktop",
  "logs",
);

/** 日志按 UTC 日期滚动，不要自己拼日期，直接挑最新的那个 */
function currentLog() {
  try {
    const files = readdirSync(logDir)
      .filter((name) => name.startsWith("sylk.log"))
      .map((name) => {
        const path = join(logDir, name);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? join(logDir, "sylk.log");
  } catch {
    return join(logDir, "sylk.log");
  }
}

const countByImage = (image) => {
  const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`], { encoding: "utf8" }).stdout || "";
  return out.split("\n").filter((line) => line.toLowerCase().includes(image.toLowerCase())).length;
};

const killAll = () => {
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq sylk.exe"], { encoding: "utf8" }).stdout || "";
  for (const line of out.split("\n")) {
    const pid = line.trim().split(/\s+/)[1];
    if (pid && /^\d+$/.test(pid)) {
      spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    }
  }
};

/**
 * 等 WebView2 真正退干净再测。
 * 强杀主进程后，它的 msedgewebview2 子进程还要一两秒才释放 user-data-dir 的锁；
 * 这时候起下一个实例，新 WebView2 会等锁，量出来就是 3-5 秒的假数据。
 */
const waitClean = async (label) => {
  for (let i = 0; i < 60; i += 1) {
    const sylk = countByImage("sylk.exe");
    const webview = countByImage("msedgewebview2.exe");
    if (sylk === 0 && webview <= baselineWebview) {
      if (label) console.log(`  ${label}：环境干净（webview 进程 ${webview}）`);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.warn("  警告：环境一直不干净，数字可能偏高");
};

let baselineWebview = 0;

const readFrom = (offset) => {
  try {
    const size = statSync(currentLog()).size;
    if (size <= offset) return { text: "", offset: size };
    const fd = openSync(currentLog(), "r");
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    return { text: buffer.toString("utf8"), offset: size };
  } catch {
    return { text: "", offset };
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];

// 先记下空闲状态下本来就有多少 webview 进程（系统里其他程序也会用）
killAll();
await sleep(1500);
baselineWebview = countByImage("msedgewebview2.exe");
console.log(`基线：其他程序的 webview 进程 ${baselineWebview} 个\n`);

for (let round = 1; round <= rounds; round += 1) {
  killAll();
  await waitClean(round === 1 ? "预热" : null);

  let offset = 0;
  try {
    offset = statSync(currentLog()).size;
  } catch {
    offset = 0;
  }

  const started = process.hrtime.bigint();
  const child = spawn(exe, [], { cwd: join(root, "src-tauri"), stdio: "ignore", detached: true });
  child.unref();

  let internal = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && internal === null) {
    const { text, offset: next } = readFrom(offset);
    offset = next;
    const match = text.match(/首屏就绪 · 从进程启动算起 (\d+) ms/);
    if (match) internal = Number(match[1]);
    else await sleep(25);
  }
  const wall = Number(process.hrtime.bigint() - started) / 1e6;

  results.push({ round, internal, wall: Math.round(wall) });
  console.log(
    `第 ${round} 次：程序自报 ${internal ?? "超时"} ms · 外部时钟 ${Math.round(wall)} ms`,
  );
}

killAll();

const ok = results.filter((r) => typeof r.internal === "number");
if (ok.length) {
  const values = ok.map((r) => r.internal).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  console.log(
    `\n首帧就绪：中位 ${median} ms · 最快 ${values[0]} ms · 最慢 ${values[values.length - 1]} ms`,
  );
} else {
  console.log("\n没读到日志，检查日志目录：", logDir);
  process.exitCode = 1;
}
