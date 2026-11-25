import { useMemo, useState } from "react";
import { Search, Users, User } from "lucide-react";

import { useApp } from "@/lib/store";
import { formatDuration, formatRelative } from "@/lib/format";
import { Avatar, cn } from "@/components/ui/primitives";
import type { Conversation } from "@/lib/types";

export function ConversationList() {
  const conversations = useApp((state) => state.conversations);
  const activeId = useApp((state) => state.activeConversationId);
  const selectConversation = useApp((state) => state.selectConversation);
  const account = useApp((state) => state.connection.account);
  const setSearchOpen = useApp((state) => state.setSearchOpen);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return conversations;
    return conversations.filter(
      (item) =>
        item.title.toLowerCase().includes(text) ||
        item.remark.toLowerCase().includes(text) ||
        item.peerId.includes(text),
    );
  }, [conversations, query]);

  const groups = useMemo(
    () => ({
      group: filtered.filter((item) => item.kind === "group"),
      friend: filtered.filter((item) => item.kind === "friend"),
    }),
    [filtered],
  );

  return (
    <aside className="conv-pane" aria-label="会话列表">
      <div className="conv-pane__head">
        <div className="conv-pane__me">
          <Avatar name={account?.nickname ?? "未登录"} src={account?.avatar} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="conv-pane__name">{account?.nickname ?? "未连接账号"}</div>
            <div className="conv-pane__sub">
              {account ? `${conversations.length} 个会话` : "未登录"}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          title="全局搜索（Ctrl K）"
          aria-label="全局搜索"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={15} />
        </button>
      </div>

      <div className="conv-pane__search">
        <div className="search-field">
          <Search size={13} color="var(--text-3)" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </div>
      </div>

      <div className="conv-pane__scroll">
        {conversations.length === 0 ? (
          <div className="form-hint" style={{ padding: "18px 10px" }}>
            暂无会话
          </div>
        ) : null}

        {groups.group.length > 0 ? (
          <div className="conv-group">
            <div className="conv-group__label">
              <Users size={11} />
              群聊
              <span className="conv-group__count">{groups.group.length}</span>
            </div>
            {groups.group.map((item) => (
              <ConversationItem
                key={item.id}
                item={item}
                active={item.id === activeId}
                onSelect={selectConversation}
              />
            ))}
          </div>
        ) : null}

        {groups.friend.length > 0 ? (
          <div className="conv-group">
            <div className="conv-group__label">
              <User size={11} />
              好友
              <span className="conv-group__count">{groups.friend.length}</span>
            </div>
            {groups.friend.map((item) => (
              <ConversationItem
                key={item.id}
                item={item}
                active={item.id === activeId}
                onSelect={selectConversation}
              />
            ))}
          </div>
        ) : null}

        {conversations.length > 0 && filtered.length === 0 ? (
          <div className="form-hint" style={{ padding: "18px 10px" }}>
            没有匹配的会话
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ConversationItem({
  item,
  active,
  onSelect,
}: {
  item: Conversation;
  active: boolean;
  onSelect: (id: number) => void;
}) {
  const name = item.remark || item.title || item.peerId;
  const sub =
    item.voiceCount > 0
      ? `${item.voiceCount} 条 · ${formatDuration(item.totalMs)}`
      : item.kind === "group"
        ? `${item.memberCount || 0} 人`
        : "";

  return (
    <button
      type="button"
      className={cn("conv-item", active && "is-active")}
      onClick={() => void onSelect(item.id)}
      title={name}
    >
      <Avatar name={name} src={item.avatar} />
      <div className="conv-item__body">
        <div className="conv-item__name">{name}</div>
        {sub ? (
          <div className="conv-item__meta">
            <span>{sub}</span>
          </div>
        ) : null}
      </div>
      <span className="conv-item__count">
        {item.lastVoiceAt ? formatRelative(item.lastVoiceAt) : ""}
      </span>
    </button>
  );
}
