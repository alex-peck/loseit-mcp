/**
 * Lose It GWT-RPC model class field layouts, empirically reverse-engineered and
 * validated by fully deserializing a real `getInitializationData` response
 * (every one of the 4120 tokens consumed, and each food's nutrient keys
 * resolving to the correct nutrient type — see the loseit-scratch harness).
 *
 * Field order is the Java declaration order (superclass fields first), which is
 * the order GWT-RPC serializes them. Layouts that are only needed so the reader
 * stays in sync (e.g. daily summaries, exercise/goal records) use best-effort
 * primitive padding; the food-critical classes near the front of each object
 * are exact. A runtime self-check in the extractor guards against a future
 * Lose It model change silently corrupting the object graph.
 */

import type { StructFieldDef, StructFieldType } from "./structReader.js";

/** Map from Lose It's internal nutrient-type id to a nutrient name. */
export const NUTRIENT_BY_INTID: Record<number, string> = {
  0: "calories",
  3: "fat",
  4: "saturatedFat",
  8: "cholesterol",
  9: "sodium",
  10: "carbohydrates",
  11: "fiber",
  12: "sugars",
  13: "protein",
};

export const GWT_ENUMS: ReadonlySet<string> = new Set([
  "CustomGoalType",
  "CustomGoalMeasureFrequency",
  "GoalsProfileActivityLevel",
  "FoodProductType",
  "FoodLogEntryType",
  "FoodLogEntryTypeExtra",
  "DailyBudgetIdentifier",
  "GoalsProfileGender",
  "GoalsSummary$GoalsPlan",
  "NutritionStrategyType",
]);

function f(name: string, type: StructFieldType): StructFieldDef {
  return { name, type };
}

/** Generate `count` filler primitive fields (used where only token/object counting matters). */
function pad(prefix: string, count: number, type: StructFieldType = "int"): StructFieldDef[] {
  const out: StructFieldDef[] = [];
  for (let i = 0; i < count; i++) out.push(f(`${prefix}${i}`, type));
  return out;
}

