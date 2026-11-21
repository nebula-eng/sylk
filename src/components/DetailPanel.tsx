import { useEffect, useState } from "react";
import {
  X,
  Play,
  Pause,
  Copy,
  Star,
  Download,
  Trash2,
  RotateCw,
  FolderDown,
  PanelRightClose,
  Filter,
} from "lucide-react";

import { api, isTauri } from "@/lib/api";
import { formatBytes, formatClock, formatDateTime, formatDuration } from "@/lib/format";
import { usePlayer } from "@/lib/player";
import { useApp } from "@/lib/store";
import { Avatar, Button, IconButton, cn } from "@/components/ui/primitives";
import { Waveform } from "@/components/Waveform";

export function DetailPanel() {
  const conversations = useApp((state) => state.conversations);
  const activeId = useApp((state) => state.activeConversationId);
  const activeVoiceId = useApp((state) => state.activeVoiceId);
  const voices = useApp((state) => state.voices);
  const selectVoice = useApp((state) => state.selectVoice);
  const setDetailOpen = useApp((state) => state.setDetailOpen);

  const conversation = conversations.find((item) => item.id === activeId) ?? null;
  const voice = voices.find((item) => item.id === activeVoiceId) ?? null;

  return (
    <aside className="detail" aria-label="语音详情">
      <div className="detail__head">
        <div className="detail__title">{voice ? "语音详情" : "会话概览"}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          {voice ? (
            <IconButton label="返回概览" onClick={() => selectVoice(null)}>
              <X size={15} />
            </IconButton>
          ) : null}
          <IconButton label="收起面板（E）" onClick={() => setDetailOpen(false)}>
            <PanelRightClose size={15} />
          </IconButton>
        </div>
      </div>

      <div className="detail__scroll">
        {voice ? (
          <VoiceDetail key={voice.id} voiceId={voice.id} />
        ) : conversation ? (
          <ConversationOverview conversationId={conversation.id} />
        ) : (
          <div className="form-hint">未选择会话。</div>
        )}
      </div>
    </aside>
  );
}

function ConversationOverview({ conversationId }: { conversationId: number }) {
  const conversations = useApp((state) => state.conversations);
  const toast = useApp((state) => state.toast);
  const conversation = conversations.find((item) => item.id === conversationId);

  if (!conversation) return null;
  const name = conversation.remark || conversation.title;

  const exportBundle = async () => {
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
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <Avatar name={name} src={conversation.avatar} size="lg" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
          </div>
          <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>
            {conversation.kind === "group" ? "群聊" : "好友"} · {conversation.peerId}
          </div>
        </div>
      </div>

      <div className="kv">
        <span className="kv__k">语音</span>
        <span className="kv__v">{conversation.voiceCount} 条</span>
        <span className="kv__k">总时长</span>
        <span className="kv__v">{formatDuration(conversation.totalMs)}</span>
        <span className="kv__k">群成员</span>
        <span className="kv__v">{conversation.kind === "group" ? `${conversation.memberCount} 人` : "—"}</span>
        <span className="kv__k">上次同步</span>
        <span className="kv__v">
          {conversation.syncedAt ? formatDateTime(conversation.syncedAt) : "尚未同步"}
        </span>
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">操作</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderDown size={13.5} />}
            disabled={conversation.voiceCount === 0}
            onClick={() => void exportBundle()}
          >
            导出整个会话
          </Button>
        </div>
      </div>

    </div>
  );
}

