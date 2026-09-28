import assert from "node:assert/strict";
import { it } from "node:test";

import { extractFoodSearch } from "./foodSearch.js";
import { writeGwtObject } from "./gwtWriter.js";
import { GWT_ARRAY_CLASS, type StructFieldDef } from "./structReader.js";

it("decodes signed food IDs and retains the lookup source from search results", () => {
  const bytes = Array.from({ length: 16 }, (_, index) => index - 8);
  Object.defineProperty(bytes, GWT_ARRAY_CLASS, { value: "[B/3308590456" });
  const rows = [{
    _cls: "SearchResultFood",
    f0: { _cls: "SimplePrimaryKey", f0: bytes },
    f1: "Short name",
    f2: null,
    f3: "Full food name",
    f4: "Brand",
    f5: null,
    f6: 0,
  }];
  Object.defineProperty(rows, GWT_ARRAY_CLASS, { value: "java.util.ArrayList/4159755760" });
  const registry = new Map<string, StructFieldDef[]>([
    ["LoseItRemoteServiceResponse", [{ name: "f3", type: "obj" }]],
    ["SearchResults", [{ name: "f0", type: "obj" }, { name: "f1", type: "int" }]],
    ["SearchResultFood", [
      { name: "f0", type: "obj" }, { name: "f1", type: "string" },
      { name: "f2", type: "string" }, { name: "f3", type: "string" },
      { name: "f4", type: "string" }, { name: "f5", type: "obj" },
      { name: "f6", type: "int" },
    ]],
    ["SimplePrimaryKey", [{ name: "f0", type: "obj" }]],
  ]);
  const signatures = new Map([...registry.keys()].map((name) => [
    name,
    `com.loseit.core.client.model.search.${name}/1`,
  ]));
  const stringTable: string[] = [];
  const ref = (value: string) => {
    const index = stringTable.indexOf(value);
    return String(index < 0 ? stringTable.push(value) : index + 1);
  };
  const tokens = writeGwtObject(
    { _cls: "LoseItRemoteServiceResponse", f3: { _cls: "SearchResults", f0: rows, f1: 1 } },
    ref,
    registry,
    signatures,
  );
  const result = extractFoodSearch({
    values: tokens.reverse().map(Number),
    stringTable,
    version: 7,
    flags: 0,
  }, registry);
  assert.deepEqual(result, {
    foods: [{
      foodId: Buffer.from(bytes).toString("base64url"),
      name: "Full food name",
      brand: "Brand",
      source: null,
    }],
    totalResults: 1,
  });
});
