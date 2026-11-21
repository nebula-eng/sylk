import { create } from "zustand";

import { api } from "./api";
import type {
  AppInfo,
  ConnectionState,
  EngineProgress,
  EngineStatus,
  QrPayload,
  Conversation,
  Job,
  ProgressEvent,
  Settings,
  StatsBundle,
  Toast,
  Voice,
} from "./types";

export type View = "voices" | "stats" | "jobs";

/** 时间范围筛选。前端只暴露粗粒度选项，具体时间戳在这里算。 */
export type RangeKey = "all" | "today" | "week" | "month";

// 搜索输入防抖 + 丢弃过期响应，避免中文输入法组字时每个按键都发查询。
let keywordTimer: number | undefined;
let voiceRequestSeq = 0;

export function rangeBounds(key: RangeKey): { from: number | null; to: number | null } {
  if (key === "all") return { from: null, to: null };
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = key === "today" ? 0 : key === "week" ? 6 : 29;
  start.setDate(start.getDate() - days);
  return { from: Math.floor(start.getTime() / 1000), to: null };
}

interface AppState {
  booted: boolean;
  loading: boolean;
  settings: Settings | null;
  info: AppInfo | null;
  connection: ConnectionState;
  conversations: Conversation[];
  activeConversationId: number | null;
  voices: Voice[];
  total: number;
  activeVoiceId: number | null;
  stats: StatsBundle | null;
  jobs: Job[];
  progress: ProgressEvent | null;
  view: View;
  keyword: string;
  onlyStarred: boolean;
  onlyTranscribed: boolean;
  range: RangeKey;
  senderFilter: string;
  /** 筛选时把名字记下来，避免筛完之后列表为空、反查不到人 */
  senderFilterLabel: string;
  /** conversation = 只看当前会话；all = 跨会话（按人筛选时用） */
  scope: "conversation" | "all";
  /** 多选模式：键为语音 id */
  selected: Set<number>;
  selectMode: boolean;
  detailOpen: boolean;
  toasts: Toast[];
  engine: EngineStatus | null;
  qr: QrPayload | null;
  prepareProgress: EngineProgress | null;
  theme: "light" | "dark";
  density: "comfortable" | "compact";
  searchOpen: boolean;
  settingsOpen: boolean;

  bootstrap: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (next: Settings, options?: { silent?: boolean }) => Promise<void>;
  refreshTheme: () => void;
  applySystemTheme: () => void;
  refreshConversations: () => Promise<void>;
  selectConversation: (id: number | null) => Promise<void>;
  refreshVoices: () => Promise<void>;
  setKeyword: (value: string) => void;
  setFilter: (patch: {
    onlyStarred?: boolean;
    onlyTranscribed?: boolean;
    range?: RangeKey;
    senderFilter?: string;
    senderFilterLabel?: string;
    scope?: "conversation" | "all";
  }) => void;
  resetFilters: () => void;
  toggleSelectMode: (on?: boolean) => void;
  toggleSelected: (id: number) => void;
  selectAllVisible: () => void;
  clearSelected: () => void;
  bulkStar: (starred: boolean) => Promise<void>;
  bulkDelete: () => Promise<void>;
  bulkTranscribe: () => Promise<void>;
  setDetailOpen: (open: boolean) => void;
  selectVoice: (id: number | null) => void;
  loadStats: () => Promise<void>;
  loadJobs: () => Promise<void>;
  connect: () => Promise<void>;
  syncHistory: (pages: number) => Promise<void>;
  syncAll: (pages: number) => Promise<void>;
  updateVoice: (id: number, patch: { starred?: boolean; note?: string; tags?: string[] }) => Promise<void>;
  deleteVoice: (id: number) => Promise<void>;
  setView: (view: View) => void;
  setProgress: (event: ProgressEvent | null) => void;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  setSearchOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setDensity: (density: "comfortable" | "compact") => void;

  // 引擎
  refreshEngine: () => Promise<void>;
  refreshQr: () => Promise<void>;
  prepareEngine: () => Promise<void>;
  startEngine: () => Promise<void>;
  stopEngine: () => Promise<void>;
  restartEngine: () => Promise<void>;
  logoutEngine: () => Promise<void>;
  setEngine: (status: EngineStatus) => void;
  setPrepareProgress: (progress: EngineProgress | null) => void;
}

let toastSeed = 1;

