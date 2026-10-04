import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { GwtParam, LoseItClient } from "../loseit/client.js";
import { primaryKey, primaryKeyId, type GwtObject } from "../loseit/dayGraph.js";
import { encodeFast, newEntityId, type Fast } from "../loseit/fasting.js";
import fixture from "../loseit/fixtures/logging-models.json" with { type: "json" };
import { dateToDayNumber, type GwtResponse } from "../loseit/gwt.js";
import { writeGwtObject } from "../loseit/gwtWriter.js";
import { validateLoggingModels } from "../loseit/loggingModels.js";
import { ProtoWriter } from "../loseit/protobuf.js";
import { GWT_ARRAY_CLASS, type StructFieldDef } from "../loseit/structReader.js";
import { createServer } from "../server.js";

// A frozen public web serializer snapshot, with synthetic account data only.
const registry = new Map(Object.entries(fixture.models).map(([name, model]) =>
  [name, model.fields as StructFieldDef[]]));
const signatures = new Map(Object.entries(fixture.models).map(([name, model]) => [name, model.signature]));
signatures.set("[B", "[B/3308590456");
const date = "2026-10-03";
const dayNumber = dateToDayNumber(new Date(date));

function model(cls: string, fields: Record<string, unknown> = {}): GwtObject {
  return {
    _cls: cls,
    ...Object.fromEntries(registry.get(cls)!.map((field) => [field.name,
      field.type === "obj" ? null : field.type === "boolean" ? false :
        field.type === "long" ? "A" : field.type === "string" ? "" : 0])),
    ...fields,
  };
}

function key(byte = 1): GwtObject {
  return primaryKey(new Uint8Array(16).fill(byte), signatures);
}

function day() { return model("DayDate", { dayNumber, f2: -6 }); }

function list(items: unknown[]): unknown[] {
  Object.defineProperty(items, GWT_ARRAY_CLASS, { value: "java.util.ArrayList/4159755760" });
  return items;
}

function response(data: unknown): { raw: GwtResponse } {
  const stringTable: string[] = [];
  const ref = (s: string) => String(stringTable.indexOf(s) < 0 ? stringTable.push(s) : stringTable.indexOf(s) + 1);
  const tokens = writeGwtObject(model("LoseItRemoteServiceResponse", { f3: data }), ref, registry, signatures);
  return { raw: {
    version: 7, flags: 0, stringTable,
    values: tokens.map((token) => /^-?\d+(\.\d+)?$/.test(token) ? Number(token) : token).reverse(),
  } };
}

function fakeClient(
  objects: () => GwtObject[],
  write: (method: string, params: GwtParam[]) => void = () => {},
): LoseItClient {
  return {
    prepare: async () => {}, getTimezone: () => "America/Denver",
    getGwtRegistry: () => registry, getGwtSignatures: () => signatures,
    gwtRpc: async () => response(list(objects())),
    gwtWriteWithParams: async (method: string, params: GwtParam[]) => { write(method, params); return response(null); },
  } as unknown as LoseItClient;
}

