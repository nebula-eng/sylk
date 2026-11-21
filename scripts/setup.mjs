/**
 * 一条命令把仓库变成装好的应用。
 *
 *   npm run setup            # 检查环境 → 装依赖 → 编译 → 打包 → 安装 → 建快捷方式
 *   npm run setup -- --check # 只检查环境，不动任何东西
 *   npm run setup -- --dist  # 只出安装包，不装到本机（给别人分发用）
 *   npm run setup -- --engine=D://Downloads//NapCat.Shell.zip
 *                            # 把你自己的引擎包打进安装包，装完零网络可用
 *
 * 设计原则：
 *   - 该说的都说在前面。缺什么、怎么补、链接在哪，一次讲完，不要编译到一半才报错。
 *   - 不替用户装系统级 SDK。Rust、VS Build Tools 体积几百 MB，静默装它们是不礼貌的。
 *   - 每一步都报进度和耗时，别让人对着黑屏猜。
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const distOnly = args.includes("--dist");
const engineArg = args.find((arg) => arg.startsWith("--engine="))?.slice("--engine=".length);

const root = process.cwd();
const isWin = process.platform === "win32";
const started = Date.now();

/* ------------------------------------------------------------------ 输出 ---- */

const C = isWin
  ? { dim: "\x1b[90m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" }
  : { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };

const say = (text = "") => console.log(text);
const ok = (label, detail = "") => say(`  ${C.green}✓${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
const bad = (label, detail = "") => say(`  ${C.red}✗${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
const warn = (label, detail = "") => say(`  ${C.yellow}!${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ""}`);
const stage = (n, total, title) => {
  say();
  say(`${C.cyan}[${n}/${total}]${C.reset} ${C.bold}${title}${C.reset}`);
};

const failures = [];
const advice = [];

const programFiles = process.env.ProgramFiles || "C:\\Program Files";
const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");

/* -------------------------------------------------------------- 环境检查 ---- */

const run = (cmd, cmdArgs, options = {}) =>
  spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: isWin, ...options });

const capture = (cmd, cmdArgs) => {
  const result = run(cmd, cmdArgs);
  return result.status === 0 ? String(result.stdout || "").trim() : "";
};

