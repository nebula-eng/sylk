# 接入引擎

Sylk 通过一个「接入引擎」读 QQ 的消息。经典方案是 [NapCat](https://github.com/NapNeko/NapCatQQ)，一个基于官方 NTQQ 的 OneBot 11 实现。

这篇写四件事：四种接入方式、目录长什么样、V8 兼容模式、出问题从哪查。

## 四种方式

### 一、内嵌引擎（经典 NapCat 注入）

Sylk 自己安装、配置、启动、监控。你只需要扫码。

首次点「下载并启动」时，Sylk 会：

1. 从官方发布渠道下载 NapCat 发布包（也可以用你自己的地址）

   > 上游 2026-11-12 已清空，`NapNeko/NapCatQQ` 的 GitHub Releases 与官方文档站
   > 都已不可用。拿不到时 Sylk 会在几秒内报出确切原因（HTTP 404、连接超时、
   > 包结构不对），并把三条手动路径摆到界面上，不会卡在进度条。
   > 如果你有可用镜像，填进「设置 → 引擎 → 下载地址」即可，Sylk 会优先用它。
   > 下载地址必须是 HTTPS（`127.0.0.1` / `localhost` 例外）；下载总大小、zip 条目数、
   > 单文件与解压后总大小都有上限，超过会中止。
2. 解压到 `<应用数据>/engine/napcat`，自动剥掉多余的一层目录
3. 按本机真实 QQ 版本生成 `qqnt.json`（补丁包），再分配端口（优先 13700/13701）与随机令牌，
   写出 `config/onebot11.json` 与 `config/webui.json`
4. 设置官方启动器需要的 `NAPCAT_*` 环境变量，拉起进程（隐藏控制台），开始监视
5. 从 `cache/qrcode.png` 读二维码，渲染到登录页

每次启动都会重写配置并重新分配端口。配置不归你管，也就不存在改坏这回事。

启动前 Sylk 会先比对引擎的兼容版本表与本机 QQ 版本：不在表里就不注入，直接给出
「引擎支持到 X，本机是 Y」的结论，而不是让 QQ 弹「文件已损坏」。

> 引擎仍需要本机已安装 QQ NT。它通过注入 QQ 来工作，这是这类方案的固有前提。Sylk 不附带腾讯的客户端。

如果你已经有一个解压好的 NapCat 目录，登录页的「指定引擎目录」会**采用**它 —— 只校验入口，不搬动文件。
「导入引擎包」支持 NapCat zip 和 V8 兼容引擎包 zip：前者解到默认的 `engine/napcat`，
后者解到 `engine/v8` 并自动把「QQ NT 安装目录」指过去。登录页的「自动查找本机引擎」
会扫描下载、桌面、文档、应用数据目录和各盘根目录（最多两层，3 秒上限），找到后优先采用
V8 兼容引擎包。

### 二、V8 兼容引擎（适配 QQ 9.9.37-54395 及以后）

新版 QQ 弃用了 `package.json.main`，并给 `application.asar` / `wrapper.node` /
`major.node` / `package.json` 加了 RSA-2048 签名表。经典 NapCat 注入在这些版本上
会让 QQ 弹「文件已损坏」并退出，改 `qqnt.json` 也无效。

社区方案是 **V8 编译期注入**：QQ 目录里放一个 `winmm.dll` 侧加载代理（QQ.exe 静态
导入 WINMM，而它不在 KnownDLLs 里，属于合法加载），代理在 QQ 主进程内 hook
`v8::ScriptCompiler::Compile*`，把引导脚本插到解密后的启动脚本前面，再 `import`
同目录的 `napcat.mjs`。全程不改 QQ 文件，因此不触发签名校验。

Sylk 的识别规则：把「设置 → 引擎 → QQ NT 安装目录」指向一个同时包含
`QQ.exe`、`winmm.dll`、`snowcat-boot.js`、`napcat.mjs` 的目录，就自动改走 V8 启动路径：

1. 直接拉起该目录的 `QQ.exe`
2. 设置 `NAPCAT_WORKDIR` 与 `NAPCAT_QQ_DATA_DIR`，让引擎的配置/缓存/日志落在该目录
3. 写入 `config/onebot11.json`（端口 + 令牌）
4. 轮询 `cache/qrcode.png` 出二维码；登录后用同一套 OneBot 客户端接手

这类引擎包与 QQ 便携副本均受第三方许可限制（NapCat 系许可证禁止未授权再分发），
**不进仓库、不进安装包**。组装方法见 `src-tauri/engine/README.md`。

### 三、连接已有 NapCat（external）

适合引擎已经在别处跑着（比如服务器上，或者你自己做了定制）的情况。

设置 → 引擎 → 接入方式 →「连接已有 NapCat」，然后到「连接」页填：

| 字段 | 示例 |
|---|---|
| HTTP 接口地址 | `http://127.0.0.1:3000` |
| WebSocket 地址 | `ws://127.0.0.1:3001` |
| 访问令牌 | 与 NapCat 里一致，没有就留空 |

此时 Sylk **不启动也不停止**任何进程，只当一个普通 OneBot 客户端。日志、二维码都要你自己去 NapCat 那边看。

### 四、什么都不装

浏览器里的演示模式（`npm run dev`）用前端写死的数据，只用来改界面。

## 目录布局

```
<应用数据>/engine/
├─ napcat/                    # 引擎本体
│  ├─ napcat.mjs              # 或 NapCatWinBootMain.exe / launcher.bat
│  ├─ config/
│  │  ├─ onebot11.json        # ← Sylk 写：HTTP + WS 服务
│  │  └─ webui.json           # ← Sylk 写：WebUI 绑定回环
│  ├─ cache/
│  │  ├─ qrcode.png           # ← 引擎写：登录二维码
│  │  └─ audio/               # ← 引擎写：语音缓存（Sylk 会来捞）
│  ├─ data/                   # 登录态；「退出登录」会清掉
│  └─ .sylk-engine.pid        # ← Sylk 写：用于清理孤儿进程
└─ node/                      # 可选：自带的 Node 运行时
```

引擎目录里那个 `.sylk-engine.pid` 是给「上次异常退出」兜底用的：下次启动前 Sylk 会按它把残留进程杀掉，避免两个实例抢同一个 QQ 登录态。

## Sylk 写进去的配置长什么样

`config/onebot11.json`（每次启动覆盖）：

```json
{
  "network": {
    "httpServers": [{
      "name": "sylk-http",
      "enable": true,
      "host": "127.0.0.1",
      "port": 13700,
      "messagePostFormat": "array",
      "token": "<24 位随机 hex>"
    }],
    "websocketServers": [{
      "name": "sylk-ws",
      "enable": true,
      "host": "127.0.0.1",
      "port": 13701,
      "messagePostFormat": "array",
      "token": "<同一个 token>"
    }]
  },
  "enableLocalFile2Url": true
}
```

几个要点：

- **`host` 永远是 `127.0.0.1`。** 不给局域网任何机会。
- **端口从 13700 开始找空位**，避开你可能已经在用的 3000/3001。
- **`onebot11.json` 是默认配置**（NapCat v4.5.3+ 支持），对所有账号生效，所以不必等拿到 QQ 号就能预先配好。
- **`enableLocalFile2Url` 打开**，这样语音能走本地路径直取，少一次网络往返。

## 状态与阶段

登录页展示的是引擎的真实阶段，不是装饰：

| 阶段 | 含义 | 触发 |
|---|---|---|
| `unavailable` | 没有可用的引擎文件 | 目录缺失或入口找不到 |
| `idle` | 有文件，没在跑 | 刚启动 / 手动停止后重新打开 |
| `preparing` | 正在下载或解压 | 一键准备 |
| `starting` | 进程已拉起，接口未通 | 引擎启动中 |
| `awaiting_scan` | 已出二维码 | 读到 `cache/qrcode.png` |
| `scanned` | 已扫码待确认 | 引擎日志出现"二维码已被扫描" |
| `online` | 登录成功 | `get_login_info` 返回了账号 |
| `stopped` | 被主动停止 | 点了「停止」或退出登录 |
| `error` | 进程退出或起不来 | watchdog 判定 |

在线判断以接口为准，日志只用来推过程感。日志文案会随版本变化，`get_login_info` 不会。

## 出问题怎么查

先看登录页底部那个可展开的「引擎日志」，它和后端日志是同一份。

| 现象 | 原因 | 处理 |
|---|---|---|
| 状态卡在「准备中」 | 下载源不可达，或地址不是 HTTPS | 设置 → 引擎 → 填一个 HTTPS 下载地址（本机服务可用 127.0.0.1），或改用本地目录/压缩包 |
| 状态是 `unavailable` | 目录在但入口找不到 | 点「打开目录」看看内容是否完整；一键包有时是嵌套目录，Sylk 会自动剥一层，剥过头就手动指定内层 |
| 卡在 `starting` 很久 | 本机没装 QQ NT，或版本不匹配 | 「环境自检」里看「QQ NT 客户端」那一行；装好点重启 |
| `error`，代码非 0 | 引擎进程崩了 | 看日志最后几行；常见是端口被占或 Node 版本太低 |
| 二维码一直是空的 | 引擎没写出 `qrcode.png`，或路径布局不同 | Sylk 会试 `cache/`、`napcat/cache/`、`versions/*/resources/app/napcat/cache/` 三处；都不中就在日志里看它自己打印的路径 |
| 登录成功但会话是空的 | HTTP 服务没起来 | 看「环境自检」里的「引擎进程」与日志中的 `HTTP服务` 一行 |

### 命令行自检

引擎跑起来后，端口和令牌在「设置 → 引擎」卡片上能看到（只读，就是给你排障用的）：

```bash
curl -s -X POST http://127.0.0.1:13700/get_login_info \
  -H "Authorization: Bearer <token>" -d '{}'
```

返回 `{"status":"ok","data":{"user_id":…}}` 就说明引擎这一侧完全正常。

### 换号 / 重新扫码

设置 → 引擎 →「退出登录」。它会停掉进程、删掉 `cache/qrcode.png` 与 `data/`（登录态），再重新拉起，你会回到扫码页。

## Sylk 只读，不写

引擎暴露的能力很多，Sylk 只用这些：

| 动作 | 用途 |
|---|---|
| `get_login_info` | 确认账号 |
| `get_status` | 在线状态 |
| `get_group_list` / `get_friend_list` | 同步会话 |
| `get_group_info` / `get_stranger_info` | 补全会话名与头像 |
| `get_group_msg_history` / `get_friend_msg_history` | 回溯历史 |
| `get_record` | 让引擎把语音转成 WAV |

不会调用的：发消息、改资料、群管理、任何写操作。权限边界就是「读」。
