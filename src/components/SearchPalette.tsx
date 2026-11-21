import { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, ArrowUp, ArrowDown, FileAudio } from "lucide-react";

import { api } from "@/lib/api";
import { formatClock, formatDateTime } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { Voice } from "@/lib/types";
import { Badge, Modal, cn } from "@/components/ui/primitives";

export function SearchPalette() {
  const open = useApp((state) => state.searchOpen);
  const setOpen = useApp((state) => state.setSearchOpen);
  const selectConversation = useApp((state) => state.selectConversation);
  const selectVoice = useApp((state) => state.selectVoice);
  const conversations = useApp((state) => state.conversations);

  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Voice[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (open) {
      setKeyword("");
      setResults([]);
      setError("");
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const text = keyword.trim();
    if (!text) {
      setResults([]);
      setError("");
      setBusy(false);
      return;
    }
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    const timer = window.setTimeout(async () => {
      try {
        const page = await api.queryVoices({ keyword: text, limit: 30 });
        if (request === requestRef.current) {
          setResults(page.items);
          setCursor(0);
        }
      } catch (err) {
        if (request === requestRef.current) {
          setResults([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (request === requestRef.current) setBusy(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
    };
  }, [keyword, open]);

  useEffect(() => {
    const element = document.querySelector(".palette-item.is-cursor");
    element?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const conversationTitles = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of conversations) map.set(item.id, item.remark || item.title);
    return map;
  }, [conversations]);

  const jump = (voice: Voice) => {
    void selectConversation(voice.conversationId).then(() => selectVoice(voice.id));
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(results.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = results[cursor];
      if (target) jump(target);
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} align="top" label="搜索语音">
      <div className="palette">
        <div className="palette__field">
          <Search size={16} color="var(--text-3)" />
          <input
            ref={inputRef}
            value={keyword}
            aria-label="搜索转写文本、发送者、会话名或标签"
            placeholder="搜索转写文本、发送者、会话名、标签"
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="palette__results">
          {!keyword.trim() ? (
            <div className="form-hint" style={{ padding: "14px 12px" }}>
              输入关键词开始搜索；Ctrl K 随时打开这里。
            </div>
          ) : error ? (
            <div className="form-hint" style={{ padding: "14px 12px" }}>
              搜索失败：{error}
            </div>
          ) : results.length === 0 ? (
            <div className="form-hint" style={{ padding: "14px 12px" }}>
              {busy ? "搜索中" : `没有匹配 ${keyword.trim()} 的语音`}
            </div>
          ) : (
            results.map((voice, index) => (
              <button
                key={voice.id}
                type="button"
                className={cn("palette-item", index === cursor && "is-cursor")}
                onMouseEnter={() => setCursor(index)}
                onClick={() => jump(voice)}
              >
                <span style={{ color: "var(--text-3)", marginTop: 2 }}>
                  <FileAudio size={14} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="palette-item__title">
                    {voice.senderName || "未知"}
                    <Badge kind={voice.conversationKind}>
                      {conversationTitles.get(voice.conversationId) ?? voice.conversationTitle}
                    </Badge>
                    <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: "var(--fs-xs)" }}>
                      {formatClock(voice.durationMs)}
                    </span>
                  </span>
                  <span className="palette-item__text">
                    {voice.transcript || "无转写文本"}
                  </span>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-3)" }}>
                    {formatDateTime(voice.sentAt)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="palette__foot">
          <span>
            <ArrowUp size={11} style={{ verticalAlign: -1 }} />
            <ArrowDown size={11} style={{ verticalAlign: -1, marginLeft: 2 }} /> 选择
          </span>
          <span>
            <CornerDownLeft size={11} style={{ verticalAlign: -1 }} /> 打开
          </span>
          <span style={{ marginLeft: "auto" }}>{results.length} 条结果</span>
        </div>
      </div>
    </Modal>
  );
}
