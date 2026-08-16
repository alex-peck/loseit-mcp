/** Descriptive statistics for one numeric series across a date range. */
export interface SeriesStats {
  count: number;
  total: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function seriesStats(values: number[]): SeriesStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, v) => sum + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2
      : sorted[mid]!;

  return {
    count: values.length,
    total: round1(total),
    mean: round1(total / values.length),
    median: round1(median),
    min: round1(sorted[0]!),
    max: round1(sorted[sorted.length - 1]!),
  };
}

export interface TrendStats {
  first: number;
  last: number;
  change: number;
  min: number;
  max: number;
}

/** First/last/net-change for an ordered series, for weight-style trends. */
export function trendStats(
  points: Array<{ value: number }>,
): TrendStats | null {
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return {
    first: round1(first),
    last: round1(last),
    change: round1(last - first),
    min: round1(Math.min(...values)),
    max: round1(Math.max(...values)),
  };
}
