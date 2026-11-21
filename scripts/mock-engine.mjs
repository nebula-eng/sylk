/**
 * 内嵌引擎替身：完整模拟 NapCat 的「行为契约」，用来验证 Sylk 的托管层。
 *
 *   node scripts/mock-engine.mjs --dir <引擎目录>
 *
 * 它做三件事，和真 NapCat 一致：
 *   1. 读 `<dir>/config/onebot11.json` 里的端口与 token —— 证明 Sylk 写的配置被采纳
 *   2. 往 `<dir>/cache/qrcode.png` 写二维码 —— 证明二维码上屏链路
 *   3. 按 [NapCat] 的日志格式打印阶段 —— 证明日志解析
 *
 * 不模拟的部分：真正的 QQ 登录。扫码用「等了 N 秒就当扫过了」代替，
 * 加 --manual 可以改成等你手工创建一个 `<dir>/cache/scanned` 文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { placeholderQr } from "./lib/png.mjs";
import { ensureAudio, startOneBot } from "./lib/onebot-fixture.mjs";

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const DIR = dirIndex >= 0 ? args[dirIndex + 1] : process.cwd();
const MANUAL = args.includes("--manual");
const SCAN_DELAY = Number((args.find((a) => a.startsWith("--delay=")) || "--delay=3000").split("=")[1]);

const log = (line) => console.log(line);

if (!existsSync(DIR)) {
  console.error(`引擎目录不存在：${DIR}`);
  process.exit(1);
}

/* 读 Sylk 写下的配置 —— 这一步是契约的核心 */
const configPath = join(DIR, "config", "onebot11.json");
if (!existsSync(configPath)) {
  console.error(`找不到配置：${configPath}（应当由 Sylk 在启动前写入）`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const httpServer = config?.network?.httpServers?.[0];
const wsServer = config?.network?.websocketServers?.[0];
if (!httpServer || !wsServer) {
  console.error("配置里缺少 httpServers / websocketServers");
  process.exit(1);
}

const HTTP_PORT = Number(httpServer.port);
const WS_PORT = Number(wsServer.port);
const TOKEN = String(httpServer.token || "");

if (httpServer.host !== "127.0.0.1" || wsServer.host !== "127.0.0.1") {
  console.warn("! 配置没有绑回环，真实部署里这会被 Sylk 覆盖回去");
}

/* NapCat 风格的启动日志 */
const banner = (text) => log(`[NapCat] ${text}`);
banner(`[Core] NapCat.Core Version: 4.18.19-mock`);
banner(`[WebUi] WebUi Token: ${TOKEN.slice(0, 8)}…`);
banner(`[WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=${TOKEN}`);
banner(`[Core] 等待网络连接…`);
banner(`[Core] 网络已连接`);

const cacheDir = join(DIR, "cache");
mkdirSync(cacheDir, { recursive: true });

/* 二维码 */
const qrPath = join(cacheDir, "qrcode.png");
writeFileSync(qrPath, placeholderQr());
banner(`请扫描下面的二维码，然后在手Q上授权登录:`);
banner(`[Core] [Login] 二维码已保存到 ${qrPath}`);

const audioDir = join(DIR, "cache", "audio");
await ensureAudio(audioDir, (line) => banner(`[Core] ${line}`));

const server = await startOneBot({
  httpPort: HTTP_PORT,
  wsPort: WS_PORT,
  token: TOKEN,
  audioDir,
  log: (line) => banner(`[OneBot] ${line}`),
  pushVoices: 3,
  pushInterval: 5000,
});

banner(`[AdapterManager] OneBot11 适配器初始化完成`);
banner(`[AdapterManager] 协议适配器初始化完成，已加载 1 个适配器`);

/* 模拟扫码 */
const waitScan = MANUAL
  ? async () => {
      const marker = join(cacheDir, "scanned");
      banner(`[Core] [Login] 等待扫码（创建 ${marker} 以模拟扫码）`);
      while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 500));
    }
  : async () => {
      await new Promise((r) => setTimeout(r, SCAN_DELAY));
    };

await waitScan();
banner(`[Core] [Login] 二维码已被扫描，等待确认...`);
await new Promise((r) => setTimeout(r, 1200));
banner(`[Core] [Login] 登录成功，账号 10000001`);

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// 保持进程存活
setInterval(() => {}, 1 << 30);
