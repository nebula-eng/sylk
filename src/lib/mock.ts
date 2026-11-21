import type { Api } from "./api";
import { buildStats, demoData } from "./demo";
import type {
  Account,
  Conversation,
  EngineCandidate,
  Job,
  Settings,
  Voice,
  VoiceQuery,
} from "./types";

/**
 * 浏览器预览模式下的内存后端。
 * 只用于 `npm run dev` 看界面与截图，不参与 Tauri 打包后的运行路径。
 */

const SETTINGS_KEY = "sylk.settings.preview";

const DEFAULT_SETTINGS: Settings = {
  engine: {
    mode: "embedded",
    napcatDir: "（预览模式不落盘）",
    nodePath: "",
    qqPath: "",
    downloadUrl: "",
    autoStart: true,
    autoSync: true,
  },
  napcat: { baseUrl: "http://127.0.0.1:3000", wsUrl: "ws://127.0.0.1:3001", token: "" },
  naming: { template: "{date}_{time}_{sender}" },
  collect: {
    autoCollect: true,
    keepRaw: true,
    concurrency: 3,
    historyPageSize: 50,
    maxHistoryPages: 40,
  },
  asr: {
    enabled: true,
    engine: "whisper-cli",
    whisperPath: "",
    modelPath: "",
    language: "zh",
    threads: 4,
    apiBase: "https://api.openai.com/v1",
    apiKey: "",
    apiModel: "whisper-1",
  },
  ui: { theme: "system", density: "comfortable", showDetail: true },
  privacy: { blockScreenCapture: false, retainDays: 0 },
  libraryDir: "D:\\Sylk Library",
  closeToTray: true,
  onboarded: true,
};

const DEMO_ACCOUNT: Account = {
  uin: "10000001",
  nickname: "预览账号",
  avatar: "",
  online: true,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) } as Settings;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

let settings = loadSettings();
const demo = demoData();
let conversations: Conversation[] = structuredClone(demo.conversations);
let voices: Voice[] = structuredClone(demo.voices);

// 演示数据没有真实音频，标记成「仅预览」。
for (const voice of voices) {
  voice.playable = false;
}

let jobs: Job[] = [
  {
    id: 1,
    kind: "download",
    refId: voices[0]?.id ?? 1,
    status: "running",
    attempts: 0,
    lastError: "",
    createdAt: Math.floor(Date.now() / 1000) - 40,
    updatedAt: Math.floor(Date.now() / 1000) - 2,
    title: voices[0]?.conversationTitle ?? "",
  },
  {
    id: 2,
    kind: "transcribe",
    refId: voices[3]?.id ?? 1,
    status: "pending",
    attempts: 0,
    lastError: "",
    createdAt: Math.floor(Date.now() / 1000) - 30,
    updatedAt: Math.floor(Date.now() / 1000) - 30,
    title: voices[3]?.conversationTitle ?? "",
  },
  {
    id: 3,
    kind: "transcribe",
    refId: voices[7]?.id ?? 1,
    status: "failed",
    attempts: 3,
    lastError: "whisper-cli 执行失败：模型文件不存在",
    createdAt: Math.floor(Date.now() / 1000) - 900,
    updatedAt: Math.floor(Date.now() / 1000) - 600,
    title: voices[7]?.conversationTitle ?? "",
  },
];

function delay<T>(value: T, ms = 60): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function recompute() {
  for (const conversation of conversations) {
    const owned = voices.filter((voice) => voice.conversationId === conversation.id);
    conversation.voiceCount = owned.length;
    conversation.totalMs = owned.reduce((sum, voice) => sum + voice.durationMs, 0);
    conversation.lastVoiceAt = owned.length ? Math.max(...owned.map((voice) => voice.sentAt)) : null;
  }
  conversations.sort((a, b) => (b.lastVoiceAt ?? 0) - (a.lastVoiceAt ?? 0));
}

function filterVoices(query: VoiceQuery): Voice[] {
  const keyword = (query.keyword ?? "").trim().toLowerCase();
  return voices.filter((voice) => {
    if (query.conversationId && voice.conversationId !== query.conversationId) return false;
    if (query.onlyStarred && !voice.starred) return false;
    if (query.onlyTranscribed && voice.transcriptStatus !== "done") return false;
    if (query.senderId && voice.senderId !== query.senderId) return false;
    if (query.from && voice.sentAt < query.from) return false;
    if (query.to && voice.sentAt > query.to) return false;
    if (!keyword) return true;
    return (
      voice.transcript.toLowerCase().includes(keyword) ||
      voice.senderName.toLowerCase().includes(keyword) ||
      voice.conversationTitle.toLowerCase().includes(keyword) ||
      voice.note.toLowerCase().includes(keyword) ||
      voice.tags.some((tag) => tag.toLowerCase().includes(keyword))
    );
  });
}

