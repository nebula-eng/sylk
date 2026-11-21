// 与 src-tauri/src/models.rs 一一对应的类型定义。

export type ThemeMode = "system" | "light" | "dark";
export type ConversationKind = "group" | "friend";
export type TranscriptStatus = "none" | "queued" | "running" | "done" | "failed";

export interface NapcatSettings {
  baseUrl: string;
  wsUrl: string;
  token: string;
}

export type EnginePhase =
  | "unavailable"
  | "idle"
  | "preparing"
  | "starting"
  | "awaiting_scan"
  | "scanned"
  | "online"
  | "stopped"
  | "error";

export interface EngineSettings {
  mode: "embedded" | "external";
  napcatDir: string;
  nodePath: string;
  qqPath: string;
  downloadUrl: string;
  autoStart: boolean;
  autoSync: boolean;
}

export interface EngineCandidate {
  /** v8 = 兼容引擎包；napcat = 经典 NapCat 目录 */
  kind: "v8" | "napcat";
  path: string;
}

export interface EngineStatus {
  phase: EnginePhase;
  detail: string;
  mode: string;
  available: boolean;
  napcatDir: string;
  qqDir: string;
  qqFound: boolean;
  /** napcat（经典注入）或 v8（V8 编译期注入兼容通道） */
  launchMode?: string;
  /** 本机 QQ 客户端版本，探测不到时为空 */
  qqVersion?: string;
  httpPort: number;
  wsPort: number;
  pid: number | null;
  qrVersion: number;
  uptime: number;
  account: Account | null;
  logs: string[];
}

export interface QrPayload {
  version: number;
  available: boolean;
  dataUrl: string;
}

export interface EngineProgress {
  stage: "download" | "unpack" | "done" | string;
  percent: number;
  detail: string;
}

export interface DiagnoseItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface NamingSettings {
  template: string;
}

export interface CollectSettings {
  autoCollect: boolean;
  keepRaw: boolean;
  concurrency: number;
  historyPageSize: number;
  maxHistoryPages: number;
}

export interface AsrSettings {
  enabled: boolean;
  engine: "whisper-cli" | "openai";
  whisperPath: string;
  modelPath: string;
  language: string;
  threads: number;
  apiBase: string;
  apiKey: string;
  apiModel: string;
}

export interface UiSettings {
  theme: ThemeMode;
  density: "comfortable" | "compact";
  showDetail: boolean;
}

export interface PrivacySettings {
  /** 让系统截屏/录屏工具捕获不到 Sylk 窗口（Windows 10 2004+） */
  blockScreenCapture: boolean;
  /** 自动清理多少天前的语音与任务；0 表示不自动清理 */
  retainDays: number;
}

export interface Settings {
  engine: EngineSettings;
  napcat: NapcatSettings;
  naming: NamingSettings;
  collect: CollectSettings;
  asr: AsrSettings;
  ui: UiSettings;
  privacy: PrivacySettings;
  libraryDir: string;
  closeToTray: boolean;
  onboarded: boolean;
}

export interface Account {
  uin: string;
  nickname: string;
  avatar: string;
  online: boolean;
}

export interface Conversation {
  id: number;
  kind: ConversationKind;
  peerId: string;
  title: string;
  avatar: string;
  memberCount: number;
  remark: string;
  voiceCount: number;
  totalMs: number;
  lastVoiceAt: number | null;
  starred: boolean;
  syncedAt: number | null;
}

export interface Voice {
  id: number;
  conversationId: number;
  conversationTitle: string;
  conversationKind: ConversationKind;
  msgId: string;
  senderId: string;
  senderName: string;
  sentAt: number;
  durationMs: number;
  sizeBytes: number;
  codec: string;
  sampleRate: number;
  playable: boolean;
  filePath: string;
  rawPath: string;
  source: "live" | "history" | "import";
  transcript: string;
  transcriptStatus: TranscriptStatus;
  transcriptError: string;
  asrEngine: string;
  peaks: number[];
  starred: boolean;
  note: string;
  tags: string[];
}

export interface VoiceQuery {
  conversationId?: number | null;
  keyword?: string;
  onlyStarred?: boolean;
  onlyTranscribed?: boolean;
  senderId?: string;
  from?: number | null;
  to?: number | null;
  limit?: number;
  offset?: number;
}

export interface VoicePage {
  items: Voice[];
  total: number;
}

export interface Job {
  id: number;
  kind: "download" | "transcribe";
  refId: number;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  title: string;
}

export interface Overview {
  voices: number;
  totalMs: number;
  conversations: number;
  transcribed: number;
  storageBytes: number;
  today: number;
  starred: number;
  pendingJobs: number;
  failedJobs: number;
}

export interface ConversationStat {
  id: number;
  title: string;
  kind: ConversationKind;
  avatar: string;
  voices: number;
  totalMs: number;
}

export interface SenderStat {
  senderId: string;
  name: string;
  voices: number;
  totalMs: number;
}

export interface HeatCell {
  weekday: number;
  hour: number;
  count: number;
}

export interface DayCount {
  day: string;
  count: number;
}

export interface StatsBundle {
  overview: Overview;
  topConversations: ConversationStat[];
  topSenders: SenderStat[];
  heatmap: HeatCell[];
  daily: DayCount[];
}

export interface ConnectionState {
  status: "idle" | "connecting" | "online" | "error";
  message: string;
  account: Account | null;
  live: boolean;
  busy: string;
}

export interface SyncReport {
  conversations: number;
  messagesScanned: number;
  voicesFound: number;
  voicesSaved: number;
  pages: number;
  stoppedReason: string;
}

export interface ProgressEvent {
  scope: string;
  current: number;
  total: number;
  label: string;
  done: boolean;
}

export interface AsrProbe {
  engine: string;
  available: boolean;
  detail: string;
}

export interface ExportReport {
  path: string;
  files: number;
  bytes: number;
}

export interface RawAudio {
  name: string;
  kind: "silk" | "wav" | "unknown";
  data: string;
}

export interface AppInfo {
  version: string;
  libraryDir: string;
  dbPath: string;
  dataDir: string;
  platform: string;
}

export interface LibraryStats {
  root: string;
  files: number;
  bytes: number;
}

export interface PrivacyStats {
  accounts: number;
  conversations: number;
  voices: number;
  libraryBytes: number;
  logBytes: number;
  engineBytes: number;
}

export interface WipeReport {
  voices: number;
  files: number;
  bytes: number;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}
