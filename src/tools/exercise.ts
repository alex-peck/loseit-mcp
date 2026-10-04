import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import {
  accountDayDate,
  isGwtObject,
  loadDayGraph,
  newPrimaryKey,
  objectParam,
  primaryKeyFromId,
  primaryKeyId,
  requireRegistry,
  type DayGraph,
  type GwtObject,
} from "../loseit/dayGraph.js";
import { parseFoodId } from "../loseit/foodModel.js";
import { dayNumberToDate, GwtParseError } from "../loseit/gwt.js";
import { toGwtLong } from "../loseit/gwtLong.js";
import { StructParseError, StructReader } from "../loseit/structReader.js";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { errorResponse, textResponse } from "./response.js";
import { writeScopeError, writeToolMeta, type WriteAuth } from "./writeAuth.js";

// Field layouts, from the web app's updateExerciseLogEntry traffic:
//   ExerciseLogEntry: f0 CalorieBurnMetrics, f1 calories, f2 DayDate, f3 false,
//     f4 Exercise, f5 ExerciseCategory, f6 false, f7 -1, f8 false, f9 minutes,
//     f10 false, f11 updated (long ms), f12 primary key
//   Exercise: f1 id, f2 category name, f3 METs, f4 icon, f5 variant, f7 key
//   ExerciseCategory: f0 -1, f1 an exercise key, f2 -1, f3 name, f4 false,
//     f5 icon, f6 name, f7 updated, f8 category key
//   SearchResultExercise: f0 exercise key (variant hits), f1 icon, f2 name,
//     f3 variant, f6 category key, f7 14 = category / 15 = exercise

const EXERCISE_MODELS = ["Exercise", "ExerciseCategory", "ExerciseLogEntry", "SearchResultExercise", "CalorieBurnMetrics"] as const;

const POUNDS_PER_KG = 2.2046226218;
const LOCALE = "en-US";
const SEARCH_LIMIT = 19;

const dateSchema = z.string().optional().describe("YYYY-MM-DD in the account timezone. Defaults to today.");
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/**
 * Lose It's burn estimate, matching the web and iOS apps: net METs above rest,
 * times body weight in kilograms, times 1.05, per hour. Reproduces logged
 * entries exactly (e.g. 3.5 METs, 30 min, 200 lb -> 119 kcal).
 */
export function exerciseCalories(mets: number, minutes: number, weightLb: number): number {
  return Math.max(0, (mets - 1) * (weightLb / POUNDS_PER_KG) * 1.05 * (minutes / 60));
}

function isoDate(dayNumber: number): string {
  return dayNumberToDate(dayNumber).toISOString().slice(0, 10);
}

function readResult(client: LoseItClient, raw: { values: unknown[]; stringTable: string[] }): GwtObject[] {
  const reader = new StructReader(raw.values, raw.stringTable, requireRegistry(client, EXERCISE_MODELS), new Set());
  reader.readObject();
  if (reader.remaining !== 0) throw new StructParseError("Could not read Lose It's exercise response");
  return [...reader.allObjects()].filter((o): o is GwtObject => isGwtObject(o));
}

function exerciseEntries(graph: DayGraph, dayNumber: number): GwtObject[] {
  const byId = new Map<string, GwtObject>();
  for (const object of graph.objects) {
    if (!isGwtObject(object, "ExerciseLogEntry") || object.f3 === true) continue;
    if (!isGwtObject(object.f2, "DayDate") || object.f2.dayNumber !== dayNumber) continue;
    const id = primaryKeyId(object.f12);
    if (id) byId.set(id, object);
  }
  return [...byId.values()];
}

function describeEntry(entry: GwtObject) {
  const exercise = isGwtObject(entry.f4, "Exercise") ? entry.f4 : null;
  return {
    entryId: primaryKeyId(entry.f12),
    exercise: exercise ? [exercise.f2, exercise.f5].filter(Boolean).join(", ") : null,
    minutes: entry.f9,
    calories: typeof entry.f1 === "number" ? Math.round(entry.f1 * 10) / 10 : null,
    mets: exercise?.f3 ?? null,
  };
}

