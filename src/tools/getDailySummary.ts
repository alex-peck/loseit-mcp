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
        "Returns a day's calorie summary: calories eaten, base budget, exercise calories earned, and calories remaining (budget + exercise - eaten), plus the same figures for each day of the current week. Numbers are the live totals shown in the Lose It app.",
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
        const { raw } = await client.gwtRpc("getInitializationData", []);

        const targetDate = args.date
          ? new Date(args.date)
          : localTodayAsUTCDate();
        const targetDayNumber = dateToDayNumber(targetDate);

        const result = extractDailySummary(raw, targetDayNumber);

        if (!result) {
          return errorResponse(
            new Error("No daily summary data found for the requested date"),
          );
        }

        // Current weight is not at a stable offset in getInitializationData;
        // read it from getGoalsData's recorded-weight history instead.
        try {
          const goals = await client.gwtRpc("getGoalsData", []);
          const weight = extractWeightHistory(goals.raw).currentWeight;
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
