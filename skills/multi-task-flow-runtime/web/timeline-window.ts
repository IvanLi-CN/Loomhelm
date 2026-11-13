export type TimelineEntryTime = { start?: string | Date | null; end?: string | Date | null };

function timestamp(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

export function defaultTimelineWindow(entries: TimelineEntryTime[]): { start?: Date; end?: Date } {
  const timestamps = entries.flatMap((entry) => [entry.start, entry.end]).map(timestamp).filter(Number.isFinite);
  if (!timestamps.length) return {};
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const span = Math.max(max - min, 30 * 60_000);
  const padding = Math.max(span * 0.14, 10 * 60_000);
  return { start: new Date(min - padding), end: new Date(max + padding) };
}