export function buildGwtTypeRegistry(): Map<string, StructFieldDef[]> {
  const t = new Map<string, StructFieldDef[]>();
  const reg = (name: string, fields: StructFieldDef[]): void => {
    t.set(name, fields);
  };

  // --- leaf / simple ---
  reg("Integer", [f("v", "int")]);
  reg("Double", [f("v", "double")]);
  reg("UserId", [f("id", "int")]);
  reg("Date", [f("time", "long")]);
  reg("Timestamp", [f("time", "long")]);
  reg("DayDate", [f("date", "obj"), f("dayNumber", "int")]);
  reg("SimplePrimaryKey", [f("keyBytes", "obj")]);
  // Nutrient KEY object: classref + one int nutrient-type id.
  reg("FoodMeasurement", [f("nutrientTypeId", "int")]);
  reg("FoodMeasure", [f("measureId", "int")]);

  // --- response envelope ---
  reg("LoseItRemoteServiceResponse", [
    f("code", "obj"),
    f("userId", "obj"),
    f("firstName", "obj"),
    f("lastName", "obj"),
    f("ts", "long"),
    f("data", "obj"),
  ]);
  reg("InitializationData", [f("customGoals", "obj"), f("dailyDetails", "obj")]);

  // --- food graph (exact for the leading fields we read) ---
  reg("FoodNutrients", [f("d0", "double"), f("d1", "double"), f("nutrients", "obj")]);
  reg("FoodServingSize", [
    f("quantity", "double"),
    f("unit", "obj"),
    f("measure", "obj"),
    f("amount", "double"),
    f("gramWeight", "double"),
    f("displayAmount", "double"),
    f("nullable0", "obj"),
    f("rawLong0", "long"),
    f("rawLong1", "long"),
    f("primaryKey", "obj"),
  ]);
  reg("FoodServing", [
    f("nutrients", "obj"),
    f("servingSize", "obj"),
    ...pad("unk", 16),
  ]);
  reg("FoodIdentifier", [
    f("owner", "obj"),
    f("icon", "obj"),
    f("nullableName", "string"),
    f("name", "obj"),
    f("brand", "obj"),
    f("productType", "obj"),
    f("owner2", "obj"),
    f("nullable0", "obj"),
    f("rawLong", "long"),
    f("primaryKey", "obj"),
  ]);
  reg("FoodLogEntryContext", [
    f("timestamp", "obj"),
    f("nullable0", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("nullable1", "obj"),
    f("meal", "int"),
    f("flag0", "int"),
    f("flag1", "int"),
    f("flag2", "int"),
    f("flag3", "int"),
  ]);
  reg("FoodLogEntry", [
    f("identifier", "obj"),
    ...pad("pre", 16),
    f("context", "obj"),
    f("entryType", "obj"),
    f("entryTypeExtra", "obj"),
    f("serving", "obj"),
  ]);

  // --- goals / exercise / daily (padding: only needed to keep the reader in sync) ---
  reg("CalorieBurnMetrics", [
    f("activityLevel", "obj"),
    f("burn", "double"),
    f("requirement", "double"),
  ]);
  reg("DailyLogGoalsState", [f("budget", "double"), f("burnMetrics", "obj")]);
  reg("DailyLogEntry", [
    f("flag0", "int"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("logged", "double"),
    f("logged2", "double"),
    f("calories", "double"),
    f("budget", "double"),
    f("goalsState", "obj"),
    f("rawLong", "long"),
  ]);
  reg("Exercise", [
    f("nullable0", "obj"),
    f("owner", "obj"),
    f("name", "string"),
    f("nullable1", "obj"),
    f("description", "string"),
    f("nullable2", "obj"),
    f("rawLong", "long"),
    f("primaryKey", "obj"),
    ...pad("unk", 16),
  ]);
  reg("ExerciseLogEntry", [
    f("burnMetrics", "obj"),
    f("nullable0", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("nullable1", "obj"),
    f("exercise", "obj"),
    ...pad("unk", 26),
    f("rawLong", "long"),
    f("primaryKey", "obj"),
    ...pad("tail", 21),
    f("rawLong2", "long"),
    f("primaryKey2", "obj"),
    ...pad("tail2_", 16),
  ]);
  reg("GoalsSummary", [
    f("burnMetrics", "obj"),
    f("date", "obj"),
    f("nullable0", "obj"),
    f("nullable1", "obj"),
    f("dobj0", "obj"),
    f("dobj1", "obj"),
    f("weight", "double"),
    f("budgetId", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("gender", "obj"),
    f("height", "int"),
    f("flag0", "int"),
    f("flag1", "int"),
    f("flag2", "int"),
    f("plan", "obj"),
  ]);
  reg("RecordedWeight", [
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("nullable0", "obj"),
    f("rawLong", "long"),
    f("weight", "double"),
  ]);
  reg("NutrientSummary", [
    f("nullable0", "obj"),
    f("d0", "double"),
    f("d1", "double"),
    f("nullable1", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("nullable2", "obj"),
    f("d2", "double"),
    f("i0", "int"),
    f("nullable3", "obj"),
    f("nullable4", "obj"),
    f("d3", "double"),
    f("d4", "double"),
    f("d5", "double"),
    f("d6", "double"),
  ]);
  reg("LogEntry", [
    f("i0", "int"),
    f("d0", "double"),
    f("i1", "int"),
    f("i2", "int"),
    f("i3", "int"),
    f("i4", "int"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("d1", "double"),
    f("d2", "double"),
  ]);
  reg("CustomGoal", [
    f("valueObj", "obj"),
    f("targetValue", "double"),
    f("nullable0", "obj"),
    f("description", "obj"),
    f("endDate", "obj"),
    f("owner0", "obj"),
    f("goalType", "obj"),
    f("limitA", "double"),
    f("limitB", "double"),
    f("glyph", "string"),
    f("measureFrequency", "obj"),
    f("name", "string"),
    f("unit", "string"),
    f("minObj", "obj"),
    f("maxObj", "obj"),
    f("startDate", "obj"),
    f("owner1", "obj"),
    f("owner2", "obj"),
    f("shortName", "string"),
    f("rawLong", "long"),
    f("primaryKey", "obj"),
    ...pad("unk", 16),
  ]);
  reg("CustomGoalValue", [
    f("customGoal", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("nullable0", "obj"),
    f("valueObj", "obj"),
    f("recordedDate", "obj"),
    f("value", "double"),
    f("rawLong", "long"),
    f("primaryKey", "obj"),
  ]);
  reg("DailyDetails", [
    ...pad("a", 21),
    f("goalValueList0", "obj"),
    ...pad("b", 35),
    f("goalValueList1", "obj"),
    ...pad("c", 35),
    f("goalValueList2", "obj"),
    ...pad("d", 35),
    f("goalValueList3", "obj"),
    ...pad("e", 35),
    f("goalValueList4", "obj"),
    ...pad("g", 35),
    f("goalValueList5", "obj"),
    ...pad("h", 35),
    f("goalValueList6", "obj"),
    ...pad("i", 16),
    f("customGoalsAgain", "obj"),
    f("nullableBeforeDaily", "obj"),
    f("dailyLogEntry", "obj"),
    f("exerciseEntries", "obj"),
    f("foodEntries", "obj"),
    f("goalsSummary", "obj"),
    f("recordedWeight", "obj"),
    f("rwNullable", "obj"),
    f("strategy", "obj"),
    f("planRef", "obj"),
    f("timestamp", "obj"),
    f("nullable0", "obj"),
    f("dayDate", "obj"),
    f("owner", "obj"),
    f("weight", "double"),
    f("nullable1", "obj"),
    f("rawA", "long"),
    f("notes", "obj"),
    f("nutrientSummary", "obj"),
    f("recordedWeight2", "obj"),
    f("dailyLogEntries", "obj"),
    f("exerciseEntries2", "obj"),
    f("goalsSummary2", "obj"),
    f("recordedWeight3", "obj"),
    f("rw3Nullable", "obj"),
    f("strategy3", "obj"),
    f("planRef2", "obj"),
    f("timestamp2", "obj"),
    f("nullable2", "obj"),
    f("dayDate2", "obj"),
    f("owner2", "obj"),
    f("weight2", "double"),
    f("nullable3", "obj"),
    f("i0", "int"),
    f("i1", "int"),
    f("logEntries", "obj"),
    f("final0", "int"),
  ]);

  return t;
}
