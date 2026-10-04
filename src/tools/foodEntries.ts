import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { isGwtObject, loadDayGraph, objectParam, primaryKeyId, type GwtObject } from "../loseit/dayGraph.js";
import type { FoodLogItem } from "../loseit/extractors.js";
import { asFoodObject, foodNutrition, foodServingSize, readFoodResponse } from "../loseit/foodModel.js";
import { dayNumberToDate, GwtParseError } from "../loseit/gwt.js";
import { applyMeasuredPortion } from "../loseit/servingPortion.js";
import { StructParseError, StructReader } from "../loseit/structReader.js";
import { WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { loadIdentifiedFoodLog, prepareFoodEntry } from "./logFood.js";
import { errorResponse, textResponse } from "./response.js";
import { writeScopeError, writeToolMeta, type WriteAuth } from "./writeAuth.js";

const entrySchema = {
  entryId: z.string().regex(/^[A-Za-z0-9_-]{22}$/).describe("entryId from loseit_get_food_log."),
  date: z.string().optional().describe("Date the entry is logged on (YYYY-MM-DD). Defaults to today."),
};

function isoDate(dayNumber: number): string {
  return dayNumberToDate(dayNumber).toISOString().slice(0, 10);
}

async function findEntry(client: LoseItClient, dayNumber: number, entryId: string) {
  const graph = await loadDayGraph(client, dayNumber);
  const entry = graph.objects.find((object): object is GwtObject =>
    isGwtObject(object, "FoodLogEntry") && primaryKeyId(object.entryKey) === entryId);
  if (!entry) {
    throw new StructParseError(`No food entry ${entryId} on ${isoDate(dayNumber)}; check loseit_get_food_log`);
  }
  return { graph, entry };
}

const MEAL_ORDINAL = { breakfast: 0, lunch: 1, dinner: 2, snacks: 3 } as const;

/** Whether getFood returned a database food (it answers null for some logged foods). */
function hasFoodDetails(client: LoseItClient, raw: { values: unknown[]; stringTable: string[] }): boolean {
  const registry = client.getGwtRegistry();
  if (!registry) throw new StructParseError("Food details require the live GWT model registry");
  const response = new StructReader(raw.values, raw.stringTable, registry, new Set()).readObject();
  return isGwtObject(response, "LoseItRemoteServiceResponse") &&
    isGwtObject(response.f3, "FoodForFoodDatabase");
}

function sameUnit(a: string, b: string): boolean {
  const norm = (unit: string) => unit.trim().toLowerCase().replace(/e?s$/, "");
  return norm(a) === norm(b);
}

/**
 * Rescale a stored entry the way the web app edits one whose food has no
 * database record: per-reference nutrients (stored totals divided by the old
 * portion factor) plus the new portion factor, amount and quantity, in the
 * entry's own unit.
 */
export function rescaleStoredEntry(
  entry: GwtObject,
  meal: keyof typeof MEAL_ORDINAL,
  amount: number,
): GwtObject {
  const serving = asFoodObject(entry.serving, "FoodServing");
  const size = asFoodObject(serving.servingSize, "FoodServingSize");
  const nutrients = asFoodObject(serving.nutrients, "FoodNutrients");
  const factor = nutrients.portionFactor;
  if (
    typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0 ||
    typeof size.amount !== "number" || !Number.isFinite(size.amount) || size.amount <= 0 ||
    typeof size.quantity !== "number" || typeof size.factorPerReference !== "number" ||
    typeof size.referenceAmount !== "number" || !Array.isArray(nutrients.nutrients)
  ) {
    throw new StructParseError("This entry's stored serving cannot be rescaled");
  }
  const scale = amount / size.amount;
  for (const pair of nutrients.nutrients) {
    const value = Array.isArray(pair) ? pair[1] : null;
    if (isGwtObject(value, "Double") && typeof value.v === "number") value.v /= factor;
  }
  nutrients.f0 = 1;
  nutrients.portionFactor = factor * scale;
  size.factorPerReference /= factor;
  size.referenceAmount /= factor;
  size.quantity *= scale;
  size.amount = amount;
  const context = asFoodObject(entry.context, "FoodLogEntryContext");
  const mealType = asFoodObject(context.mealType, "FoodLogEntryType");
  if (mealType.f0 !== MEAL_ORDINAL[meal]) {
    mealType.f0 = MEAL_ORDINAL[meal];
    context.f9 = null;
  }
  return entry;
}

function describe(item: FoodLogItem | undefined) {
  return item && {
    entryId: item.entryId,
    name: item.name,
    brand: item.brand,
    meal: item.meal,
    servingAmount: item.servingAmount,
    servingUnit: item.servingUnit,
    calories: item.nutrition.calories,
  };
}

function handleError(error: unknown) {
  if (error instanceof StructParseError || error instanceof GwtParseError || error instanceof DateRangeError) {
    return errorResponse(error);
  }
  throw error;
}

export function registerFoodEntryTools(server: McpServer, client: LoseItClient, writeAuth: WriteAuth): void {
  server.registerTool(
    "loseit_update_food_entry",
    {
      title: "Update Food Entry",
      description:
        "Changes a logged food's amount and/or meal. For the amount, give portion " +
        "{amount, unit}; unit defaults to the entry's current servingUnit (for example " +
        "{amount: 2} on an entry logged as 1 Each makes it 2 Each). Other units are " +
        "converted like loseit_log_food. Nutrition is recalculated by Lose It.",
      inputSchema: {
        ...entrySchema,
        meal: z.enum(["breakfast", "lunch", "dinner", "snacks"]).optional(),
        portion: z.object({
          amount: z.number().positive().finite().max(100_000),
          unit: z.string().trim().min(1).optional(),
          servingSizeIndex: z.number().int().min(0).optional(),
        }).optional(),
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ entryId, date, meal, portion }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Editing a food entry");
      if (denied) return denied;
      try {
        if (!meal && !portion) throw new StructParseError("Specify meal or portion");
        const dayNumber = resolveDayNumber(date, client);
        const before = await loadIdentifiedFoodLog(client, dayNumber);
        const current = before.find((item) => item.entryId === entryId);
        const { graph, entry: existing } = await findEntry(client, dayNumber, entryId);
        if (!current?.foodId || current.servingAmount === null || !current.servingUnit || !current.meal) {
          throw new StructParseError("This entry's food or serving cannot be identified");
        }

        const targetMeal = meal ?? current.meal;
        const { raw: foodRaw } = await client.getFoodDetails(current.foodId);
        if (!hasFoodDetails(client, foodRaw)) {
          // Lose It has no database record for some logged foods (for example
          // entries saved through saveCustomFoodLogEntry get their own food
          // key). The web app then rescales the stored entry in its own unit.
          if ((portion?.unit !== undefined && !sameUnit(portion.unit, current.servingUnit)) ||
            portion?.servingSizeIndex !== undefined) {
            throw new StructParseError(
              `Lose It has no serving sizes for this entry's food; give the amount in ${current.servingUnit}`,
            );
          }
          const rescaled = rescaleStoredEntry(existing, targetMeal, portion?.amount ?? current.servingAmount);
          await client.gwtWriteWithParams("updateFoodLogEntry", [objectParam(rescaled, graph)]);
          const after = (await loadIdentifiedFoodLog(client, dayNumber)).find((item) => item.entryId === entryId);
          const amount = portion?.amount ?? current.servingAmount;
          if (!after || after.meal !== targetMeal || after.servingUnit !== current.servingUnit ||
            after.servingAmount === null || Math.abs(after.servingAmount - amount) > 1e-3 * Math.max(1, amount)) {
            throw new StructParseError("Lose It did not apply the change; check loseit_get_food_log");
          }
          return textResponse({ updated: true, date: isoDate(dayNumber), before: describe(current), after: describe(after) });
        }

        // Rebuild the serving from the food itself, as the web app does: the
        // stored entry holds portion totals, an update carries per-reference
        // nutrients plus a portion factor.
        const { raw: draftRaw } = await client.getFoodDraft(current.foodId, null, current.name);
        const draft = readFoodResponse(draftRaw, client.getGwtRegistry(), "FoodLogEntry");
        const rebuilt = prepareFoodEntry(draft.data, dayNumber, client.getTimezone(), targetMeal, 1);
        const food = readFoodResponse(foodRaw, client.getGwtRegistry(), "FoodForFoodDatabase");
        const identifier = asFoodObject(rebuilt.identifier, "FoodIdentifier");
        const foodIdentifier = asFoodObject(food.data.f0, "FoodIdentifier");
        if (primaryKeyId(identifier.primaryKey) !== current.foodId ||
          primaryKeyId(foodIdentifier.primaryKey) !== current.foodId) {
          throw new StructParseError("Lose It returned a different food; the entry was not changed");
        }
        applyMeasuredPortion(rebuilt, food.data, {
          amount: portion?.amount ?? current.servingAmount,
          unit: portion?.unit ?? (portion?.servingSizeIndex === undefined ? current.servingUnit : undefined),
          servingSizeIndex: portion?.servingSizeIndex,
        });
        // Keep the draft's edit context, matching the web app's request.
        // Stored contexts include server-only flags and old meal extras.
        rebuilt.entryKey = existing.entryKey;
        const signatures = new Map([...client.getGwtSignatures(), ...draft.signatures, ...food.signatures]);
        await client.gwtWriteWithParams("updateFoodLogEntry", [
          objectParam(rebuilt as GwtObject, { registry: draft.registry, signatures }),
        ]);

        const after = (await loadIdentifiedFoodLog(client, dayNumber)).find((item) => item.entryId === entryId);
        const size = foodServingSize(asFoodObject(rebuilt.serving, "FoodServing").servingSize);
        const calories = foodNutrition(asFoodObject(rebuilt.serving, "FoodServing").nutrients, true).calories;
        if (!after || after.meal !== targetMeal || after.servingUnit !== size.unit ||
          (calories !== undefined && (after.nutrition.calories === null ||
            Math.abs(after.nutrition.calories - calories) > Math.max(1, Math.abs(calories) * 0.02))) ||
          after.servingAmount === null || Math.abs(after.servingAmount - size.amount) > 1e-3 * Math.max(1, size.amount)) {
          throw new StructParseError("Lose It did not apply the change; check loseit_get_food_log");
        }
        return textResponse({ updated: true, date: isoDate(dayNumber), before: describe(current), after: describe(after) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_delete_food_entry",
    {
      title: "Delete Food Entry",
      description: "Deletes a logged food from a day's log.",
      inputSchema: entrySchema,
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ entryId, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Deleting a food entry");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const before = (await loadIdentifiedFoodLog(client, dayNumber)).find((item) => item.entryId === entryId);
        const { graph, entry } = await findEntry(client, dayNumber, entryId);
        await client.gwtWriteWithParams("deleteFoodLogEntry", [objectParam(entry, graph)]);
        const stillThere = (await loadIdentifiedFoodLog(client, dayNumber)).some((item) => item.entryId === entryId);
        if (stillThere) throw new StructParseError("Lose It did not delete the entry; check loseit_get_food_log");
        return textResponse({ deleted: true, date: isoDate(dayNumber), entry: describe(before) });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
