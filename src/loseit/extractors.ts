/**
 * Targeted extraction functions for GWT-RPC responses.
 *
 * GWT-RPC serializes depth-first, right-to-left. Inner/leaf data appears at
 * the START of the values array; wrapper objects appear at the END.
 */

import { dayNumberToDate, type GwtResponse } from "./gwt.js";
import { StructReader, StructParseError } from "./structReader.js";
import type { StructFieldDef } from "./structReader.js";
import {
  buildGwtTypeRegistry,
  GWT_ENUMS,
  NUTRIENT_BY_INTID,
} from "./structTypes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dayNumberToDateString(dayNumber: number): string {
  const d = dayNumberToDate(dayNumber);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isDayNumber(n: unknown): n is number {
  return typeof n === "number" && n >= 7000 && n <= 11000;
}

function isWeight(n: unknown): n is number {
  return typeof n === "number" && n >= 50 && n <= 500;
}

function findStringRef(stringTable: string[], prefix: string): number {
  const idx = stringTable.findIndex((s) => s.startsWith(prefix));
  return idx >= 0 ? idx + 1 : -1;
}

// ---------------------------------------------------------------------------
// getInitializationData -> Daily Summary
// ---------------------------------------------------------------------------

export interface DailyEntry {
  date: string;
  dayNumber: number;
  caloriesBudget: number;
  caloriesEaten: number;
  exerciseCalories: number;
  caloriesRemaining: number;
}

export interface DailySummaryResult {
  date: string;
  dayNumber: number;
  weight: number;
  caloriesBudget: number;
  caloriesEaten: number;
  exerciseCalories: number;
  caloriesRemaining: number;
  weekEntries: DailyEntry[];
}

/**
 * Extract the daily calorie summary from a `getInitializationData` response.
 *
 * The live per-day totals live in `DailyLogGoalsState` blocks in this response
 * (the food-log endpoint), NOT in `getGoalsData` — whose calories/exercise
 * fields are a lagging snapshot that can be hours stale relative to the app.
 *
 * Anchored on the `DailyLogGoalsState/` class ref (its 1-based index in the
 * string table). Relative to that marker at position M:
 *   M-1: base calorie budget (double)
 *   M+1, M+2: calories eaten (duplicated int/double pair)
 *   M+3, M+4: exercise calories (duplicated int/double pair)
 *   M+6: the DayDate's day number
 *
 * The duplicated numeric pairs + a valid day number 6 slots on form a
 * structural signature that reliably distinguishes a real class marker from a
 * data value that merely equals the class-ref index. `weight` is populated by
 * the caller (from `getGoalsData`) since it is not at a stable offset here.
 */
export function extractDailySummary(
  raw: GwtResponse,
  targetDayNumber: number,
): DailySummaryResult | null {
  const { values, stringTable } = raw;

  const goalsStateRef = findStringRef(
    stringTable,
    "com.loseit.core.client.model.DailyLogGoalsState/",
  );
  if (goalsStateRef < 0) return null;

  const byDay = new Map<number, DailyEntry>();

  for (let m = 1; m < values.length - 6; m++) {
    if (values[m] !== goalsStateRef) continue;

    const baseBudget = values[m - 1];
    const eaten = values[m + 1];
    const eatenDup = values[m + 2];
    const exercise = values[m + 3];
    const exerciseDup = values[m + 4];
    const dayNumber = values[m + 6];

    if (
      typeof baseBudget !== "number" ||
      baseBudget <= 0 ||
      typeof eaten !== "number" ||
      eaten !== eatenDup ||
      typeof exercise !== "number" ||
      exercise !== exerciseDup ||
      !isDayNumber(dayNumber)
    ) {
      continue;
    }

    if (byDay.has(dayNumber)) continue;

    const budget = Math.round(baseBudget);
    byDay.set(dayNumber, {
      date: dayNumberToDateString(dayNumber),
      dayNumber,
      caloriesBudget: budget,
      caloriesEaten: Math.round(eaten),
      exerciseCalories: Math.round(exercise),
      caloriesRemaining: Math.round(baseBudget + exercise - eaten),
    });
  }

  const entries = [...byDay.values()].sort((a, b) => a.dayNumber - b.dayNumber);
  if (entries.length === 0) return null;

  const target = entries.find((e) => e.dayNumber === targetDayNumber);
  const effective = target ?? entries[entries.length - 1]!;

  return {
    date: effective.date,
    dayNumber: effective.dayNumber,
    weight: 0,
    caloriesBudget: effective.caloriesBudget,
    caloriesEaten: effective.caloriesEaten,
    exerciseCalories: effective.exerciseCalories,
    caloriesRemaining: effective.caloriesRemaining,
    weekEntries: entries,
  };
}

