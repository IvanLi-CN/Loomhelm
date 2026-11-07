export type ExecutionRange = { start: string | null; end: string | null };

export type ExecutionInterval = {
  start: string | null;
  end: string | null;
};

export function rangeFromIntervals(
  intervals: readonly ExecutionInterval[],
): ExecutionRange {
  const starts = intervals
    .map((interval) => interval.start)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)));
  const start = starts.length
    ? starts.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
    : null;
  const complete = intervals.length > 0 && intervals.every(
    (interval) => interval.end !== null && Number.isFinite(Date.parse(interval.end)),
  );
  const ends = complete
    ? intervals
      .map((interval) => interval.end!)
      .sort((left, right) => Date.parse(right) - Date.parse(left))
    : [];
  return { start, end: ends[0] ?? null };
}
