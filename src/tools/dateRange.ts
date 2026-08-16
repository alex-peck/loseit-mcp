import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { dateToDayNumber, localTodayAsUTCDate } from "../loseit/gwt.js";

/**
 * Upper bound on how many days a single bulk request may span.
 *
 * Lose It happily serves multi-year ranges in one call, but the response has to
 * fit in an MCP client's context, so the cap keeps a runaway request from
 * returning an unusable wall of data.
 */
export const MAX_RANGE_DAYS = 1100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dateRangeInputSchema = {
  startDate: z
    .string()
    .regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)")
    .optional()
    .describe(
      "First day of the range, inclusive (YYYY-MM-DD). Defaults to 'days' before endDate.",
    ),
  endDate: z
    .string()
    .regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)")
    .optional()
    .describe(
      "Last day of the range, inclusive (YYYY-MM-DD). Defaults to today.",
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_RANGE_DAYS)
    .optional()
    .describe(
      `Number of days to return, counting back from endDate. Used when startDate is omitted. Defaults to 30, max ${MAX_RANGE_DAYS}.`,
    ),
};

export interface ResolvedDateRange {
  startDayNumber: number;
  endDayNumber: number;
  startDate: string;
  endDate: string;
  dayCount: number;
}

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

function toDayNumber(iso: string, label: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new DateRangeError(`${label} is not a valid date: ${iso}`);
  }
  return dateToDayNumber(date);
}

function toIso(dayNumber: number): string {
  const ms = Date.UTC(2000, 11, 31) + dayNumber * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolve the `startDate` / `endDate` / `days` triple into an inclusive day
 * number range. "Today" is resolved in the account's configured timezone so the
 * correct day is used even when the server process runs in UTC.
 */
export function resolveDateRange(
  args: {
    startDate?: string | undefined;
    endDate?: string | undefined;
    days?: number | undefined;
  },
  client: LoseItClient,
): ResolvedDateRange {
  const today = dateToDayNumber(localTodayAsUTCDate(client.getTimezone()));

  const endDayNumber = args.endDate
    ? toDayNumber(args.endDate, "endDate")
    : today;

  const startDayNumber = args.startDate
    ? toDayNumber(args.startDate, "startDate")
    : endDayNumber - (args.days ?? 30) + 1;

  if (startDayNumber > endDayNumber) {
    throw new DateRangeError(
      `startDate (${toIso(startDayNumber)}) is after endDate (${toIso(endDayNumber)})`,
    );
  }

  const dayCount = endDayNumber - startDayNumber + 1;
  if (dayCount > MAX_RANGE_DAYS) {
    throw new DateRangeError(
      `Requested range spans ${dayCount} days, which exceeds the ${MAX_RANGE_DAYS}-day maximum. Narrow the range or request it in chunks.`,
    );
  }

  return {
    startDayNumber,
    endDayNumber,
    startDate: toIso(startDayNumber),
    endDate: toIso(endDayNumber),
    dayCount,
  };
}