const initialConnection: ConnectionState = {
  status: "idle",
  message: "尚未连接",
  account: null,
  live: false,
  busy: "",
};

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  loading: false,
  settings: null,  info: null,
  connection: initialConnection,
  conversations: [],
  activeConversationId: null,
  voices: [],
  total: 0,
  activeVoiceId: null,
  stats: null,
  jobs: [],
  progress: null,
  view: "voices",
  keyword: "",
  onlyStarred: false,
  onlyTranscribed: false,
  range: "all",
  senderFilter: "",
  senderFilterLabel: "",
  scope: "conversation",
  selected: new Set<number>(),
  selectMode: false,
  detailOpen: true,
  toasts: [],
  engine: null,
  qr: null,
  prepareProgress: null,
  theme: "light",
  density: "comfortable",
  searchOpen: false,
  settingsOpen: false,

  bootstrap: async () => {
    set({ loading: true });
    try {
      const [settings, info, connection, conversations, engine] = await Promise.all([
        api.getSettings(),
        api.getAppInfo(),
        api.getConnection(),
        api.listConversations(),
        api.engineStatus().catch(() => null),
      ]);
      const theme =
        settings.ui.theme === "dark" || (settings.ui.theme === "system" && systemTheme() === "dark")
          ? "dark"
          : "light";
      set({
        settings,
        info,
        connection,
        conversations,
        engine,
        theme,
        density: settings.ui.density,
        detailOpen: settings.ui.showDetail,
        booted: true,
        loading: false,
      });
      if (conversations.length > 0) {
        await get().selectConversation(conversations[0].id);
      }
      await Promise.all([get().loadStats(), get().loadJobs()]);
    } catch (error) {
      set({ loading: false, booted: true });
      get().toast("error", error instanceof Error ? error.message : String(error));
    }
  },

  refreshSettings: async () => {
    const settings = await api.getSettings();
    set({ settings, density: settings.ui.density });
  },

  saveSettings: async (next, options) => {
    const saved = await api.saveSettings(next);
    const theme =
      saved.ui.theme === "dark" || (saved.ui.theme === "system" && systemTheme() === "dark")
        ? "dark"
        : "light";
    set({ settings: saved, theme, density: saved.ui.density });
    if (!options?.silent) {
      get().toast("success", "设置已保存");
    }
  },

  refreshTheme: () => {
    const settings = get().settings;
    if (!settings) return;
    if (settings.ui.theme === "system") {
      set({ theme: systemTheme() });
    } else {
      set({ theme: settings.ui.theme === "dark" ? "dark" : "light" });
    }
  },

  applySystemTheme: () => {
    const settings = get().settings;
    if (settings?.ui.theme === "system") {
      set({ theme: systemTheme() });
    }
  },

  refreshConversations: async () => {
    const conversations = await api.listConversations();
    set({ conversations });
    const active = get().activeConversationId;
    if (!active && conversations.length > 0) {
      // 刚登录或换账号后没有 active 会话：自动选中第一条，否则空态刷新看起来没反应。
      await get().selectConversation(conversations[0].id);
      return;
    }
    if (active && !conversations.some((item) => item.id === active)) {
      const next = conversations[0]?.id ?? null;
      set({ activeConversationId: next, activeVoiceId: null });
      if (next) await get().refreshVoices();
    }
  },

  selectConversation: async (id) => {
    set({
      activeConversationId: id,
      activeVoiceId: null,
      view: "voices",
      senderFilter: "",
      senderFilterLabel: "",
      scope: "conversation",
      selected: new Set<number>(),
      selectMode: false,
    });
    await get().refreshVoices();
  },

  refreshVoices: async () => {
    const request = ++voiceRequestSeq;
    const {
      activeConversationId,
      keyword,
      onlyStarred,
      onlyTranscribed,
      range,
      senderFilter,
      scope,
    } = get();
    const bounds = rangeBounds(range);
    const page = await api.queryVoices({
      conversationId: scope === "all" ? null : activeConversationId,
      keyword,
      onlyStarred,
      onlyTranscribed,
      senderId: senderFilter,
      from: bounds.from,
      to: bounds.to,
      limit: 500,
    });
    // 快速输入时只保留最后一次请求的结果。
    if (request !== voiceRequestSeq) return;
    set({ voices: page.items, total: page.total });
    const activeVoice = get().activeVoiceId;
    if (activeVoice && !page.items.some((item) => item.id === activeVoice)) {
      set({ activeVoiceId: null });
    }
  },

  setKeyword: (value) => {
    set({ keyword: value });
    window.clearTimeout(keywordTimer);
    keywordTimer = window.setTimeout(() => {
      void get().refreshVoices();
    }, 250);
  },

  setFilter: (patch) => {
    set({
      onlyStarred: patch.onlyStarred ?? get().onlyStarred,
      onlyTranscribed: patch.onlyTranscribed ?? get().onlyTranscribed,
      range: patch.range ?? get().range,
      scope: patch.scope ?? get().scope,
      senderFilter: patch.senderFilter ?? get().senderFilter,
      // 只改 id 不带名字时清空旧名字，免得标签上挂着上一个人的名字
      senderFilterLabel:
        patch.senderFilterLabel !== undefined
          ? patch.senderFilterLabel
          : patch.senderFilter !== undefined
            ? ""
            : get().senderFilterLabel,
    });
    void get().refreshVoices();
  },

  resetFilters: () => {
    set({
      keyword: "",
      onlyStarred: false,
      onlyTranscribed: false,
      range: "all",
      senderFilter: "",
      senderFilterLabel: "",
      scope: "conversation",
    });
    void get().refreshVoices();
  },

  toggleSelectMode: (on) => {
    const next = on ?? !get().selectMode;
    set({ selectMode: next, selected: next ? get().selected : new Set<number>() });
  },

  toggleSelected: (id) => {
    const next = new Set(get().selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },

  selectAllVisible: () => {
    set({ selected: new Set(get().voices.map((voice) => voice.id)) });
  },

  clearSelected: () => set({ selected: new Set<number>() }),

  bulkStar: async (starred) => {
    const ids = [...get().selected];
    if (ids.length === 0) return;
    for (const id of ids) {
      const voice = get().voices.find((item) => item.id === id);
      if (!voice) continue;
      const updated = await api.updateVoice(id, starred, voice.note, voice.tags);
      set({ voices: get().voices.map((item) => (item.id === id ? updated : item)) });
    }
    get().toast("success", `已${starred ? "标记" : "取消标记"} ${ids.length} 条`);
  },

  bulkDelete: async () => {
    const ids = [...get().selected];
    if (ids.length === 0) return;
    const removed: number[] = [];
    let firstError = "";
    for (const id of ids) {
      try {
        await api.deleteVoice(id);
        removed.push(id);
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error.message : String(error);
      }
    }
    if (removed.length > 0) {
      set({
        voices: get().voices.filter((voice) => !removed.includes(voice.id)),
        total: Math.max(0, get().total - removed.length),
        selected: new Set<number>(),
        selectMode: false,
        activeVoiceId: removed.includes(get().activeVoiceId ?? -1) ? null : get().activeVoiceId,
      });
      await Promise.all([get().refreshConversations(), get().loadStats()]);
    }
    if (removed.length === ids.length) {
      get().toast("success", `已删除 ${removed.length} 条语音`);
    } else {
      get().toast(
        "error",
        `已删除 ${removed.length} 条，${ids.length - removed.length} 条失败：${firstError || "未知原因"}`,
      );
    }
  },

  bulkTranscribe: async () => {
    const ids = [...get().selected];
    if (ids.length === 0) return;
    let queued = 0;
    let firstError = "";
    for (const id of ids) {
      try {
        await api.transcribeVoice(id);
        queued += 1;
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error.message : String(error);
      }
    }
    if (queued > 0) {
      get().toast("info", `已把 ${queued} 条所选语音加入转写队列`);
    }
    if (queued < ids.length) {
      get().toast("error", `有 ${ids.length - queued} 条未加入队列：${firstError || "未知原因"}`);
    }
  },

  setDetailOpen: (open) => set({ detailOpen: open }),

  selectVoice: (id) => set({ activeVoiceId: id }),

  loadStats: async () => {
    try {
      const stats = await api.getStats();
      set({ stats });
    } catch (error) {
      get().toast("error", error instanceof Error ? error.message : String(error));
    }
  },

  loadJobs: async () => {
    try {
      const jobs = await api.listJobs();
      set({ jobs });
    } catch {
      // 任务面板失败不打扰用户。
    }
  },

  connect: async () => {
    set({ connection: { ...get().connection, status: "connecting", message: "正在连接…" } });
    try {
      const connection = await api.connect();
      set({ connection });
      await get().refreshConversations();
      await get().refreshVoices();
      if (connection.status === "online") {
        get().toast("success", connection.message);
      } else {
        get().toast("error", connection.message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ connection: { ...initialConnection, status: "error", message } });
      get().toast("error", message);
    }
  },

  syncHistory: async (pages) => {
    const conversationId = get().activeConversationId;
    if (!conversationId) return;
    try {
      const report = await api.syncHistory(conversationId, pages);
      await Promise.all([get().refreshConversations(), get().refreshVoices(), get().loadStats()]);
      const reason: Record<string, string> = {
        no_more: "已到最早的消息",
        stalled: "没有更早的消息了",
        reached_limit: "达到页数上限",
        cancelled: "已取消",
      };
      get().toast(
        "success",
        `回溯完成：扫描 ${report.messagesScanned} 条消息，新增 ${report.voicesSaved} 条语音（${reason[report.stoppedReason] ?? report.stoppedReason}）`,
      );
    } catch (error) {
      get().toast("error", error instanceof Error ? error.message : String(error));
    }
  },

  syncAll: async (pages) => {
    try {
      await api.syncAll(pages);
      get().toast("info", "批量回溯已在后台开始，进度会显示在顶部");
    } catch (error) {
      get().toast("error", error instanceof Error ? error.message : String(error));
    }
  },

  updateVoice: async (id, patch) => {
    const current = get().voices.find((voice) => voice.id === id);
    if (!current) return;
    const next = {
      starred: patch.starred ?? current.starred,
      note: patch.note ?? current.note,
      tags: patch.tags ?? current.tags,
    };
    const updated = await api.updateVoice(id, next.starred, next.note, next.tags);
    set({
      voices: get().voices.map((voice) => (voice.id === id ? updated : voice)),
    });
  },

  deleteVoice: async (id) => {
    await api.deleteVoice(id);
    set({
      voices: get().voices.filter((voice) => voice.id !== id),
      total: Math.max(0, get().total - 1),
      activeVoiceId: get().activeVoiceId === id ? null : get().activeVoiceId,
    });
    await Promise.all([get().refreshConversations(), get().loadStats()]);
    get().toast("success", "已删除这条语音");
  },

  setView: (view) => set({ view }),

  setProgress: (event) => set({ progress: event }),

  toast: (kind, text) => {
    const id = toastSeed++;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    window.setTimeout(() => get().dismissToast(id), kind === "error" ? 7000 : 4000);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  setSearchOpen: (open) => set({ searchOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setDensity: (density) => set({ density }),

  // ---------------------------------------------------------------- 引擎 ---

  refreshEngine: async () => {
    try {
      const engine = await api.engineStatus();
      const previous = get().engine;
      set({ engine });
      // 版本变了要取新图；首次进入等待扫码时可能版本没变但图还没拿到，也要补一次
      const needsQr =
        engine.qrVersion !== (previous?.qrVersion ?? -1) ||
        (engine.phase === "awaiting_scan" && !get().qr);
      if (needsQr) {
        await get().refreshQr();
      }
      if (engine.phase === "online" && engine.account && !get().connection.account) {
        // 引擎自己已经登录了，顺手把应用层连接补上
        void get().connect();
      }
    } catch {
      // 引擎状态查不到不该影响主界面
    }
  },

  refreshQr: async () => {
    try {
      const qr = await api.engineQrcode();
      set({ qr: qr.available ? qr : null });
    } catch {
      set({ qr: null });
    }
  },

  prepareEngine: async () => {
    set({ prepareProgress: { stage: "download", percent: 1, detail: "正在准备…" } });
    try {
      const engine = await api.enginePrepare();
      set({ engine, prepareProgress: null });
      if (engine.phase === "online") {
        get().toast("success", "引擎已就绪，账号已登录");
      } else {
        get().toast("success", "引擎已就绪，请扫码登录");
      }
      await get().refreshQr();
    } catch (error) {
      set({ prepareProgress: null });
      get().toast("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  },

  startEngine: async () => {
    try {
      const engine = await api.engineStart();
      set({ engine });
      await get().refreshQr();
    } catch (error) {
      get().toast("error", error instanceof Error ? error.message : String(error));
    }
  },

  stopEngine: async () => {
    const engine = await api.engineStop();
    set({ engine, qr: null });
  },

  restartEngine: async () => {
    get().toast("info", "正在重启引擎…");
    const engine = await api.engineRestart();
    set({ engine });
    await get().refreshQr();
  },

  logoutEngine: async () => {
    const engine = await api.engineLogout();
    set({
      engine,
      qr: null,
      connection: { ...initialConnection, message: "已退出登录" },
    });
    await get().refreshQr();
    get().toast("info", "已退出登录，请重新扫码");
  },

  setEngine: (status) => {
    const previous = get().engine;
    set({ engine: status });
    if (status.qrVersion !== (previous?.qrVersion ?? -1)) {
      void get().refreshQr();
    }
    if (status.phase === "online" && previous?.phase !== "online") {
      void get().connect();
    }
  },

  setPrepareProgress: (progress) => set({ prepareProgress: progress }),
}));
