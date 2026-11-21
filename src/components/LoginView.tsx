import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  QrCode,
  Power,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { EnginePhase } from "@/lib/types";
import { Button, cn } from "@/components/ui/primitives";

/** 引擎阶段 → 三步。hint 说的是「这一步要花多久 / 你要做什么」，不是概念解释。 */
const STEPS = [
  { key: "engine", title: "准备引擎", hint: "自动完成，通常十几秒" },
  { key: "scan", title: "扫码登录", hint: "手机 QQ 扫一扫并确认" },
  { key: "ready", title: "同步会话", hint: "登录后自动拉取群聊与好友" },
];

const HEADLINE: Record<string, string> = {
  unavailable: "先准备一下",
  preparing: "正在准备",
  starting: "正在启动",
  awaiting_scan: "用手机 QQ 扫码",
  scanned: "在手机上确认",
  online: "登录好了",
  stopped: "引擎已停止",
  error: "引擎启动失败",
  idle: "准备启动",
};

function stepState(phase: EnginePhase, index: number): "done" | "active" | "todo" | "error" {
  if (phase === "error") {
    return index === 0 ? "error" : "todo";
  }
  if (phase === "online") return "done";
  if (phase === "unavailable" || phase === "preparing") {
    return index === 0 ? (phase === "unavailable" ? "error" : "active") : "todo";
  }
  // starting / awaiting_scan / scanned / stopped / idle
  if (index === 0) return "done";
  if (index === 1) return "active";
  return "todo";
}