// ---------------------------------------------------------------------------
// getGoalsStatus -> Goals
// ---------------------------------------------------------------------------

export interface GoalEntry {
  name: string;
  description: string;
  unit: string;
  goalId: string;
  targetValue: number;
  currentValue: number;
}

export interface GoalsResult {
  goals: GoalEntry[];
  currentWeight: number | null;
  goalWeight: number | null;
}

/**
 * Extract goals from getGoalsStatus response.
 *
 * Each goal name appears in a recognizable context:
 *   ..., 8(doubleRef), currentWrapped, 8(doubleRef), "",
 *   nameRef, backRef, unitIdRef, target, target, ...
 *   descriptionRef, 0, currentValue, ...
 *
 * Name at position P:
 *   P-1: "" (empty string ref)
 *   P+1: back-ref (negative number)
 *   P+2: unitId ref
 *   P+3, P+4: target value (duplicated)
 *   Then ahead: descriptionRef, 0, currentValue
 */
export function extractGoals(raw: GwtResponse): GoalsResult {
  const { values, stringTable } = raw;

  const goalNames = [
    "Fat", "Protein", "Carbohydrates", "Fiber", "Sodium", "Steps",
    "Apple Activity Move Goal", "Apple Activity Exercise Goal",
    "Apple Activity Stand Goal",
  ];

  const goalNameRefs = new Map<number, string>();
  for (const name of goalNames) {
    const idx = stringTable.indexOf(name);
    if (idx >= 0) goalNameRefs.set(idx + 1, name);
  }

  const unitIdToUnit: Record<string, string> = {
    fatgrams: "g", fatgms: "g",
    protgrams: "g", protgms: "g",
    carbgrams: "g", carbgms: "g",
    fiber: "g",
    sod: "mg",
    steps: "steps",
    excal: "cal",
    exmin: "min",
    aplmove: "",
    aplexer: "",
    aplstand: "",
  };

  const classPattern = /^(com\.|java\.|org\.|net\.|\[L|\[B)/;
  const descriptionRefs = new Map<number, string>();
  for (let i = 0; i < stringTable.length; i++) {
    const s = stringTable[i]!;
    if (s.startsWith("Consume ") || s.startsWith("Complete ") || s.startsWith("Take ")) {
      descriptionRefs.set(i + 1, s);
    }
  }

  const emptyStrRef = stringTable.indexOf("") + 1;

  const goals: GoalEntry[] = [];
  const seenNames = new Set<string>();

  for (let i = 2; i < values.length - 5; i++) {
    const ref = values[i];
    if (typeof ref !== "number") continue;
    const name = goalNameRefs.get(ref);
    if (!name) continue;

    // Verify context: P-1 should be empty string ref
    if (values[i - 1] !== emptyStrRef && values[i - 1] !== 0) continue;

    // P+1 should be negative (back-ref) or 0
    const afterName = values[i + 1];
    if (typeof afterName !== "number" || afterName > 0) continue;

    if (seenNames.has(name)) continue;
    seenNames.add(name);

    // Two patterns exist for goal data:
    //
    // Pattern A (most goals): P+1 is back-ref (<0)
    //   P+2: unitIdRef, P+3: target, P+4: target(dup)
    //
    // Pattern B (Fat, last goal): P+1 is 0
    //   P+2: CustomGoalMeasureFrequency class ref
    //   P+3: unitIdRef("fatgrams"), P+4: target, P+5: target(dup)

    let unitId = "";
    let unit = "";
    let targetValue = 0;

    if (afterName === 0) {
      // Pattern B: shifted by 1
      const unitRef = values[i + 3];
      if (typeof unitRef === "number" && unitRef > 0 && unitRef <= stringTable.length) {
        const s = stringTable[unitRef - 1]!;
        if (!classPattern.test(s)) {
          unitId = s;
          unit = unitIdToUnit[s] ?? s;
        }
      }
      const t1 = values[i + 4];
      const t2 = values[i + 5];
      if (typeof t1 === "number" && t1 >= 0 && typeof t2 === "number" && t1 === t2) {
        targetValue = t1;
      }
    } else {
      // Pattern A
      const unitRef = values[i + 2];
      if (typeof unitRef === "number" && unitRef > 0 && unitRef <= stringTable.length) {
        const s = stringTable[unitRef - 1]!;
        if (!classPattern.test(s)) {
          unitId = s;
          unit = unitIdToUnit[s] ?? s;
        }
      }
      const t1 = values[i + 3];
      const t2 = values[i + 4];
      if (typeof t1 === "number" && t1 >= 0 && typeof t2 === "number" && t1 === t2) {
        targetValue = t1;
      } else if (typeof t1 === "number" && t1 >= 0) {
        targetValue = t1;
      }
    }

    // Find description and current value by scanning forward
    let description = "";
    let currentValue = 0;

    for (let j = i + 4; j < Math.min(i + 30, values.length - 2); j++) {
      const dRef = values[j];
      if (typeof dRef === "number" && descriptionRefs.has(dRef)) {
        description = descriptionRefs.get(dRef)!;
        if (values[j + 1] === 0 && typeof values[j + 2] === "number") {
          currentValue = values[j + 2] as number;
        }
        break;
      }
    }

    goals.push({
      name,
      description,
      unit,
      goalId: unitId,
      targetValue: Math.round(targetValue * 100) / 100,
      currentValue: Math.round(currentValue * 100) / 100,
    });
  }

  // Extract GoalsSummary for current/goal weight
  const goalsSummaryRef = findStringRef(stringTable, "com.loseit.core.client.model.GoalsSummary/");
  let currentWeight: number | null = null;
  let goalWeight: number | null = null;

  for (let i = 0; i < values.length; i++) {
    if (values[i] !== goalsSummaryRef) continue;

    const weights: number[] = [];
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const v = values[j];
      if (isWeight(v)) weights.push(v);
    }
    if (weights.length >= 1) currentWeight = weights[0]!;

    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const v = values[j];
      if (typeof v === "number" && v >= 100 && v <= 400 && v !== currentWeight) {
        goalWeight = v;
        break;
      }
    }
    break;
  }

  return { goals, currentWeight, goalWeight };
}

