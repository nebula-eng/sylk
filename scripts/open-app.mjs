/**
 * 打开 Sylk。优先用编译好的 release 程序 —— 它把前端打进二进制，
 * 不需要 vite、不需要 cargo，1 秒内出窗口。
 *
 *   npm run app:open
 *   SYLK_CDP_PORT=9333 npm run app:open    # 需要自动化时开调试端口
 *
 * 只有 release 程序不存在、debug 存在时才退回 debug（那个需要前端服务）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const bin = process.platform === "win32" ? "sylk.exe" : "sylk";
const release = join(root, "src-tauri", "target", "release", bin);
const debug = join(root, "src-tauri", "target", "debug", bin);

const isUp = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
};

const launch = (exe) => {
  const child = spawn(exe, [], {
    cwd: join(root, "src-tauri"),
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();
};

/* 已经在跑就唤回窗口。单实例守卫也兜得住，但省一次进程启动 */
const running = spawnSync("tasklist", ["/FI", "IMAGENAME eq sylk.exe"], { encoding: "utf8" }).stdout || "";
if (running.includes("sylk.exe")) {
  if (existsSync(release)) launch(release);
  console.log("Sylk 已在运行，已唤回窗口");
  process.exit(0);
}

if (existsSync(release)) {
  launch(release);
  console.log("已启动（release，无需前端服务）");
  process.exit(0);
}

if (!existsSync(debug)) {
  console.error("还没有编译好的程序。先跑一次：");
  console.error("  npm run app:rel      # 出 release 程序，约 2-3 分钟；之后每次打开只要 1 秒");
  process.exit(1);
}

console.log("没有 release 程序，退回 debug 版（需要前端服务）");
if (!(await isUp("http://127.0.0.1:1420/"))) {
  spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
    cwd: root,
    stdio: "ignore",
    shell: true,
  });
  for (let i = 0; i < 60; i += 1) {
    if (await isUp("http://127.0.0.1:1420/")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}
launch(debug);
console.log("已启动（debug）");