export function LoginView() {
  const engine = useApp((state) => state.engine);
  const qr = useApp((state) => state.qr);
  const prepareProgress = useApp((state) => state.prepareProgress);
  const prepareEngine = useApp((state) => state.prepareEngine);
  const refreshQr = useApp((state) => state.refreshQr);
  const startEngine = useApp((state) => state.startEngine);
  const restartEngine = useApp((state) => state.restartEngine);
  const toast = useApp((state) => state.toast);
  const settings = useApp((state) => state.settings);
  const saveSettings = useApp((state) => state.saveSettings);

  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const phase: EnginePhase = engine?.phase ?? "idle";
  const external = settings?.engine.mode === "external";

  useEffect(() => {
    if (showLogs && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [showLogs, engine?.logs.length]);

  // 挂载时先取一次二维码，别等轮询发现版本变化。
  useEffect(() => {
    void refreshQr();
  }, [refreshQr]);

  // 引擎装好了但没在跑：只有开启「随应用自动启动」时才自动拉起。
  useEffect(() => {
    if (autoStarted.current) return;
    if (!engine) return;
    if (engine.mode === "external") return;
    if (!engine.available) return;
    if (engine.phase !== "idle") return;
    if (settings?.engine.autoStart === false) return;
    autoStarted.current = true;
    void startEngine();
  }, [engine, settings?.engine.autoStart, startEngine]);

  const pickDir = async () => {
    if (!isTauri) {
      toast("info", "浏览器预览模式不能选择本机目录");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "选择引擎目录（兼容引擎包或 NapCat）" });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const status = await api.engineAdoptDir(picked);
      useApp.setState({ engine: status });
      await refreshQr();
      toast("success", "已采用这个引擎目录，正在启动");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const pickArchive = async () => {
    if (!isTauri) {
      toast("info", "浏览器预览模式不能选择本机文件");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      title: "选择引擎包（zip）",
      filters: [{ name: "Zip 压缩包", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const status = await api.engineInstallArchive(picked);
      useApp.setState({ engine: status });
      await refreshQr();
      toast("success", "引擎包已导入，正在启动");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const scanLocal = async () => {
    if (!isTauri) {
      toast("info", "浏览器预览模式不扫描本机目录");
      return;
    }
    setBusy(true);
    try {
      const found = await api.engineScan();
      if (found.length === 0) {
        toast(
          "info",
          "没有在下载、桌面、文档和盘符根目录找到现成引擎。可以用指定引擎目录或导入引擎包；也可以到 设置 → 引擎 手动指定。"
        );
        return;
      }
      // 新版 QQ 走 V8 通道；同时找到多份时优先兼容引擎包。
      const picked = found.find((item) => item.kind === "v8") ?? found[0];
      toast("info", `找到 ${found.length} 个引擎，正在使用：${picked.path}`);
      const status = await api.engineAdoptDir(picked.path);
      useApp.setState({ engine: status });
      await refreshQr();
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const runPrepare = async () => {
    setBusy(true);
    try {
      await prepareEngine();
    } catch {
      // toast 已在 store 里发过
    } finally {
      setBusy(false);
    }
  };

  const switchToExternal = async () => {
    if (!settings) return;
    await saveSettings(
      { ...settings, engine: { ...settings.engine, mode: "external" } },
      { silent: true },
    );
    useApp.getState().setSettingsOpen(true);
    toast("info", "已切换为外部 NapCat，请在设置中填写地址");
  };

  const preparing = phase === "preparing" || prepareProgress !== null;
  // 引擎文件不再可用时（包括刚停掉、配置被清空）也回到首次接入界面，
  // 否则界面会停在「引擎已停止」而看不到自动查找/导入入口。
  const needsPrepare =
    phase === "unavailable" ||
    (!!engine && !engine.available && !preparing && phase !== "online");

  return (
    <div className="login">
      <div className="login__card">
        {/* 左：叙事与步骤 */}
        <div className="login__aside">
          <div className="login__brand">
            <div className="login__mark">
              <ScanLine size={18} strokeWidth={2.1} />
            </div>
            <div>
              <div className="login__name">Sylk · 声匣</div>
              <div className="login__tagline">QQ 语音与转写</div>
            </div>
          </div>

          <h1 className="login__h">{HEADLINE[phase] ?? "准备启动"}</h1>
          <p className="login__p">
            {needsPrepare
              ? "Sylk 需要本机的 QQ 客户端与一个兼容引擎。可自动查找本机已有引擎，或指定目录、导入引擎包。"
              : external
                ? "当前使用外部 NapCat。在设置中填写地址与令牌后，这里会显示二维码。"
                : "使用你自己的账号登录。二维码显示在右侧，扫码确认后进入主界面。"}
          </p>

          <ol className="login__steps">
            {STEPS.map((step, index) => {
              const state = stepState(phase, index);
              return (
                <li key={step.key} className={cn("login__step", `is-${state}`)}>
                  <span className="login__dot">
                    {state === "done" ? (
                      <Check size={11} />
                    ) : state === "error" ? (
                      <TriangleAlert size={11} />
                    ) : state === "active" ? (
                      <Loader2 size={11} className="spin" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="login__step-text">
                    <strong>{step.title}</strong>
                    <em>{step.hint}</em>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="login__foot">
            <ShieldAlert size={12} />
            <span>
              引擎仅监听本机 127.0.0.1。语音、转写文本与数据库均保存在本机。
            </span>
          </div>
        </div>

        {/* 右：二维码 */}
        <div className="login__stage">
          {needsPrepare ? (
            <div className="login__prepare">
              <div className="login__prepare-icon">
                <QrCode size={30} strokeWidth={1.6} />
              </div>
              <div className="login__prepare-title">
                {engine?.detail?.startsWith("自动获取失败") ? "无法自动获取引擎" : "尚未配置引擎"}
              </div>
              <div className="login__prepare-text">
                {engine?.detail?.startsWith("自动获取失败")
                  ? "内置下载地址由上游提供，当前不可用。可以用下面任一方式接入已有引擎。"
                  : "先自动查找本机引擎，或用指定目录、导入引擎包的方式接入。兼容引擎包与 NapCat 目录都支持。"}
              </div>
              {engine?.detail?.startsWith("自动获取失败") ? (
                <div className="login__prepare-hint login__prepare-hint--error">
                  {engine.detail.replace("自动获取失败：", "")}
                </div>
              ) : null}
              <Button variant="primary" onClick={() => void scanLocal()} disabled={busy}>
                自动查找本机引擎
              </Button>
              <div className="login__prepare-alt">
                <button type="button" onClick={() => void pickDir()}>
                  指定引擎目录
                </button>
                <span>·</span>
                <button type="button" onClick={() => void pickArchive()}>
                  导入引擎包
                </button>
                <span>·</span>
                <button type="button" onClick={() => void runPrepare()} disabled={busy}>
                  在线下载
                </button>
                <span>·</span>
                <button type="button" onClick={() => void switchToExternal()}>
                  使用外部 NapCat
                </button>
              </div>
            </div>
          ) : preparing ? (
            <div className="login__prepare">
              <div className="login__prepare-icon">
                <Loader2 size={28} className="spin" />
              </div>
              <div className="login__prepare-title">正在准备引擎</div>
              <div className="login__progress">
                <div
                  className="login__progress-fill"
                  style={{ width: `${prepareProgress?.percent ?? 6}%` }}
                />
              </div>
              <div className="login__prepare-text">
                {prepareProgress?.detail ?? "正在获取文件"}
              </div>
            </div>
          ) : phase === "error" || phase === "stopped" ? (
            <div className="login__prepare">
              <div className={cn("login__prepare-icon", phase === "error" && "is-error")}>
                {phase === "error" ? (
                  <TriangleAlert size={26} strokeWidth={1.7} />
                ) : (
                  <Power size={26} strokeWidth={1.7} />
                )}
              </div>
              <div className="login__prepare-title">
                {phase === "stopped" ? "引擎已停止" : "引擎启动失败"}
              </div>
              <div className="login__prepare-text">{engine?.detail}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="primary" onClick={() => void startEngine()}>
                  启动引擎
                </Button>
                {phase === "error" ? (
                  <Button variant="ghost" onClick={() => void runPrepare()}>
                    重新获取
                  </Button>
                ) : null}
              </div>
              {!engine?.qqFound ? (
                <div className="login__prepare-hint">
                  未检测到 QQ NT。引擎依赖本机安装的 QQ，请先安装
                  <button
                    type="button"
                    className="login__link"
                    onClick={() => {
                      void import("@tauri-apps/plugin-opener")
                        .then(({ openUrl }) => openUrl("https://im.qq.com/"))
                        .catch(() => toast("info", "https://im.qq.com/"));
                    }}
                  >
                    im.qq.com
                  </button>
                  后重试。
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="login__qr-frame">
                {qr?.dataUrl ? (
                  <img src={qr.dataUrl} alt="QQ 登录二维码" className="login__qr" />
                ) : (
                  <div className="login__qr-empty">
                    <Loader2 size={22} className="spin" />
                    <span>
                      {phase === "scanned"
                        ? "已扫码，请在手机上确认"
                        : phase === "online"
                          ? "登录完成"
                          : engine?.detail?.includes("二维码已过期")
                            ? "二维码已过期。点下方刷新二维码重新生成。"
                            : "正在生成二维码"}
                    </span>
                  </div>
                )}
                {phase === "scanned" ? (
                  <div className="login__qr-veil">
                    <Smartphone size={22} />
                    <strong>已扫码</strong>
                    <span>请在手机上确认登录</span>
                  </div>
                ) : null}
                {phase === "online" ? (
                  <div className="login__qr-veil is-ok">
                    <Check size={24} />
                    <strong>登录成功</strong>
                    <span>{engine?.account?.nickname ?? ""}，正在同步会话…</span>
                  </div>
                ) : null}
              </div>

              <div className="login__qr-foot">
                <button
                  type="button"
                  className="login__link"
                  onClick={() => {
                    // 二维码由引擎生成，本地只有缓存图；过期后需要重启引擎换新码。
                    void restartEngine();
                  }}
                  title="重启引擎并生成新的二维码"
                >
                  <RefreshCw size={11} />
                  刷新二维码
                </button>
                <span className="login__qr-hint">
                  {phase === "awaiting_scan" ? "手机 QQ 扫一扫" : engine?.detail}
                </span>
              </div>
            </>
          )}

          {engine && (engine.logs.length > 0 || engine.uptime > 0) ? (
            <div className="login__logs">
              <button
                type="button"
                className="login__logs-toggle"
                onClick={() => setShowLogs(!showLogs)}
                aria-expanded={showLogs}
              >
                <ChevronDown size={12} className={cn("chev", showLogs && "is-open")} />
                引擎日志
                <span className="login__logs-meta">
                  {engine.pid ? `PID ${engine.pid}` : "未运行"}
                  {engine.uptime > 0 ? ` · ${formatDuration(engine.uptime * 1000)}` : ""}
                  {engine.httpPort ? ` · 127.0.0.1:${engine.httpPort}` : ""}
                </span>
              </button>
              {showLogs ? (
                <div className="login__logs-body" ref={logRef}>
                  {engine.logs.map((line, index) => (
                    <div className="login__log-line" key={`${index}-${line.slice(0, 12)}`}>
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!needsPrepare && phase !== "online" && phase !== "error" ? (
            <div className="login__actions">
              <button type="button" className="login__link" onClick={() => void pickDir()}>
                更换引擎目录
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
