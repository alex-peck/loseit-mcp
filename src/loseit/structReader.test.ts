import assert from "node:assert/strict";
import { test } from "node:test";

import { StructReader } from "./structReader.js";
import type { StructFieldDef } from "./structReader.js";
import { NUTRIENT_BY_INTID } from "./structTypes.js";

function reader(
  values: unknown[],
  stringTable: string[],
  types: Map<string, StructFieldDef[]> = new Map(),
  enums: Set<string> = new Set(),
): StructReader {
  return new StructReader(values, stringTable, types, enums);
}

test("reads a registered object with primitive fields backward", () => {
  const types = new Map<string, StructFieldDef[]>([
    [
      "A",
      [
        { name: "n", type: "int" },
        { name: "flag", type: "boolean" },
      ],
    ],
  ]);
  const stringTable = ["com.example.A/1"];
  // Read order: classref(1), n(42), flag(true=1). Array is reversed.
  const r = reader([1, 42, 1].reverse(), stringTable, types);
  const obj = r.readObject() as Record<string, unknown>;
  assert.equal(obj._cls, "A");
  assert.equal(obj.n, 42);
  assert.equal(obj.flag, true);
  assert.equal(r.remaining, 0);
});

test("a string literal in an Object slot consumes an object id (back-ref counting)", () => {
  // Regression: a sentence-like string with a '.' but no '/hash' must be treated
  // as a String *instance*, not a class name. It still takes an object id so that
  // a later back-reference resolves to it correctly.
  const types = new Map<string, StructFieldDef[]>([
    [
      "A",
      [
        { name: "x", type: "obj" },
        { name: "y", type: "obj" },
      ],
    ],
  ]);
  const stringTable = ["com.example.A/1", "Eat more food."];
  // Read order: classref A(1), x -> string ref(2), y -> back-ref(-2).
  const r = reader([1, 2, -2].reverse(), stringTable, types);
  const obj = r.readObject() as Record<string, unknown>;
  assert.equal(obj.x, "Eat more food.");
  // If the string had not consumed an object id, this back-ref would be null.
  assert.equal(obj.y, "Eat more food.");
  assert.equal(r.remaining, 0);
});

test("reads a HashMap as an array of key/value pairs", () => {
  const types = new Map<string, StructFieldDef[]>([
    ["Key", [{ name: "id", type: "int" }]],
    ["Double", [{ name: "v", type: "double" }]],
  ]);
  const stringTable = [
    "java.util.HashMap/1",
    "com.example.Key/2",
    "com.example.Double/3",
  ];
  // Read order: HashMap(1), count(1), key -> Key(2){id:7}, value -> Double(3){v:1.5}
  const r = reader([1, 1, 2, 7, 3, 1.5].reverse(), stringTable, types);
  const map = r.readObject() as Array<[unknown, unknown]>;
  assert.equal(map.length, 1);
  const [k, v] = map[0]!;
  assert.equal((k as Record<string, unknown>).id, 7);
  assert.equal((v as Record<string, unknown>).v, 1.5);
  assert.equal(r.remaining, 0);
});

test("reads enums as an ordinal", () => {
  const stringTable = ["com.example.Color/1"];
  const r = reader([1, 2].reverse(), stringTable, new Map(), new Set(["Color"]));
  const e = r.readObject() as Record<string, unknown>;
  assert.equal(e._enum, "Color");
  assert.equal(e.ordinal, 2);
  assert.equal(r.remaining, 0);
});

test("NUTRIENT_BY_INTID maps the stable Lose It nutrient type ids", () => {
  assert.equal(NUTRIENT_BY_INTID[0], "calories");
  assert.equal(NUTRIENT_BY_INTID[3], "fat");
  assert.equal(NUTRIENT_BY_INTID[4], "saturatedFat");
  assert.equal(NUTRIENT_BY_INTID[8], "cholesterol");
  assert.equal(NUTRIENT_BY_INTID[9], "sodium");
  assert.equal(NUTRIENT_BY_INTID[10], "carbohydrates");
  assert.equal(NUTRIENT_BY_INTID[11], "fiber");
  assert.equal(NUTRIENT_BY_INTID[12], "sugars");
  assert.equal(NUTRIENT_BY_INTID[13], "protein");
});
