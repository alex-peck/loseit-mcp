import {
  asFoodObject,
  foodMeasureName,
  foodMeasures,
  foodServingSize,
  type FoodObject,
} from "./foodModel.js";
import { StructParseError } from "./structReader.js";

export interface MeasuredPortion {
  amount: number;
  unit?: string | undefined;
  servingSizeIndex?: number | undefined;
}

const UNIT_ALIASES: Record<string, number> = {
  g: 8, gram: 8, grams: 8,
  kg: 9, kilogram: 9, kilograms: 9,
  mg: 16, milligram: 16, milligrams: 16,
  oz: 6, ounce: 6, ounces: 6,
  lb: 7, lbs: 7, pound: 7, pounds: 7,
  "fl oz": 10, "fluid oz": 10, "fluid ounce": 10, "fluid ounces": 10,
  ml: 11, milliliter: 11, milliliters: 11,
  l: 12, liter: 12, liters: 12,
};

const MASS_GRAMS: Record<number, number> = {
  6: 28.349523125,
  7: 453.59237,
  8: 1,
  9: 1000,
  16: 0.001,
  17: 0.000001,
};

const VOLUME_ML: Record<number, number> = {
  10: 29.5735295625,
  11: 1,
  12: 1000,
};

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
}

function unitId(unit: string, selectedId?: number): number | null {
  const normalized = normalizeUnit(unit);
  const alias = UNIT_ALIASES[normalized];
  if (alias !== undefined) return alias;
  const matches = foodMeasures().filter(
    (measure) => normalizeUnit(measure.unit) === normalized,
  );
  if (matches.length === 1) return matches[0]!.id;
  return matches.find((measure) => measure.id === selectedId)?.id ?? null;
}

function selectServingSize(
  sizes: FoodObject[],
  portion: MeasuredPortion,
): { size: FoodObject; index: number; amount: number; requestedUnit: string } {
  if (!Number.isFinite(portion.amount) || portion.amount <= 0) {
    throw new StructParseError("Portion amount must be positive and finite");
  }
  if (portion.unit === undefined && portion.servingSizeIndex === undefined) {
    throw new StructParseError("Specify portion.unit or portion.servingSizeIndex");
  }

  const measured = sizes.map((size, index) => ({
    size,
    index,
    measureId: foodServingSize(size).measureId,
  }));
  let options = measured;
  if (portion.servingSizeIndex !== undefined) {
    const index = portion.servingSizeIndex;
    if (!Number.isInteger(index) || index < 0 || index >= sizes.length) {
      throw new StructParseError("Unknown servingSizeIndex; inspect loseit_get_food");
    }
    options = [measured[index]!];
  }
  const requestedId = portion.unit === undefined
    ? null
    : unitId(portion.unit, options.length === 1
      ? options[0]!.measureId ?? undefined
      : undefined);
  if (portion.unit !== undefined && requestedId === null) {
    throw new StructParseError(
      `Unknown or ambiguous unit "${portion.unit}"; use a unit from loseit_get_food`,
    );
  }

  if (requestedId === null) {
    const option = options[0]!;
    if (option.measureId === null) {
      throw new StructParseError("The selected serving size has no measurable unit");
    }
    return {
      size: option.size,
      index: option.index,
      amount: portion.amount,
      requestedUnit: foodMeasureName(option.measureId),
    };
  }

  const exact = options.filter((option) => option.measureId === requestedId);
  if (exact.length > 1) {
    throw new StructParseError(
      `Multiple ${foodMeasureName(requestedId)} serving sizes; choose a servingSizeIndex from loseit_get_food`,
    );
  }
  if (exact.length === 1) {
    return {
      size: exact[0]!.size,
      index: exact[0]!.index,
      amount: portion.amount,
      requestedUnit: portion.unit!,
    };
  }

  const conversions = MASS_GRAMS[requestedId] === undefined
    ? VOLUME_ML
    : MASS_GRAMS;
  const requestedFactor = conversions[requestedId];
  if (requestedFactor === undefined) {
    throw new StructParseError(
      `This food has no ${foodMeasureName(requestedId)} serving size; inspect loseit_get_food`,
    );
  }
  const compatible = options.filter((option) =>
    option.measureId !== null && conversions[option.measureId] !== undefined
  );
  if (compatible.length !== 1) {
    throw new StructParseError(
      `This food has no unambiguous compatible unit for ${portion.unit}; choose a compatible servingSizeIndex from loseit_get_food`,
    );
  }
  const option = compatible[0]!;
  return {
    size: option.size,
    index: option.index,
    amount: portion.amount * requestedFactor / conversions[option.measureId!]!,
    requestedUnit: portion.unit!,
  };
}