function VoiceDetail({ voiceId }: { voiceId: number }) {
  const voices = useApp((state) => state.voices);
  const voice = voices.find((item) => item.id === voiceId);
  const updateVoice = useApp((state) => state.updateVoice);
  const deleteVoice = useApp((state) => state.deleteVoice);
  const setFilter = useApp((state) => state.setFilter);
  const toast = useApp((state) => state.toast);
  const playingId = usePlayer((state) => state.voiceId);
  const playing = usePlayer((state) => state.playing);
  const toggle = usePlayer((state) => state.toggle);
  const requestSeek = usePlayer((state) => state.requestSeek);
  const current = usePlayer((state) => state.current);
  const duration = usePlayer((state) => state.duration);

  const [note, setNote] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setNote(voice?.note ?? "");
    setConfirmDelete(false);
  }, [voice?.id, voice?.note]);

  if (!voice) return null;

  const isCurrent = playingId === voice.id;
  const isPlaying = isCurrent && playing;
  const progress =
    isCurrent && duration > 0 ? Math.min(1, current / duration) : 0;

  const copyTranscript = async () => {
    if (!voice.transcript) return;
    try {
      await navigator.clipboard.writeText(voice.transcript);
      toast("success", "已复制转写文本");
    } catch {
      toast("error", "复制失败，请手动选择");
    }
  };

  const saveNote = async () => {
    if (note === voice.note) return;
    try {
      await updateVoice(voice.id, { note });
      toast("success", "备注已保存");
    } catch (error) {
      toast("error", `备注保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const addTag = async () => {
    const value = tagDraft.trim();
    if (!value) return;
    if (voice.tags.includes(value)) {
      setTagDraft("");
      return;
    }
    await updateVoice(voice.id, { tags: [...voice.tags, value] });
    setTagDraft("");
  };

  const exportAudio = async () => {
    try {
      let target = "";
      if (isTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({
          title: "导出语音",
          defaultPath: `${voice.senderName || "voice"}-${formatClock(voice.durationMs).replace(":", "m")}s.wav`,
          filters: [{ name: "WAV 音频", extensions: ["wav"] }],
        });
        if (!picked) return;
        target = picked;
      } else {
        target = `preview-${voice.id}.wav`;
      }
      const report = await api.exportSingle(voice.id, target);
      toast("success", `已导出到 ${report.path}`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  const requeueTranscribe = async () => {
    try {
      await api.transcribeVoice(voice.id);
      toast("info", "已加入转写队列");
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div>
      <div className="detail__wave">
        <Waveform
          peaks={voice.peaks}
          bars={96}
          height={54}
          progress={progress}
          onSeek={voice.playable ? (ratio) => requestSeek(ratio) : undefined}
          className="player__wave"
        />
        <div className="detail__meta">
          <span className="tabular">
            {isCurrent ? formatClock(current * 1000) : "00:00"} / {formatClock(voice.durationMs)}
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="play-btn"
              disabled={!voice.playable}
              onClick={() => toggle(voice.id)}
              title={voice.playable ? "播放" : "音频未下载"}
            >
              {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            </button>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 14 }}>
        <Avatar name={voice.senderName} size="md" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "var(--fs-base)", fontWeight: 600 }}>{voice.senderName || "未知发送者"}</div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-3)" }}>{formatDateTime(voice.sentAt)}</div>
        </div>
        <IconButton
          label="只看这个人的语音"
          onClick={() =>
            setFilter({ senderFilter: voice.senderId, senderFilterLabel: voice.senderName })
          }
        >
          <Filter size={14} />
        </IconButton>
        <IconButton
          label={voice.starred ? "取消星标" : "加星标"}
          tone="gold"
          active={voice.starred}
          onClick={() => void updateVoice(voice.id, { starred: !voice.starred })}
        >
          <Star size={15} fill={voice.starred ? "currentColor" : "none"} />
        </IconButton>
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">转写</span>
          <span className="section__action">
            {voice.transcript ? (
              <IconButton label="复制文字" onClick={() => void copyTranscript()}>
                <Copy size={14} />
              </IconButton>
            ) : null}
            <IconButton
              label={voice.transcript ? "重新转写" : "加入转写队列"}
              onClick={() => void requeueTranscribe()}
            >
              <RotateCw size={14} />
            </IconButton>
          </span>
        </div>
        <div className={cn("transcript", !voice.transcript && "is-empty")}>
          {voice.transcript ||
            (voice.transcriptStatus === "failed"
              ? `转写失败：${voice.transcriptError || "未知原因"}`
              : voice.transcriptStatus === "running"
                ? "正在转写…"
                : "尚无转写文本。启用转写后可重新处理。")}
        </div>
        {voice.asrEngine && voice.transcript ? (
          <div className="form-hint">由 {voice.asrEngine} 转写</div>
        ) : null}
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">标签</span>
        </div>
        <div className="tag-list">
          {voice.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
              <button
                type="button"
                aria-label={`删除标签 ${tag}`}
                onClick={() => void updateVoice(voice.id, { tags: voice.tags.filter((item) => item !== tag) })}
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <input
            className="tag-add"
            style={{ width: 76, outline: "none" }}
            placeholder="+ 标签"
            value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addTag();
              }
            }}
            onBlur={() => void addTag()}
          />
        </div>
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">备注</span>
        </div>
        <textarea
          className="detail__note selectable"
          value={note}
          placeholder="添加备注"
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => void saveNote()}
        />
      </div>

      <div className="section">
        <div className="section__head">
          <span className="section__title">文件信息</span>
        </div>
        <div className="kv">
          <span className="kv__k">时长</span>
          <span className="kv__v">{formatDuration(voice.durationMs)}</span>
          <span className="kv__k">大小</span>
          <span className="kv__v">{formatBytes(voice.sizeBytes)}</span>
          <span className="kv__k">格式</span>
          <span className="kv__v">
            {voice.codec.toUpperCase()}
            {voice.sampleRate ? ` · ${(voice.sampleRate / 1000).toFixed(1)} kHz` : ""}
          </span>
          <span className="kv__k">来源</span>
          <span className="kv__v">{voice.source === "live" ? "实时接收" : voice.source === "history" ? "历史同步" : "手动导入"}</span>
          <span className="kv__k">消息 ID</span>
          <span className="kv__v mono kv__v--mono">
            {voice.msgId}
          </span>
        </div>
      </div>

      <div className="section" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          variant="ghost"
          size="sm"
          icon={<Download size={13.5} />}
          disabled={!voice.playable}
          onClick={() => void exportAudio()}
        >
          导出音频
        </Button>
        {confirmDelete ? (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={13.5} />}
            onClick={() => void deleteVoice(voice.id)}
          >
            确认删除
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13.5} />}
            onClick={() => setConfirmDelete(true)}
          >
            删除
          </Button>
        )}
      </div>
    </div>
  );
}
