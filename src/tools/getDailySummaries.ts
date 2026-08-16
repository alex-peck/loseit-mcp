import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { GwtParseError } from "../loseit/gwt.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";
import {
  DateRangeError,
  dateRangeInputSchema,
  resolveDateRange,
} from "./dateRange.js";
import { loadDailyRange } from "./loadDailyRange.js";
import { seriesStats, trendStats } from "./stats.js";

export function registerGetDailySummariesTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_daily_summaries",
    {
      title: "Get Daily Summaries (Bulk)",
      description:
        "Bulk calorie history: returns one record per day for an entire date " +
        "range in a single request, which is the right tool for any analysis " +
        "spanning more than a day or two (trends, weekly averages, weekday vs " +
        "weekend, correlation with weight). Each day has caloriesEaten, " +
        "caloriesBudget (base budget, excludes exercise), exerciseCalories, " +
        "caloriesRemaining (budget + exercise - eaten), the weight recorded that " +
        "day (null if none), foodEntryCount, and whether anything was logged. " +
        "Also returns aggregate stats (totals, mean/median/min/max, days over " +
        "budget, weight trend) computed over logged days only, so gaps in " +
        "logging do not drag averages toward zero. Specify the range with " +
        "startDate+endDate, or with days (counting back from endDate).",
      inputSchema: {
        ...dateRangeInputSchema,
        includeUnloggedDays: z
          .boolean()
          .optional()
          .describe(
            "Include days with no food logged in the days array. Defaults to true. Set false to return only days with entries.",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const range = resolveDateRange(args, client);
        const { days: inRange, detailed } = await loadDailyRange(client, range);

        const loggedDays = inRange.filter((d) => d.logged);
        const days = (
          args.includeUnloggedDays === false ? loggedDays : inRange
        ).map(({ entries: _entries, nutrition: _nutrition, ...day }) => day);

        const weighIns = inRange
          .filter((d) => d.weight !== null)
          .map((d) => ({ date: d.date, value: d.weight! }));

        return textResponse({
          startDate: range.startDate,
          endDate: range.endDate,
          dayCount: range.dayCount,
          daysReturned: days.length,
          daysLogged: loggedDays.length,
          daysMissing: range.dayCount - inRange.length,
          detailed,
          stats: {
            caloriesEaten: seriesStats(loggedDays.map((d) => d.caloriesEaten)),
            caloriesBudget: seriesStats(
              loggedDays.map((d) => d.caloriesBudget),
            ),
            exerciseCalories: seriesStats(
              loggedDays.map((d) => d.exerciseCalories),
            ),
            // Net intake after exercise — the figure that drives weight change.
            netCalories: seriesStats(
              loggedDays.map((d) => d.caloriesEaten - d.exerciseCalories),
            ),
            daysOverBudget: loggedDays.filter((d) => d.caloriesRemaining < 0)
              .length,
            daysUnderBudget: loggedDays.filter((d) => d.caloriesRemaining >= 0)
              .length,
            weight: trendStats(weighIns),
            weighIns: weighIns.length,
          },
          days,
        });
      } catch (error) {
        if (error instanceof DateRangeError || error instanceof GwtParseError) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
