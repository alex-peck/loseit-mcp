import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { dateToDayNumber, localTodayAsUTCDate, GwtParseError } from "../loseit/gwt.js";
import { extractFoodLog } from "../loseit/extractors.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";

export function registerGetFoodLogTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_food_log",
    {
      title: "Get Food Log",
      description:
        "Returns the food log for a given day. Each entry includes the food name, " +
        "brand, servings logged (quantity), and per-food nutrition for the logged " +
        "portion (calories, protein, fat, saturatedFat, cholesterol, sodium, " +
        "carbohydrates, fiber, sugars; grams except calories/kcal and mg for " +
        "cholesterol/sodium). Also returns totalCalories for the day. A nutrient is " +
        "null when Lose It has no value for that food. If 'detailed' is false the " +
        "server could only recover food names/brands (nutrition unavailable).",
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
        const { raw } = await client.gwtRpc(
          "getInitializationData",
          [],
        );

        const targetDate = args.date
          ? new Date(args.date)
          : localTodayAsUTCDate();
        const targetDayNumber = dateToDayNumber(targetDate);

        const result = extractFoodLog(
          raw,
          targetDayNumber,
          client.getGwtRegistry(),
        );
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