export const mockApi: Api = {
  getSettings: () => delay(settings),
  saveSettings: (next) => {
    settings = next;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return delay(next);
  },
  getConnection: () =>
    delay({
      status: "online",
      message: "已连接 预览账号（10000001）· 预览模式",
      account: DEMO_ACCOUNT,
      live: true,
      busy: "",
    }),
  testConnection: () =>
    delay({
      status: "online",
      message: "预览模式下始终返回连接成功",
      account: DEMO_ACCOUNT,
      live: false,
      busy: "",
    }),
  connect: () =>
    delay({
      status: "online",
      message: "已连接 预览账号（10000001）· 预览模式",
      account: DEMO_ACCOUNT,
      live: true,
      busy: "",
    }),
  getAppInfo: () =>
    delay({
      version: "0.1.0",
      libraryDir: settings.libraryDir,
      dbPath: "（预览模式不写数据库）",
      dataDir: "（预览模式）",
      platform: "web-preview",
    }),
  listConversations: (keyword) => {
    const text = (keyword ?? "").trim().toLowerCase();
    const items = text
      ? conversations.filter(
          (item) =>
            item.title.toLowerCase().includes(text) ||
            item.remark.toLowerCase().includes(text) ||
            item.peerId.includes(text),
        )
      : conversations;
    return delay(items);
  },
  queryVoices: (query) => {
    const matched = filterVoices(query).sort((a, b) => b.sentAt - a.sentAt);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 200;
    return delay({ items: matched.slice(offset, offset + limit), total: matched.length });
  },
  getVoice: (id) => delay(voices.find((voice) => voice.id === id) ?? null),
  getStats: () => {
    recompute();
    return delay(buildStats(conversations, voices));
  },
  syncIndex: () => delay(conversations.length),
  syncHistory: (conversationId) => {
    const owned = voices.filter((voice) => voice.conversationId === conversationId);
    return delay({
      conversations: 1,
      messagesScanned: owned.length * 6,
      voicesFound: owned.length,
      voicesSaved: 0,
      pages: 2,
      stoppedReason: "no_more",
    });
  },
  syncAll: () => delay(undefined, 200),
  updateVoice: (id, starred, note, tags) => {
    const voice = voices.find((item) => item.id === id);
    if (!voice) return Promise.reject(new Error("语音不存在"));
    voice.starred = starred;
    voice.note = note;
    voice.tags = tags;
    return delay({ ...voice });
  },
  updateConversation: (id, starred, remark) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return Promise.reject(new Error("会话不存在"));
    conversation.starred = starred;
    conversation.remark = remark;
    return delay({ ...conversation });
  },
  deleteVoice: (id) => {
    voices = voices.filter((voice) => voice.id !== id);
    recompute();
    return delay(undefined);
  },
  enqueueMissing: () => delay(0),
  enqueueTranscribe: (limit) => delay(Math.min(limit ?? 200, 12)),
  transcribeVoice: () => delay(undefined),
  listJobs: () => delay([...jobs]),
  retryJobs: () => {
    jobs = jobs.map((job) => (job.status === "failed" ? { ...job, status: "pending", attempts: 0 } : job));
    return delay(undefined);
  },
  clearJobs: () => {
    jobs = jobs.filter((job) => job.status !== "done");
    return delay(undefined);
  },
  probeAsr: () =>
    delay({
      engine: "whisper-cli",
      available: true,
      detail: "C:\\tools\\whisper-cli.exe · ggml-medium.bin（预览）",
    }),
  pendingDecode: () => delay([]),
  readVoiceBase64: () => Promise.reject(new Error("预览数据不包含音频文件")),
  readVoiceAudio: () => Promise.reject(new Error("预览数据不包含音频文件")),
  saveDecoded: () => Promise.reject(new Error("预览模式无法写入音频")),
  exportConversation: (conversationId) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    const owned = voices.filter((voice) => voice.conversationId === conversationId);
    return delay({
      path: `${settings.libraryDir}\\exports\\${conversation?.title ?? "会话"}`,
      files: owned.length + 4,
      bytes: owned.reduce((sum, voice) => sum + voice.sizeBytes, 0),
    });
  },
  exportCsv: (path, query) =>
    delay({
      path,
      files: 1,
      bytes: filterVoices(query).reduce((sum, voice) => sum + voice.sizeBytes, 0),
    }),
  exportSingle: (id, targetPath) =>
    delay({ path: targetPath, files: 1, bytes: voices.find((voice) => voice.id === id)?.sizeBytes ?? 0 }),
  wipeArchive: () => {
    conversations = [];
    voices = [];
    return delay(undefined);
  },
  engineStatus: () => {
    // 浏览器预览默认停在「已登录」，localStorage 里放 sylk.preview.login=0 可以看登录页
    const showLogin =
      typeof localStorage !== "undefined" && localStorage.getItem("sylk.preview.login") === "0";
    if (showLogin) {
      return delay({
        phase: "awaiting_scan" as const,
        detail: "用手机 QQ 扫描二维码完成登录",
        mode: "embedded",
        available: true,
        napcatDir: "（预览模式）",
        qqDir: "（预览模式）",
        qqFound: true,
        httpPort: 13700,
        wsPort: 13701,
        pid: 4242,
        qrVersion: 2,
        uptime: 24,
        account: null,
        logs: [
          "[NapCat] [Core] NapCat.Core Version: 4.18.19-preview",
          "[NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=preview",
          "配置已写入 · HTTP 13700 · WS 13701",
          "引擎已拉起 · PID 4242 · napcat.mjs",
          "[NapCat] [Core] [Login] 二维码已保存到 cache/qrcode.png",
        ],
      });
    }
    return delay({
      phase: "online" as const,
      detail: "预览模式：已登录 预览账号（10000001）",
      mode: "embedded",
      available: true,
      napcatDir: "（预览模式）",
      qqDir: "（预览模式）",
      qqFound: true,
      httpPort: 13700,
      wsPort: 13701,
      pid: 4242,
      qrVersion: 1,
      uptime: 3800,
      account: DEMO_ACCOUNT,
      logs: [
        "[NapCat] [Core] NapCat.Core Version: 4.18.19-preview",
        "[NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=preview",
        "引擎已拉起 · PID 4242 · napcat.mjs",
        "登录成功 · 预览账号（10000001）",
      ],
    });
  },
  engineStart: () => mockApi.engineStatus(),
  engineStop: () =>
    delay({
      ...({
        phase: "stopped",
        detail: "引擎已停止",
        mode: "embedded",
        available: true,
        napcatDir: "（预览模式）",
        qqDir: "",
        qqFound: true,
        httpPort: 0,
        wsPort: 0,
        pid: null,
        qrVersion: 2,
        uptime: 0,
        account: null,
        logs: [],
      } as Awaited<ReturnType<Api["engineStatus"]>>),
    }),
  engineRestart: () => mockApi.engineStatus(),
  engineLogout: () => mockApi.engineStatus(),
  engineQrcode: () =>
    delay({
      version: 2,
      available: true,
      dataUrl: previewQr(),
    }),
  enginePrepare: () => mockApi.engineStatus(),
  engineAdoptDir: () => mockApi.engineStatus(),
  engineInstallArchive: () => mockApi.engineStatus(),
  engineScan: () => delay([] as EngineCandidate[]),
  engineDiagnose: () =>
    delay([
      { key: "engine", label: "引擎文件", ok: true, detail: "（预览模式）" },
      { key: "qq", label: "QQ NT 客户端", ok: true, detail: "（预览模式）" },
      { key: "process", label: "引擎进程", ok: true, detail: "运行中 · PID 4242" },
      { key: "login", label: "账号登录", ok: true, detail: "预览账号（10000001）" },
    ]),
  engineOpenDir: () => delay(undefined),
  reportReady: () => delay(0),
  libraryStats: () =>
    delay({
      root: settings.libraryDir,
      files: voices.length * 2 + 8,
      bytes: voices.reduce((sum, voice) => sum + voice.sizeBytes, 0),
    }),
  privacyStats: () =>
    delay({
      accounts: 1,
      conversations: conversations.length,
      voices: voices.length,
      libraryBytes: voices.reduce((sum, voice) => sum + voice.sizeBytes, 0),
      logBytes: 4096,
      engineBytes: 0,
    }),
  privacyWipe: () => {
    conversations = [];
    voices = [];
    jobs = [];
    return delay({ voices: 0, files: 0, bytes: 0 });
  },
};

/** 预览用的占位二维码：SVG data URL，纯装饰。 */
function previewQr(): string {
  const modules = 25;
  let seed = 20261121;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const cells: string[] = [];
  const finder = (ox: number, oy: number) => {
    cells.push(`<rect x="${ox}" y="${oy}" width="7" height="7" fill="#111622"/>`);
    cells.push(`<rect x="${ox + 1}" y="${oy + 1}" width="5" height="5" fill="#fff"/>`);
    cells.push(`<rect x="${ox + 2}" y="${oy + 2}" width="3" height="3" fill="#111622"/>`);
  };
  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      const nearFinder =
        (x < 8 && y < 8) || (x > modules - 9 && y < 8) || (x < 8 && y > modules - 9);
      if (nearFinder) continue;
      if (next() > 0.52) {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#111622"/>`);
      }
    }
  }
  finder(0, 0);
  finder(modules - 7, 0);
  finder(0, modules - 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${modules + 4} ${modules + 4}"><rect x="-2" y="-2" width="${modules + 4}" height="${modules + 4}" fill="#fff"/>${cells.join("")}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
