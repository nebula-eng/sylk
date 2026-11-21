const DAY = 86_400;

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "0 秒";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function startOfDay(date: Date): number {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

export function formatTime(ts: number): string {
  const date = new Date(ts * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatDateTime(ts: number): string {
  const date = new Date(ts * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")} ${formatTime(ts)}`;
}

export function formatRelative(ts: number | null): string {
  if (!ts) return "—";
  const now = Date.now();
  const diff = Math.floor(now / 1000) - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(ts * 1000));
  const dayDiff = Math.round((today - target) / (DAY * 1000));
  if (dayDiff === 0) return formatTime(ts);
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return WEEKDAYS[(new Date(ts * 1000).getDay() + 6) % 7];
  const date = new Date(ts * 1000);
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

export function dayKey(ts: number): string {
  const date = new Date(ts * 1000);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function dayLabel(ts: number): string {
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(ts * 1000));
  const diff = Math.round((today - target) / (DAY * 1000));
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff === 2) return "前天";
  const date = new Date(ts * 1000);
  const weekday = WEEKDAYS[(date.getDay() + 6) % 7];
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekday}`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function groupByDay<T extends { sentAt: number }>(items: T[]): { key: string; label: string; items: T[] }[] {
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.sentAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label: dayLabel(item.sentAt), items: [item] });
    }
  }
  return groups;
}

export function initials(name: string): string {
  const trimmed = (name || "?").trim();
  if (!trimmed) return "?";
  const first = trimmed[0];
  // 中文名取一个字，英文名取首字母大写。
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

export function hueFor(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
}

export function weekdayShort(index: number): string {
  return ["一", "二", "三", "四", "五", "六", "日"][index] ?? "";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return clamp(Math.round((part / total) * 100), 0, 100);
}

