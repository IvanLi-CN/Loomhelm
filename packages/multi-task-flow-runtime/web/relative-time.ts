export function formatRelativeHours(minutes: number | null | undefined): string {
  if (minutes == null) return "";
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 2)}h`;
}