export function applyMeasuredPortion(
  entry: FoodObject,
  food: FoodObject,
  portion: MeasuredPortion,
): { servingSizeIndex: number; requestedAmount: number; requestedUnit: string } {
  const serving = asFoodObject(entry.serving, "FoodServing");
  const defaultSize = asFoodObject(serving.servingSize, "FoodServingSize");
  const nutrients = asFoodObject(serving.nutrients, "FoodNutrients");
  if (!Array.isArray(food.f2)) {
    throw new StructParseError("Food serving sizes are unavailable");
  }
  const sizes = food.f2.map((size) => asFoodObject(size, "FoodServingSize"));
  const selected = selectServingSize(sizes, portion);
  const size = selected.size;
  const reference = size.referenceAmount;
  const factor = size.factorPerReference;
  const defaultReference = defaultSize.referenceAmount;
  if (
    typeof reference !== "number" || !Number.isFinite(reference) || reference <= 0 ||
    typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0 ||
    typeof size.amount !== "number" || !Number.isFinite(size.amount) ||
      size.amount <= 0 ||
    typeof size.quantity !== "number" || !Number.isFinite(size.quantity) ||
    Math.abs(size.quantity - factor * size.amount / reference) >
      1e-7 * Math.max(1, size.quantity) ||
    typeof defaultSize.quantity !== "number" ||
      !Number.isFinite(defaultSize.quantity) || defaultSize.quantity <= 0 ||
    typeof defaultReference !== "number" ||
      !Number.isFinite(defaultReference) || defaultReference <= 0 ||
    typeof defaultSize.factorPerReference !== "number" ||
      !Number.isFinite(defaultSize.factorPerReference) ||
      defaultSize.factorPerReference <= 0 ||
    typeof defaultSize.amount !== "number" ||
      !Number.isFinite(defaultSize.amount) || defaultSize.amount <= 0 ||
    Math.abs(
      defaultSize.quantity -
      defaultSize.factorPerReference * defaultSize.amount / defaultReference,
    ) > 1e-7 * Math.max(1, defaultSize.quantity) ||
    typeof nutrients.portionFactor !== "number" ||
      !Number.isFinite(nutrients.portionFactor) || nutrients.portionFactor <= 0
  ) {
    throw new StructParseError("Unrecognized serving-size conversion; food was not logged");
  }

  // A descriptor's quantity is its reference portion scaled by the requested amount.
  const quantity = factor * selected.amount / reference;
  const portionFactor = nutrients.portionFactor * quantity / defaultSize.quantity;
  if (
    !Number.isFinite(quantity) || quantity <= 0 ||
    !Number.isFinite(portionFactor) || portionFactor <= 0 ||
    portionFactor > 100_000
  ) {
    throw new StructParseError("Portion is outside the supported range");
  }

  size.amount = selected.amount;
  size.quantity = quantity;
  nutrients.portionFactor = portionFactor;
  serving.servingSize = size;
  return {
    servingSizeIndex: selected.index,
    requestedAmount: portion.amount,
    requestedUnit: selected.requestedUnit,
  };
}
