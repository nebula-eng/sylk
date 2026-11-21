# 贡献指南

先说结论：**开 issue 比直接提 PR 更省双方时间**，尤其是涉及协议行为、解码细节或 UI 大改的时候。功能想法欢迎先聊。

## 环境

| 依赖 | 版本 |
|---|---|
| Node.js | 20 或更高（推荐 22） |
| Rust | 1.80 或更高（MSVC toolchain） |
| Tauri 依赖 | Windows: MSVC Build Tools + WebView2；macOS: Xcode CLT；Linux: webkit2gtk-4.1 |

跑起来：

```bash
npm install

npm run setup      # 检查环境 → 装依赖 → 编译 → 打包 → 装到本机 + 建桌面快捷方式

npm run app:rel        # 或者只编不打包，直接跑 src-tauri/target/release/sylk.exe
npm run app:dev        # 改前端时用，热更新

npm run mock:prepare   # 可选：造一个假引擎，不装 QQ 也能跑通全链路
```

**样式只加变量，不加字面量。** 字号用 `--fs-*`、圆角用 `--r-*`、控件高度用 `--ctl-h`，
都在 `src/styles/tokens.css`。`app.css` 里出现 `font-size: 11.5px` 这种就是违规 —— 以前积了 21 种字号。

**别用 `cargo build --release` 之外的自定义 profile 发版。** tauri-build 只认 `release` 这个档名，
换成 `release-fast` 之类的名字会被当成开发模式，编出来的程序去连 `devUrl` 的 1420 端口。
这个坑已经踩过一次，`Cargo.toml` 里有注释。

要自动化（截图、e2e）时才开调试端口：`SYLK_CDP_PORT=9333 npm run app:open`。

## 代码地图

```
src/                     前端（React 19 + TypeScript）
  components/            界面，按区域拆分
  lib/api.ts             与后端通信的唯一入口（同时提供浏览器 mock）
  lib/silk.ts            SILK → WAV 解码
  lib/store.ts           应用状态
  styles/                设计令牌 + 组件样式（无 UI 框架）
src-tauri/src/
  engine.rs              内嵌引擎托管：路径探测、配置写入、进程与二维码、健康判定
  provision.rs           引擎获取：采用已有目录 / 解压本地包 / 下载安装
  napcat.rs              OneBot 11 客户端与事件解析
  pipeline.rs            同步 / 下载 / 转写三条流水线
  db.rs                  SQLite 结构与查询
  media.rs               WAV 解析、重采样、波形峰值、文件名规范
  asr.rs                 whisper.cpp / OpenAI 兼容接口调度
  export.rs              会话档案导出
  commands.rs            暴露给前端的命令
scripts/
  lib/onebot-fixture.mjs 共用数据集与 OneBot 服务器
  lib/png.mjs            极简 PNG 编码（生成占位二维码）
  mock-engine.mjs        内嵌引擎替身：读配置、写二维码、打印 NapCat 式日志
  mock-napcat.mjs        外部模式替身（固定端口）
  prepare-mock-engine.mjs 造一个假引擎目录并把设置指过去
  e2e-engine.mjs         托管链路端到端验收
  final-shots.mjs        产出 docs/screenshots
  audit.mjs              溢出/重叠/文本截断检查
```

几条约定：

- 前端不直接 fetch 任何外部地址。所有网络请求都在 Rust 侧，方便统一超时与错误文案。
- 引擎相关的副作用（写配置、起进程、删文件）只能在 `engine.rs` / `provision.rs` 里发生，别散落到命令层。
- 筛选条件（时间、发送者、星标）必须落到 `VoiceQuery` 由 SQL 过滤，不要在前端截取数组——分页和统计会算错。
- 快捷键统一在 `App.tsx` 的 keydown 里处理，先判断输入框焦点，再分发。
- 涉及的路径一律走 `engine::resolve_dir` / `cfg(windows)` 的注册表读取，不要硬编码盘符。
- 新增 UI 状态优先放进 `store.ts`，组件内只保留纯展示用的临时状态。
- 数据库迁移写在 `db.rs` 的 `SCHEMA` 里，用 `CREATE TABLE IF NOT EXISTS`，暂不引入版本化迁移框架。

## 提交前自查

```bash
npm run typecheck
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

UI 改动请跑一遍全面走查，它会抓溢出、重叠、文字裁剪，并在 1440 / 1100 / 960 三个宽度下各验一次：

```bash
npm run dev
# 另开一个终端
"/path/to/msedge" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/sylk-audit about:blank &
CDP_PORT=9222 node scripts/review.mjs
```

文档配图由 `npm run shots` 生成，别手改 `docs/screenshots/`。

## 提交信息

用一句话说清「改了什么、为什么」。不要写 "update" "fix bug" 这种。

```
fix: 回溯时游标停滞导致重复拉同一页
feat: 导出档案里增加可离线打开的 HTML
```

## 代码风格

- Rust：`cargo fmt` 默认风格；函数超过 80 行就该拆。
- TypeScript：2 空格，双引号，组件用函数式，避免 `any`。
- CSS：只用 `styles/tokens.css` 里的变量取色，不写裸色值。
- 文案：中文用全角标点，术语保持一致（会话 / 语音 / 转写 / 回溯）。

## 不接受的改动

- 引入 UI 组件库（项目刻意保持零 UI 依赖）。
- 把登录、协议、加解密逻辑自己实现一遍。
- 未经讨论的大规模重构。
- 任何绕过权限、批量抓取非本人可见内容的代码。
