import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dateToDayNumber } from "../loseit/gwt.js";
import { foodNutrition } from "../loseit/foodModel.js";
import type { FoodLogItem } from "../loseit/extractors.js";
import { assertFoodSaved, findLoggedFood, prepareFoodEntry } from "./logFood.js";

function draft() {
  return {
    _cls: "FoodLogEntry",
    context: {
      _cls: "FoodLogEntryContext",
      dayDate: { _cls: "DayDate", f0: { _cls: "Date" }, dayNumber: 9000, f2: -5 },
      mealType: { _cls: "FoodLogEntryType", f0: 0 },
    },
    serving: {
      _cls: "FoodServing",
      servingSize: {
        _cls: "FoodServingSize",
        quantity: 1.5,
        amount: 1,
        referenceAmount: 1,
        factorPerReference: 1.5,
        measure: { _cls: "FoodMeasure", f0: 27 },
      },
      nutrients: {
        _cls: "FoodNutrients",
        portionFactor: 1.25,
        nutrients: [
          [{ _cls: "FoodMeasurement", nutrientTypeId: 0 }, { _cls: "Double", v: 120 }],
          [{ _cls: "FoodMeasurement", nutrientTypeId: 13 }, { _cls: "Double", v: 4 }],
        ],
      },
    },
  };
}

describe("prepareFoodEntry", () => {
  it("moves the draft to a chosen meal and day and scales all nutrients", () => {
    const entry = draft();
    const day = dateToDayNumber(new Date("2026-01-15"));
    prepareFoodEntry(entry, day, "America/Chicago", "dinner", 2);
    assert.equal(entry.context.mealType.f0, 2);
    assert.equal(entry.context.dayDate.dayNumber, day);
    assert.equal(entry.context.dayDate.f0, null);
    assert.equal(entry.context.dayDate.f2, -6);
    assert.equal(entry.serving.servingSize.quantity, 3);
    assert.equal(entry.serving.servingSize.amount, 2);
    assert.equal(entry.serving.nutrients.portionFactor, 2.5);
    assert.deepEqual(entry.serving.nutrients.nutrients.map((pair) => pair[1]!.v), [120, 4]);
    assert.equal(foodNutrition(entry.serving.nutrients, true).calories, 300);
  });

  it("keeps the original day's Date when logging the default serving", () => {
    const entry = draft();
    const date = entry.context.dayDate.f0;
    prepareFoodEntry(entry, 9000, "America/Chicago", "snacks", 1);
    assert.equal(entry.context.dayDate.f0, date);
    assert.equal(entry.context.mealType.f0, 3);
    assert.equal(entry.serving.nutrients.nutrients[0]![1]!.v, 120);
    assert.equal(entry.serving.servingSize.amount, 1);
  });

  function logged(overrides: Partial<FoodLogItem> = {}): FoodLogItem {
    return {
      entryId: "new-entry",
      foodId: "search-food",
      name: "Food",
      brand: "Brand",
      meal: "snacks",
      quantity: 0.3,
      servingAmount: 30,
      servingUnit: "Gram",
      nutrition: {
        calories: 30,
        fat: null,
        saturatedFat: null,
        cholesterol: null,
        sodium: null,
        carbohydrates: null,
        fiber: null,
        sugars: null,
        protein: null,
      },
      ...overrides,
    };
  }

  const selection = {
    foodId: "search-food",
    name: "Food",
    brand: "Brand",
    meal: "snacks" as const,
    size: { amount: 30, unit: "Gram", quantity: 0.3, measureId: 8, referenceAmount: 100 },
    expectedCalories: 30,
  };

  describe("findLoggedFood", () => {
    it("matches a new entry when the logged food key differs from the search key", () => {
      const item = logged({ foodId: "different-key" });
      assert.equal(findLoggedFood(new Set(), [item], selection), item);
    });

    it("does not accept an unrelated food with the same amount and calories", () => {
      const item = logged({ foodId: "different-key", name: "Renamed on save" });
      assert.throws(
        () => findLoggedFood(new Set(), [item], selection),
        /Could not uniquely verify/,
      );
    });

    it("refuses ambiguous or mismatched entries", () => {
      assert.throws(
        () => findLoggedFood(new Set(), [logged(), logged({ entryId: "another" })], selection),
        /Could not uniquely verify/,
      );
      assert.throws(
        () => findLoggedFood(new Set(), [logged({ servingAmount: 31 })], selection),
        /Could not uniquely verify/,
      );
      assert.throws(
        () => findLoggedFood(new Set(), [logged({ nutrition: {
          ...logged().nutrition, calories: 60,
        } })], selection),
        /Could not uniquely verify/,
      );
      assert.throws(
        () => findLoggedFood(new Set(), [logged({ foodId: "other", name: "Other" })], selection),
        /Could not uniquely verify/,
      );
    });

    it("checks the total serving amount for default-serving multiples", () => {
      const item = logged({ servingAmount: 1, nutrition: {
        ...logged().nutrition, calories: 60,
      } });
      assert.throws(
        () => findLoggedFood(new Set(), [item], {
          ...selection,
          size: { ...selection.size, amount: 2 },
          expectedCalories: 60,
        }),
        /Could not uniquely verify/,
      );
    });
  });

  it("does not treat a negative or missing save acknowledgment as success", () => {
    assert.doesNotThrow(() => assertFoodSaved(true));
    assert.throws(() => assertFoodSaved(false), /Food save was not confirmed/);
    assert.throws(() => assertFoodSaved(undefined), /Food save was not confirmed/);
  });

  it("uses the target day's post-transition timezone offset", () => {
    const entry = draft();
    const day = dateToDayNumber(new Date("2026-03-08"));
    prepareFoodEntry(entry, day, "America/Chicago", "breakfast", 1);
    assert.equal(entry.context.dayDate.f2, -5);
  });
});
