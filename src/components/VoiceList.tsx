import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  Star,
  History,
  FolderDown,
  RefreshCw,
  FileText,
  Play,
  Pause,
  StickyNote,
  CheckSquare,
  Square,
  X,
  Trash2,
  ListChecks,
  PanelRightOpen,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { formatClock, formatDuration, formatTime, groupByDay } from "@/lib/format";
import { usePlayer } from "@/lib/player";
import { useApp, type RangeKey } from "@/lib/store";
import type { Voice } from "@/lib/types";
import { Avatar, Badge, Button, IconButton, cn } from "@/components/ui/primitives";
import { Waveform } from "@/components/Waveform";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "today", label: "今天" },
  { key: "week", label: "7 天" },
  { key: "month", label: "30 天" },
];

export function VoiceList() {
  const conversations = useApp((state) => state.conversations);
  const activeId = useApp((state) => state.activeConversationId);
  const voices = useApp((state) => state.voices);
  const total = useApp((state) => state.total);
  const keyword = useApp((state) => state.keyword);
  const onlyStarred = useApp((state) => state.onlyStarred);
  const onlyTranscribed = useApp((state) => state.onlyTranscribed);
  const range = useApp((state) => state.range);
  const senderFilter = useApp((state) => state.senderFilter);
  const senderLabel = useApp((state) => state.senderFilterLabel);
  const selectMode = useApp((state) => state.selectMode);
  const selected = useApp((state) => state.selected);
  const setKeyword = useApp((state) => state.setKeyword);
  const setFilter = useApp((state) => state.setFilter);
  const resetFilters = useApp((state) => state.resetFilters);
  const toggleSelectMode = useApp((state) => state.toggleSelectMode);
  const selectAllVisible = useApp((state) => state.selectAllVisible);
  const clearSelected = useApp((state) => state.clearSelected);
  const bulkStar = useApp((state) => state.bulkStar);
  const bulkDelete = useApp((state) => state.bulkDelete);
  const bulkTranscribe = useApp((state) => state.bulkTranscribe);
  const selectVoice = useApp((state) => state.selectVoice);
  const activeVoiceId = useApp((state) => state.activeVoiceId);
  const syncHistory = useApp((state) => state.syncHistory);
  const connection = useApp((state) => state.connection);
  const toast = useApp((state) => state.toast);
  const activity = useApp((state) => state.progress);
  const detailOpen = useApp((state) => state.detailOpen);
  const setDetailOpen = useApp((state) => state.setDetailOpen);
  const scope = useApp((state) => state.scope);

  const conversation = conversations.find((item) => item.id === activeId) ?? null;
  const groups = useMemo(() => groupByDay(voices), [voices]);
  // 优先用筛选时记下的名字，列表空了也能显示对人
  const senderName = senderLabel || senderFilter;

  const filtered = Boolean(keyword || onlyStarred || onlyTranscribed || senderFilter || range !== "all");
  const [exporting, setExporting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const exportBundle = async () => {
    if (!conversation || exporting) return;
    setExporting(true);
    try {
      let target: string | undefined;
      if (isTauri) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true, title: "选择导出目录" });
        if (!picked) return;
        target = typeof picked === "string" ? picked : picked[0];
      }
      const report = await api.exportConversation(conversation.id, target);
      toast("success", `已导出 ${report.files} 个文件 → ${report.path}`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  };

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await syncHistory(10);
    } finally {
      setSyncing(false);
    }
  };

  // 跨会话视图：不依赖某个会话
  const crossConversation = scope === "all";

  if (!conversation && !crossConversation) {
    return (
      <div className="main">
        <div className="empty">
          <EmptyArt />
          <div className="empty__title">选择一个会话</div>
          <div className="empty__text">在左侧选择一个群聊或好友。</div>
        </div>
      </div>
    );
  }

  const name = crossConversation
    ? senderName
      ? `${senderName} · 全部会话`
      : "全部会话"
    : (conversation?.remark || conversation?.title || "");
  const online = connection.status === "online";

  return (
    <div className={cn("main", detailOpen && "has-detail")}>
      <header className="main__head">
        <Avatar name={name} src={conversation?.avatar} size="lg" />
        <div className="main__titles">
          <div className="main__title">
            {name}
            {crossConversation ? (
              <Badge kind="group">跨会话</Badge>
            ) : conversation ? (
              <Badge kind={conversation.kind}>
                {conversation.kind === "group" ? "群聊" : "好友"}
              </Badge>
            ) : null}
          </div>
          <div className="main__sub">
            {crossConversation
              ? `${total} 条 · ${new Set(voices.map((v) => v.conversationId)).size} 个会话`
              : conversation
                ? `${conversation.voiceCount} 条 · ${formatDuration(conversation.totalMs)}${
                    conversation.kind === "group" && conversation.memberCount > 0
                      ? ` · ${conversation.memberCount} 人`
                      : ""
                  }`
                : ""}
          </div>
        </div>
        <div className="main__actions">
          {crossConversation ? null : (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={<History size={13.5} className={syncing ? "spin" : undefined} />}
                disabled={!online || syncing}
                onClick={() => void runSync()}
                title="同步这个会话的历史语音"
              >
                {syncing ? "同步中" : "同步"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<FolderDown size={13.5} />}
                disabled={(conversation?.voiceCount ?? 0) === 0 || exporting}
                onClick={() => void exportBundle()}
                title="导出音频、文字稿与 HTML"
              >
                {exporting ? "导出中" : "导出"}
              </Button>
            </>
          )}
          <IconButton label="展开详情（E）" onClick={() => setDetailOpen(true)}>
            <PanelRightOpen size={16} />
          </IconButton>
        </div>
      </header>

      {activity && !activity.done ? (
        <div className="notice">
          <RefreshCw size={12} className="spin" />
          <span>{activity.label}</span>
          <span className="tabular notice__count">
            {activity.current} / {activity.total}
          </span>
        </div>
      ) : null}

      <div className="toolbar">
        <div className="search-field toolbar__grow">
          <Search size={13} color="var(--text-3)" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索"
            aria-label="搜索语音"
          />
          {keyword ? (
            <button
              type="button"
              className="search-field__clear"
              aria-label="清空搜索"
              onClick={() => setKeyword("")}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        <div className="toolbar__group" role="group" aria-label="时间范围">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={cn("seg", range === item.key && "is-on")}
              onClick={() => setFilter({ range: item.key })}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={cn("chip", onlyStarred && "is-on")}
          onClick={() => setFilter({ onlyStarred: !onlyStarred })}
          aria-pressed={onlyStarred}
          aria-label="只看星标"
          title="只看星标"
        >
          <Star size={12} />
          <span className="chip__label">星标</span>
        </button>
        <button
          type="button"
          className={cn("chip", onlyTranscribed && "is-on")}
          onClick={() => setFilter({ onlyTranscribed: !onlyTranscribed })}
          aria-pressed={onlyTranscribed}
          aria-label="只看已转写的"
          title="只看已转写的"
        >
          <FileText size={12} />
          <span className="chip__label">已转写</span>
        </button>

        <button
          type="button"
          className={cn("icon-btn", selectMode && "is-on")}
          title={selectMode ? "退出多选" : "多选"}
          aria-label="多选"
          aria-pressed={selectMode}
          onClick={() => toggleSelectMode()}
        >
          <CheckSquare size={15} />
        </button>
      </div>

      {senderFilter || filtered ? (
        <div className="filter-bar">
          {senderFilter ? (
            <span className="filter-tag">
              {senderName}
              <button
                type="button"
                aria-label="清除发送者筛选"
                onClick={() => setFilter({ senderFilter: "" })}
              >
                <X size={10} />
              </button>
            </span>
          ) : null}
          <span className="filter-bar__count">
            {voices.length === total ? `${total} 条` : `${voices.length} / ${total} 条`}
          </span>
          <button type="button" className="filter-bar__reset" onClick={() => resetFilters()}>
            清除筛选
          </button>
        </div>
      ) : null}

      {selectMode ? (
        <div className="bulk-bar">
          <span className="bulk-bar__count">已选 {selected.size} 条</span>
          <Button size="sm" variant="ghost" onClick={() => selectAllVisible()}>
            全选
          </Button>
          <Button size="sm" variant="ghost" onClick={() => clearSelected()}>
            取消
          </Button>
          <span className="bulk-bar__grow" />
          <Button
            size="sm"
            variant="ghost"
            icon={<Star size={12} />}
            disabled={selected.size === 0}
            onClick={() => void bulkStar(true)}
          >
            星标
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ListChecks size={12} />}
            disabled={selected.size === 0}
            onClick={() => void bulkTranscribe()}
          >
            转写
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={12} />}
            disabled={selected.size === 0}
            onClick={() => {
              if (selected.size === 0) return;
              const confirmed = window.confirm(
                `删除所选 ${selected.size} 条语音？音频原件和转写会一并删除，无法恢复。`,
              );
              if (confirmed) void bulkDelete();
            }}
          >
            删除
          </Button>
        </div>
      ) : null}

      {voices.length === 0 ? (
        <div className="empty">
          <EmptyArt />
          <div className="empty__title">{filtered ? "没有匹配结果" : "还没有语音"}</div>
          {!filtered ? (
            <div className="empty__text">{online ? "同步这个会话开始收集。" : "引擎未连接。"}</div>
          ) : null}
        </div>
      ) : (
        <div className="voice-list" role="listbox" aria-label="语音列表">
          {groups.map((group) => (
            <section key={group.key}>
              <div className="day-head">
                {group.label}
                <span className="day-head__line" />
              </div>
              {group.items.map((voice) => (
                <VoiceRow
                  key={voice.id}
                  voice={voice}
                  active={voice.id === activeVoiceId}
                  selectMode={selectMode}
                  selected={selected.has(voice.id)}
                  onSelect={() => {
                    if (selectMode) useApp.getState().toggleSelected(voice.id);
                    else selectVoice(voice.id);
                  }}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function VoiceRow({
  voice,
  active,
  selectMode,
  selected,
  onSelect,
}: {
  voice: Voice;
  active: boolean;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const playingId = usePlayer((state) => state.voiceId);
  const playing = usePlayer((state) => state.playing);
  const toggle = usePlayer((state) => state.toggle);
  const updateVoice = useApp((state) => state.updateVoice);
  const isPlaying = playingId === voice.id && playing;
  const rowRef = useRef<HTMLElement | null>(null);

  // 用键盘选中时把行滚进视野
  useEffect(() => {
    if (active) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const transcriptLine =
    voice.transcriptStatus === "running"
      ? "正在转写…"
      : voice.transcriptStatus === "failed"
        ? `转写失败：${voice.transcriptError || "原因不明"}`
        : voice.transcript || "";

  return (
    <article
      ref={rowRef}
      className={cn("voice-row", active && "is-active", selected && "is-selected")}
      onClick={onSelect}
      onDoubleClick={() => {
        if (voice.playable && !selectMode) toggle(voice.id);
      }}
      role="option"
      aria-selected={selected || active}
      tabIndex={-1}
    >
      {selectMode ? (
        <span className="voice-row__check" aria-hidden="true">
          {selected ? <CheckSquare size={16} /> : <Square size={16} />}
        </span>
      ) : (
        <button
          type="button"
          className="play-btn"
          disabled={!voice.playable}
          title={voice.playable ? "播放" : "音频未下载"}
          aria-label={isPlaying ? "暂停" : "播放"}
          onClick={(event) => {
            event.stopPropagation();
            if (voice.playable) toggle(voice.id);
          }}
        >
          {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
      )}

      <div className="voice-row__body">
        <div className="voice-row__top">
          <span className="voice-row__name">{voice.senderName || "未知发送者"}</span>
          <span className="voice-row__time">{formatTime(voice.sentAt)}</span>
          {voice.tags.slice(0, 1).map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
          <span className="voice-row__dur">{formatClock(voice.durationMs)}</span>
        </div>

        <div className="voice-row__wave">
          <Waveform
            peaks={voice.peaks}
            bars={44}
            height={20}
            progress={0}
            className="player__wave"
            dimmed={!voice.playable}
          />
        </div>

        {transcriptLine ? (
          <div className={cn("voice-row__text", !voice.transcript && "is-empty")}>{transcriptLine}</div>
        ) : null}
      </div>

      <div className="voice-row__side">
        {voice.note ? (
          <span className="voice-row__flag" title={voice.note}>
            <StickyNote size={13} />
          </span>
        ) : null}
        <button
          type="button"
          className={cn("icon-btn icon-btn--sm", voice.starred && "is-gold")}
          title={voice.starred ? "取消星标" : "加星标"}
          aria-label={voice.starred ? "取消星标" : "加星标"}
          aria-pressed={voice.starred}
          onClick={(event) => {
            event.stopPropagation();
            void updateVoice(voice.id, { starred: !voice.starred });
          }}
        >
          <Star size={14} fill={voice.starred ? "currentColor" : "none"} />
        </button>
      </div>
    </article>
  );
}

function EmptyArt() {
  return (
    <svg className="empty__art" viewBox="0 0 132 108" fill="none" aria-hidden="true">
      <rect x="14" y="18" width="104" height="72" rx="12" stroke="var(--border-strong)" strokeWidth="1.5" />
      <rect x="26" y="34" width="6" height="22" rx="3" fill="var(--accent)" opacity="0.24" />
      <rect x="38" y="26" width="6" height="38" rx="3" fill="var(--accent)" opacity="0.4" />
      <rect x="50" y="20" width="6" height="50" rx="3" fill="var(--accent)" opacity="0.6" />
      <rect x="62" y="30" width="6" height="30" rx="3" fill="var(--accent)" opacity="0.4" />
      <rect x="74" y="38" width="6" height="14" rx="3" fill="var(--accent)" opacity="0.24" />
      <circle cx="96" cy="76" r="12" stroke="var(--border-strong)" strokeWidth="1.5" />
      <path d="M96 70v7l5 3" stroke="var(--text-3)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
