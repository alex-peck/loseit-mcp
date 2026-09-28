import assert from "node:assert/strict";
import { it } from "node:test";

import { parseFoodId } from "./foodModel.js";
import { writeGwtObject } from "./gwtWriter.js";
import { GWT_ARRAY_CLASS, type StructFieldDef } from "./structReader.js";

it("serializes a food primary key and signed GWT bytes", () => {
  const bytes = [-128, 0, 127];
  Object.defineProperty(bytes, GWT_ARRAY_CLASS, { value: "[B/3308590456" });
  const registry = new Map<string, StructFieldDef[]>([
    ["SimplePrimaryKey", [{ name: "f0", type: "obj" }]],
  ]);
  const signatures = new Map([["SimplePrimaryKey", "com.loseit.core.client.model.SimplePrimaryKey/3621315060"]]);
  const table: string[] = [];
  const ref = (s: string) => String(table.indexOf(s) < 0 ? table.push(s) : table.indexOf(s) + 1);
  assert.deepEqual(
    writeGwtObject({ _cls: "SimplePrimaryKey", f0: bytes }, ref, registry, signatures),
    ["1", "2", "3", "-128", "0", "127"],
  );
  assert.deepEqual(table, [
    "com.loseit.core.client.model.SimplePrimaryKey/3621315060",
    "[B/3308590456",
  ]);
});

it("round-trips the canonical 16-byte search food ID", () => {
  const source = [-128, 127, ...Array.from({ length: 14 }, (_, i) => i - 7)];
  const encoded = Buffer.from(source).toString("base64url");
  assert.deepEqual(parseFoodId(encoded), source);
  assert.throws(() => parseFoodId(encoded.slice(0, -1)));
});
