import { invoke } from "@tauri-apps/api/core";

import { mockApi } from "./mock";
import type {
  AppInfo,
  AsrProbe,
  DiagnoseItem,
  EngineCandidate,
  EngineStatus,
  QrPayload,
  ConnectionState,
  Conversation,
  ExportReport,
  Job,
  LibraryStats,
  PrivacyStats,
  RawAudio,
  Settings,
  StatsBundle,
  SyncReport,
  Voice,
  VoicePage,
  VoiceQuery,
  WipeReport,
} from "./types";

export interface Api {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  getConnection(): Promise<ConnectionState>;
  testConnection(): Promise<ConnectionState>;
  connect(): Promise<ConnectionState>;
  getAppInfo(): Promise<AppInfo>;
  listConversations(keyword?: string): Promise<Conversation[]>;
  queryVoices(query: VoiceQuery): Promise<VoicePage>;
  getVoice(id: number): Promise<Voice | null>;
  getStats(): Promise<StatsBundle>;
  syncIndex(): Promise<number>;
  syncHistory(conversationId: number, pages?: number): Promise<SyncReport>;
  syncAll(pagesPerConversation?: number): Promise<void>;
  updateVoice(id: number, starred: boolean, note: string, tags: string[]): Promise<Voice>;
  updateConversation(id: number, starred: boolean, remark: string): Promise<Conversation>;
  deleteVoice(id: number): Promise<void>;
  enqueueMissing(): Promise<number>;
  enqueueTranscribe(limit?: number): Promise<number>;
  listJobs(): Promise<Job[]>;
  retryJobs(): Promise<void>;
  clearJobs(): Promise<void>;
  probeAsr(): Promise<AsrProbe>;
  pendingDecode(): Promise<number[]>;
  readVoiceBase64(id: number): Promise<RawAudio>;
  readVoiceAudio(id: number): Promise<RawAudio>;
  saveDecoded(id: number, data: string, sampleRate?: number): Promise<void>;
  exportConversation(conversationId: number, targetDir?: string): Promise<ExportReport>;
  exportCsv(path: string, query: VoiceQuery): Promise<ExportReport>;
  exportSingle(id: number, targetPath: string): Promise<ExportReport>;
  wipeArchive(): Promise<void>;
  libraryStats(): Promise<LibraryStats>;
  privacyStats(): Promise<PrivacyStats>;
  privacyWipe(): Promise<WipeReport>;

  // 内嵌引擎
  engineStatus(): Promise<EngineStatus>;
  engineStart(): Promise<EngineStatus>;
  engineStop(): Promise<EngineStatus>;
  engineRestart(): Promise<EngineStatus>;
  engineLogout(): Promise<EngineStatus>;
  engineQrcode(): Promise<QrPayload>;
  enginePrepare(): Promise<EngineStatus>;
  engineAdoptDir(dir: string): Promise<EngineStatus>;
  engineInstallArchive(archive: string): Promise<EngineStatus>;
  engineScan(): Promise<EngineCandidate[]>;
  engineDiagnose(): Promise<DiagnoseItem[]>;
  engineOpenDir(): Promise<void>;
  reportReady(): Promise<number>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const tauriApi: Api = {
  getSettings: () => invoke("get_settings"),
  saveSettings: (settings) => invoke("save_settings", { settings }),
  getConnection: () => invoke("get_connection"),
  testConnection: () => invoke("test_connection"),
  connect: () => invoke("connect"),
  getAppInfo: () => invoke("get_app_info"),
  listConversations: (keyword) => invoke("list_conversations", { keyword: keyword ?? "" }),
  queryVoices: (query) => invoke("query_voices", { query }),
  getVoice: (id) => invoke("get_voice", { id }),
  getStats: () => invoke("get_stats"),
  syncIndex: () => invoke("sync_index"),
  syncHistory: (conversationId, pages) => invoke("sync_history", { conversationId, pages }),
  syncAll: (pagesPerConversation) => invoke("sync_all", { pagesPerConversation }),
  updateVoice: (id, starred, note, tags) => invoke("update_voice", { id, starred, note, tags }),
  updateConversation: (id, starred, remark) =>
    invoke("update_conversation", { id, starred, remark }),
  deleteVoice: (id) => invoke("delete_voice", { id }),
  enqueueMissing: () => invoke("enqueue_missing"),
  enqueueTranscribe: (limit) => invoke("enqueue_transcribe", { limit }),
  listJobs: () => invoke("list_jobs"),
  retryJobs: () => invoke("retry_jobs"),
  clearJobs: () => invoke("clear_jobs"),
  probeAsr: () => invoke("probe_asr"),
  pendingDecode: () => invoke("pending_decode"),
  readVoiceBase64: (id) => invoke("read_voice_base64", { id }),
  readVoiceAudio: (id) => invoke("read_voice_audio", { id }),
  saveDecoded: (id, data, sampleRate) => invoke("save_decoded", { id, data, sampleRate }),
  exportConversation: (conversationId, targetDir) =>
    invoke("export_conversation", { conversationId, targetDir }),
  exportCsv: (path, query) => invoke("export_csv", { path, query }),
  exportSingle: (id, targetPath) => invoke("export_single", { id, targetPath }),
  wipeArchive: () => invoke("wipe_archive"),
  libraryStats: () => invoke("library_stats"),
  privacyStats: () => invoke("privacy_stats"),
  privacyWipe: () => invoke("privacy_wipe"),

  engineStatus: () => invoke("engine_status"),
  engineStart: () => invoke("engine_start"),
  engineStop: () => invoke("engine_stop"),
  engineRestart: () => invoke("engine_restart"),
  engineLogout: () => invoke("engine_logout"),
  engineQrcode: () => invoke("engine_qrcode"),
  enginePrepare: () => invoke("engine_prepare"),
  engineAdoptDir: (dir) => invoke("engine_adopt_dir", { dir }),
  engineInstallArchive: (archive) => invoke("engine_install_archive", { archive }),
  engineScan: () => invoke("engine_scan"),
  engineDiagnose: () => invoke("engine_diagnose"),
  engineOpenDir: () => invoke("engine_open_dir"),
  reportReady: () => invoke("report_ready"),
};

export const api: Api = isTauri ? tauriApi : mockApi;
