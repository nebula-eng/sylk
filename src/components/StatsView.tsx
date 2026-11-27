import { useMemo } from "react";
import {
  Mic,
  Clock3,
  FileText,
  HardDrive,
  Flame,
  Users,
  ChevronRight,
} from "lucide-react";

import { formatBytes, formatDuration, percent, weekdayShort } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Avatar } from "@/components/ui/primitives";

export function StatsView() {
  const stats = useApp((state) => state.stats);
  const conversations = useApp((state) => state.conversations);
  const selectConversation = useApp((state) => state.selectConversation);
  const setFilter = useApp((state) => state.setFilter);
  const setView = useApp((state) => state.setView);

  const maxConversationMs = useMemo(
    () => Math.max(1, ...(stats?.topConversations.map((item) => item.totalMs) ?? [1])),
    [stats],
  );
  const maxHeat = useMemo(
    () => Math.max(1, ...(stats?.heatmap.map((cell) => cell.count) ?? [1])),
    [stats],
  );
  const maxDaily = useMemo(
    () => Math.max(1, ...(stats?.daily.map((item) => item.count) ?? [1])),
    [stats],
  );

  if (!stats || stats.overview.voices === 0) {
    return (
      <div className="main">
        <PageHead title="统计" subtitle="还没有语音" />
        <div className="empty">
          <div className="empty__title">还没有语音</div>
          <div className="empty__text">同步后这里会显示统计。</div>
        </div>
      </div>
    );
  }

  const { overview } = stats;

  return (
    <div className="main">
      <PageHead
        title="统计"
        subtitle={`${overview.conversations} 个会话 · ${overview.voices} 条 · ${formatDuration(overview.totalMs)}`}
      />

      <div className="stats-view">
        <div className="stat-grid">
          <StatCard icon={<Mic size={13} />} label="语音" value={overview.voices} unit="条" />
          <StatCard icon={<Clock3 size={13} />} label="时长" value={formatDuration(overview.totalMs)} />
          <StatCard icon={<FileText size={13} />} label="已转写" value={overview.transcribed} unit="条" />
          <StatCard icon={<HardDrive size={13} />} label="占用" value={formatBytes(overview.storageBytes)} />
        </div>

        <div className="stat-cols">
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel__head">
              <Users size={13} color="var(--text-3)" />
              <span className="panel__title">会话排行</span>
            </div>
            <div className="bar-list">
              {stats.topConversations.map((item) => {
                const conversation = conversations.find((conv) => conv.id === item.id);
                return (
                  <button
                    type="button"
                    className="bar-row bar-row--link"
                    key={item.id}
                    title={`进入 ${item.title}`}
                    onClick={() => {
                      void selectConversation(item.id);
                    }}
                  >
                    <Avatar name={item.title} src={conversation?.avatar} size="sm" />
                    <span className="bar-row__name">{item.title}</span>
                    <span className="bar-row__track">
                      <span
                        className="bar-row__fill"
                        style={{ width: `${percent(item.totalMs, maxConversationMs)}%` }}
                      />
                    </span>
                    <span className="bar-row__value">{formatDuration(item.totalMs)}</span>
                    <ChevronRight size={12} className="bar-row__go" />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel__head">
              <Users size={13} color="var(--text-3)" />
              <span className="panel__title">发送者</span>
            </div>
            <div>
              {stats.topSenders.map((sender, index) => (
                <button
                  type="button"
                  className="sender-row sender-row--link"
                  key={`${sender.senderId}-${index}`}
                  title={`筛选 ${sender.name || sender.senderId} 的语音`}
                  onClick={() => {
                    // 这个人可能不在当前会话里，所以跨会话筛
                    setView("voices");
                    setFilter({
                      senderFilter: sender.senderId,
                      senderFilterLabel: sender.name || sender.senderId,
                      scope: "all",
                    });
                  }}
                >
                  <span
                    className="bar-row__value"
                    style={{ width: 16, flex: "0 0 16px", textAlign: "left" }}
                  >
                    {index + 1}
                  </span>
                  <span className="sender-row__name">{sender.name || sender.senderId}</span>
                  <span className="sender-row__value">{sender.voices} 条</span>
                  <span className="sender-row__value" style={{ width: 52, flex: "0 0 52px" }}>
                    {formatDuration(sender.totalMs)}
                  </span>
                  <ChevronRight size={12} className="bar-row__go" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            <Flame size={13} color="var(--text-3)" />
            <span className="panel__title">活跃时段</span>
          </div>
          <div className="heatmap">
            <div className="heatmap__labels">
              {[0, 1, 2, 3, 4, 5, 6].map((index) => (
                <span key={index}>{weekdayShort(index)}</span>
              ))}
            </div>
            <div className="heatmap__grid-wrap">
              <div className="heatmap__hours">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour}>{hour % 3 === 0 ? hour : ""}</span>
                ))}
              </div>
              <div className="heatmap__grid">
                {Array.from({ length: 7 }, (_, weekday) =>
                  Array.from({ length: 24 }, (_, hour) => {
                    const cell = stats.heatmap.find(
                      (item) => item.weekday === weekday && item.hour === hour,
                    );
                    const count = cell?.count ?? 0;
                    const ratio = count / maxHeat;
                    const background = count
                      ? `color-mix(in srgb, var(--accent) ${Math.round(14 + ratio * 78)}%, var(--surface-2))`
                      : "var(--surface-2)";
                    return (
                      <div
                        className="heatmap__cell"
                        key={`${weekday}-${hour}`}
                        style={{ background }}
                        title={`周${weekdayShort(weekday)} ${hour}:00 · ${count} 条`}
                      />
                    );
                  }),
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            <Clock3 size={13} color="var(--text-3)" />
            <span className="panel__title">近 30 天</span>
          </div>
          <div className="spark" role="img" aria-label="最近 30 天每日语音条数">
            {stats.daily.map((item) => (
              <div
                key={item.day}
                className="spark__bar"
                style={{ height: `${Math.max(3, (item.count / maxDaily) * 100)}%` }}
                title={`${item.day} · ${item.count} 条`}
              />
            ))}
          </div>
          <div className="spark__axis">
            <span>{stats.daily[0]?.day.slice(5)}</span>
            <span>{stats.daily[stats.daily.length - 1]?.day.slice(5)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PageHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="main__head">
      <div className="main__titles">
        <div className="main__title">{title}</div>
        <div className="main__sub">{subtitle}</div>
      </div>
    </header>
  );
}

function StatCard({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  unit?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">
        {icon}
        {label}
      </div>
      <div className="stat-card__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
    </div>
  );
}