async function categoryVariants(client: LoseItClient, categoryId: string, name: string) {
  const { raw } = await client.gwtRpcWithParams("getExercisesForExerciseCategory", [
    { kind: "primaryKey", bytes: parseFoodId(categoryId) },
    { kind: "string", value: name },
    { kind: "string", value: LOCALE },
  ]);
  const objects = readResult(client, raw);
  const seen = new Set<string>();
  return objects.filter((o): o is GwtObject => {
    if (!isGwtObject(o, "Exercise")) return false;
    const id = primaryKeyId(o.f7);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function handleError(error: unknown) {
  if (error instanceof StructParseError || error instanceof GwtParseError || error instanceof DateRangeError) {
    return errorResponse(error);
  }
  throw error;
}

export function registerExerciseTools(server: McpServer, client: LoseItClient, writeAuth: WriteAuth): void {
  server.registerTool(
    "loseit_search_exercises",
    {
      title: "Search Exercises",
      description:
        "Searches Lose It's exercise database. Returns categories (e.g. Walking) with " +
        "their variants (e.g. 3 mph) and METs; pass a variant's exerciseId with its " +
        "categoryId to loseit_log_exercise.",
      inputSchema: { query: z.string().trim().min(1).max(100) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ query }) => {
      try {
        const { raw } = await client.gwtRpcWithParams("searchExercisesByName", [
          { kind: "string", value: query },
          { kind: "int", value: SEARCH_LIMIT },
          { kind: "string", value: LOCALE },
        ]);
        const categories = new Map<string, string>();
        for (const result of readResult(client, raw)) {
          if (!isGwtObject(result, "SearchResultExercise")) continue;
          const id = primaryKeyId(result.f6);
          if (id && typeof result.f2 === "string" && !categories.has(id)) {
            categories.set(id, result.f7 === 15 && typeof result.f3 === "string" ? result.f3 : result.f2);
          }
        }
        const results = [];
        for (const [categoryId, name] of [...categories].slice(0, 6)) {
          const variants = await categoryVariants(client, categoryId, name);
          results.push({
            categoryId,
            category: variants[0]?.f2 ?? name,
            exercises: variants.map((v) => ({
              exerciseId: primaryKeyId(v.f7),
              name: [v.f2, v.f5].filter(Boolean).join(", "),
              mets: v.f3,
            })),
          });
        }
        return textResponse({ query, results });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_get_exercise_log",
    {
      title: "Get Exercise Log",
      description: "Returns the exercises logged on a date with minutes and calories burned.",
      inputSchema: { date: dateSchema },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ date }) => {
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, EXERCISE_MODELS);
        const entries = exerciseEntries(graph, dayNumber).map(describeEntry);
        return textResponse({
          date: isoDate(dayNumber),
          entries,
          totalCalories: Math.round(entries.reduce((sum, e) => sum + (e.calories ?? 0), 0) * 10) / 10,
        });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_log_exercise",
    {
      title: "Log Exercise",
      description:
        "Logs an exercise from loseit_search_exercises for a number of minutes. " +
        "Calories are estimated the way Lose It does (from METs and current weight) " +
        "unless calories is given, e.g. from a fitness tracker. Lose It also posts " +
        "the workout to the account's activity feed. Creates a new entry; after " +
        "a timeout or lost response, check loseit_get_exercise_log before retrying.",
      inputSchema: {
        categoryId: keySchema.describe("categoryId from loseit_search_exercises."),
        exerciseId: keySchema.describe("exerciseId of the variant from loseit_search_exercises."),
        minutes: z.number().int().min(1).max(1440).describe("Duration in whole minutes (1–1440)."),
        calories: z.number().min(0).max(20_000).optional(),
        date: dateSchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
      ...writeToolMeta(writeAuth),
    },
    async ({ categoryId, exerciseId, minutes, calories, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Logging exercise");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, EXERCISE_MODELS);
        const metrics = graph.objects.find((o) => isGwtObject(o, "CalorieBurnMetrics"));
        if (!metrics || (calories === undefined &&
          (typeof metrics.f2 !== "number" || !Number.isFinite(metrics.f2) || metrics.f2 <= 0))) {
          throw new StructParseError("The day's calorie-burn profile is unavailable");
        }
        const variants = await categoryVariants(client, categoryId, "");
        const exercise = variants.find((v) => primaryKeyId(v.f7) === exerciseId);
        if (!exercise || typeof exercise.f3 !== "number" || typeof exercise.f2 !== "string") {
          throw new StructParseError("Unknown exercise for this category; use loseit_search_exercises");
        }
        const now = Date.now();
        const category: GwtObject = {
          _cls: "ExerciseCategory",
          f0: -1,
          f1: exercise.f7,
          f2: -1,
          f3: exercise.f2,
          f4: false,
          f5: typeof exercise.f4 === "string" ? exercise.f4 : exercise.f2,
          f6: exercise.f2,
          f7: toGwtLong(now),
          f8: primaryKeyFromId(categoryId, graph.signatures),
        };
        const before = new Set(exerciseEntries(graph, dayNumber).map((e) => primaryKeyId(e.f12)));
        const entry: GwtObject = {
          _cls: "ExerciseLogEntry",
          f0: metrics,
          f1: calories ?? Math.round(exerciseCalories(exercise.f3, minutes, metrics.f2 as number)),
          f2: accountDayDate(client, dayNumber),
          f3: false,
          f4: exercise,
          f5: category,
          f6: false,
          f7: -1,
          f8: false,
          f9: minutes,
          f10: false,
          f11: toGwtLong(now),
          f12: newPrimaryKey(graph.signatures),
        };
        await client.gwtWriteWithParams("updateExerciseLogEntry", [objectParam(entry, graph)]);
        const added = exerciseEntries(await loadDayGraph(client, dayNumber, EXERCISE_MODELS), dayNumber)
          .find((e) => !before.has(primaryKeyId(e.f12)) && primaryKeyId(e.f12) === primaryKeyId(entry.f12));
        if (!added || added.f9 !== minutes || typeof added.f1 !== "number" ||
          Math.abs(added.f1 - (entry.f1 as number)) > 0.05 ||
          !isGwtObject(added.f4, "Exercise") || primaryKeyId(added.f4.f7) !== exerciseId) {
          throw new StructParseError("Exercise may not have been logged as requested; check loseit_get_exercise_log before retrying");
        }
        return textResponse({ logged: true, date: isoDate(dayNumber), entry: describeEntry(added) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_delete_exercise",
    {
      title: "Delete Exercise",
      description: "Deletes a logged exercise.",
      inputSchema: { entryId: keySchema.describe("entryId from loseit_get_exercise_log."), date: dateSchema },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ entryId, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Deleting exercise");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, EXERCISE_MODELS);
        const entry = exerciseEntries(graph, dayNumber).find((e) => primaryKeyId(e.f12) === entryId);
        if (!entry) throw new StructParseError(`No exercise ${entryId} on ${isoDate(dayNumber)}`);
        await client.gwtWriteWithParams("deleteExerciseLogEntry", [objectParam(entry, graph)]);
        const still = exerciseEntries(await loadDayGraph(client, dayNumber, EXERCISE_MODELS), dayNumber)
          .some((e) => primaryKeyId(e.f12) === entryId);
        if (still) throw new StructParseError("Lose It did not delete the exercise; check loseit_get_exercise_log");
        return textResponse({ deleted: true, date: isoDate(dayNumber), entry: describeEntry(entry) });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
