use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NapcatSettings {
    /// OneBot 11 HTTP 接口根地址，例如 http://127.0.0.1:3000
    pub base_url: String,
    /// 正向 WebSocket 地址，例如 ws://127.0.0.1:3001
    pub ws_url: String,
    /// 访问令牌，留空表示 NapCat 未设置鉴权
    pub token: String,
}

impl Default for NapcatSettings {
    fn default() -> Self {
        Self {
            base_url: "http://127.0.0.1:3000".into(),
            ws_url: "ws://127.0.0.1:3001".into(),
            token: String::new(),
        }
    }
}

/// 引擎：Sylk 自己托管的 NapCat 实例。
/// `mode` 为 `embedded` 时由 Sylk 拉起、配置、监控；为 `external` 时沿用用户已有的 NapCat。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSettings {
    pub mode: String,
    /// 引擎安装目录（embedded 模式）
    pub napcat_dir: String,
    /// 指定 Node 可执行文件；留空则用内置或 PATH 里的
    pub node_path: String,
    /// 指定 QQ NT 安装目录；留空则查注册表
    pub qq_path: String,
    /// 自动获取引擎时使用的下载地址，留空用内置候选
    pub download_url: String,
    /// Sylk 启动时自动拉起引擎
    pub auto_start: bool,
    /// 登录成功后自动同步会话索引
    pub auto_sync: bool,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            mode: "embedded".into(),
            napcat_dir: String::new(),
            node_path: String::new(),
            qq_path: String::new(),
            download_url: String::new(),
            auto_start: true,
            auto_sync: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingSettings {
    /// 可用占位符：{date} {time} {sender} {duration} {seq}
    pub template: String,
}

