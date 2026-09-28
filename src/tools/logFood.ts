import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { MCP_WRITE_SCOPE } from "../auth/scopes.js";
import type { LoseItClient } from "../loseit/client.js";
import { extractFoodLog, type FoodLogItem } from "../loseit/extractors.js";
import {
  asFoodObject,
  foodNutrition,
  foodServingSize,
  readFoodResponse,
  type FoodObject,
} from "../loseit/foodModel.js";
import {
  dayNumberToDate,
  getTimezoneOffset,
  GwtParseError,
} from "../loseit/gwt.js";
import { StructParseError } from "../loseit/structReader.js";
import { applyMeasuredPortion } from "../loseit/servingPortion.js";
import { WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { foodSelectionSchema } from "./getFood.js";
import { errorResponse, textResponse } from "./response.js";

const MEAL_ORDINAL = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snacks: 3,
} as const;

export function findLoggedFood(
  beforeIds: ReadonlySet<string | null>,
  after: FoodLogItem[],
  selection: {
    foodId: string;
    name: string;
    brand: string;
    meal: keyof typeof MEAL_ORDINAL;
    size: ReturnType<typeof foodServingSize>;
    expectedCalories: number | null;
  },
): FoodLogItem {
  const added = after.filter((item) =>
    item.entryId !== null &&
    !beforeIds.has(item.entryId) &&
    item.meal === selection.meal
  );
  const matches = added.filter((item) => {
    const sameFood = item.foodId === selection.foodId ||
      (item.name === selection.name && item.brand === selection.brand);
    const sameAmount = item.servingUnit === selection.size.unit &&
      item.servingAmount !== null &&
      Math.abs(item.servingAmount - selection.size.amount) <=
        0.0002 * Math.max(1, selection.size.amount);
    const sameCalories = selection.expectedCalories === null ||
      (typeof item.nutrition.calories === "number" &&
        Math.abs(item.nutrition.calories - selection.expectedCalories) <=
          Math.max(1, 0.02 * selection.expectedCalories));
    return sameFood && sameAmount && sameCalories;
  });
  if (matches.length === 1) return matches[0]!;
  throw new StructParseError(
    "Could not uniquely verify the new entry; check the food log before retrying",
  );
}

export function assertFoodSaved(value: unknown): void {
  if (value !== true) {
    throw new StructParseError(
      "Food save was not confirmed; check the food log before retrying",
    );
  }
}

async function loadIdentifiedFoodLog(
  client: LoseItClient,
  dayNumber: number,
): Promise<FoodLogItem[]> {
  const { raw } = await client.gwtRpc(
    "getDailyDetailsForDate", [], false, dayNumber,
  );
  const log = extractFoodLog(raw, dayNumber, client.getGwtRegistry());
  if (!log.detailed || log.entries.some((entry) => !entry.entryId)) {
    throw new StructParseError(
      "Cannot identify the day's food entries; logging is unavailable",
    );
  }
  return log.entries;
}

export function prepareFoodEntry(
  entry: FoodObject,
  dayNumber: number,
  timezone: string,
  meal: keyof typeof MEAL_ORDINAL,
  servings: number,
): FoodObject {
  const context = asFoodObject(entry.context, "FoodLogEntryContext");
  const dayDate = asFoodObject(context.dayDate, "DayDate");
  const entryType = asFoodObject(context.mealType, "FoodLogEntryType");
  const serving = asFoodObject(entry.serving, "FoodServing");
  const size = asFoodObject(serving.servingSize, "FoodServingSize");
  const nutrients = asFoodObject(serving.nutrients, "FoodNutrients");
  if (
    !Number.isFinite(servings) || servings <= 0 || servings > 100 ||
    typeof size.quantity !== "number" ||
      !Number.isFinite(size.quantity) || size.quantity <= 0 ||
    typeof size.amount !== "number" ||
      !Number.isFinite(size.amount) || size.amount <= 0 ||
    typeof nutrients.portionFactor !== "number" ||
      !Number.isFinite(nutrients.portionFactor) || nutrients.portionFactor <= 0 ||
    !Array.isArray(nutrients.nutrients)
  ) {
    throw new StructParseError("Invalid default serving for food");
  }

  if (dayDate.dayNumber !== dayNumber) {
    dayDate.f0 = null;
    dayDate.dayNumber = dayNumber;
    dayDate.f2 = getTimezoneOffset(
      timezone,
      new Date(dayNumberToDate(dayNumber).getTime() + 12 * 60 * 60 * 1000),
    );
  }
  entryType.f0 = MEAL_ORDINAL[meal];
  // Lose It applies portionFactor to the nutrient map on save; do not scale both.
  size.amount *= servings;
  size.quantity *= servings;
  nutrients.portionFactor *= servings;
  if (
    !Number.isFinite(size.amount) || !Number.isFinite(size.quantity) ||
    !Number.isFinite(nutrients.portionFactor)
  ) {
    throw new StructParseError("Portion is outside the supported range");
  }
  return entry;
}

