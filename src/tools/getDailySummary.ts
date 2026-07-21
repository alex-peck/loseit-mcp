import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { dateToDayNumber, localTodayAsUTCDate, GwtParseError } from "../loseit/gwt.js";
import { extractDailySummary, extractWeightHistory } from "../loseit/extractors.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";

export function registerGetDailySummaryTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_daily_summary",
    {
      title: "Get Daily Summary",
      description:
        "Returns a day's calorie summary: calories eaten, base budget, exercise calories earned, and calories remaining (budget + exercise - eaten), plus the recorded weight for that day. For a date in the current week the response also includes the same figures for each day of the week; for a historical date it returns just that day. Numbers are the live totals shown in the Lose It app.",
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
          : localTodayAsUTCDate();
        const targetDayNumber = dateToDayNumber(targetDate);

        // getInitializationData returns the current week (with the same-week
        // context). If the requested day falls in that week, use it so the
        // response keeps the full week of entries. Otherwise fetch the specific
        // day directly via getDailyDetailsForDate so historical dates work.
        const { raw } = await client.gwtRpc("getInitializationData", []);
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
          result = extractDailySummary(dated.raw, targetDayNumber);
        }

        if (!result) {
          return errorResponse(
            new Error("No daily summary data found for the requested date"),
          );
        }

        // Weight is not at a stable offset in the daily response; read it from
        // getGoalsData's recorded-weight history instead. For the current week
        // use the reliable current weight; for a historical day use the weight
        // recorded on or most recently before that day, falling back to the
        // current weight.
        try {
          const goals = await client.gwtRpc("getGoalsData", []);
          const history = extractWeightHistory(goals.raw);
          let weight = history.currentWeight;
          if (!inCurrentWeek) {
            const onOrBefore = history.entries
              .filter((e) => e.dayNumber <= targetDayNumber)
              .sort((a, b) => b.dayNumber - a.dayNumber)[0];
            weight = onOrBefore?.weight ?? history.currentWeight;
          }
          if (typeof weight === "number") result.weight = weight;
        } catch {
          // Weight is best-effort; leave it at 0 if getGoalsData fails.
        }

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
