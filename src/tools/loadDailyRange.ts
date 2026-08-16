import type { LoseItClient } from "../loseit/client.js";
import { extractDailyRange } from "../loseit/extractors.js";
import type { DailyRecord } from "../loseit/extractors.js";
import type { ResolvedDateRange } from "./dateRange.js";

export interface LoadedDailyRange {
  /** One record per day, chronological, clipped to the requested range. */
  days: DailyRecord[];
  /**
   * True when every chunk deserialized cleanly, so weight and per-day
   * nutrition are present. False means only the calorie figures were
   * recovered from the positional fallback.
   */
  detailed: boolean;
}

/**
 * Fetch a date range and flatten it into one record per day.
 *
 * Long ranges arrive as several chunked responses; each is extracted
 * independently and merged here. Days outside the requested range (Lose It can
 * include neighbouring context days) are dropped, and duplicates across chunk
 * boundaries collapse to a single record.
 */
export async function loadDailyRange(
  client: LoseItClient,
  range: ResolvedDateRange,
): Promise<LoadedDailyRange> {
  const responses = await client.getDailyDetailsRange(
    range.startDayNumber,
    range.endDayNumber,
  );

  const registry = client.getGwtRegistry();
  const byDay = new Map<number, DailyRecord>();
  let detailed = true;

  for (const raw of responses) {
    const result = extractDailyRange(raw, registry);
    if (!result.detailed) detailed = false;
    for (const day of result.days) {
      if (
        day.dayNumber < range.startDayNumber ||
        day.dayNumber > range.endDayNumber
      ) {
        continue;
      }
      byDay.set(day.dayNumber, day);
    }
  }

  return {
    days: [...byDay.values()].sort((a, b) => a.dayNumber - b.dayNumber),
    detailed,
  };
}