// ---------------------------------------------------------------------------
// getInitializationData -> Food Log
// ---------------------------------------------------------------------------

export interface FoodNutrition {
  /** Calories for the logged portion. */
  calories: number | null;
  fat: number | null;
  saturatedFat: number | null;
  cholesterol: number | null;
  sodium: number | null;
  carbohydrates: number | null;
  fiber: number | null;
  sugars: number | null;
  protein: number | null;
}

export interface FoodLogItem {
  name: string;
  brand: string;
  /** Number of servings logged (informational; nutrition is already portion-adjusted). */
  quantity: number | null;
  nutrition: FoodNutrition;
}

export interface FoodLogResult {
  date: string;
  entries: FoodLogItem[];
  /** Sum of per-entry calories for the day, when nutrition could be extracted. */
  totalCalories: number | null;
  /**
   * True when full per-food nutrition was extracted structurally; false when the
   * parser fell back to name/brand-only heuristics (e.g. after a Lose It model change).
   */
  detailed: boolean;
}

/**
 * Extract food log from getInitializationData response.
 *
 * Food entries are identified by the FoodIdentifier class ref pattern.
 * Each FoodIdentifier (reading left-to-right in the array) appears as:
 *   brand(ref), name(ref), 0, category(ref), backRef(-1), FoodIdentifier(ref)
 *
 * The FoodIdentifier is followed by FoodLogEntry(ref), then other objects.
 * The associated FoodServing calorie data appears earlier in the array
 * (since GWT serializes depth-first right-to-left).
 *
 * Each FoodServing data block has: entryId(string), servingId(string), 0,
 * numServings, numServings, servingAmount, ..., FoodServingSizeRef,
 * caloriesPerServing, doubleRef, ...
 */
