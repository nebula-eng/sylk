# 从源码构建

官方只发布 Windows x64 安装包；源码本身可以自行尝试其他平台构建，但未经验证，也不在支持范围内。

## 需要什么

| 依赖 | 说明 |
|---|---|
| Node.js 20+ | 建议装 LTS 版 |
| Rust 1.80+ | `winget install Rustlang.Rustup` |
| VS Build Tools | 安装时勾「使用 C++ 的桌面开发」 |
| WebView2 运行时 | Windows 11 自带；Windows 10 可能需要单独安装 |

不确定环境是否齐全时先跑：

```powershell
npm run setup -- --check
```

它只检查，不编译、不安装。

## 一条命令：build.cmd

```powershell
git clone https://github.com/nebula-eng/sylk.git
cd sylk
.\build.cmd
```

`build.cmd` 会依次：检查工具链 → 安装依赖 → 编译前端和 Rust → 打包安装程序 → 安装到当前用户 →
创建桌面快捷方式。首次约 5–10 分钟（取决于网络和机器），之后增量构建约 1 分钟。
中间长时间没有输出是正常的。

命令行等价写法：

```powershell
npm run setup              # 编译 + 安装
npm run setup -- --check   # 只检查环境
npm run setup -- --dist    # 只出安装包，不装本机
```

安装位置是 `%LOCALAPPDATA%\Sylk`，当前用户模式，不需要管理员权限，带卸载程序。

## 只编译、不安装

干净 clone 没有 `dist/`，必须先构建前端，否则 `tauri::generate_context!` 会因为找不到
`../dist` 编译失败：

```powershell
npm install
npm run build
npm run app:rel
```

产物：`src-tauri/target/release/sylk.exe`。双击它，或运行 `.\open.cmd`。

## 开发模式

```powershell
npm run app:dev     # Tauri 开发模式，前端热更新；改 Rust 会重新编译
npm run dev         # 只跑 Vite，看浏览器界面，http://127.0.0.1:1420
```

浏览器预览使用演示数据，音频不可播放，页面顶部会显示提示。想看登录页：

```js
localStorage.setItem("sylk.preview.login", "0");
location.reload();
```

## 没有 QQ 也能跑全链路

仓库带一个引擎替身，会读 Sylk 写入的配置、生成二维码、按 NapCat 的格式输出日志，
所以验证的是完整的引擎托管逻辑，不是假页面。

PowerShell：

```powershell
npm run mock:prepare
npm run app:rel
$env:SYLK_CDP_PORT = "9333"
npm run app:open
```

另开一个 PowerShell 窗口：

```powershell
npm run e2e:engine
npm run e2e:features
```

`e2e:engine` 覆盖扫码 → 登录 → 同步历史 → 解码 → 播放 → 重启 → 停止；
`e2e:features` 覆盖筛选、批量操作、详情折叠与键盘。

只验证「连接外部 NapCat」：`npm run mock` 会起 HTTP 3000 / WS 3001 的替身。

`SYLK_CDP_PORT` 只用于自动化；平时启动不要设置，WebView2 不会打开调试端口。

## 检查

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
npm run typecheck
npm run build
```

界面布局检查（先跑 `npm run dev`，再启动一个带 CDP 的 Edge）：

```powershell
$edge = "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
$profile = Join-Path $env:TEMP "sylk-review-edge"
& $edge --headless=new --disable-gpu --remote-debugging-port=9222 `
  "--user-data-dir=$profile" --window-size=1440,920 http://127.0.0.1:1420/

node scripts/review.mjs "$env:TEMP\sylk-review"
```

脚本会在 1440 / 1100 / 960 三个宽度下检查溢出、重叠、文字裁剪，并截图到指定目录。

## 常见构建问题

**`frontendDist` 不存在 / `generate_context!` 报错**
先跑 `npm run build` 生成 `dist/`，再 `cargo build`/`npm run app:rel`。

**改 Rust 后界面没变化**
前端资源编译进二进制了，需要重新 `npm run app:rel` 或 `npm run app:dev`；只改 CSS/TSX 用热更新。

**安装包体积突然变大**
检查是否误把第三方引擎或 QQ 便携目录放进仓库/资源目录。发布流程会拦截 `*.zip` 和 15 MB 以上的安装包。

**端口 1420 被占用**
之前的 `npm run dev` 还没退出；结束 Node 进程后重试。
