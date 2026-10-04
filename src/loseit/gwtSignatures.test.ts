import assert from "node:assert/strict";
import { it } from "node:test";

import { gwtSignaturesFromCacheJs } from "./client.js";
import { responseSignatures } from "./gwtWriter.js";

it("prefers java.util.Date and Lose It models regardless of bundle order", () => {
  const signatures = [
    "java.sql.Date/730999118", "java.util.Date/3385151746",
    "com.other.Example/1", "com.loseit.core.Example/2",
    "[Ljava.sql.Date;/1", "[Ljava.util.Date;/2",
  ];
  for (const table of [signatures, [...signatures].reverse()]) {
    const map = gwtSignaturesFromCacheJs(table.map((signature) => `'${signature}'`).join(";"));
    assert.equal(map.get("Date"), "java.util.Date/3385151746");
    assert.equal(map.get("Example"), "com.loseit.core.Example/2");
    assert.equal(map.get("Date;"), "[Ljava.util.Date;/2");
    assert.deepEqual(responseSignatures({ stringTable: table, values: [], flags: 0, version: 7 }), map);
  }
});