export function registerLogFoodTool(
  server: McpServer,
  client: LoseItClient,
  requireWriteScope: boolean,
): void {
  server.registerTool(
    "loseit_log_food",
    {
      title: "Log Food",
      description:
        "Log a food selected by loseit_search_foods into breakfast, lunch, dinner, " +
        "or snacks for a date. Supply the foodId, name and source exactly as returned " +
        "by search. For an explicit amount and unit (for example 30 grams or 16 " +
        "fluid ounces), set portion: {amount, unit}. If multiple serving sizes " +
        "match, add servingSizeIndex from loseit_get_food; amount remains in the " +
        "requested unit. Alternatively use {amount, servingSizeIndex} to specify " +
        "an amount in that serving size's unit. The unit must be available or convertible " +
        "within the same mass/volume family. Alternatively, servings multiplies " +
        "Lose It's default portion. Do not supply both portion and servings. This creates " +
        "a new entry and is not idempotent; if a request fails after being sent, " +
        "check loseit_get_food_log before attempting it again.",
      inputSchema: {
        ...foodSelectionSchema,
        meal: z.enum(["breakfast", "lunch", "dinner", "snacks"]).describe(
          "The meal in which to record the food.",
        ),
        servings: z.number().positive().max(100).optional().describe(
          "Multiplier of the default serving returned by loseit_get_food (default 1).",
        ),
        portion: z.object({
          amount: z.number().positive().finite().max(100_000),
          unit: z.string().trim().min(1).optional().describe(
            "Requested amount's unit (e.g. grams, fluid ounces, g, fl oz) or exact unit from loseit_get_food.",
          ),
          servingSizeIndex: z.number().int().min(0).optional().describe(
            "Index from loseit_get_food; optionally pair with unit to disambiguate conversions.",
          ),
        }).optional().describe(
          "An explicit measured amount. Supply unit, servingSizeIndex, or both.",
        ),
        date: z.string().optional().describe(
          "YYYY-MM-DD in the account timezone. Defaults to today.",
        ),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ foodId, name, source, meal, servings, portion, date }, extra) => {
      try {
        if (requireWriteScope && !extra.authInfo?.scopes.includes(MCP_WRITE_SCOPE)) {
          throw new StructParseError(
            `Logging food requires ${MCP_WRITE_SCOPE}; reconnect with write access`,
          );
        }
        if (portion && servings !== undefined) {
          throw new StructParseError("Specify either servings or portion, not both");
        }
        if (portion && portion.unit === undefined &&
          portion.servingSizeIndex === undefined) {
          throw new StructParseError(
            "Specify portion.unit or portion.servingSizeIndex",
          );
        }
        const dayNumber = resolveDayNumber(date, client);
        const { raw } = await client.getFoodDraft(foodId, source, name);
        const draft = readFoodResponse(
          raw, client.getGwtRegistry(), "FoodLogEntry",
        );
        const identifier = asFoodObject(draft.data.identifier, "FoodIdentifier");
        const key = asFoodObject(identifier.primaryKey, "SimplePrimaryKey");
        if (typeof identifier.name !== "string" || !identifier.name) {
          throw new StructParseError("Selected food has no name");
        }
        const brand = typeof identifier.brand === "string" ? identifier.brand : "";
        if (
          !Array.isArray(key.f0) ||
          Buffer.from(key.f0).toString("base64url") !== foodId
        ) {
          throw new StructParseError("Lose It returned a different food than selected");
        }
        const entry = prepareFoodEntry(
          draft.data, dayNumber, client.getTimezone(), meal, servings ?? 1,
        );
        let requestedPortion: ReturnType<typeof applyMeasuredPortion> | null = null;
        let signatures = draft.signatures;
        if (portion) {
          const { raw: foodRaw } = await client.getFoodDetails(foodId);
          const food = readFoodResponse(
            foodRaw, client.getGwtRegistry(), "FoodForFoodDatabase",
          );
          const foodIdentifier = asFoodObject(food.data.f0, "FoodIdentifier");
          const foodKey = asFoodObject(foodIdentifier.primaryKey, "SimplePrimaryKey");
          if (
            !Array.isArray(foodKey.f0) ||
            Buffer.from(foodKey.f0).toString("base64url") !== foodId
          ) {
            throw new StructParseError("Lose It returned different food serving sizes");
          }
          requestedPortion = applyMeasuredPortion(
            entry, food.data, portion,
          );
          signatures = new Map([...draft.signatures, ...food.signatures]);
        }
        const serving = asFoodObject(entry.serving, "FoodServing");
        const nutrition = foodNutrition(serving.nutrients, true);
        const size = foodServingSize(serving.servingSize);
        const entryTypeSignature = draft.signatures.get("FoodLogEntry");
        if (!entryTypeSignature) {
          throw new StructParseError("FoodLogEntry signature is unavailable");
        }
        const before = await loadIdentifiedFoodLog(client, dayNumber);
        const previousIds = new Set(before.map((item) => item.entryId));
        const { raw: savedRaw } = await client.gwtWriteWithParams(
          "saveCustomFoodLogEntry",
          [
            {
              kind: "object",
              declaredType: entryTypeSignature,
              value: entry,
              registry: draft.registry,
              signatures,
            },
            { kind: "string", value: "en-US" },
            { kind: "boolean", value: false },
            { kind: "boolean", value: false },
          ],
        );
        const saved = readFoodResponse(
          savedRaw, client.getGwtRegistry(), "Boolean",
        ).data;
        assertFoodSaved(saved.f0);
        let logged: FoodLogItem;
        try {
          const after = await loadIdentifiedFoodLog(client, dayNumber);
          logged = findLoggedFood(previousIds, after, {
            foodId,
            name: identifier.name,
            brand,
            meal,
            size,
            expectedCalories: nutrition.calories ?? null,
          });
        } catch (error) {
          throw new StructParseError(
            `Food may have been logged but verification failed; check the food log before retrying. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return textResponse({
          logged: true,
          date: dayNumberToDate(dayNumber).toISOString().slice(0, 10),
          meal,
          entryId: logged.entryId,
          foodId,
          name: identifier.name,
          brand,
          servings: portion ? null : servings ?? 1,
          requestedPortion,
          portion: size,
          calories: logged.nutrition.calories,
          expectedCalories: nutrition.calories,
        });
      } catch (error) {
        if (
          error instanceof DateRangeError ||
          error instanceof StructParseError ||
          error instanceof GwtParseError
        ) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
