import { useCallback, useEffect, useRef } from "react";

import { api, isTauri } from "@/lib/api";
import { usePlayer } from "@/lib/player";
import { bytesToBase64, silkToWav } from "@/lib/silk";
import { useApp } from "@/lib/store";
import type { ConnectionState, EngineProgress, EngineStatus, ProgressEvent } from "@/lib/types";
import { ConversationList } from "@/components/ConversationList";
import { DetailPanel } from "@/components/DetailPanel";
import { JobsView } from "@/components/JobsView";
import { LoginView } from "@/components/LoginView";
import { PlayerBar } from "@/components/PlayerBar";
import { Rail } from "@/components/Rail";
import { SearchPalette } from "@/components/SearchPalette";
import { SettingsPanel } from "@/components/SettingsPanel";
import { StatsView } from "@/components/StatsView";
import { Toasts } from "@/components/Toasts";
import { VoiceList } from "@/components/VoiceList";

export default function App() {
  const booted = useApp((state) => state.booted);
  const view = useApp((state) => state.view);
  const theme = useApp((state) => state.theme);
  const density = useApp((state) => state.density);
  const progress = useApp((state) => state.progress);
  const engine = useApp((state) => state.engine);
  const detailOpen = useApp((state) => state.detailOpen);
  const settings = useApp((state) => state.settings);
  const playerVoiceId = usePlayer((state) => state.voiceId);
  const bootstrap = useApp((state) => state.bootstrap);
  const setProgress = useApp((state) => state.setProgress);
  const refreshEngine = useApp((state) => state.refreshEngine);
  const setDetailOpen = useApp((state) => state.setDetailOpen);

  const decoding = useRef<Set<number>>(new Set());

  const decodeOne = useCallback(async (id: number) => {
    if (decoding.current.has(id)) return;
    decoding.current.add(id);
    try {
      const raw = await api.readVoiceBase64(id);
      if (raw.kind !== "silk") return;
      const decoded = await silkToWav(raw.data);
      await api.saveDecoded(id, bytesToBase64(decoded.wav), decoded.sampleRate);
      await useApp.getState().refreshVoices();
    } catch (error) {
      console.warn("SILK 解码失败", error);
      useApp.getState().toast("error", "有一条 SILK 语音解码失败，已保留原件");
    } finally {
      decoding.current.delete(id);
    }
  }, []);

  // 空壳画出来就上报：这是用户眼里「窗口有东西了」的那一刻
  useEffect(() => {
    requestAnimationFrame(() => {
      void api.reportReady?.().catch(() => {});
    });
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 折叠状态回写到设置，下次打开还是这个样子
  useEffect(() => {
    if (!settings || settings.ui.showDetail === detailOpen) return;
    const timer = window.setTimeout(() => {
      const current = useApp.getState().settings;
      if (!current) return;
      void useApp
        .getState()
        .saveSettings({ ...current, ui: { ...current.ui, showDetail: detailOpen } }, { silent: true });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [detailOpen, settings]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => useApp.getState().applySystemTheme();
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  // 窗口窄到放不下三栏时，详情面板默认收起，改成点按钮打开的覆盖式抽屉。
  // 必须等设置加载完再判断，否则会被 bootstrap 回填的 showDetail 覆盖。
  const narrowDetailInit = useRef(false);
  useEffect(() => {
    if (!settings || narrowDetailInit.current) return;
    narrowDetailInit.current = true;
    if (window.matchMedia("(max-width: 1150px)").matches) {
      useApp.getState().setDetailOpen(false);
    }
  }, [settings]);

  // 引擎状态轮询：没登录时看紧一点，登录后只做心跳。
  const loggedIn = engine?.mode === "external" || engine?.phase === "online";
  useEffect(() => {
    if (!booted) return;
    const timer = window.setInterval(() => void refreshEngine(), loggedIn ? 8000 : 2000);
    return () => window.clearInterval(timer);
  }, [booted, loggedIn, refreshEngine]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      // 键盘焦点在按钮/链接/开关/输入框上时，Space 和 Enter 属于控件自己，
      // 不能抢去控制播放器；否则设置页和弹窗里的按钮按空格无法激活。
      const interactive = target?.closest(
        "button, a, input, textarea, select, [role='switch'], [role='tab'], [contenteditable='true']",
      );
      const appState = useApp.getState();

      if ((event.ctrlKey || event.metaKey) && ["k", "f"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        appState.setSearchOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (appState.settingsOpen || appState.searchOpen) return; // 由弹窗自己处理
        appState.setSearchOpen(false);
        return;
      }
      if (typing || interactive) return;
      if (appState.settingsOpen || appState.searchOpen) return;

      const app = appState;
      const player = usePlayer.getState();

      if (event.code === "Space") {
        event.preventDefault();
        if (app.selectMode) {
          if (app.activeVoiceId) app.toggleSelected(app.activeVoiceId);
          return;
        }
        if (player.voiceId) player.setPlaying(!player.playing);
        return;
      }

      // 左右键换播放器里的上/下一条
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const list = app.voices;
        if (!player.voiceId || list.length === 0) return;
        const index = list.findIndex((voice) => voice.id === player.voiceId);
        const next = list[index + (event.key === "ArrowRight" ? 1 : -1)];
        if (next) {
          event.preventDefault();
          player.play(next.id);
          app.selectVoice(next.id);
        }
        return;
      }

      // 语音列表上下移动；Enter 播放，S 星标，多选态下 Space 勾选
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (app.selectMode) return;
        const list = app.voices;
        if (list.length === 0) return;
        event.preventDefault();
        const current = list.findIndex((voice) => voice.id === app.activeVoiceId);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = current < 0 ? 0 : Math.min(list.length - 1, Math.max(0, current + delta));
        if (current < 0) app.selectVoice(list[0].id);
        else if (next !== current) app.selectVoice(list[next].id);
        return;
      }

      const active = app.voices.find((voice) => voice.id === app.activeVoiceId);
      if (!active) return;

      if (event.key === "Enter") {
        event.preventDefault();
        if (active.playable) player.toggle(active.id);
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void app.updateVoice(active.id, { starred: !active.starred });
        return;
      }
      if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        app.setDetailOpen(!app.detailOpen);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // 后端事件
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    let voiceTimer: number | undefined;

    const scheduleVoices = () => {
      window.clearTimeout(voiceTimer);
      voiceTimer = window.setTimeout(() => {
        void useApp.getState().refreshVoices();
        void useApp.getState().refreshConversations();
        void useApp.getState().loadStats();
      }, 350);
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const add = async <T,>(name: string, handler: (payload: T) => void) => {
        const un = await listen<T>(name, (event) => handler(event.payload));
        if (disposed) un();
        else unlisteners.push(un);
      };

      await add<ProgressEvent>("sylk://progress", (payload) => {
        setProgress(payload);
        if (payload.done) {
          scheduleVoices();
          void useApp.getState().loadJobs();
        }
      });
      await add<ConnectionState>("sylk://connection", (payload) => {
        useApp.setState({ connection: payload });
      });
      await add<EngineStatus>("sylk://engine", (payload) => {
        useApp.getState().setEngine(payload);
      });
      await add<EngineProgress>("sylk://engine-prepare", (payload) => {
        useApp.getState().setPrepareProgress(payload.stage === "done" ? null : payload);
      });
      await add<{ uin: string; nickname: string }>("sylk://engine-ready", () => {
        const current = useApp.getState();
        void current.connect();
        if (current.settings && !current.settings.onboarded) {
          // 登录成功即视为完成引导，不再多走一步。
          void current.saveSettings({ ...current.settings, onboarded: true }, { silent: true });
        }
      });
      await add<{ reason?: string }>("sylk://voices", () => scheduleVoices());
      await add<unknown>("sylk://jobs", () => void useApp.getState().loadJobs());
      await add<{ kind: "info" | "success" | "error"; text: string }>("sylk://toast", (payload) => {
        useApp.getState().toast(payload.kind, payload.text);
      });
      await add<{ voiceId: number }>("sylk://decode", (payload) => {
        void decodeOne(payload.voiceId);
      });

      const pending = await api.pendingDecode().catch(() => []);
      for (const id of pending) {
        void decodeOne(id);
      }
    })();

    return () => {
      disposed = true;
      window.clearTimeout(voiceTimer);
      for (const un of unlisteners) un();
    };
  }, [decodeOne, setProgress]);

  if (!booted) {
    return (
      <div className="app">
        <div className="empty" style={{ height: "100%" }}>
          <div className="empty__title">正在打开你的语音档案…</div>
          <div className="empty__text">读取本地索引，第一次启动会慢一点。</div>
        </div>
      </div>
    );
  }

  const showLogin = engine !== null && engine.mode !== "external" && engine.phase !== "online";

  return (
    <div className="app" data-density={density} data-detail={detailOpen ? "on" : "off"}>
      {!isTauri ? (
        <div className="demo-banner">
          <strong>预览模式</strong>
          <span>当前界面使用内置演示数据，音频不可播放；桌面版会连接你真实的 QQ 账号。</span>
        </div>
      ) : null}

      {progress && !progress.done ? (
        <div className="progress-line">
          <div
            className="progress-line__fill"
            style={{
              width: `${progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 30}%`,
            }}
          />
        </div>
      ) : null}

      {showLogin ? (
        <div className="app__body">
          <Rail minimal />
          <LoginView />
        </div>
      ) : (
        <div className="app__body">
          <Rail />
          <ConversationList />
          {view === "voices" ? (
            <>
              <VoiceList />
              {detailOpen ? (
                <>
                  <div
                    className="detail-backdrop"
                    aria-hidden="true"
                    onClick={() => setDetailOpen(false)}
                  />
                  <DetailPanel />
                </>
              ) : null}
            </>
          ) : view === "stats" ? (
            <StatsView />
          ) : (
            <JobsView />
          )}
        </div>
      )}

      {showLogin || !playerVoiceId ? null : <PlayerBar />}
      <SearchPalette />
      <SettingsPanel />
      <Toasts />
    </div>
  );
}
