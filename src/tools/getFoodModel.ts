import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { LoseItClient } from "../loseit/client.js";
import { foodMeasures } from "../loseit/foodModel.js";
import { NUTRIENT_BY_INTID } from "../loseit/structTypes.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { textResponse } from "./response.js";

export function registerGetFoodModelTool(server: McpServer, client: LoseItClient): void {
  server.registerTool(
    "loseit_get_food_model",
    {
      title: "Get Food Logging Model",
      description:
        "Discover Lose It's supported meal categories, food measurement units, " +
        "nutrient units, account timezone, and the search-to-log workflow. " +
        "Call this when deciding how to map a user's food and serving request.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async () => textResponse({
      timezone: client.getTimezone(),
      meals: ["breakfast", "lunch", "dinner", "snacks"],
      servingUnits: foodMeasures(),
      nutrientUnits: Object.fromEntries(
        Object.values(NUTRIENT_BY_INTID).map((name) => [
          name,
          name === "calories" ? "kcal"
            : name === "sodium" || name === "cholesterol" ? "mg" : "g",
        ]),
      ),
      workflow: [
        "Search with loseit_search_foods; select a foodId, name and source from one result.",
        "Inspect its default portion, nutrition and available measures with loseit_get_food.",
        "Log an amount and unit using loseit_log_food portion: {amount, unit}; add servingSizeIndex if multiple sizes or compatible conversions match.",
        "Alternatively, log with servings to multiply the default portion. Do not supply both.",
        "Verify entries with loseit_get_food_log. A failed write must be checked there before retrying.",
      ],
      limitations: [
        "Only food-specific units and compatible mass/volume conversions are supported. Mass and volume cannot be converted without food density.",
        "Food creation, editing, deletion and recipe logging are not supported.",
        "Unknown nutrientId fields have no verified name or unit mapping.",
      ],
    }),
  );
}
