import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import {
  asFoodObject,
  foodNutrition,
  foodServingSize,
  readFoodResponse,
} from "../loseit/foodModel.js";
import { GwtParseError } from "../loseit/gwt.js";
import { StructParseError } from "../loseit/structReader.js";
import { READ_ONLY_TOOL_ANNOTATIONS } from "./common.js";
import { errorResponse, textResponse } from "./response.js";

export const foodSelectionSchema = {
  foodId: z.string().describe("The foodId returned by loseit_search_foods."),
  name: z.string().min(1).describe("The name returned by loseit_search_foods."),
  source: z.string().nullable().describe(
    "The source returned by loseit_search_foods (including null).",
  ),
};

export function registerGetFoodTool(server: McpServer, client: LoseItClient): void {
  server.registerTool(
    "loseit_get_food",
    {
      title: "Get Food Details",
      description:
        "Inspect a selected food before logging it. Use the foodId, name and source " +
        "from loseit_search_foods. Returns the default serving, nutrients, and the " +
        "available serving sizes with their physical amount, unit, referenceAmount, " +
        "and internal quantity. Default nutrition is for the default portion. " +
        "Use a returned unit or servingSizeIndex with loseit_log_food to log an " +
        "explicit measured amount, or use servings to multiply the default portion.",
      inputSchema: foodSelectionSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ foodId, name, source }) => {
      try {
        const [{ raw: foodRaw }, { raw: draftRaw }] = await Promise.all([
          client.getFoodDetails(foodId),
          client.getFoodDraft(foodId, source, name),
        ]);
        const food = readFoodResponse(
          foodRaw, client.getGwtRegistry(), "FoodForFoodDatabase",
        ).data;
        const draft = readFoodResponse(
          draftRaw, client.getGwtRegistry(), "FoodLogEntry",
        ).data;
        const identifier = asFoodObject(food.f0, "FoodIdentifier");
        const serving = asFoodObject(draft.serving, "FoodServing");
        if (!Array.isArray(food.f2)) {
          throw new StructParseError("Food serving sizes are unavailable");
        }
        return textResponse({
          foodId,
          name: identifier.name,
          brand: identifier.brand,
          defaultServing: foodServingSize(serving.servingSize),
          defaultNutrition: foodNutrition(serving.nutrients, true),
          servingSizes: food.f2.map((size, index) => ({
            index,
            ...foodServingSize(size),
          })),
        });
      } catch (error) {
        if (error instanceof StructParseError || error instanceof GwtParseError) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
