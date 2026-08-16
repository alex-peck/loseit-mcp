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

interface FoodAggregate {
  name: string;
  brand: string;
  timesLogged: number;
  daysLogged: number;
  totalCalories: number;
  totalProtein: number;
  lastLogged: string;
}

export function registerGetTopFoodsTool(
  server: McpServer,
  client: LoseItClient,
): void {
  server.registerTool(
    "loseit_get_top_foods",
    {
      title: "Get Top Foods (Bulk)",
      description:
        "Aggregates every food logged across a date range into a ranked list, " +
        "answering questions like 'what do I eat most often?' or 'which foods " +
        "account for most of my calories?'. Each row has the food name, brand, " +
        "timesLogged, daysLogged, totalCalories and totalProtein contributed " +
        "over the range, average calories per logging, the share of total " +
        "calories, and the date it was last logged. Rank by frequency or by " +
        "total calories. Specify the range with startDate+endDate, or with days " +
        "counting back from endDate.",
      inputSchema: {
        ...dateRangeInputSchema,
        sortBy: z
          .enum(["calories", "frequency"])
          .optional()
          .describe(
            "Rank by total calories contributed (default) or by how often the food was logged.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum foods to return. Defaults to 25."),
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
              "Food-level data is unavailable: the Lose It object graph could not be deserialized.",
            ),
          );
        }

        const byFood = new Map<string, FoodAggregate>();
        let rangeCalories = 0;
        let daysLogged = 0;

        for (const day of days) {
          if (day.logged) daysLogged++;

          // A food logged twice in one day counts twice for timesLogged but
          // only once for daysLogged.
          const seenToday = new Set<string>();
          for (const entry of day.entries ?? []) {
            const key = `${entry.name}\u0000${entry.brand}`;
            let agg = byFood.get(key);
            if (!agg) {
              agg = {
                name: entry.name,
                brand: entry.brand,
                timesLogged: 0,
                daysLogged: 0,
                totalCalories: 0,
                totalProtein: 0,
                lastLogged: day.date,
              };
              byFood.set(key, agg);
            }
            agg.timesLogged++;
            if (!seenToday.has(key)) {
              seenToday.add(key);
              agg.daysLogged++;
            }
            agg.totalCalories += entry.nutrition.calories ?? 0;
            agg.totalProtein += entry.nutrition.protein ?? 0;
            rangeCalories += entry.nutrition.calories ?? 0;
            if (day.date > agg.lastLogged) agg.lastLogged = day.date;
          }
        }

        const sortBy = args.sortBy ?? "calories";
        const ranked = [...byFood.values()]
          .sort((a, b) =>
            sortBy === "frequency"
              ? b.timesLogged - a.timesLogged ||
                b.totalCalories - a.totalCalories
              : b.totalCalories - a.totalCalories ||
                b.timesLogged - a.timesLogged,
          )
          .slice(0, args.limit ?? 25)
          .map((f) => ({
            name: f.name,
            brand: f.brand,
            timesLogged: f.timesLogged,
            daysLogged: f.daysLogged,
            totalCalories: Math.round(f.totalCalories),
            averageCalories: Math.round(f.totalCalories / f.timesLogged),
            totalProtein: Math.round(f.totalProtein * 10) / 10,
            percentOfCalories:
              rangeCalories > 0
                ? Math.round((f.totalCalories / rangeCalories) * 1000) / 10
                : 0,
            lastLogged: f.lastLogged,
          }));

        return textResponse({
          startDate: range.startDate,
          endDate: range.endDate,
          daysLogged,
          uniqueFoods: byFood.size,
          totalCalories: Math.round(rangeCalories),
          sortBy,
          foods: ranked,
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
