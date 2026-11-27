import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  QrCode,
  Power,
  RefreshCw,
  ScanLine,
  Smartphone,
  TriangleAlert,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { EnginePhase } from "@/lib/types";
import { Button, cn } from "@/components/ui/primitives";

const HEADLINE: Record<string, string> = {
  unavailable: "接入引擎",
  preparing: "正在准备",
  starting: "正在启动",
  awaiting_scan: "扫码登录",
  scanned: "请在手机上确认",
  online: "登录成功",
  stopped: "引擎未启动",
  error: "无法启动引擎",
  idle: "准备中",
};

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

  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);

  const phase: EnginePhase = engine?.phase ?? "idle";
  const external = settings?.engine.mode === "external";

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
      <div className={cn("login__card", (preparing || (!needsPrepare && (phase === "error" || phase === "stopped"))) && "is-status")}>
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
              ? "选择一个已有引擎。"
              : external
                ? "连接外部 NapCat 后展示二维码。"
                : "打开手机 QQ 扫一扫。"}
          </p>
        </div>

        {/* 右：二维码 */}
        <div className="login__stage">
          {needsPrepare ? (
            <div className="login__prepare is-compact">
              <div className="login__prepare-icon">
                <QrCode size={30} strokeWidth={1.6} />
              </div>
              <div className="login__prepare-title">
                {engine?.detail?.startsWith("自动获取失败") ? "无法在线下载" : "尚未配置引擎"}
              </div>
              <div className="login__prepare-text">
                {engine?.detail?.startsWith("自动获取失败")
                  ? "下载源暂不可用，请使用本地引擎。"
                  : "选择本机已有的引擎目录或安装包。"}
              </div>
              {engine?.detail?.startsWith("自动获取失败") ? (
                <div className="login__prepare-hint login__prepare-hint--error">
                  {engine.detail.replace("自动获取失败：", "")}
                </div>
              ) : null}
              <Button variant="primary" onClick={() => void scanLocal()} disabled={busy}>
                自动查找引擎
              </Button>
              <div className="login__prepare-alt">
                <button type="button" onClick={() => void pickDir()}>
                  指定目录
                </button>
                <span>·</span>
                <button type="button" onClick={() => void pickArchive()}>
                  导入 zip
                </button>
                <span>·</span>
                <button type="button" onClick={() => void switchToExternal()}>
                  外部 NapCat
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
                {phase === "stopped" ? "引擎未启动" : "启动失败"}
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
                  未检测到 QQ，
                  <button
                    type="button"
                    className="login__link"
                    onClick={() => {
                      void import("@tauri-apps/plugin-opener")
                        .then(({ openUrl }) => openUrl("https://im.qq.com/"))
                        .catch(() => toast("info", "https://im.qq.com/"));
                    }}
                  >
                    前往下载
                  </button>
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
