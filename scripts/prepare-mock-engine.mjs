/**
 * 准备一个「假引擎目录」，让内嵌引擎的托管链路可以在没有真 QQ 的机器上验收。
 *
 *   node scripts/prepare-mock-engine.mjs [目录]
 *
 * 它只做两件事：
 *   1. 放一个 napcat.mjs，转发到 scripts/mock-engine.mjs（模拟 NapCat 的启动入口）
 *   2. 把 settings.json 里的引擎目录指向它，并重置引导状态
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || "D:/tmp/sylk-engine-e2e/engine");
mkdirSync(target, { recursive: true });
mkdirSync(join(target, "config"), { recursive: true });

const mockUrl = pathToFileURL(join(here, "mock-engine.mjs")).href;
const entry = `// 由 prepare-mock-engine.mjs 生成，仅用于联调。
await import(${JSON.stringify(mockUrl)});
`;
writeFileSync(join(target, "napcat.mjs"), entry);

const appData = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "app.sylk.desktop");
mkdirSync(appData, { recursive: true });
const settingsPath = join(appData, "settings.json");

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
}

settings.engine = {
  mode: "embedded",
  napcatDir: target,
  nodePath: "",
  qqPath: "",
  downloadUrl: "",
  autoStart: true,
  autoSync: true,
  ...(settings.engine ?? {}),
  // 强制覆盖这三项，确保指向假引擎
  mode: "embedded",
  napcatDir: target,
  autoStart: true,
};
settings.onboarded = false;
settings.libraryDir = settings.libraryDir || join(homedir(), "Documents", "Sylk Library");
settings.napcat = settings.napcat ?? {
  baseUrl: "http://127.0.0.1:3000",
  wsUrl: "ws://127.0.0.1:3001",
  token: "",
};

writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

// Windows 上应用占着 settings.json 时，写入会失败但不报错。
// 读回来比对，避免拿着旧配置去跑 e2e 然后对着「引擎目录未知」发呆。
const written = JSON.parse(readFileSync(settingsPath, "utf8"));
if (written.engine?.napcatDir !== target) {
  console.error("");
  console.error("写入没生效：settings.json 里仍然是");
  console.error(`  napcatDir = ${JSON.stringify(written.engine?.napcatDir)}`);
  console.error("多半是 Sylk 正在运行，占着这个文件。关掉应用再跑一次。");
  process.exit(1);
}

console.log(`引擎目录  ${target}`);
console.log(`入口      ${join(target, "napcat.mjs")} → scripts/mock-engine.mjs`);
console.log(`配置      ${settingsPath}`);
console.log("");
console.log("接下来：");
console.log("  npm run app:rel                          # 出 release 程序");
console.log("  SYLK_CDP_PORT=9333 npm run app:open      # 带调试端口启动");
console.log("  npm run e2e:engine");
