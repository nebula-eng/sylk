import { useState } from "react";
import {
  CircleAlert,
  FolderOpen,
  Loader2,
  LogOut,
  Power,
  RefreshCw,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { EnginePhase, Settings } from "@/lib/types";
import { Button, Field, Segmented, Switch, cn } from "@/components/ui/primitives";

const PHASE_LABEL: Record<EnginePhase, string> = {
  unavailable: "未安装",
  idle: "未启动",
  preparing: "准备中",
  starting: "启动中",
  awaiting_scan: "等待扫码",
  scanned: "已扫码",
  online: "已登录",
  stopped: "已停止",
  error: "异常",
};

function phaseTone(phase: EnginePhase): "ok" | "busy" | "bad" | "idle" {
  if (phase === "online") return "ok";
  if (phase === "error") return "bad";
  if (phase === "preparing" || phase === "starting" || phase === "awaiting_scan" || phase === "scanned") {
    return "busy";
  }
  return "idle";
}

export function EnginePanel({
  draft,
  patch,
}: {
  draft: Settings;
  patch: (next: Partial<Settings>) => void;
}) {
  const engine = useApp((state) => state.engine);
  const prepareEngine = useApp((state) => state.prepareEngine);
  const restartEngine = useApp((state) => state.restartEngine);
  const stopEngine = useApp((state) => state.stopEngine);
  const logoutEngine = useApp((state) => state.logoutEngine);
  const toast = useApp((state) => state.toast);

  const [busy, setBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const phase = engine?.phase ?? "idle";
  const tone = phaseTone(phase);
  const embedded = draft.engine.mode !== "external";

  const patchEngine = (next: Partial<Settings["engine"]>) =>
    patch({ engine: { ...draft.engine, ...next } });

  const run = async (action: () => Promise<unknown>, label: string) => {
    setBusy(true);
    try {
      await action();
      toast("success", label);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const pickDir = async () => {
    if (!isTauri) {
      toast("info", "浏览器预览模式不支持选择本机目录");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: "选择 NapCat 目录" });
    if (typeof picked !== "string") return;
    await run(async () => {
      const status = await api.engineAdoptDir(picked);
      useApp.setState({ engine: status });
      patchEngine({ napcatDir: picked });
    }, "已采用这个目录");
  };

  return (
    <>
      <div className="engine-card">
        <div className="engine-card__head">
          <span className={cn("engine-dot", `is-${tone}`)} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="engine-card__title">
              内嵌引擎
              <span className={cn("engine-pill", `is-${tone}`)}>{PHASE_LABEL[phase]}</span>
            </div>
            <div className="engine-card__sub">
              {engine?.account?.nickname
                ? `${engine.account.nickname}${engine.uptime ? ` · ${formatDuration(engine.uptime * 1000)}` : ""}`
                : engine?.detail || "未启动"}
            </div>
          </div>
          {tone === "busy" ? <Loader2 size={16} className="spin" color="var(--accent)" /> : null}
        </div>

        {engine?.httpPort ? (
          <div className="engine-card__ports">
            <span>
              接口 <code>127.0.0.1:{engine.httpPort}</code>
            </span>
            <span>
              事件 <code>127.0.0.1:{engine.wsPort}</code>
            </span>
            <span className="engine-card__hint">端口从 13700 起找空位，令牌每次随机</span>
          </div>
        ) : null}

        <div className="engine-card__actions">
          {phase === "online" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={13} />}
                disabled={busy}
                onClick={() => void run(restartEngine, "引擎已重启")}
              >
                重启
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<LogOut size={13} />}
                disabled={busy}
                onClick={() => void run(logoutEngine, "已退出登录")}
              >
                退出
              </Button>
            </>
          ) : phase === "unavailable" ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Power size={13} />}
              disabled={busy}
              onClick={() => void run(prepareEngine, "引擎已就绪")}
            >
              下载并启动
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={<Power size={13} />}
                disabled={busy}
                onClick={() => void run(restartEngine, "引擎已重启")}
              >
                重启
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<CircleAlert size={13} />}
                disabled={busy}
                onClick={() => void run(stopEngine, "引擎已停止")}
              >
                停止
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderOpen size={13} />}
            onClick={() =>
              void run(async () => {
                await api.engineOpenDir();
              }, "已打开引擎目录")
            }
          >
            目录
          </Button>
          <button
            type="button"
            className="link-btn"
            style={{ marginLeft: "auto" }}
            onClick={() => setShowLogs(!showLogs)}
          >
            {showLogs ? "收起" : "日志"}
          </button>
        </div>

        {showLogs ? (
          <div className="engine-logs">
            {engine?.logs.length ? (
              engine.logs.map((line, index) => (
                <div className="engine-log-line" key={`${index}-${line.slice(0, 10)}`}>
                  {line}
                </div>
              ))
            ) : (
              <div className="engine-log-line" style={{ color: "var(--text-3)" }}>
                暂无日志
              </div>
            )}
          </div>
        ) : null}
      </div>

      <Field
        label="接入方式"
        hint="内嵌引擎由 Sylk 安装与托管；已有 NapCat 时可直接连接"
      >
        <Segmented
          value={draft.engine.mode}
          onChange={(value) => patchEngine({ mode: value })}
          options={[
            { value: "embedded", label: "内嵌引擎" },
            { value: "external", label: "外部 NapCat" },
          ]}
        />
      </Field>

      {embedded ? (
        <>
          <Field
            label="引擎目录"
            hint="留空使用默认位置；也可指向已有的 NapCat 目录"
          >
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input input--mono"
                value={draft.engine.napcatDir}
                placeholder="（默认位置）"
                onChange={(event) => patchEngine({ napcatDir: event.target.value })}
              />
              <Button variant="ghost" onClick={() => void pickDir()}>
                选择
              </Button>
            </div>
          </Field>

          <Field
            label="QQ NT 安装目录"
            hint="留空自动检测。引擎依赖本机安装的 QQ NT"
          >
            <input
              className="input input--mono"
              value={draft.engine.qqPath}
              placeholder="（自动检测）"
              onChange={(event) => patchEngine({ qqPath: event.target.value })}
            />
          </Field>

          <Field label="Node 运行时" hint="整合包已自带，仅在纯 Node 版 NapCat 下需要指定">
            <input
              className="input input--mono"
              value={draft.engine.nodePath}
              placeholder="（自动查找）"
              onChange={(event) => patchEngine({ nodePath: event.target.value })}
            />
          </Field>

          <Field label="引擎下载地址" hint="留空使用内置地址；自动获取失败时可填自有镜像">
            <input
              className="input input--mono"
              value={draft.engine.downloadUrl}
              placeholder="https://…/NapCat.Shell.zip"
              onChange={(event) => patchEngine({ downloadUrl: event.target.value })}
            />
          </Field>

          <div className="form-row form-row--inline">
            <div style={{ flex: 1 }}>
              <div className="form-label" style={{ marginBottom: 2 }}>
                随应用自动启动
              </div>
              <div className="form-hint" style={{ marginTop: 0 }}>
                关闭后需手动启动引擎
              </div>
            </div>
            <Switch
              label="自动启动引擎"
              checked={draft.engine.autoStart}
              onChange={(value) => patchEngine({ autoStart: value })}
            />
          </div>

          <div className="form-row form-row--inline">
            <div style={{ flex: 1 }}>
              <div className="form-label" style={{ marginBottom: 2 }}>
                登录后自动同步语音
              </div>
              <div className="form-hint" style={{ marginTop: 0 }}>
                登录后拉取每个会话最近一页语音，放进下载任务；关闭后只同步会话列表
              </div>
            </div>
            <Switch
              label="自动同步"
              checked={draft.engine.autoSync}
              onChange={(value) => patchEngine({ autoSync: value })}
            />
          </div>
        </>
      ) : (
        <div className="form-hint" style={{ lineHeight: 1.75 }}>
          外部模式下 Sylk 不启动或停止任何进程，只连接设置页中填写的地址。
        </div>
      )}
    </>
  );
}
