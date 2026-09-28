import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foodNutrition, foodServingSize } from "./foodModel.js";
import { applyMeasuredPortion } from "./servingPortion.js";
import { StructParseError } from "./structReader.js";

function size(
  measureId: number,
  factorPerReference: number,
  referenceAmount: number,
  amount = referenceAmount,
) {
  return {
    _cls: "FoodServingSize",
    quantity: factorPerReference * amount / referenceAmount,
    measure: { _cls: "FoodMeasure", f0: measureId },
    factorPerReference,
    referenceAmount,
    amount,
  };
}

function draft(defaultSize: ReturnType<typeof size>) {
  return {
    _cls: "FoodLogEntry",
    serving: {
      _cls: "FoodServing",
      servingSize: defaultSize,
      nutrients: {
        _cls: "FoodNutrients",
        portionFactor: defaultSize.quantity,
        nutrients: [
          [{ _cls: "FoodMeasurement", nutrientTypeId: 0 }, { _cls: "Double", v: 100 }],
        ],
      },
    },
  };
}

describe("applyMeasuredPortion", () => {
  it("logs 30 grams from a 100-gram reference without scaling raw nutrients", () => {
    const entry = draft(size(5, 1.18, 1));
    const food = { f2: [size(5, 1.18, 1), size(8, 1, 100)] };
    const result = applyMeasuredPortion(entry, food, { amount: 30, unit: "grams" });

    assert.deepEqual(result, {
      servingSizeIndex: 1,
      requestedAmount: 30,
      requestedUnit: "grams",
    });
    assert.deepEqual(foodServingSize(entry.serving.servingSize), {
      quantity: 0.3, measureId: 8, unit: "Gram", amount: 30, referenceAmount: 100,
    });
    assert.equal(entry.serving.nutrients.portionFactor, 0.3);
    assert.equal(entry.serving.nutrients.nutrients[0]![1]!.v, 100);
    assert.equal(foodNutrition(entry.serving.nutrients, true).calories, 30);
  });

  it("logs 16 fluid ounces from a 12-fluid-ounce reference", () => {
    const entry = draft(size(10, 1, 12));
    const result = applyMeasuredPortion(
      entry, { f2: [size(10, 1, 12)] }, { amount: 16, unit: "fl oz" },
    );

    assert.equal(result.servingSizeIndex, 0);
    assert.equal(entry.serving.servingSize.amount, 16);
    assert.ok(Math.abs(entry.serving.servingSize.quantity - 4 / 3) < 1e-12);
    assert.ok(Math.abs(entry.serving.nutrients.portionFactor - 4 / 3) < 1e-12);
  });

  it("converts fluid ounces to milliliters only when the food offers mL", () => {
    const entry = draft(size(11, 1, 236.588));
    applyMeasuredPortion(
      entry,
      { f2: [size(11, 1, 236.588)] },
      { amount: 16, unit: "fluid ounces" },
    );

    assert.equal(entry.serving.servingSize.measure.f0, 11);
    assert.ok(Math.abs(entry.serving.servingSize.amount - 473.176473) < 0.001);
    assert.ok(Math.abs(entry.serving.nutrients.portionFactor - 2) < 0.00001);
  });

  it("converts grams to ounces when that is the food's only mass unit", () => {
    const entry = draft(size(6, 1, 3.5));
    applyMeasuredPortion(
      entry, { f2: [size(6, 1, 3.5)] }, { amount: 30, unit: "g" },
    );
    assert.equal(entry.serving.servingSize.measure.f0, 6);
    assert.ok(Math.abs(entry.serving.servingSize.amount - 1.05821886) < 1e-7);
    assert.ok(Math.abs(entry.serving.nutrients.portionFactor - 0.30234825) < 1e-7);
  });

  it("rejects mass-to-volume guesses, missing units, and ambiguous options", () => {
    assert.throws(
      () => applyMeasuredPortion(
        draft(size(11, 1, 100)), { f2: [size(11, 1, 100)] },
        { amount: 30, unit: "grams" },
      ),
      StructParseError,
    );
    assert.throws(
      () => applyMeasuredPortion(
        draft(size(8, 1, 100)), { f2: [size(8, 1, 100), size(8, 2, 100)] },
        { amount: 30, unit: "grams" },
      ),
      /Multiple Gram serving sizes/,
    );
    assert.throws(
      () => applyMeasuredPortion(
        draft(size(8, 1, 100)), { f2: [size(8, 1, 100)] },
        { amount: 30, servingSizeIndex: 2 },
      ),
      StructParseError,
    );
  });

  it("uses an exact serving-size index when multiple sizes have the same unit", () => {
    const entry = draft(size(8, 1, 100));
    applyMeasuredPortion(
      entry,
      { f2: [size(8, 1, 100), size(8, 2, 100)] },
      { amount: 30, servingSizeIndex: 1 },
    );
    assert.equal(entry.serving.servingSize.amount, 30);
    assert.equal(entry.serving.nutrients.portionFactor, 0.6);
  });

  it("uses an index to disambiguate a conversion while retaining the requested unit", () => {
    const entry = draft(size(6, 1, 3.5));
    const food = { f2: [size(6, 1, 3.5), size(7, 1, 1)] };
    assert.throws(
      () => applyMeasuredPortion(draft(size(6, 1, 3.5)), food, {
        amount: 30, unit: "grams",
      }),
      /compatible servingSizeIndex/,
    );
    const result = applyMeasuredPortion(entry, food, {
      amount: 30, unit: "grams", servingSizeIndex: 0,
    });

    assert.equal(result.requestedUnit, "grams");
    assert.equal(entry.serving.servingSize.measure.f0, 6);
    assert.ok(Math.abs(entry.serving.servingSize.amount - 1.05821886) < 1e-7);
  });

  it("resolves duplicate unit labels using a selected serving-size index", () => {
    const entry = draft(size(40, 1, 1));
    applyMeasuredPortion(
      entry,
      { f2: [size(2, 1, 1), size(40, 1, 1)] },
      { amount: 2, unit: "Tablespoon", servingSizeIndex: 1 },
    );
    assert.equal(entry.serving.servingSize.measure.f0, 40);
    assert.equal(entry.serving.servingSize.amount, 2);
  });

  it("rejects a changed upstream serving formula before sending a write", () => {
    const option = size(8, 1, 100);
    option.quantity = 10;
    assert.throws(
      () => applyMeasuredPortion(
        draft(size(8, 1, 100)), { f2: [option] },
        { amount: 30, unit: "grams" },
      ),
      /Unrecognized serving-size conversion/,
    );
  });

  it("rejects non-finite fields in the source serving descriptors", () => {
    const defaultEntry = draft(size(8, 1, 100));
    defaultEntry.serving.servingSize.amount = Number.NaN;
    assert.throws(
      () => applyMeasuredPortion(
        defaultEntry, { f2: [size(8, 1, 100)] },
        { amount: 30, unit: "grams" },
      ),
      /Unrecognized serving-size conversion/,
    );

    const option = size(8, 1, 100);
    option.amount = Number.NaN;
    assert.throws(
      () => applyMeasuredPortion(
        draft(size(8, 1, 100)), { f2: [option] },
        { amount: 30, unit: "grams" },
      ),
      /Unrecognized serving-size conversion/,
    );
  });
});