/// 隐私与数据保留选项。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PrivacySettings {
    /// 让系统截屏/录屏工具捕获不到 Sylk 窗口（Windows 10 2004+）。
    pub block_screen_capture: bool,
    /// 自动清理多少天前的语音与任务；0 表示不自动清理。
    pub retain_days: u32,
}
impl Default for NamingSettings {
    fn default() -> Self {
        Self {
            template: "{date}_{time}_{sender}".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectSettings {
    /// 开启后，收到新语音会自动入队下载
    pub auto_collect: bool,
    /// 保留原始 silk 文件
    pub keep_raw: bool,
    /// 同时下载的语音数量
    pub concurrency: u32,
    /// 每次向 NapCat 请求的历史条数
    pub history_page_size: u32,
    /// 单个会话最多回溯多少页，防止无限翻页
    pub max_history_pages: u32,
}

impl Default for CollectSettings {
    fn default() -> Self {
        Self {
            auto_collect: true,
            keep_raw: true,
            concurrency: 3,
            history_page_size: 50,
            max_history_pages: 40,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSettings {
    pub enabled: bool,
    /// whisper-cli | openai
    pub engine: String,
    /// whisper-cli 可执行文件路径，留空时自动在 PATH 与常见安装目录里找
    pub whisper_path: String,
    /// ggml 模型路径
    pub model_path: String,
    pub language: String,
    pub threads: u32,
    /// OpenAI 兼容接口
    pub api_base: String,
    pub api_key: String,
    pub api_model: String,
}

impl Default for AsrSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: "whisper-cli".into(),
            whisper_path: String::new(),
            model_path: String::new(),
            language: "zh".into(),
            threads: 4,
            api_base: "https://api.openai.com/v1".into(),
            api_key: String::new(),
            api_model: "whisper-1".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    /// system | light | dark
    pub theme: String,
    /// comfortable | compact
    pub density: String,
    /// 详情面板是否展开
    pub show_detail: bool,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            density: "comfortable".into(),
            show_detail: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub engine: EngineSettings,
    pub napcat: NapcatSettings,
    pub naming: NamingSettings,
    pub collect: CollectSettings,
    pub asr: AsrSettings,
    pub ui: UiSettings,
    #[serde(default)]
    pub privacy: PrivacySettings,
    /// 媒体库根目录，语音文件与导出产物都放在这里
    pub library_dir: String,
    pub close_to_tray: bool,
    /// 是否已完成首次引导
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            engine: EngineSettings::default(),
            napcat: NapcatSettings::default(),
            naming: NamingSettings::default(),
            collect: CollectSettings::default(),
            asr: AsrSettings::default(),
            ui: UiSettings::default(),
            privacy: PrivacySettings::default(),
            library_dir: String::new(),
            close_to_tray: true,
            onboarded: false,
        }
    }
}

// ---------------------------------------------------------------------------
// 业务数据
// ---------------------------------------------------------------------------

/// 引擎对外状态。phase 取值：
/// unavailable | idle | preparing | starting | awaiting_scan | scanned | online | stopped | error
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub phase: String,
    pub detail: String,
    pub mode: String,
    /// 引擎文件是否齐全
    pub available: bool,
    pub napcat_dir: String,
    pub qq_dir: String,
    pub qq_found: bool,
    /// 启动方式：napcat（经典注入）/ v8（V8 编译期注入兼容通道）
    pub launch_mode: String,
    /// 本机 QQ 客户端版本（如 9.9.37-54395），探测不到时为空
    pub qq_version: String,
    pub http_port: u16,
    pub ws_port: u16,
    pub pid: Option<u32>,
    /// 二维码版本，变化时前端需要重新取图
    pub qr_version: u64,
    pub uptime: i64,
    pub account: Option<Account>,
    pub logs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub uin: String,
    pub nickname: String,
    pub avatar: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    pub kind: String,
    pub peer_id: String,
    pub title: String,
    pub avatar: String,
    pub member_count: i64,
    pub remark: String,
    pub voice_count: i64,
    pub total_ms: i64,
    pub last_voice_at: Option<i64>,
    pub starred: bool,
    pub synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub id: i64,
    pub conversation_id: i64,
    pub conversation_title: String,
    pub conversation_kind: String,
    pub msg_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub sent_at: i64,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub codec: String,
    pub sample_rate: i64,
    /// 是否已有可直接播放的文件
    pub playable: bool,
    pub file_path: String,
    pub raw_path: String,
    pub source: String,
    pub transcript: String,
    pub transcript_status: String,
    pub transcript_error: String,
    pub asr_engine: String,
    pub peaks: Vec<u8>,
    pub starred: bool,
    pub note: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceQuery {
    pub conversation_id: Option<i64>,
    pub keyword: String,
    pub only_starred: bool,
    pub only_transcribed: bool,
    /// 按发送者 id 过滤，空表示不筛
    pub sender_id: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for VoiceQuery {
    fn default() -> Self {
        Self {
            conversation_id: None,
            keyword: String::new(),
            only_starred: false,
            only_transcribed: false,
            sender_id: String::new(),
            from: None,
            to: None,
            limit: 200,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePage {
    pub items: Vec<Voice>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: i64,
    pub kind: String,
    pub ref_id: i64,
    pub status: String,
    pub attempts: i64,
    pub last_error: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub voices: i64,
    pub total_ms: i64,
    pub conversations: i64,
    pub transcribed: i64,
    pub storage_bytes: i64,
    pub today: i64,
    pub starred: i64,
    pub pending_jobs: i64,
    pub failed_jobs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStat {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub avatar: String,
    pub voices: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderStat {
    pub sender_id: String,
    pub name: String,
    pub voices: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell {
    /// 0 = 周一 … 6 = 周日
    pub weekday: i64,
    pub hour: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub day: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBundle {
    pub overview: Overview,
    pub top_conversations: Vec<ConversationStat>,
    pub top_senders: Vec<SenderStat>,
    pub heatmap: Vec<HeatCell>,
    pub daily: Vec<DayCount>,
}

// ---------------------------------------------------------------------------
// 连接 / 同步
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    /// idle | connecting | online | error
    pub status: String,
    pub message: String,
    pub account: Option<Account>,
    /// WebSocket 是否在线
    pub live: bool,
    /// 当前正在跑的任务描述
    pub busy: String,
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            message: String::new(),
            account: None,
            live: false,
            busy: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub conversations: i64,
    pub messages_scanned: i64,
    pub voices_found: i64,
    pub voices_saved: i64,
    pub pages: i64,
    pub stopped_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// sync | download | transcribe | jobs
    pub scope: String,
    pub current: i64,
    pub total: i64,
    pub label: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrProbe {
    pub engine: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub files: i64,
    pub bytes: i64,
}