const EMPTY_NUTRITION: FoodNutrition = {
  calories: null,
  fat: null,
  saturatedFat: null,
  cholesterol: null,
  sodium: null,
  carbohydrates: null,
  fiber: null,
  sugars: null,
  protein: null,
};

// The type registry is immutable; build it once and reuse across calls.
let cachedRegistry: Map<string, StructFieldDef[]> | null = null;
function gwtRegistry(): Map<string, StructFieldDef[]> {
  cachedRegistry ??= buildGwtTypeRegistry();
  return cachedRegistry;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function doubleValue(v: unknown): number | null {
  const rec = asRecord(v);
  const raw = rec && rec._cls === "Double" ? rec.v : v;
  return typeof raw === "number" ? raw : null;
}

function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * graph, then read every FoodLogEntry's serving nutrients. Nutrient map keys
 * are FoodMeasurement objects carrying a stable nutrient-type id; back-references
 * to shared key objects resolve automatically via the reader's object table.
 * Returns null if the graph fails to deserialize cleanly (caller falls back).
 */
/**
 * Fully deserialize a GWT-RPC response into its object graph, or return null
 * if the layout desyncs (callers fall back to heuristics). Shared by the
 * single-day food log and the bulk date-range extractors.
 */
function readObjectGraph(
  raw: GwtResponse,
  registry?: Map<string, StructFieldDef[]> | null,
): StructReader | null {
  // The auto-derived registry labels enums as single-int types, so route them
  // through the type path (empty enum set). The built-in registry relies on the
  // reader's enum handling and the curated GWT_ENUMS set.
  const useAuto = registry != null;
  const reader = new StructReader(
    raw.values,
    raw.stringTable,
    registry ?? gwtRegistry(),
    useAuto ? new Set<string>() : GWT_ENUMS,
  );

  try {
    reader.readObject();
  } catch (error) {
    if (error instanceof StructParseError) return null;
    throw error;
  }
  // A clean read consumes every token; anything left means the layout desynced.
  if (reader.remaining !== 0) return null;
  return reader;
}

/**
 * Collect every FoodLogEntry in a deserialized graph, grouped by the day it was
 * logged on. A range response contains many days; a single-day response one.
 * Returns null when entries were found but no nutrient resolved, which means
 * the nutrient-key mapping broke and the caller should fall back.
 */
function foodItemsByDay(
  reader: StructReader,
): Map<number, FoodLogItem[]> | null {
  const byDay = new Map<number, FoodLogItem[]>();
  let anyItem = false;
  let anyNutrient = false;

  for (const obj of reader.allObjects()) {
    const entry = asRecord(obj);
    if (!entry || entry._cls !== "FoodLogEntry") continue;

    const ident = asRecord(entry.identifier);
    const name =
      (ident && typeof ident.name === "string" ? ident.name : null) ??
      (ident && typeof ident.nullableName === "string"
        ? ident.nullableName
        : null);
    if (!name) continue;
    const brand = ident && typeof ident.brand === "string" ? ident.brand : "";

    const ctx = asRecord(entry.context);
    const dayDate = ctx && asRecord(ctx.dayDate);
    const day = dayDate && typeof dayDate.dayNumber === "number"
      ? dayDate.dayNumber
      : null;
    if (day === null) continue;

    const serving = asRecord(entry.serving);
    const foodNutrients = serving && asRecord(serving.nutrients);
    const servingSize = serving && asRecord(serving.servingSize);
    const quantity =
      servingSize && typeof servingSize.quantity === "number"
        ? servingSize.quantity
        : null;

    const nutrition: FoodNutrition = { ...EMPTY_NUTRITION };
    const pairs = foodNutrients?.nutrients;
    if (Array.isArray(pairs)) {
      for (const pair of pairs as Array<[unknown, unknown]>) {
        const key = asRecord(pair[0]);
        if (!key || key._cls !== "FoodMeasurement") continue;
        const nutrientName = NUTRIENT_BY_INTID[key.nutrientTypeId as number];
        if (!nutrientName) continue;
        const value = doubleValue(pair[1]);
        (nutrition as unknown as Record<string, number | null>)[nutrientName] =
          round(value, 2);
        if (value !== null) anyNutrient = true;
      }
    }

    let dayItems = byDay.get(day);
    if (!dayItems) byDay.set(day, (dayItems = []));
    dayItems.push({ name, brand, quantity: round(quantity, 4), nutrition });
    anyItem = true;
  }

  // If we found entries but not a single nutrient resolved, the nutrient-key
  // mapping is broken — treat as a failed structural read.
  if (anyItem && !anyNutrient) return null;
  return byDay;
}

function extractFoodLogStructural(
  raw: GwtResponse,
  targetDayNumber: number,
  registry?: Map<string, StructFieldDef[]> | null,
): FoodLogItem[] | null {
  const reader = readObjectGraph(raw, registry);
  if (!reader) return null;
  const byDay = foodItemsByDay(reader);
  if (!byDay) return null;
  return byDay.get(targetDayNumber) ?? [];
}

function extractFoodLogHeuristic(
  raw: GwtResponse,
  targetDayNumber: number,
): FoodLogItem[] {
  const { values, stringTable } = raw;

  const foodIdentifierRef = findStringRef(stringTable, "com.loseit.core.client.model.FoodIdentifier/");
  const foodLogEntryRef = findStringRef(stringTable, "com.loseit.core.client.model.FoodLogEntry/");

  const classPattern = /^(com\.|java\.|org\.|net\.|\[L|\[B)/;
  // The username is always at string table index 3 (0-indexed)
  const username = stringTable[3] ?? "";
  const skipStrings = new Set([
    "Default", username, "",
    "fatgrams", "fatgms", "protgrams", "protgms", "carbgrams", "carbgms",
    "fiber", "sod", "steps", "excal", "exmin", "aplmove", "aplexer", "aplstand",
    "Fat", "Protein", "Carbohydrates", "Fiber", "Sodium", "Steps",
    "Apple Activity Move Goal", "Apple Activity Exercise Goal",
    "Apple Activity Stand Goal",
  ]);

  function isFoodName(ref: number): boolean {
    if (ref < 1 || ref > stringTable.length) return false;
    const s = stringTable[ref - 1]!;
    return s.length > 0 && !classPattern.test(s) && !skipStrings.has(s);
  }

  // Find all FoodIdentifier positions.
  // Pattern: brand(ref), name(ref), 0, category(ref), backRef, FoodIdentifier(ref), FoodLogEntry(ref)
  interface FoodEntryPos {
    name: string;
    brand: string;
    pos: number;
  }

  const foodEntryPositions: FoodEntryPos[] = [];

  for (let i = 5; i < values.length - 1; i++) {
    if (values[i] !== foodIdentifierRef) continue;
    if (values[i + 1] !== foodLogEntryRef) continue;

    const backRef = values[i - 1];
    if (typeof backRef !== "number" || backRef > 0) continue;

    let category = "";
    let name = "";
    let brand = "";

    const catRef = values[i - 2];
    if (typeof catRef === "number" && isFoodName(catRef)) {
      category = stringTable[catRef - 1]!;
    }

    if (values[i - 3] === 0) {
      const nameRef = values[i - 4];
      if (typeof nameRef === "number" && isFoodName(nameRef)) {
        name = stringTable[nameRef - 1]!;
      }
      const brandRef = values[i - 5];
      if (typeof brandRef === "number" && isFoodName(brandRef)) {
        brand = stringTable[brandRef - 1]!;
      }
    }

    if (!name && category) {
      name = category;
      category = "";
    }

    if (name) {
      foodEntryPositions.push({ name, brand, pos: i });
    }
  }

  // Filter to entries for the target day.
  // The target day number appears after each food entry block.
  const targetDayPositions: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === targetDayNumber) targetDayPositions.push(i);
  }

  const entries: FoodLogItem[] = [];
  const seenNames = new Set<string>();

  for (const food of foodEntryPositions) {
    const isTargetDay = targetDayPositions.some(
      (p) => Math.abs(p - food.pos) < 80,
    );
    if (!isTargetDay) continue;

    // Deduplicate by name+brand (same food may appear in multiple sections)
    const key = `${food.name}|${food.brand}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    entries.push({
      name: food.name,
      brand: food.brand,
      quantity: null,
      nutrition: { ...EMPTY_NUTRITION },
    });
  }

  return entries;
}

/**
 * Extract the food log for a day from a getInitializationData response.
 *
 * Prefers a full structural deserialization (per-food calories + macros); if
 * the object graph fails to parse cleanly (e.g. Lose It changed its model),
 * gracefully falls back to a name/brand-only positional heuristic.
 */
export function extractFoodLog(
  raw: GwtResponse,
  targetDayNumber: number,
  registry?: Map<string, StructFieldDef[]> | null,
): FoodLogResult {
  const structural = extractFoodLogStructural(raw, targetDayNumber, registry);
  const detailed = structural !== null;
  const entries = structural ?? extractFoodLogHeuristic(raw, targetDayNumber);

  let totalCalories: number | null = null;
  if (detailed) {
    totalCalories = round(
      entries.reduce((sum, e) => sum + (e.nutrition.calories ?? 0), 0),
      1,
    );
  }

  return {
    date: dayNumberToDateString(targetDayNumber),
    entries,
    totalCalories,
    detailed,
  };
}

// ---------------------------------------------------------------------------
// getDailyDetailsIncludingPendingForDateRange -> bulk per-day records
// ---------------------------------------------------------------------------

/** Per-day totals for every nutrient the food log tracks. */
export type NutritionTotals = Record<keyof FoodNutrition, number>;

export interface DailyRecord {
  date: string;
  dayNumber: number;
  /** Base calorie budget for the day (excludes exercise). */
  caloriesBudget: number;
  caloriesEaten: number;
  exerciseCalories: number;
  /** budget + exercise - eaten. Negative means over budget. */
  caloriesRemaining: number;
  /** Weight recorded on this day, or null if none was recorded. */
  weight: number | null;
  /** Number of foods logged on this day. */
  foodEntryCount: number;
  /** True when at least one food was logged. */
  logged: boolean;
  /** Summed nutrition across everything logged that day. */
  nutrition: NutritionTotals;
  /** Individual foods, only populated when the caller asks for them. */
  entries?: FoodLogItem[];
}

export interface DailyRangeResult {
  days: DailyRecord[];
  /**
   * True when the object graph deserialized cleanly, so weight and per-day
   * nutrition are present. False means only the calorie figures (budget,
   * eaten, exercise) could be recovered from the positional fallback.
   */
  detailed: boolean;
}

const NUTRIENT_KEYS = Object.keys(EMPTY_NUTRITION) as Array<keyof FoodNutrition>;

function emptyTotals(): NutritionTotals {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])) as NutritionTotals;
}

function sumNutrition(items: FoodLogItem[]): NutritionTotals {
  const totals = emptyTotals();
  for (const item of items) {
    for (const key of NUTRIENT_KEYS) {
      const value = item.nutrition[key];
      if (value !== null) totals[key] += value;
    }
  }
  for (const key of NUTRIENT_KEYS) {
    totals[key] = round(totals[key], 1)!;
  }
  return totals;
}

/**
 * Extract one record per day from a `getDailyDetailsIncludingPendingForDateRange`
 * response, which carries a `DailyDetails` object per day in the range.
 *
 * Prefers a full structural deserialization, which yields the day's recorded
 * weight and summed nutrition alongside the calorie figures. If the object
 * graph fails to parse cleanly (e.g. Lose It changed its model), falls back to
 * the positional `DailyLogGoalsState` scan used by the single-day summary,
 * which still recovers budget/eaten/exercise for every day but no weight or
 * nutrition; `detailed` is false in that case.
 */
export function extractDailyRange(
  raw: GwtResponse,
  registry?: Map<string, StructFieldDef[]> | null,
): DailyRangeResult {
  const reader = readObjectGraph(raw, registry);
  const byDay = reader ? foodItemsByDay(reader) : null;
  const structural = reader && byDay ? readDailyDetails(reader, byDay) : null;

  if (structural && structural.length > 0) {
    return { days: structural, detailed: true };
  }

  // Fallback: the positional scan finds every day's calorie figures.
  const summary = extractDailySummary(raw, -1);
  const days = (summary?.weekEntries ?? []).map<DailyRecord>((e) => ({
    date: e.date,
    dayNumber: e.dayNumber,
    caloriesBudget: e.caloriesBudget,
    caloriesEaten: e.caloriesEaten,
    exerciseCalories: e.exerciseCalories,
    caloriesRemaining: e.caloriesRemaining,
    weight: null,
    foodEntryCount: 0,
    logged: e.caloriesEaten > 0,
    nutrition: emptyTotals(),
  }));

  return { days, detailed: false };
}

function readDailyDetails(
  reader: StructReader,
  foodByDay: Map<number, FoodLogItem[]>,
): DailyRecord[] | null {
  const byDay = new Map<number, DailyRecord>();

  for (const obj of reader.allObjects()) {
    const details = asRecord(obj);
    if (!details || details._cls !== "DailyDetails") continue;

    const logEntry = asRecord(details.dailyLogEntry);
    const dayDate = logEntry && asRecord(logEntry.dayDate);
    const dayNumber = dayDate && typeof dayDate.dayNumber === "number"
      ? dayDate.dayNumber
      : null;
    if (dayNumber === null || byDay.has(dayNumber)) continue;

    const goalsState = asRecord(logEntry?.goalsState);
    const budget = doubleValue(goalsState?.budget);
    const eaten = doubleValue(logEntry?.caloriesEaten);
    const exercise = doubleValue(logEntry?.exerciseCalories);
    if (budget === null || eaten === null || exercise === null) return null;

    // The recorded weight hangs off the day, so it is correctly attributed even
    // on days with no weigh-in (where it is simply absent).
    const recorded = asRecord(details.recordedWeight);
    const weight = doubleValue(recorded?.weight);

    const items = foodByDay.get(dayNumber) ?? [];

    byDay.set(dayNumber, {
      date: dayNumberToDateString(dayNumber),
      dayNumber,
      caloriesBudget: Math.round(budget),
      caloriesEaten: Math.round(eaten),
      exerciseCalories: Math.round(exercise),
      caloriesRemaining: Math.round(budget + exercise - eaten),
      weight: weight === null ? null : round(weight, 2),
      foodEntryCount: items.length,
      logged: items.length > 0,
      nutrition: sumNutrition(items),
      entries: items,
    });
  }

  if (byDay.size === 0) return null;
  return [...byDay.values()].sort((a, b) => a.dayNumber - b.dayNumber);
}
