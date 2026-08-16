import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { GwtParseError } from "../loseit/gwt.js";
import type { NutritionTotals } from "../loseit/extractors.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";
import {
  DateRangeError,
  dateRangeInputSchema,
  resolveDateRange,
} from "./dateRange.js";
import { loadDailyRange } from "./loadDailyRange.js";
import { seriesStats } from "./stats.js";

const NUTRIENT_KEYS: Array<keyof NutritionTotals> = [
  "calories",
  "protein",
  "fat",
  "saturatedFat",
  "carbohydrates",
  "fiber",
  "sugars",
  "sodium",
  "cholesterol",
];

export function registerGetNutritionHistoryTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_nutrition_history",
    {
      title: "Get Nutrition History (Bulk)",
      description:
        "Bulk macro/micronutrient history: returns per-day totals for every " +
        "nutrient Lose It tracks (calories, protein, fat, saturatedFat, " +
        "carbohydrates, fiber, sugars, sodium, cholesterol) across a whole date " +
        "range in one request, plus mean/median/min/max for each nutrient over " +
        "logged days. Grams except calories (kcal) and sodium/cholesterol (mg). " +
        "Use this for macro trends, protein-target adherence, or fiber/sodium " +
        "analysis. Set includeFoods to also get the individual foods per day " +
        "(much larger output — prefer loseit_get_food_logs for that). Specify " +
        "the range with startDate+endDate, or with days counting back from endDate.",
      inputSchema: {
        ...dateRangeInputSchema,
        includeFoods: z
          .boolean()
          .optional()
          .describe(
            "Include each day's individual food entries. Defaults to false; output grows a lot when enabled.",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const range = resolveDateRange(args, client);
        const { days, detailed } = await loadDailyRange(client, range);

        if (!detailed) {
          return errorResponse(
            new Error(
              "Per-day nutrition is unavailable: the Lose It object graph could not be deserialized. Calorie totals are still available via loseit_get_daily_summaries.",
            ),
          );
        }

        const loggedDays = days.filter((d) => d.logged);

        const stats = Object.fromEntries(
          NUTRIENT_KEYS.map((key) => [
            key,
            seriesStats(loggedDays.map((d) => d.nutrition[key])),
          ]),
        );

        return textResponse({
          startDate: range.startDate,
          endDate: range.endDate,
          dayCount: range.dayCount,
          daysLogged: loggedDays.length,
          units: {
            calories: "kcal",
            sodium: "mg",
            cholesterol: "mg",
            other: "g",
          },
          stats,
          days: loggedDays.map((d) => ({
            date: d.date,
            foodEntryCount: d.foodEntryCount,
            ...d.nutrition,
            ...(args.includeFoods ? { entries: d.entries } : {}),
          })),
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
