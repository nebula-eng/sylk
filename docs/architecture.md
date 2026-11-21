# 架构说明

这份文档写给想改代码的人。它解释 Sylk 为什么长成这样，以及哪些地方看起来可以简化、其实不能。

## 进程与线程

```
┌─────────────────────────────────────────────────────────────┐
│  WebView（React）                                            │
│   界面 · 状态 · SILK→WAV 解码（WebAssembly）· 播放            │
└───────────────┬─────────────────────────────────────────────┘
                │ invoke / event（Tauri IPC）
┌───────────────┴─────────────────────────────────────────────┐
│  Rust 主进程                                                 │
│   ├─ 命令层 commands.rs     同步、查询、导出                  │
│   ├─ 流水线 pipeline.rs     同步 / 下载 / 转写                │
│   ├─ OneBot 客户端 napcat.rs HTTP + WebSocket                │
│   ├─ 存储 db.rs             SQLite（WAL）                    │
│   └─ 媒体 media.rs          WAV 解析、重采样、波形             │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP / WS（本机回环）
┌───────────────┴─────────────────────────────────────────────┐
│  引擎（经典 NapCat 注入 / V8 兼容通道，Sylk 托管）              │
└─────────────────────────────────────────────────────────────┘
```

一条硬约束：**前端永远不直接发网络请求**。所有出网动作在 Rust 侧完成，好处是超时、重试、错误文案、日志都在一处。

## 引擎为什么算「内嵌」而不是「依赖」

把 NapCat 的文件放进安装包只是捆绑 —— 用户仍然要自己配端口、抄令牌、去目录里找二维码、盯着进程死没死。真正割裂的是这些动作，不是文件位置。

所以 `engine.rs` 接管的是**生命周期**，不是文件：

```
start(settings)
  ├─ v8_dir           识别 V8 兼容引擎包（QQ 目录含 winmm.dll / snowcat-boot.js / napcat.mjs）
  ├─ resolve_dir      否则找经典 NapCat 引擎目录（设置 → 应用数据默认位置）
  ├─ entrypoint       在 6 个候选入口里挑一个（exe / bat / mjs，含嵌套目录）
  ├─ check_qq_compat  版本门禁：引擎支持表里没有本机 QQ 就拒绝注入
  ├─ write_dynamic_qqnt  按本机真实 QQ 版本重写 qqnt.json
  ├─ reap_orphan      读 .sylk-engine.pid，杀掉上次残留
  ├─ reserve_ports    从 13700 起找两个相邻空位，避开 3000/3001
  ├─ random_token     24 位 hex，每次启动重来
  ├─ write_configs    覆盖写 onebot11.json + webui.json（host 永远 127.0.0.1）
  ├─ spawn            CREATE_NO_WINDOW；经典模式设 NAPCAT_* 环境变量，V8 模式直接拉起 QQ.exe
  ├─ spawn_reader     逐行入环形缓冲 + 阶段解析（token 脱敏）
  ├─ spawn_qr_watcher 700ms 轮询 qrcode.png 的 size+mtime；过期自动重启换码
  └─ spawn_watchdog   2s 一轮：try_wait + get_login_info
```

四个刻意的决定：

1. **配置每次重写。** 用户手改坏了会自愈；端口冲突也不会长期存在。代价是用户不能自定义端口 —— 但那本来就不该是他的活。
2. **在线判断用接口，不用日志。** 日志文案会随 NapCat 版本变，`get_login_info` 不会。日志只负责让 UI 有的看。
3. **watchdog 用 pid 判身份。** 主动 stop 会把 `rt.pid` 清掉，watchdog 下一轮发现 pid 对不上就安静退出，不会把正常停止误报成崩溃。
4. **PID 文件防孤儿。** 应用被强杀时子进程会活下来占住登录态，下次启动先按 PID 清理。

这样带来的一个额外好处：因为 Sylk 知道引擎装在哪，`engine::cached_audio` 能直接去 `cache/` 里捞语音原件 —— `get_record` 失败（NapCat 那侧缺 ffmpeg）时这是最后一道兜底。外部模式下拿不到这个信息。

## 三条流水线

### 1. 会话索引

`sync_index` 调 `get_group_list` + `get_friend_list`，把结果 upsert 进 `conversations`。这个动作很轻，连接成功后自动跑一次。

### 2. 历史回溯

```
for page in 0..max_pages:
    messages = get_group_msg_history(peer, cursor, page_size)
    若 messages 为空            → 停（no_more）
    对每条消息提取 record 段     → insert_voice（UNIQUE 去重）
    cursor = 本页最早一条的 message_id
    若本页没有新消息            → 停（stalled）
    若本页短于 page_size        → 停（no_more）
```

