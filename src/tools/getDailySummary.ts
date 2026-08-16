import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import type { GwtResponse } from "../loseit/gwt.js";
import { dateToDayNumber, localTodayAsUTCDate, GwtParseError } from "../loseit/gwt.js";
import { extractDailyRange, extractDailySummary } from "../loseit/extractors.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";

/** How far back to look for a carried-forward weight when a day has no weigh-in. */
const WEIGHT_LOOKBACK_DAYS = 30;

/**
 * Resolve the weight to report for `targetDayNumber`.
 *
 * Each weigh-in hangs off the `DailyDetails` record for the day it was recorded
 * on, so reading it structurally attributes it to the correct date. If that day
 * has no weigh-in, carry forward the most recent one within the lookback
 * window, matching what the Lose It app shows.
 */
async function resolveWeight(
  client: LoseItClient,
  targetDayNumber: number,
  primary: GwtResponse,
): Promise<number | null> {
  const registry = client.getGwtRegistry();

  const onDay = extractDailyRange(primary, registry).days.find(
    (d) => d.dayNumber === targetDayNumber,
  )?.weight;
  if (typeof onDay === "number") return onDay;

  try {
    const responses = await client.getDailyDetailsRange(
      targetDayNumber - WEIGHT_LOOKBACK_DAYS + 1,
      targetDayNumber,
    );
    const recent = responses
      .flatMap((raw) => extractDailyRange(raw, registry).days)
      .filter((d) => d.weight !== null && d.dayNumber <= targetDayNumber)
      .sort((a, b) => b.dayNumber - a.dayNumber)[0];
    return recent?.weight ?? null;
  } catch {
    // Weight is best-effort; the calorie figures are the point of this tool.
    return null;
  }
}

export function registerGetDailySummaryTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_daily_summary",
    {
      title: "Get Daily Summary",
      description:
        "Returns a single day's calorie summary: calories eaten, base budget, exercise calories earned, and calories remaining (budget + exercise - eaten), plus the recorded weight for that day. For a date in the current week the response also includes the same figures for each day of the week; for a historical date it returns just that day. Numbers are the live totals shown in the Lose It app. For anything spanning more than a day or two, use loseit_get_daily_summaries instead — it returns a whole date range in a single request.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe(
            "ISO date string (YYYY-MM-DD). Defaults to today.",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const targetDate = args.date
          ? new Date(args.date)
          : localTodayAsUTCDate(client.getTimezone());
        const targetDayNumber = dateToDayNumber(targetDate);

        // getInitializationData returns the current week (with the same-week
        // context). If the requested day falls in that week, use it so the
        // response keeps the full week of entries. Otherwise fetch the specific
        // day directly via getDailyDetailsForDate so historical dates work.
        const { raw } = await client.gwtRpc("getInitializationData", []);
        let payload = raw;
        let result = extractDailySummary(raw, targetDayNumber);

        const inCurrentWeek =
          result?.weekEntries.some((e) => e.dayNumber === targetDayNumber) ??
          false;

        if (!inCurrentWeek) {
          const dated = await client.gwtRpc(
            "getDailyDetailsForDate",
            [],
            false,
            targetDayNumber,
          );
          payload = dated.raw;
          result = extractDailySummary(dated.raw, targetDayNumber);
        }

        if (!result) {
          return errorResponse(
            new Error("No daily summary data found for the requested date"),
          );
        }

        const weight = await resolveWeight(client, targetDayNumber, payload);
        if (weight !== null) result.weight = weight;

        return textResponse(result);
      } catch (error) {
        if (error instanceof GwtParseError) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
