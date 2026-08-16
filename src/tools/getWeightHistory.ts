import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

export function registerGetWeightHistoryTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_weight_history",
    {
      title: "Get Weight History (Bulk)",
      description:
        "Returns every weigh-in recorded over a date range, each attributed to " +
        "the day it was recorded on, plus the net change, min/max, and a " +
        "7-day rolling average to smooth day-to-day noise. Days without a " +
        "weigh-in are omitted. Use this together with " +
        "loseit_get_daily_summaries to relate calorie intake to weight trend. " +
        "Specify the range with startDate+endDate, or with days counting back " +
        "from endDate.",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const range = resolveDateRange(args, client);
        const { days, detailed } = await loadDailyRange(client, range);

        if (!detailed) {
          return errorResponse(
            new Error(
              "Weight history is unavailable: the Lose It object graph could not be deserialized.",
            ),
          );
        }

        const weighIns = days
          .filter((d) => d.weight !== null)
          .map((d) => ({
            date: d.date,
            dayNumber: d.dayNumber,
            weight: d.weight!,
          }));

        const entries = weighIns.map((entry, index) => {
          // Rolling average over the previous 7 weigh-ins (not calendar days),
          // so gaps in weighing do not blank out the smoothed series.
          const window = weighIns.slice(Math.max(0, index - 6), index + 1);
          const mean =
            window.reduce((sum, w) => sum + w.weight, 0) / window.length;
          return {
            date: entry.date,
            weight: entry.weight,
            rollingAverage7: Math.round(mean * 100) / 100,
          };
        });

        return textResponse({
          startDate: range.startDate,
          endDate: range.endDate,
          dayCount: range.dayCount,
          weighIns: entries.length,
          trend: trendStats(weighIns.map((w) => ({ value: w.weight }))),
          stats: seriesStats(weighIns.map((w) => w.weight)),
          entries,
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