**为什么不只依赖"空页"判断：** NapCat 的 `message_seq` 在不同版本里既是游标也可能被当成原生 id，传错时返回的是"从该点往后"而不是"更早"。如果只等空页，可能在同一页上无限循环。三个停止条件里，`stalled`（本页全见过的消息）是最重要的保险。

**为什么用"最早一条的 id"而不是"最后一条"：** 返回顺序在实现之间不稳定，按 `time` 找最小值比按数组下标可靠。

### 3. 下载与转码

```
claim_job("download")
  ├─ A. record_path 本地可读且是 WAV   → 直接用
  ├─ B. get_record(file, "wav")       → 读 NapCat 给的绝对路径
  ├─ C. record_url 直下                → 判断是 WAV 还是 SILK
  ├─ 拿到 WAV → 落盘 + 算波形 + 记 sha256 → 完成
  ├─ 只拿到 SILK → 存 raw/，发 sylk://decode 事件 → 前端解码 → save_decoded 写回
  └─ 都没有 → job.failed（带原因），最多重试 3 次
```

顺序是刻意的。A 最快但依赖同机；B 依赖 NapCat 装了 ffmpeg；C 最通用，但 QQ 的语音 URL 有时效。三条都试过才算失败。

`claim_job` 用条件更新抢占任务：

```sql
UPDATE jobs SET status='running' WHERE id=? AND status IN ('pending','failed')
```

影响行数为 0 说明被别的 worker 抢走了，直接返回。这样 N 个并发 worker 不需要额外的锁。

### 4. 转写

串行执行，因为 whisper 本身就会吃满 CPU。输入先统一成 16 kHz 单声道 WAV：如果源是 24 kHz，用线性插值重采样（`media::resample_linear`），避免为了转写再引一个 ffmpeg 依赖。非 WAV 输入才回退到调用系统 ffmpeg。

## 数据库

```sql
accounts(uin PK, nickname, avatar, created_at, last_seen_at)

conversations(
  id PK, account_uin, kind CHECK(group|friend), peer_id, title, avatar,
  member_count, remark, voice_count, total_ms, last_voice_at, starred, synced_at,
  created_at, UNIQUE(account_uin, kind, peer_id)
)

voices(
  id PK, conversation_id FK→conversations ON DELETE CASCADE, account_uin, msg_id,
  msg_seq, sender_id, sender_name, sent_at, duration_ms, size_bytes, codec, sample_rate,
  file_path, raw_path, record_file, record_url, record_path, sha256, source, magic,
  transcript, transcript_lang, transcript_status, transcript_error, asr_engine,
  peaks, starred, note, tags, created_at,
  UNIQUE(account_uin, msg_id)
)

jobs(
  id PK, kind, ref_id, status, attempts, last_error, created_at, updated_at,
  UNIQUE(kind, ref_id)
)
```

设计取舍：

- **`UNIQUE(account_uin, msg_id)`** 是幂等的来源。同一消息被实时事件和历史回溯同时碰到，只有第一次插入成功。
- **`voice_count` / `total_ms` / `last_voice_at` 是冗余字段**，每次入库后由 `recompute_conversation_stats` 重算。会话列表要按"最近有语音"排序，每次聚合 `voices` 表在几千条时还能接受，上万条就会拖慢首屏 —— 冗余换响应速度。
- **`peaks` 存 JSON 数组**（96 个 0-100 的整数）。二进制打包能省空间，但调试时看不懂，收益不值。
- **不加 FTS5。** 个人账号的语音量级在几千到几万，`LIKE '%kw%'` 配合索引完全够用；引入 FTS 要处理分词器与中文，复杂度不划算。真到十万级再换。
- **没有版本化迁移框架。** 建表全部 `IF NOT EXISTS`，改结构时手写 `ALTER TABLE`。0.x 阶段不值得上 `refinery`。
- **筛选在 SQL 里做。** 时间、发送者、星标、关键词都拼进 `WHERE`，前端只负责把条件翻译成 `VoiceQuery`。放前端过滤的话，「共 N 条」会算错，分页也会错位。

## 前端

