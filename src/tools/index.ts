import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { LoseItClient } from "../loseit/client.js";
import { registerGetDailySummaryTool } from "./getDailySummary.js";
import { registerGetDailySummariesTool } from "./getDailySummaries.js";
import { registerGetFoodLogTool } from "./getFoodLog.js";
import { registerGetFoodTool } from "./getFood.js";
import { registerGetFoodModelTool } from "./getFoodModel.js";
import { registerGetNutritionHistoryTool } from "./getNutritionHistory.js";
import { registerGetTopFoodsTool } from "./getTopFoods.js";
import { registerGetWeightHistoryTool } from "./getWeightHistory.js";
import { registerSearchFoodsTool } from "./searchFoods.js";
import { registerLogFoodTool } from "./logFood.js";

export function registerTools(
  server: McpServer,
  client: LoseItClient,
  requireWriteScope: boolean,
): void {
  // Single-day tools.
  registerGetDailySummaryTool(server, client);
  registerGetFoodLogTool(server, client);
  registerSearchFoodsTool(server, client);
  registerGetFoodTool(server, client);
  registerGetFoodModelTool(server, client);
  registerLogFoodTool(server, client, requireWriteScope);

  // Bulk date-range tools, each backed by a single range RPC.
  registerGetDailySummariesTool(server, client);
  registerGetNutritionHistoryTool(server, client);
  registerGetTopFoodsTool(server, client);
  registerGetWeightHistoryTool(server, client);
}
