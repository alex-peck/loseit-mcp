import assert from "node:assert/strict";
import { it } from "node:test";

import { buildBundle, decodeFast, encodeFast, FastingStore, newEntityId, parseBundleResponse, type Fast } from "./fasting.js";
import type { LoseItClient } from "./client.js";
import { decodeMessage, getRepeatedMessages, getVarint, ProtoWriter } from "./protobuf.js";

// Synthetic wire fixture matching the observed iOS 18.5.400 field layout.
// All entity IDs, account IDs, timestamps, and goal values are fictional.
const END_FAST_REQUEST =
  "0a7208017800800102ca01680a10000102030405060708090a0b0c0d0e0f1210101112131415161718191a1b1c1d1e1f1a13323032332d31312d31342031353a31333a323020c0072a0c0880d095ffbc31150000e0c0320c0880a0d19abd31150000e0c038004080d095ffbc314880a0d19abd311080d095ffbc31202a";
const END_FAST_RESPONSE = "08012080a0d19abd312880a0d19abd31382a";

function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

it("decodes a synthetic fasting transaction", () => {
  const bundle = decodeMessage(hex(END_FAST_REQUEST));
  const [transaction] = getRepeatedMessages(bundle, 1);
  const [entry] = getRepeatedMessages(transaction!, 25);
  const fast = decodeFast(entry!);
  assert.equal(fast.id, Buffer.from("000102030405060708090a0b0c0d0e0f", "hex").toString("base64url"));
  assert.equal(fast.revisionId, Buffer.from("101112131415161718191a1b1c1d1e1f", "hex").toString("base64url"));
  assert.equal(fast.scheduledStart, "2023-11-14 15:13:20");
  assert.equal(fast.targetMinutes, 960);
  assert.deepEqual(fast.start, { ms: 1700000000000, hoursFromGmt: -7 });
  assert.deepEqual(fast.end, { ms: 1700057600000, hoursFromGmt: -7 });
  assert.equal(fast.deleted, false);
  assert.equal(fast.createdMs, 1700000000000);
  assert.equal(fast.modifiedMs, 1700057600000);
});

function testFast(): Fast {
  return {
    id: newEntityId(), revisionId: newEntityId(), scheduledStart: null,
    targetMinutes: 960, start: { ms: 1_700_000_000_000, hoursFromGmt: -7 },
    end: null, deleted: false, createdMs: 1, modifiedMs: 1,
  };
}

function syncResponse(cursor: number, fasts: Fast[] = [], acknowledge = false): Uint8Array {
  const changes = new ProtoWriter();
  for (const fast of fasts) changes.message(25, encodeFast(fast));
  const response = new ProtoWriter().message(3, changes).uint(4, cursor);
  if (acknowledge) response.uint(1, 1);
  return response.finish();
}

it("retains newer server changes returned alongside a fasting acknowledgement", async () => {
  const fast = testFast();
  const remote = { ...fast, targetMinutes: 1200, modifiedMs: 5 };
  let calls = 0;
  const client = {
    getUserId: () => 42,
    gatewayBundle: async () => ++calls === 1 ? syncResponse(1) : syncResponse(5, [remote], true),
  } as unknown as LoseItClient;
  const store = new FastingStore(client);
  assert.deepEqual(await store.save(() => fast), remote);
});

it("serializes concurrent fasting changes against the latest sync cursor", async () => {
  const cursors: bigint[] = [];
  let call = 0;
  const client = {
    getUserId: () => 42,
    gatewayBundle: async (body: Uint8Array) => {
      cursors.push(getVarint(decodeMessage(body), 2)!);
      await new Promise((resolve) => setTimeout(resolve, 2));
      call++;
      return syncResponse(call, [], call % 2 === 0);
    },
  } as unknown as LoseItClient;
  const store = new FastingStore(client);
  await Promise.all([store.save(() => testFast()), store.save(() => testFast())]);
  assert.deepEqual(cursors, [0n, 1n, 2n, 3n]);
});

it("does not cache an unacknowledged fast and recovers after a failed save", async () => {
  let calls = 0;
  const client = {
    getUserId: () => 42,
    gatewayBundle: async () => syncResponse(++calls),
  } as unknown as LoseItClient;
  const store = new FastingStore(client);
  await assert.rejects(store.save(() => testFast()), /did not acknowledge/);
  assert.equal((await store.sync()).fasts.size, 0);
});

it("re-encodes a fasting transaction byte for byte", () => {
  const bundle = decodeMessage(hex(END_FAST_REQUEST));
  const [transaction] = getRepeatedMessages(bundle, 1);
  const fast = decodeFast(getRepeatedMessages(transaction!, 25)[0]!);
  const rebuilt = buildBundle(42, 1700000000000n, [fast]);
  assert.equal(Buffer.from(rebuilt).toString("hex"), END_FAST_REQUEST);
});

it("reads acknowledgements and the next cursor", () => {
  const response = parseBundleResponse(hex(END_FAST_RESPONSE));
  assert.deepEqual(response.acknowledged, [1]);
  assert.equal(response.cursor, 1700057600000n);
  assert.deepEqual(response.fasts, []);
});

it("collects fasts and schedule days from server changes", () => {
  const fast = new ProtoWriter()
    .bytes(1, new Uint8Array(16).fill(1))
    .bytes(2, new Uint8Array(16).fill(2))
    .uint(4, 960)
    .message(5, new ProtoWriter().uint(1, 1_700_000_000_000).float(2, -7))
    .bool(7, false);
  const day = new ProtoWriter()
    .bytes(1, new Uint8Array(16).fill(3))
    .uint(2, 1)
    .string(3, "20:00:00")
    .uint(4, 960)
    .bool(5, false);
  const response = new ProtoWriter()
    .message(3, new ProtoWriter().message(25, fast).message(26, day))
    .uint(4, 42)
    .finish();
  const parsed = parseBundleResponse(response);
  assert.equal(parsed.fasts.length, 1);
  assert.equal(parsed.fasts[0]!.end, null);
  assert.equal(parsed.fasts[0]!.targetMinutes, 960);
  assert.equal(parsed.scheduleDays[0]!.startTime, "20:00:00");
  assert.equal(parsed.cursor, 42n);
});