const globVersionDir = (base) => {
  if (!existsSync(base)) return null;
  try {
    const dirs = readdirSync(base)
      .filter((name) => /^\d+\./.test(name))
      .map((name) => ({ name, mtime: statSync(join(base, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return dirs[0]?.name ?? null;
  } catch {
    return null;
  }
};

function checkEnvironment() {
  /* Node */
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) ok("Node", `v${process.versions.node}`);
  else {
    bad("Node 版本过低", `v${process.versions.node}，需要 20+`);
    failures.push("Node 20+");
    advice.push("升级 Node：https://nodejs.org/ （选 LTS）");
  }

  /* Rust */
  const rustc = capture("rustc", ["-V"]);
  if (rustc) ok("Rust", rustc.replace("rustc ", ""));
  else {
    bad("找不到 rustc");
    failures.push("Rust 工具链");
    advice.push(
      isWin
        ? "装 Rust：https://rustup.rs/ ；或者一行命令：winget install Rustlang.Rustup"
        : "装 Rust：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    );
  }

  /* 链接器：我们用 rust-lld，但仍需要 MSVC 的库 */
  const sysroot = capture("rustc", ["--print", "sysroot"]);
  const lld = sysroot
    ? join(sysroot, "lib", "rustlib", "x86_64-pc-windows-msvc", "bin", "rust-lld.exe")
    : "";
  if (lld && existsSync(lld)) ok("链接器", "rust-lld（随工具链提供）");
  else if (isWin) warn("rust-lld 不在默认位置", "会回落到 MSVC link.exe");

  if (isWin) {
    const vsRoots = [
      join(programFilesX86, "Microsoft Visual Studio"),
      join(programFiles, "Microsoft Visual Studio"),
    ];
    const hasVs = vsRoots.some((path) => existsSync(path));
    const kits = join(programFilesX86, "Windows Kits", "10");
    if (hasVs || existsSync(kits)) ok("MSVC 构建工具 / Windows SDK");
    else {
      bad("找不到 MSVC 构建工具或 Windows SDK");
      failures.push("MSVC 构建工具");
      advice.push(
        "装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）：https://visualstudio.microsoft.com/downloads/",
      );
    }
  }

  /* WebView2 运行时：Windows 11 自带，Win10 可能要装 */
  if (isWin) {
    const bases = [
      join(programFilesX86, "Microsoft", "EdgeWebView", "Application"),
      join(programFiles, "Microsoft", "EdgeWebView", "Application"),
      join(localAppData, "Microsoft", "EdgeWebView", "Application"),
      join(programFilesX86, "Microsoft", "Edge", "Application"),
    ];
    const found = bases.map(globVersionDir).find(Boolean);
    if (found) ok("WebView2 运行时", found);
    else {
      bad("找不到 WebView2 运行时");
      failures.push("WebView2 运行时");
      advice.push(
        "装 WebView2 Runtime（Evergreen）：https://developer.microsoft.com/microsoft-edge/webview2/",
      );
    }
  }
}

/* ------------------------------------------------------------------ 主流程 ---- */

say();
say(`${C.bold}Sylk 构建${C.reset} ${C.dim}· 一条命令，从源码到能双击的图标${C.reset}`);
say(`${C.dim}${root}${C.reset}`);

stage(1, 5, "检查环境");
checkEnvironment();

if (failures.length > 0) {
  say();
  say(`${C.red}还差 ${failures.length} 样东西：${failures.join("、")}${C.reset}`);
  say();
  for (const line of advice) say(`  · ${line}`);
  say();
  say(`${C.dim}装完重新运行  npm run setup  即可。已装的不会被重复处理。${C.reset}`);
  process.exit(1);
}

if (checkOnly) {
  say();
  say(`${C.green}环境齐全，可以构建。${C.reset}`);
  process.exit(0);
}

/* 依赖 */
stage(2, 5, "安装前端依赖");
const marker = join(root, "node_modules", ".package-lock.json");
const lock = join(root, "package-lock.json");
const needsInstall =
  !existsSync(join(root, "node_modules")) ||
  !existsSync(marker) ||
  (existsSync(lock) && statSync(lock).mtimeMs > statSync(marker).mtimeMs);

if (needsInstall) {
  const t0 = Date.now();
  const result = run(existsSync(lock) ? "npm ci" : "npm install", [], { stdio: "inherit" });
  if (result.status !== 0) {
    bad("依赖安装失败");
    process.exit(1);
  }
  ok("依赖已安装", `${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
} else {
  ok("依赖已是最新", "跳过");
}

/* 引擎包：只有显式 --engine 才塞进安装包，避免误分发第三方二进制 */
const engineDir = join(root, "src-tauri", "engine");
const engineZip = join(engineDir, "NapCat.Shell.zip");
let bundledEngine = false;
if (engineArg) {
  const source = engineArg.startsWith("/") || /^[A-Za-z]:/.test(engineArg) ? engineArg : join(root, engineArg);
  if (!existsSync(source)) {
    bad("找不到引擎包", source);
    process.exit(1);
  }
  mkdirSync(engineDir, { recursive: true });
  copyFileSync(source, engineZip);
  bundledEngine = true;
  ok("引擎包已就位", `${(statSync(engineZip).size / 1048576).toFixed(1)} MB`);
} else {
  warn(
    "不内置引擎",
    existsSync(engineZip)
      ? "目录里有引擎包但没加 --engine，按发布规范不打包（第三方许可限制）"
      : "装出来的应用需要你手动指定 NapCat/兼容引擎包，加 --engine= 可打包进去",
  );
}

/* V8/QQ 兼容引擎包属于第三方分发物，只在显式要求时通过临时配置注入资源 */
const engineConfigPath = join(root, "src-tauri", "tauri.engine.conf.json");
let engineConfigArg = null;
if (bundledEngine) {
  writeFileSync(
    engineConfigPath,
    JSON.stringify({ bundle: { resources: ["engine/NapCat.Shell.zip"] } }, null, 2),
  );
  engineConfigArg = engineConfigPath;
}

/* 前端 + Rust + 打包：交给 tauri build，它自己会跑 beforeBuildCommand */
stage(3, 5, "编译（前端 → Rust → 安装包）");
say(`${C.dim}  首次约 4-6 分钟，之后改前端秒级、改 Rust 十几秒。中间没有输出是正常的。${C.reset}`);
const buildStart = Date.now();
const tauriArgs = ["tauri", "build"];
if (engineConfigArg) {
  tauriArgs.push("--config", engineConfigArg);
}
let build;
try {
  build = spawnSync("npx", tauriArgs, { stdio: "inherit", shell: isWin, cwd: root });
} finally {
  if (existsSync(engineConfigPath)) {
    rmSync(engineConfigPath, { force: true });
  }
}
if (build.status !== 0) {
  bad("编译失败");
  say(`${C.dim}  常见原因：网络拉不到 crates（可配国内镜像）、MSVC 组件没装全。${C.reset}`);
  process.exit(1);
}
ok("编译完成", `${((Date.now() - buildStart) / 1000).toFixed(0)} 秒`);

/* 找产物 */
stage(4, 5, "定位产物");
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const exePath = join(root, "src-tauri", "target", "release", isWin ? "sylk.exe" : "sylk");
if (!existsSync(exePath)) {
  bad("没有找到编译产物", exePath);
  process.exit(1);
}
const exeSize = (statSync(exePath).size / 1048576).toFixed(1);
ok("可执行文件", `sylk.exe  ${exeSize} MB`);

const installers = existsSync(bundleDir)
  ? readdirSync(bundleDir)
      .filter((name) => name.endsWith(".exe"))
      .map((name) => ({ name, path: join(bundleDir, name), mtime: statSync(join(bundleDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
  : [];
if (installers.length > 0) {
  ok("安装包", `${installers[0].name}  ${(statSync(installers[0].path).size / 1048576).toFixed(1)} MB`);
} else {
  warn("没有生成安装包", "只产出了可执行文件");
}

if (distOnly) {
  stage(5, 5, "完成");
  say();
  ok("安装包已就绪", installers[0]?.path ?? exePath);
  say(`${C.dim}  拷给别人双击安装即可。要装到本机，去掉 --dist 再跑一次。${C.reset}`);
  process.exit(0);
}

/* 安装 */
stage(5, 5, "安装到本机");
const installer = installers[0];
if (!installer) {
  warn("没有安装包，跳过安装");
  say(`${C.dim}  可以直接运行：${exePath}${C.reset}`);
  process.exit(0);
}

const install = spawnSync(installer.path, ["/S"], { stdio: "inherit" });
if (install.status !== 0) {
  bad("安装失败", `退出码 ${install.status}`);
  say(`${C.dim}  也可以手动双击：${installer.path}${C.reset}`);
  process.exit(1);
}

const installedCandidates = [
  join(localAppData, "Sylk", isWin ? "sylk.exe" : "sylk"),
  join(localAppData, "Programs", "Sylk", isWin ? "sylk.exe" : "sylk"),
  join(process.env.ProgramFiles || "", "Sylk", isWin ? "sylk.exe" : "sylk"),
];
const installed = installedCandidates.find((path) => existsSync(path));

if (installed) {
  ok("已安装", installed);

  /* 桌面快捷方式 */
  const desktop = join(homedir(), "Desktop");
  if (existsSync(desktop)) {
    const shortcut = join(desktop, "Sylk.lnk");
    const dir = installed.replace(/[\\/][^\\/]+$/, "");
    const script = `
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut('${shortcut.replace(/'/g, "''")}')
$lnk.TargetPath = '${installed.replace(/'/g, "''")}'
$lnk.WorkingDirectory = '${dir.replace(/'/g, "''")}'
$lnk.IconLocation = '${installed.replace(/'/g, "''")}'
$lnk.Description = 'Sylk - QQ 语音归档'
$lnk.Save()
`;
    const made = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    if (made.status === 0) ok("桌面快捷方式", shortcut);
    else warn("桌面快捷方式没建成", "可以从开始菜单打开");
  }
} else {
  warn("装完了，但没在默认位置找到程序", "从开始菜单搜「Sylk」");
}

/* 收尾 */
const total = ((Date.now() - started) / 1000).toFixed(0);
say();
say(`${C.green}${C.bold}搞定${C.reset}  用时 ${total} 秒`);
say();
say(`  以后打开：桌面上的 Sylk 图标，或开始菜单搜「Sylk」${C.dim}（约 1 秒出界面）${C.reset}`);
say(`  改了代码：再跑一次 npm run setup，或者带 --dist 只出安装包`);
if (bundledEngine) {
  say(`  引擎：已随包内置，首次启动本地解压，不需要联网`);
} else {
  say(`  引擎：未内置，首次启动需指定 NapCat（${C.dim}--engine=<zip> 可打包进去${C.reset}）`);
}
say();