- **状态在 `store.ts`（zustand）**，组件只订阅需要的切片。播放状态单独放 `player.ts`，避免播放进度导致整个列表重渲染。
- **波形用 canvas**，不用几百个 DOM 节点。列表里 44 根柱、详情页 96 根、播放器 110 根，尺寸随容器宽度和 DPR 重算。
- **`api.ts` 是唯一的后端边界**，同时导出浏览器 mock。这让 `npm run dev` 能在没有 Rust、没有 QQ 的情况下看到完整界面，也让截图脚本可以独立运行。
- **样式只有两个文件**：`tokens.css` 定义颜色/间距/圆角，`app.css` 按区块组织。没有 CSS-in-JS，没有 UI 框架。
- **长列表用 `content-visibility: auto`**，视口外的行跳过布局与绘制。500 条的滚动开销和 50 条差不多，超过这个量级才需要真正的虚拟滚动。
- **快捷键集中在 `App.tsx`**：先看焦点是否在输入框，再分发。`↑↓` 走列表，`←→` 走播放器，两套互不干扰。

## 事件

后端 → 前端：

| 事件 | 载荷 | 用途 |
|---|---|---|
| `sylk://progress` | `ProgressEvent` | 回溯进度条 |
| `sylk://connection` | `ConnectionState` | 连接状态与账号 |
| `sylk://voices` | `{reason, voiceId?, conversationId?}` | 语音列表需要刷新 |
| `sylk://jobs` | `{}` | 任务队列需要刷新 |
| `sylk://toast` | `{kind, text}` | 后台失败提示 |
| `sylk://decode` | `{voiceId}` | 需要前端把 SILK 解成 WAV |

前端对 `voices` 事件做了 350 ms 防抖：批量回溯时一秒内可能插入几十条，逐条刷新会卡。

## 错误处理

- 后端所有命令返回 `Result<T, AppError>`，`AppError` 的 `Display` 就是给用户看的中文句子。
- 下载与转写失败不抛出到界面，写入 `jobs.last_error`，在任务队列里可见、可重试。
- 日志用 `tracing`，写 `logs/sylk.log`（按天滚动），同时输出到 stderr（dev 模式可见）。

## 性能上的已知边界

| 场景 | 现状 | 什么时候需要改 |
|---|---|---|
| 二维码轮询 | 700 ms 一次 `metadata`，几乎无开销 | 不需要改 |
| 引擎日志 | 环形缓冲 400 行 | 需要回看更早的日志时读 `logs/` |
| 语音列表 500 条 | 一次性渲染，无明显卡顿 | 超过 2000 条需要上虚拟滚动 |
| 搜索 | `LIKE` 全表扫描 | 十万级时换 FTS5 |
| SQLite 并发 | 单连接 + `Mutex` | 写压力大时改连接池 |
| 波形生成 | 插入时算一次，存 JSON | 峰值精度不够时改存 256 点 |

这些数字是实测与估算，不是拍脑袋的上限。真遇到了，按表里的方向改。

## 隐私层

`privacy.rs` 集中处理数据保护，不散落在各模块里：

```
privacy.rs
  ├─ protect_secret / unprotect_secret   Windows DPAPI 加解密云端转写密钥
  ├─ random_hex                          CSPRNG 令牌
  ├─ redact_line / mask_uin              引擎日志脱敏（令牌、用户目录、QQ 号）
  ├─ validate_remote_url                 出站地址必须是 HTTPS（回环除外）
  ├─ ensure_under                        媒体路径必须位于媒体库目录
  ├─ apply_capture_protection            WDA_EXCLUDEFROMCAPTURE 窗口截屏防护
  ├─ purge_expired                       按 retainDays 清理过期语音与任务
  ├─ prune_logs                          日志保留 14 天
  └─ wipe_all                            清除数据库、媒体、引擎登录态与日志
```

几个刻意的取舍：

- **数据库保持明文 SQLite。** 加密要么上 SQLCipher（构建复杂、依赖 OpenSSL），要么改字段级
  加密（搜索、统计、导出都要解密，量级一大就慢）。现状选择依赖 Windows 账户隔离，并在
  `docs/privacy.md` 里明确写出这一限制，而不是做半套加密给人虚假的安全感。
- **播放不走 asset 协议。** WebView 拿文件读取权限的风险大于收益；WAV 经后端命令按语音 ID
  读出、转 blob URL 播放，路径校验集中在 `ensure_under`。
- **日志在进入界面前脱敏，而不是在写入时脱敏。** 落盘日志还保留原始路径，便于排查本机问题；
  界面日志（可能被截图、被分享）只留脱敏版本。如果你要连落盘日志也脱敏，改
  `spawn_reader` 一处即可。
- **截屏防护是可选开关。** 默认关：它会改变窗口的捕获行为，部分远程桌面/录屏软件可能因此
  黑屏，不适合默认开启。
- **保留期清理是「删除」不是「归档」。** 过期语音连文件一起删，数据库行同步删除，
  `VACUUM` 由「清除本机数据」执行。