async function withTools(loseIt: LoseItClient, work: (client: Client) => Promise<void>) {
  const server = createServer(loseIt, { writeAuth: null });
  const client = new Client({ name: "test", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    await work(client);
  } finally {
    await client.close();
    await server.close();
  }
}

it("rejects stale note text after an acknowledged update", async () => {
  const note = model("Note", { f0: "old body", f1: dayNumber, f4: "Title", f7: key() });
  await withTools(fakeClient(() => [note]), async (client) => {
    const result = await client.callTool({ name: "loseit_update_note", arguments: { noteId: primaryKeyId(note.f7), body: "new body", date } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /did not apply the note change/);
  });
});

it("verifies note creation, editing, and deletion against the saved content", async () => {
  let notes: GwtObject[] = [];
  const loseIt = fakeClient(() => notes, (method, params) => {
    assert.equal(params[0]?.kind, "object");
    const note = (params[0] as Extract<GwtParam, { kind: "object" }>).value as GwtObject;
    notes = method === "deleteNoteLogEntry" ? [] : [note];
  });
  await withTools(loseIt, async (client) => {
    const added = await client.callTool({ name: "loseit_add_note", arguments: { title: "Title", body: "Body", date } });
    assert.equal(added.isError, undefined);
    const noteId = primaryKeyId(notes[0]!.f7);
    const updated = await client.callTool({ name: "loseit_update_note", arguments: { noteId, title: "Updated", body: "", date } });
    assert.equal(updated.isError, undefined);
    assert.equal(notes[0]!.f0, "");
    const deleted = await client.callTool({ name: "loseit_delete_note", arguments: { noteId, date } });
    assert.equal(deleted.isError, undefined);
    assert.equal(notes.length, 0);
  });
});

it("verifies the secondary goal value as well as the primary value", async () => {
  const goal = model("CustomGoal", { f8: "bloodpressure", f10: "Blood pressure", f18: key() });
  const value = model("CustomGoalValue", { f0: goal.f18, f1: day(), f3: model("Double", { v: 70 }), f5: 120, f7: key(2) });
  await withTools(fakeClient(() => [goal, value]), async (client) => {
    const result = await client.callTool({ name: "loseit_record_custom_goal_value", arguments: { goal: "Blood pressure", value: 120, secondaryValue: 80, date } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /did not record the value/);
  });
});

it("blocks food-derived goal records before writing", async () => {
  for (const tag of ["netcarbs", "protgrams", "fiber"]) {
    const goal = model("CustomGoal", { f8: tag, f10: tag, f18: key() });
    await withTools(fakeClient(() => [goal], () => assert.fail("unexpected write")), async (client) => {
      const result = await client.callTool({ name: "loseit_record_custom_goal_value", arguments: { goal: tag, value: 5, date } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /calculated from the food log/);
    });
  }
});

it("converts kilograms and rejects a weight that rounds to zero before writing", async () => {
  let pounds: number | null = null;
  let writes = 0;
  const loseIt = fakeClient(() => pounds === null ? [] : [model("RecordedWeight", { dayDate: day(), weight: pounds })], (_method, params) => {
    assert.equal(params[0]?.kind, "double");
    pounds = (params[0] as Extract<GwtParam, { kind: "double" }>).value;
    writes++;
  });
  await withTools(loseIt, async (client) => {
    const saved = await client.callTool({ name: "loseit_record_weight", arguments: { weight: 80, unit: "kg", date } });
    assert.equal(saved.isError, undefined);
    assert.equal(pounds, 176.4);
    const invalid = await client.callTool({ name: "loseit_record_weight", arguments: { weight: 0.01, date } });
    assert.equal(invalid.isError, true);
    assert.equal(writes, 1);
  });
});

it("uses the most common fasting goal without assuming weekday numbering", async () => {
  const changes = new ProtoWriter();
  for (let weekday = 1; weekday <= 7; weekday++) {
    changes.message(26, new ProtoWriter().bytes(1, new Uint8Array(16).fill(weekday))
      .uint(2, weekday).string(3, "20:00:00").uint(4, weekday === 7 ? 1200 : 960));
  }
  let calls = 0;
  const loseIt = {
    getTimezone: () => "America/Denver", getUserId: () => 42,
    gatewayBundle: async () => ++calls === 1
      ? new ProtoWriter().message(3, changes).uint(4, 1).finish()
      : new ProtoWriter().uint(1, 1).uint(4, 2).finish(),
  } as unknown as LoseItClient;
  await withTools(loseIt, async (client) => {
    const result = await client.callTool({ name: "loseit_start_fast", arguments: { startTime: "2020-01-04T10:00" } });
    assert.equal(result.isError, undefined);
    const data = result.structuredContent as { result: { fast: { targetHours: number } } };
    assert.equal(data.result.fast.targetHours, 16);
  });
});

it("uses a tracker calorie figure without requiring a usable profile weight", async () => {
  const exercise = model("Exercise", { f2: "Walking", f3: 3.5, f5: "3 mph", f7: key(2) });
  let entries: GwtObject[] = [];
  const loseIt = fakeClient(() => [model("CalorieBurnMetrics", { f2: 0 }), ...entries], (_method, params) => {
    entries = [(params[0] as Extract<GwtParam, { kind: "object" }>).value as GwtObject];
  });
  loseIt.gwtRpcWithParams = async () => response(list([exercise])) as Awaited<ReturnType<LoseItClient["gwtRpcWithParams"]>>;
  await withTools(loseIt, async (client) => {
    const args = { categoryId: primaryKeyId(key()), exerciseId: primaryKeyId(exercise.f7), minutes: 30, calories: 123, date };
    const fractional = await client.callTool({ name: "loseit_log_exercise", arguments: { ...args, minutes: 0.4 } });
    assert.equal(fractional.isError, true);
    assert.equal(entries.length, 0);
    const saved = await client.callTool({ name: "loseit_log_exercise", arguments: args });
    assert.equal(saved.isError, undefined);
    assert.equal(entries[0]!.f1, 123);
    assert.equal(entries[0]!.f9, 30);
  });
});

it("rejects an exercise saved with the wrong duration", async () => {
  const exercise = model("Exercise", { f2: "Walking", f3: 3.5, f7: key(2) });
  let entries: GwtObject[] = [];
  const loseIt = fakeClient(() => [model("CalorieBurnMetrics", { f2: 200 }), ...entries], (_method, params) => {
    entries = [{ ...((params[0] as Extract<GwtParam, { kind: "object" }>).value as GwtObject), f9: 20 }];
  });
  loseIt.gwtRpcWithParams = async () => response(list([exercise])) as Awaited<ReturnType<LoseItClient["gwtRpcWithParams"]>>;
  await withTools(loseIt, async (client) => {
    const result = await client.callTool({ name: "loseit_log_exercise", arguments: { categoryId: primaryKeyId(key()), exerciseId: primaryKeyId(exercise.f7), minutes: 30, date } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /before retrying/);
  });
});

function fast(start: string): Fast {
  return {
    id: newEntityId(), revisionId: newEntityId(), scheduledStart: null, targetMinutes: 960,
    start: { ms: Date.parse(start), hoursFromGmt: -6 }, end: null,
    deleted: false, createdMs: 1, modifiedMs: 1,
  };
}

it("includes the entire local fasting date across 23-hour and 25-hour days", async () => {
  for (const [date, starts, expected] of [
    ["2026-03-08", ["2026-03-08T23:30:00-06:00", "2026-03-09T00:30:00-06:00"], 1],
    ["2026-11-01", ["2026-11-01T23:30:00-07:00", "2026-11-02T00:30:00-07:00"], 1],
  ] as const) {
    const changes = new ProtoWriter();
    starts.forEach((start) => changes.message(25, encodeFast(fast(start))));
    const loseIt = {
      getTimezone: () => "America/Denver", getUserId: () => 42,
      gatewayBundle: async () => new ProtoWriter().message(3, changes).uint(4, 1).finish(),
    } as unknown as LoseItClient;
    await withTools(loseIt, async (client) => {
      const result = await client.callTool({ name: "loseit_get_fasts", arguments: { startDate: date, endDate: date } });
      assert.equal(result.isError, undefined);
      const data = result.structuredContent as { result: { fasts: unknown[] } };
      assert.equal(data.result.fasts.length, expected);
    });
  }
});

it("refuses changed numbered-field model layouts", () => {
  assert.doesNotThrow(() => validateLoggingModels(registry, ["Note"]));
  const changed = new Map(registry);
  changed.set("Note", [{ name: "f0", type: "int" }, ...registry.get("Note")!.slice(1)]);
  assert.throws(() => validateLoggingModels(changed, ["Note"]), /Note model changed/);
});

it("keeps note and weight tools working when an unrelated exercise layout changes", async () => {
  const changed = new Map(registry);
  changed.set("Exercise", [{ name: "f0", type: "string" }, ...registry.get("Exercise")!.slice(1)]);
  let weight: number | null = null;
  const loseIt = fakeClient(() => weight === null ? [] : [model("RecordedWeight", { dayDate: day(), weight })], (_method, params) => {
    weight = (params[0] as Extract<GwtParam, { kind: "double" }>).value;
  });
  loseIt.getGwtRegistry = () => changed;
  await withTools(loseIt, async (client) => {
    const notes = await client.callTool({ name: "loseit_get_notes", arguments: { date } });
    assert.equal(notes.isError, undefined);
    const saved = await client.callTool({ name: "loseit_record_weight", arguments: { weight: 200, date } });
    assert.equal(saved.isError, undefined);
    const exercises = await client.callTool({ name: "loseit_get_exercise_log", arguments: { date } });
    assert.equal(exercises.isError, true);
    assert.match(JSON.stringify(exercises.content), /Exercise model changed/);
  });
});

function nutrients(calories: number, portionFactor = 1): GwtObject {
  const pairs = [[model("FoodMeasurement", { nutrientTypeId: 0 }), model("Double", { v: calories })]];
  Object.defineProperty(pairs, GWT_ARRAY_CLASS, { value: "java.util.HashMap/1797211028" });
  return model("FoodNutrients", { portionFactor, nutrients: pairs });
}

function foodSize(reference = 100): GwtObject {
  return model("FoodServingSize", { quantity: 1, amount: reference, referenceAmount: reference,
    factorPerReference: 1, measure: model("FoodMeasure", { f0: 8 }) });
}

function foodEntry(): GwtObject {
  return model("FoodLogEntry", {
    identifier: model("FoodIdentifier", { name: "Banana", primaryKey: key(3) }),
    context: model("FoodLogEntryContext", { dayDate: day(), mealType: model("FoodLogEntryType", { f0: 0 }) }),
    serving: model("FoodServing", { servingSize: foodSize(), nutrients: nutrients(89) }),
    entryKey: key(4),
  });
}

it("uses the draft edit context when moving a stored snack to lunch", async () => {
  let saved = foodEntry();
  const storedContext = saved.context as GwtObject;
  storedContext.f4 = 1;
  storedContext.f9 = model("FoodLogEntryType", { f0: 3 });
  storedContext.mealType = model("FoodLogEntryType", { f0: 3 });
  const entryId = primaryKeyId(saved.entryKey);
  const draft = foodEntry();
  (draft.context as GwtObject).f4 = -1;
  const food = model("FoodForFoodDatabase", { f0: draft.identifier, f2: list([foodSize()]) });
  const loseIt = fakeClient(() => [saved], (_method, params) => {
    saved = (params[0] as Extract<GwtParam, { kind: "object" }>).value as GwtObject;
  });
  loseIt.getFoodDraft = async () => response(draft) as Awaited<ReturnType<LoseItClient["getFoodDraft"]>>;
  loseIt.getFoodDetails = async () => response(food) as Awaited<ReturnType<LoseItClient["getFoodDetails"]>>;
  await withTools(loseIt, async (client) => {
    const result = await client.callTool({ name: "loseit_update_food_entry", arguments: { entryId, meal: "lunch", date } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const context = saved.context as GwtObject;
    assert.equal(context.f4, -1);
    assert.equal(context.f9, null);
    assert.equal((context.mealType as GwtObject).f0, 1);
    assert.equal((context.dayDate as GwtObject).dayNumber, dayNumber);
    assert.equal(primaryKeyId(saved.entryKey), entryId);
  });
});

it("rejects a food edit saved with the right amount in the wrong unit", async () => {
  let saved = foodEntry();
  const draft = foodEntry();
  const food = model("FoodForFoodDatabase", { f0: draft.identifier, f2: list([foodSize()]) });
  const loseIt = fakeClient(() => [saved], (_method, params) => {
    const sent = (params[0] as Extract<GwtParam, { kind: "object" }>).value as GwtObject;
    const serving = sent.serving as GwtObject;
    saved = { ...sent, serving: { ...serving, nutrients: nutrients(133.5),
      servingSize: { ...(serving.servingSize as GwtObject), measure: model("FoodMeasure", { f0: 5 }) } } };
  });
  loseIt.getFoodDraft = async () => response(draft) as Awaited<ReturnType<LoseItClient["getFoodDraft"]>>;
  loseIt.getFoodDetails = async () => response(food) as Awaited<ReturnType<LoseItClient["getFoodDetails"]>>;
  await withTools(loseIt, async (client) => {
    const result = await client.callTool({ name: "loseit_update_food_entry", arguments: { entryId: primaryKeyId(saved.entryKey), portion: { amount: 150, unit: "grams" }, date } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /did not apply the change/);
  });
});

it("rescales a stored entry whose food has no database record, as the web app does", async () => {
  const { rescaleStoredEntry } = await import("./foodEntries.js");
  const double = (v: number) => ({ _cls: "Double", v });
  const entry = {
    _cls: "FoodLogEntry",
    context: { _cls: "FoodLogEntryContext", mealType: { _cls: "FoodLogEntryType", f0: 0 }, f9: { _cls: "FoodLogEntryTypeExtra", f0: 3 } },
    serving: {
      _cls: "FoodServing",
      nutrients: { _cls: "FoodNutrients", f0: 2, portionFactor: 2, nutrients: [[{ _cls: "FoodMeasurement", nutrientTypeId: 0 }, double(210)]] },
      servingSize: { _cls: "FoodServingSize", quantity: 2, f1: false, measure: { _cls: "FoodMeasure", f0: 5 }, factorPerReference: 2, referenceAmount: 2, amount: 2 },
    },
  };
  rescaleStoredEntry(entry, "lunch", 3);
  // Matches the web app's request for this edit: per-reference nutrients,
  // portionFactor 3, reference values back to one serving.
  assert.equal((entry.serving.nutrients.nutrients[0]![1] as { v: number }).v, 105);
  assert.equal(entry.serving.nutrients.portionFactor, 3);
  assert.equal(entry.serving.nutrients.f0, 1);
  assert.deepEqual(
    [entry.serving.servingSize.quantity, entry.serving.servingSize.amount, entry.serving.servingSize.factorPerReference, entry.serving.servingSize.referenceAmount],
    [3, 3, 1, 1],
  );
  assert.equal(entry.context.mealType.f0, 1);
  assert.equal(entry.context.f9, null);
});
