import type { GwtResponse } from "./gwt.js";
import { responseSignatures } from "./gwtWriter.js";
import { StructReader, StructParseError, type StructFieldDef } from "./structReader.js";
import { NUTRIENT_BY_INTID } from "./structTypes.js";

export type FoodObject = Record<string, unknown>;

const FOOD_MEASURES = [
  "None", "Teaspoon", "Tablespoon", "Cup", "Piece", "Each", "Ounce", "Pound",
  "Gram", "Kilogram", "Fluid ounce", "Milliliter", "Liter", "Gallon", "Pint",
  "Quart", "Milligram", "Microgram", "Intake", "Bottle", "Box", "Can", "Cube",
  "Jar", "Stick", "Tablet", "Slice", "Serving", "300 Can", "303 Can",
  "401 Can", "404 Can", "Ind Package", "Scoop", "Metric Cup", "Dry Cup",
  "Imperial Fluid Ounce", "Imperial Gallon", "Imperial Quart", "Imperial Pint",
  "Tablespoon", "Dessertspoon", "Pot", "Punnet", "As Entered", "Container",
  "Package", "Pouch",
] as const;

export function foodMeasureName(id: number): string {
  return FOOD_MEASURES[id] ?? `Unknown (${id})`;
}

export function foodMeasures(): Array<{ id: number; unit: string }> {
  return FOOD_MEASURES.map((unit, id) => ({ id, unit }));
}

export function asFoodObject(value: unknown, expected: string): FoodObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as FoodObject)._cls !== expected
  ) {
    throw new StructParseError(`Expected ${expected} in Lose It response`);
  }
  return value as FoodObject;
}

export function readFoodResponse(
  raw: GwtResponse,
  registry: Map<string, StructFieldDef[]> | null,
  expected: string,
): { data: FoodObject; registry: Map<string, StructFieldDef[]>; signatures: Map<string, string> } {
  if (!registry) {
    throw new StructParseError(
      "Food details require the live GWT model registry; check GWT auto-discovery",
    );
  }
  const reader = new StructReader(raw.values, raw.stringTable, registry, new Set());
  const response = asFoodObject(reader.readObject(), "LoseItRemoteServiceResponse");
  if (reader.remaining !== 0) {
    throw new StructParseError("Food response has unread GWT tokens");
  }
  return {
    data: asFoodObject(response.f3, expected),
    registry,
    signatures: responseSignatures(raw),
  };
}

export function parseFoodId(foodId: string): number[] {
  if (!/^[A-Za-z0-9_-]{22}$/.test(foodId)) {
    throw new StructParseError("Invalid foodId; select a food from loseit_search_foods");
  }
  const bytes = Buffer.from(foodId, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== foodId) {
    throw new StructParseError("Invalid foodId; select a food from loseit_search_foods");
  }
  return [...bytes].map((byte) => byte > 127 ? byte - 256 : byte);
}

export function foodNutrition(
  nutrients: unknown,
  applyPortionFactor = false,
): Record<string, number> {
  // Draft measurements are unscaled; logged entries already contain portion totals.
  const food = asFoodObject(nutrients, "FoodNutrients");
  if (!Array.isArray(food.nutrients)) {
    throw new StructParseError("Food has no nutrient measurements");
  }
  const factor = applyPortionFactor ? food.portionFactor : 1;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    throw new StructParseError("Invalid food portion factor");
  }
  const values: Record<string, number> = {};
  for (const pair of food.nutrients) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new StructParseError("Invalid food nutrient measurement");
    }
    const key = asFoodObject(pair[0], "FoodMeasurement");
    if (pair[1] === null) continue;
    const value = asFoodObject(pair[1], "Double");
    if (
      typeof key.nutrientTypeId !== "number" ||
      typeof value.v !== "number" ||
      !Number.isFinite(value.v)
    ) {
      throw new StructParseError("Invalid food nutrient measurement");
    }
    values[NUTRIENT_BY_INTID[key.nutrientTypeId] ?? `nutrientId${key.nutrientTypeId}`] =
      Math.round(value.v * factor * 100) / 100;
  }
  return values;
}

export function foodServingSize(servingSize: unknown): {
  quantity: number;
  measureId: number | null;
  unit: string | null;
  amount: number;
  referenceAmount: number;
} {
  const size = asFoodObject(servingSize, "FoodServingSize");
  const measure = size.measure === null
    ? null
    : asFoodObject(size.measure, "FoodMeasure");
  const measureId = measure?.f0;
  if (
    typeof size.quantity !== "number" ||
    typeof size.amount !== "number" ||
    typeof size.referenceAmount !== "number" ||
    (measure !== null && typeof measureId !== "number")
  ) {
    throw new StructParseError("Invalid food serving size");
  }
  return {
    quantity: size.quantity,
    measureId: typeof measureId === "number" ? measureId : null,
    unit: typeof measureId === "number" ? foodMeasureName(measureId) : null,
    amount: size.amount,
    referenceAmount: size.referenceAmount,
  };
}
