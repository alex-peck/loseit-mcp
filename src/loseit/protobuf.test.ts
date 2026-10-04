import assert from "node:assert/strict";
import { it } from "node:test";

import { decodeMessage, getNumber, getRepeatedVarints, getVarint, ProtoWriter } from "./protobuf.js";

it("rejects oversized or truncated protobuf values", () => {
  assert.throws(() => decodeMessage(Uint8Array.of(8, 128)), /Truncated varint/);
  assert.throws(() => decodeMessage(Uint8Array.of(10, 3, 0)), /Truncated length/);
  assert.throws(() => decodeMessage(Uint8Array.of(8, ...new Array(9).fill(255), 2)), /exceeds uint64/);
  assert.throws(() => getNumber(decodeMessage(new ProtoWriter().uint(1, 1n << 63n).finish()), 1), /safe integer/);
  assert.throws(() => new ProtoWriter().uint(1, Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  assert.throws(() => new ProtoWriter().uint(1, 1n << 64n), /outside uint64/);
  assert.throws(() => new ProtoWriter().uint(0, 1), /Invalid field/);
  assert.throws(() => new ProtoWriter().float(1, Infinity), /finite/);
});

it("supports packed acknowledgements and the maximum protobuf field number", () => {
  const message = decodeMessage(new ProtoWriter().bytes(1, Uint8Array.of(1, 2, 172, 2)).uint(1, 3).finish());
  assert.deepEqual(getRepeatedVarints(message, 1), [1n, 2n, 300n, 3n]);
  assert.equal(getVarint(decodeMessage(new ProtoWriter().uint(0x1fffffff, 42).finish()), 0x1fffffff), 42n);
});
