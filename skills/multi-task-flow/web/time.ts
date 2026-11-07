export function formatDuration(start: string | null, end: string | null, now = Date.now()): string {
  const startedAt = start ? Date.parse(start) : Number.NaN;
  const finishedAt = end ? Date.parse(end) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return "未知";
  const minutes = Math.floor((finishedAt - startedAt) / 60000);
  const hours = Math.floor(minutes / 60);
  const value = minutes < 1 ? "不足1分钟" : (hours ? String(hours) + "小时" : "") + (minutes % 60 ? String(minutes % 60) + "分" : "");
  return value;
}
export function formatLocalTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  const age = now - date.getTime();
  if (age >= 12 * 3600000 && age < 7 * 86400000) {
    const days = Math.floor(age / 86400000);
    return new Intl.RelativeTimeFormat("zh-CN", { numeric: "always" }).format(-(days || Math.floor(age / 3600000)), days ? "day" : "hour");
  }
  const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return age >= 0 && age < 12 * 3600000 ? clock : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
export function fullLocalTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "long" }).format(new Date(value));
}
