import { useEffect, useState } from "react";
import {
  X,
  Plug,
  FolderCog,
  AudioLines,
  Palette,
  Info,
  FolderOpen,
  Check,
  FileText,
  Wand2,
  Shield,
  ShieldAlert,
  Cog,
  Trash2,
  RefreshCw,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { AsrProbe, LibraryStats, PrivacyStats, Settings } from "@/lib/types";
import { Button, Field, IconButton, Modal, Segmented, Switch, cn } from "@/components/ui/primitives";
import { EnginePanel } from "@/components/EnginePanel";

type Tab = "engine" | "connection" | "library" | "asr" | "appearance" | "privacy" | "about";

const TABS: { id: Tab; label: string; icon: typeof Plug }[] = [
  { id: "engine", label: "引擎", icon: Cog },
  { id: "connection", label: "连接", icon: Plug },
  { id: "library", label: "媒体库", icon: FolderCog },
  { id: "asr", label: "转写", icon: AudioLines },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "privacy", label: "隐私", icon: Shield },
  { id: "about", label: "关于", icon: Info },
];

export function SettingsPanel() {
  const open = useApp((state) => state.settingsOpen);
  const setOpen = useApp((state) => state.setSettingsOpen);
  const settings = useApp((state) => state.settings);
  const connection = useApp((state) => state.connection);
  const connect = useApp((state) => state.connect);
  const saveSettings = useApp((state) => state.saveSettings);
  const info = useApp((state) => state.info);
  const toast = useApp((state) => state.toast);

  const [tab, setTab] = useState<Tab>("engine");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [probe, setProbe] = useState<AsrProbe | null>(null);
  const [library, setLibrary] = useState<LibraryStats | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [privacy, setPrivacy] = useState<PrivacyStats | null>(null);
  const [confirmWipeAll, setConfirmWipeAll] = useState(false);

  useEffect(() => {
    if (open && settings) {
      setDraft(structuredClone(settings));
      setConfirmWipe(false);
      setConfirmWipeAll(false);
    }
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    if (tab === "asr") {
      setProbe(null);
      void api.probeAsr().then(setProbe).catch(() => setProbe(null));
    }
    if (tab === "privacy") {
      void api.privacyStats().then(setPrivacy).catch(() => setPrivacy(null));
    }
    if (tab === "about") {
      void api.libraryStats().then(setLibrary).catch(() => setLibrary(null));
    }
  }, [open, tab, draft?.asr.engine, draft?.asr.modelPath, draft?.asr.whisperPath]);

  if (!draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const close = () => {
    if (dirty && !window.confirm("设置尚未保存，要放弃这次修改吗？")) return;
    setOpen(false);
  };

  const patch = (part: Partial<Settings>) => setDraft({ ...draft, ...part });
  const patchNapcat = (part: Partial<Settings["napcat"]>) =>
    setDraft({ ...draft, napcat: { ...draft.napcat, ...part } });
  const patchCollect = (part: Partial<Settings["collect"]>) =>
    setDraft({ ...draft, collect: { ...draft.collect, ...part } });
  const patchAsr = (part: Partial<Settings["asr"]>) =>
    setDraft({ ...draft, asr: { ...draft.asr, ...part } });
  const patchUi = (part: Partial<Settings["ui"]>) =>
    setDraft({ ...draft, ui: { ...draft.ui, ...part } });
  const patchPrivacy = (part: Partial<Settings["privacy"]>) =>
    setDraft({ ...draft, privacy: { ...draft.privacy, ...part } });

  const save = async (close = true) => {
    try {
      await saveSettings(draft);
      if (close) setOpen(false);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };
  const pickPath = async (
    apply: (value: string) => void,
    options: { directory?: boolean; filters?: { name: string; extensions: string[] }[] },
  ) => {
    if (!isTauri) {
      toast("info", "浏览器预览模式不支持选择本机路径");
      return;
    }
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const picked = await openDialog({ multiple: false, ...options });
    if (typeof picked === "string") apply(picked);
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      // 测试连接需要先把草稿写入后端，因此这里会保存当前设置。
      await saveSettings(draft, { silent: true });
      const result = await api.testConnection();
      toast(result.status === "online" ? "success" : "error", result.message);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const doConnect = async () => {
    await saveSettings(draft, { silent: true });
    setOpen(false);
    await connect();
  };

  return (
    <Modal open={open} onClose={close} label="设置">
      <div className="settings">
        <div className="settings__head">
          <div className="settings__title">
            设置
            {dirty ? <span className="settings__dirty">未保存</span> : null}
          </div>
          <IconButton label="关闭" style={{ marginLeft: "auto" }} onClick={close}>
            <X size={16} />
          </IconButton>
        </div>

        <div className="settings__body">
          <div className="settings__tabs">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn("settings__tab", tab === item.id && "is-active")}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={14} />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="settings__panels">
            {tab === "engine" ? <EnginePanel draft={draft} patch={patch} /> : null}

            {tab === "connection" ? (
              <>
                <div className="step-card">
                  <div className="step-card__title">
                    <Plug size={13} />
                    NapCat
                  </div>
                  <button
                    type="button"
                    className="link-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      void import("@tauri-apps/plugin-opener")
                        .then(({ openUrl }) => openUrl("https://github.com/NapNeko/NapCatQQ/releases"))
                        .catch(() => toast("info", "https://github.com/NapNeko/NapCatQQ"));
                    }}
                  >
                    <FolderOpen size={12} />
                    项目页
                  </button>
                </div>

                <Field label="HTTP 地址" hint="拉取会话列表、历史消息与音频">
                  <input
                    className="input input--mono"
                    value={draft.napcat.baseUrl}
                    onChange={(event) => patchNapcat({ baseUrl: event.target.value })}
                    placeholder="http://127.0.0.1:3000"
                  />
                </Field>

                <Field label="WebSocket 地址" hint="接收实时消息，断线自动重连">
                  <input
                    className="input input--mono"
                    value={draft.napcat.wsUrl}
                    onChange={(event) => patchNapcat({ wsUrl: event.target.value })}
                    placeholder="ws://127.0.0.1:3001"
                  />
                </Field>

                <Field label="访问令牌" hint="NapCat 配置了 token 时填写，否则留空">
                  <input
                    className="input input--mono"
                    type="password"
                    value={draft.napcat.token}
                    onChange={(event) => patchNapcat({ token: event.target.value })}
                    placeholder="access_token"
                  />
                </Field>

                <div className="check-line">
                  <span
                    className={cn(
                      "check-line__icon",
                      connection.status === "online" ? "is-ok" : connection.status === "error" ? "is-bad" : "",
                    )}
                  >
                    {connection.status === "online" ? <Check size={11} /> : <ShieldAlert size={11} />}
                  </span>
                  <span>{connection.status === "online" ? "已连接" : "未连接"}</span>
                  <span className="check-line__detail">{connection.message}</span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Button variant="ghost" onClick={() => void testConnection()} disabled={testing}>
                    {testing ? "正在测试…" : "保存并测试连接"}
                  </Button>
                  <Button variant="primary" onClick={() => void doConnect()}>
                    保存并连接
                  </Button>
                </div>
              </>
            ) : null}

            {tab === "library" ? (
              <>
                <Field label="媒体库目录" hint="语音、原始文件与导出的存放位置">
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="input input--mono"
                      value={draft.libraryDir}
                      onChange={(event) => patch({ libraryDir: event.target.value })}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => void pickPath((value) => patch({ libraryDir: value }), { directory: true })}
                    >
                      选择
                    </Button>
                  </div>
                </Field>

                <Field label="文件命名模板" hint="可用占位符：{date} {time} {sender} {duration} {seq}">
                  <input
                    className="input input--mono"
                    value={draft.naming.template}
                    onChange={(event) => patch({ naming: { template: event.target.value } })}
                    placeholder="{date}_{time}_{sender}"
                  />
                </Field>

                <div className="form-row form-row--inline">
                  <div style={{ flex: 1 }}>
                    <div className="form-label" style={{ marginBottom: 2 }}>
                      自动保存新语音
                    </div>
                    <div className="form-hint" style={{ marginTop: 0 }}>
                      实时收到的语音自动下载
                    </div>
                  </div>
                  <Switch
                    label="自动采集"
                    checked={draft.collect.autoCollect}
                    onChange={(value) => patchCollect({ autoCollect: value })}
                  />
                </div>

                <div className="form-row form-row--inline">
                  <div style={{ flex: 1 }}>
                    <div className="form-label" style={{ marginBottom: 2 }}>
                      保留原始 SILK 文件
                    </div>
                    <div className="form-hint" style={{ marginTop: 0 }}>
                      原件体积较小，可用于长期存档
                    </div>
                  </div>
                  <Switch
                    label="保留原件"
                    checked={draft.collect.keepRaw}
                    onChange={(value) => patchCollect({ keepRaw: value })}
                  />
                </div>

                <div className="row-2">
                  <Field label="下载并发数" hint="1 至 8，配置较低的机器建议 2">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={8}
                      value={draft.collect.concurrency}
                      onChange={(event) =>
                        patchCollect({ concurrency: Number(event.target.value) || 1 })
                      }
                    />
                  </Field>
                  <Field label="每页消息数" hint="10 至 100，过大可能触发限流">
                    <input
                      className="input"
                      type="number"
                      min={10}
                      max={100}
                      value={draft.collect.historyPageSize}
                      onChange={(event) =>
                        patchCollect({ historyPageSize: Number(event.target.value) || 50 })
                      }
                    />
                  </Field>
                </div>

                <Field label="单会话最多同步页数" hint="每次同步最多翻多少页，默认 40">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={200}
                    value={draft.collect.maxHistoryPages}
                    onChange={(event) =>
                      patchCollect({ maxHistoryPages: Number(event.target.value) || 40 })
                    }
                  />
                </Field>
              </>
            ) : null}

            {tab === "asr" ? (
              <>
                <div className="form-row form-row--inline">
                  <div style={{ flex: 1 }}>
                    <div className="form-label" style={{ marginBottom: 2 }}>
                      语音转写
                    </div>
                    <div className="form-hint" style={{ marginTop: 0 }}>
                      默认在本地运行，音频不外传
                    </div>
                  </div>
                  <Switch
                    label="启用转写"
                    checked={draft.asr.enabled}
                    onChange={(value) => patchAsr({ enabled: value })}
                  />
                </div>

                <Field label="引擎">
                  <Segmented
                    value={draft.asr.engine}
                    onChange={(value) => patchAsr({ engine: value })}
                    options={[
                      { value: "whisper-cli", label: "本地 whisper.cpp" },
                      { value: "openai", label: "OpenAI 兼容接口" },
                    ]}
                  />
                </Field>

                {draft.asr.engine === "whisper-cli" ? (
                  <>
                    <Field label="whisper-cli 路径" hint="留空时自动在 PATH 中查找">
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          className="input input--mono"
                          value={draft.asr.whisperPath}
                          onChange={(event) => patchAsr({ whisperPath: event.target.value })}
                          placeholder="C:\\tools\\whisper-cli.exe"
                        />
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void pickPath((value) => patchAsr({ whisperPath: value }), {
                              filters: [{ name: "可执行文件", extensions: ["exe"] }],
                            })
                          }
                        >
                          浏览
                        </Button>
                      </div>
                    </Field>

                    <Field label="模型文件" hint="中文建议 medium；模型越大越准，速度越慢">
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          className="input input--mono"
                          value={draft.asr.modelPath}
                          onChange={(event) => patchAsr({ modelPath: event.target.value })}
                          placeholder="ggml-medium.bin"
                        />
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void pickPath((value) => patchAsr({ modelPath: value }), {
                              filters: [{ name: "whisper 模型", extensions: ["bin"] }],
                            })
                          }
                        >
                          浏览
                        </Button>
                      </div>
                    </Field>

                    <div className="row-2">
                      <Field label="语言">
                        <input
                          className="input"
                          value={draft.asr.language}
                          onChange={(event) => patchAsr({ language: event.target.value })}
                          placeholder="zh"
                        />
                      </Field>
                      <Field label="线程数">
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={32}
                          value={draft.asr.threads}
                          onChange={(event) => patchAsr({ threads: Number(event.target.value) || 4 })}
                        />
                      </Field>
                    </div>
                  </>
                ) : (
                  <>
                    <Field label="接口地址" hint="兼容 /audio/transcriptions 的服务">
                      <input
                        className="input input--mono"
                        value={draft.asr.apiBase}
                        onChange={(event) => patchAsr({ apiBase: event.target.value })}
                        placeholder="https://api.openai.com/v1"
                      />
                    </Field>
                    <Field label="密钥">
                      <input
                        className="input input--mono"
                        type="password"
                        value={draft.asr.apiKey}
                        onChange={(event) => patchAsr({ apiKey: event.target.value })}
                      />
                    </Field>
                    <Field label="模型名">
                      <input
                        className="input input--mono"
                        value={draft.asr.apiModel}
                        onChange={(event) => patchAsr({ apiModel: event.target.value })}
                        placeholder="whisper-1"
                      />
                    </Field>
                  </>
                )}

                <div className="check-line">
                  <span
                    className={cn(
                      "check-line__icon",
                      probe === null ? "is-pending" : probe.available ? "is-ok" : "is-bad",
                    )}
                  >
                    {probe === null ? (
                      <RefreshCw size={11} className="spin" />
                    ) : probe.available ? (
                      <Check size={11} />
                    ) : (
                      <ShieldAlert size={11} />
                    )}
                  </span>
                  <span>{probe === null ? "正在检测…" : probe.available ? "引擎就绪" : "引擎不可用"}</span>
                  <span className="check-line__detail">{probe?.detail ?? "正在读取引擎状态"}</span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Button
                    variant="ghost"
                    icon={<Wand2 size={13} />}
                    onClick={async () => {
                      try {
                        await saveSettings(draft, { silent: true });
                        const count = await api.enqueueTranscribe(200);
                        toast("info", count > 0 ? `已加入 ${count} 条转写任务` : "没有需要转写的语音");
                      } catch (error) {
                        toast("error", error instanceof Error ? error.message : String(error));
                      }
                    }}
                  >
                    转写未处理的语音
                  </Button>
                </div>

                <div className="form-hint" style={{ marginTop: 12 }}>
                  转写在后台串行执行。失败原因见任务页，修复配置后可重试。
                </div>
              </>
            ) : null}

            {tab === "appearance" ? (
              <>
                <Field label="主题">
                  <Segmented
                    value={draft.ui.theme}
                    onChange={(value) => patchUi({ theme: value })}
                    options={[
                      { value: "system", label: "跟随系统" },
                      { value: "light", label: "浅色" },
                      { value: "dark", label: "深色" },
                    ]}
                  />
                </Field>

                <Field label="列表密度">
                  <Segmented
                    value={draft.ui.density}
                    onChange={(value) => patchUi({ density: value })}
                    options={[
                      { value: "comfortable", label: "舒适" },
                      { value: "compact", label: "紧凑" },
                    ]}
                  />
                </Field>

                <div className="form-row form-row--inline">
                  <div style={{ flex: 1 }}>
                    <div className="form-label" style={{ marginBottom: 2 }}>
                      关闭窗口时最小化到托盘
                    </div>
                    <div className="form-hint" style={{ marginTop: 0 }}>
                      {draft.closeToTray
                        ? "关闭窗口后收进托盘，实时接收继续；从托盘退出才会停止。"
                        : "关闭窗口直接退出，实时接收同时停止。"}
                    </div>
                  </div>
                  <Switch
                    label="关闭到托盘"
                    checked={draft.closeToTray}
                    onChange={(value) => patch({ closeToTray: value })}
                  />
                </div>
              </>
            ) : null}

            {tab === "privacy" ? (
              <>
                <div className="step-card">
                  <div className="step-card__title">
                    <Shield size={13} />
                    本机数据
                  </div>
                  <div className="step-card__text">
                    Sylk 不设账号体系，也不向自有服务器上传内容。语音、转写文本、数据库和引擎登录态
                    都保存在这台电脑上；出网动作只有你主动开启的云端转写，以及下载引擎包。
                  </div>
                  <div className="kv">
                    <span className="kv__k">已登录账号</span>
                    <span className="kv__v">{privacy ? `${privacy.accounts} 个` : "统计中…"}</span>
                    <span className="kv__k">会话 / 语音</span>
                    <span className="kv__v">
                      {privacy ? `${privacy.conversations} / ${privacy.voices}` : "统计中…"}
                    </span>
                    <span className="kv__k">媒体库</span>
                    <span className="kv__v">{privacy ? formatBytes(privacy.libraryBytes) : "…"}</span>
                    <span className="kv__k">日志</span>
                    <span className="kv__v">{privacy ? formatBytes(privacy.logBytes) : "…"}</span>
                    <span className="kv__k">引擎登录态</span>
                    <span className="kv__v">{privacy ? formatBytes(privacy.engineBytes) : "…"}</span>
                  </div>
                </div>

                <div className="form-row form-row--inline">
                  <div style={{ flex: 1 }}>
                    <div className="form-label" style={{ marginBottom: 2 }}>
                      截屏防护
                    </div>
                    <div className="form-hint" style={{ marginTop: 0 }}>
                      开启后，系统截屏与录屏工具捕获不到 Sylk 窗口（Windows 10 2004 及以上）。
                      屏幕共享时窗口对其他应用仍然可见，这不是防窥镜。
                    </div>
                  </div>
                  <Switch
                    label="截屏防护"
                    checked={draft.privacy.blockScreenCapture}
                    onChange={(value) => patchPrivacy({ blockScreenCapture: value })}
                  />
                </div>

                <Field
                  label="自动清理"
                  hint="超过保留期的语音、转写与任务会在启动后清理，本地文件一并删除。"
                >
                  <Segmented
                    value={String(draft.privacy.retainDays)}
                    onChange={(value) => patchPrivacy({ retainDays: Number(value) })}
                    options={[
                      { value: "0", label: "不清理" },
                      { value: "7", label: "7 天" },
                      { value: "30", label: "30 天" },
                      { value: "90", label: "90 天" },
                    ]}
                  />
                </Field>

                <div className="form-hint" style={{ lineHeight: 1.75 }}>
                  云端转写的 API Key 以 Windows DPAPI 加密后写入设置文件，只有当前 Windows
                  账户能解开。引擎日志在显示前会去掉访问令牌、本机用户目录与 QQ 号中间位；
                  日志文件保留 14 天。
                </div>

                <div className="divider" />

                <div
                  className="form-row--inline"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  {confirmWipeAll ? (
                    <>
                      <Button
                        variant="danger"
                        icon={<Trash2 size={13} />}
                        onClick={async () => {
                          try {
                            const report = await api.privacyWipe();
                            setConfirmWipeAll(false);
                            setOpen(false);
                            await useApp.getState().bootstrap();
                            toast(
                              "success",
                              `已清除 ${report.voices} 条语音、${report.files} 个文件（${formatBytes(report.bytes)}）`,
                            );
                          } catch (error) {
                            toast("error", error instanceof Error ? error.message : String(error));
                          }
                        }}
                      >
                        确认清除
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmWipeAll(false)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      icon={<Trash2 size={13} />}
                      onClick={() => setConfirmWipeAll(true)}
                    >
                      清除本机数据
                    </Button>
                  )}
                  <span className="form-hint" style={{ marginLeft: "auto", marginTop: 0 }}>
                    删除数据库、媒体文件、引擎登录态与日志；保留程序与设置
                  </span>
                </div>
              </>
            ) : null}

            {tab === "about" ? (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 18 }}>
                  <div className="rail__brand" style={{ marginBottom: 0 }}>
                    <AudioLines size={17} />
                  </div>
                  <div>
                    <div style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>Sylk · 声匣</div>
                    <div className="settings__version">
                      版本 {info?.version ?? "—"} · {info?.platform ?? "—"}
                    </div>
                  </div>
                </div>

                <div className="kv">
                  <span className="kv__k">媒体库</span>
                  <span className="kv__v">{info?.libraryDir}</span>
                  <span className="kv__k">数据库</span>
                  <span className="kv__v">{info?.dbPath}</span>
                  <span className="kv__k">已用空间</span>
                  <span className="kv__v">
                    {library ? `${formatBytes(library.bytes)} · ${library.files} 个文件` : "统计中…"}
                  </span>
                </div>

                <div className="divider" />

                <div className="form-hint" style={{ lineHeight: 1.75 }}>
                  语音、转写与数据库默认保存在本机；只有你主动开启云端转写时，音频才会发到你配置的接口。
                  API Key 用 Windows DPAPI 加密保存。数据清理选项在「隐私」页。
                  使用第三方引擎或转写服务前，请自行确认其条款与账号风险。
                </div>

                <div className="divider" />

                <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <Button
                    variant="ghost"
                    icon={<Wand2 size={13} />}
                    onClick={() => {
                      setTab("engine");
                    }}
                  >
                    引擎状态与自检
                  </Button>
                </div>

                <div className="divider" />

                <div className="form-row--inline" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {confirmWipe ? (
                    <>
                      <Button
                        variant="danger"
                        icon={<ShieldAlert size={13} />}
                        onClick={async () => {
                          try {
                            await api.wipeArchive();
                            toast("success", "语音索引已清空，媒体文件保留");
                            setConfirmWipe(false);
                            await useApp.getState().bootstrap();
                          } catch (error) {
                            toast("error", error instanceof Error ? error.message : String(error));
                          }
                        }}
                      >
                        确认清空
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmWipe(false)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" icon={<FileText size={13} />} onClick={() => setConfirmWipe(true)}>
                      清空语音索引
                    </Button>
                  )}
                  <span className="form-hint" style={{ marginLeft: "auto", marginTop: 0 }}>
                    不删除媒体库中的音频文件
                  </span>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="modal__foot">
          <span className="form-hint" style={{ marginTop: 0 }}>
            设置仅保存在本机
          </span>
          <span className="grow" />
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            保存更改
          </Button>
        </div>
      </div>
    </Modal>
  );
}
