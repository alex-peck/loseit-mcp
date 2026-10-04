import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import {
  accountDayDate,
  gwtDate,
  isGwtObject,
  loadDayGraph,
  objectParam,
  primaryKeyId,
  type DayGraph,
  type GwtObject,
} from "../loseit/dayGraph.js";
import { dayNumberToDate, GwtParseError } from "../loseit/gwt.js";
import { StructParseError } from "../loseit/structReader.js";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { errorResponse, textResponse } from "./response.js";
import { writeScopeError, writeToolMeta, type WriteAuth } from "./writeAuth.js";

// CustomGoal: f1 latest value, f2 deleted, f3 description, f6/f7 goal range,
//   f8 tag, f10 name, f16 descriptor tag, f18 primary key.
// CustomGoalValue: f0 goal key, f1 DayDate, f2 deleted, f3 secondary value
//   (Double, -1 when unused), f4 recorded Date, f5 value, f6 updated, f7 key.

/**
 * Goals whose daily value Lose It derives from the food log (tags observed on
 * a live account; other nutrient goals are not blocked from manual entry).
 */
const NUTRIENT_TAGS = new Set(["netcarbs", "protgrams", "fiber"]);

const dateSchema = z.string().optional().describe("YYYY-MM-DD in the account timezone. Defaults to today.");
const goalSchema = z.string().trim().min(1).describe("Goal name, tag, or goalId from loseit_get_custom_goals (e.g. Steps, water).");

function isoDate(dayNumber: number): string {
  return dayNumberToDate(dayNumber).toISOString().slice(0, 10);
}

function goals(graph: DayGraph): GwtObject[] {
  const byId = new Map<string, GwtObject>();
  for (const object of graph.objects) {
    const id = isGwtObject(object, "CustomGoal") && object.f2 !== true ? primaryKeyId(object.f18) : null;
    if (id) byId.set(id, object);
  }
  return [...byId.values()];
}

function valueFor(graph: DayGraph, goal: GwtObject, dayNumber: number): GwtObject | undefined {
  const goalId = primaryKeyId(goal.f18);
  return graph.objects.find((object): object is GwtObject =>
    isGwtObject(object, "CustomGoalValue") && object.f2 !== true &&
    primaryKeyId(object.f0) === goalId &&
    isGwtObject(object.f1, "DayDate") && object.f1.dayNumber === dayNumber);
}

function secondary(value: GwtObject): number | null {
  return isGwtObject(value.f3, "Double") && typeof value.f3.v === "number" && value.f3.v >= 0
    ? value.f3.v
    : null;
}

function describeGoal(graph: DayGraph, goal: GwtObject, dayNumber: number) {
  const value = valueFor(graph, goal, dayNumber);
  const tag = typeof goal.f8 === "string" ? goal.f8 : "";
  return {
    goalId: primaryKeyId(goal.f18),
    name: goal.f10,
    tag,
    description: goal.f3,
    goalLow: goal.f6,
    goalHigh: goal.f7,
    derivedFromFoodLog: NUTRIENT_TAGS.has(tag),
    value: typeof value?.f5 === "number" ? value.f5 : null,
    secondaryValue: value ? secondary(value) : null,
  };
}

function findGoal(graph: DayGraph, query: string): GwtObject {
  const q = query.trim().toLowerCase();
  const matches = goals(graph).filter((goal) =>
    primaryKeyId(goal.f18) === query.trim() || [goal.f10, goal.f8, goal.f16]
      .some((field) => typeof field === "string" && field.toLowerCase() === q));
  if (matches.length !== 1) {
    const names = goals(graph).map((goal) => goal.f10).join(", ");
    throw new StructParseError(
      matches.length ? `"${query}" matches several goals` : `No custom goal "${query}". Goals: ${names}`,
    );
  }
  return matches[0]!;
}

function handleError(error: unknown) {
  if (error instanceof StructParseError || error instanceof GwtParseError || error instanceof DateRangeError) {
    return errorResponse(error);
  }
  throw error;
}

export function registerCustomGoalTools(server: McpServer, client: LoseItClient, writeAuth: WriteAuth): void {
  server.registerTool(
    "loseit_get_custom_goals",
    {
      title: "Get Custom Goals",
      description:
        "Lists the account's custom goals (steps, water, sleep, body measurements, " +
        "nutrient targets, and so on) with each goal's range and its value on a date. " +
        "Goals marked derivedFromFoodLog are calculated by Lose It from logged food.",
      inputSchema: { date: dateSchema },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ date }) => {
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, ["CustomGoal", "CustomGoalValue"]);
        return textResponse({
          date: isoDate(dayNumber),
          goals: goals(graph).map((goal) => describeGoal(graph, goal, dayNumber)),
        });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_record_custom_goal_value",
    {
      title: "Record Custom Goal Value",
      description:
        "Records a custom goal's value for a date (for example steps, water, or a " +
        "body measurement), replacing that day's value. Blood pressure takes the " +
        "diastolic reading as secondaryValue.",
      inputSchema: {
        goal: goalSchema,
        value: z.number().finite().min(0).max(1_000_000),
        secondaryValue: z.number().finite().min(0).max(1_000_000).optional(),
        date: dateSchema,
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ goal: query, value, secondaryValue, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Recording a goal value");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, ["CustomGoal", "CustomGoalValue"]);
        const goal = findGoal(graph, query);
        if (NUTRIENT_TAGS.has(String(goal.f8))) {
          throw new StructParseError(`${String(goal.f10)} is calculated from the food log; log food instead`);
        }
        const before = describeGoal(graph, goal, dayNumber);
        await client.gwtWriteWithParams("saveCustomGoalValue", [
          objectParam(goal, graph),
          objectParam(accountDayDate(client, dayNumber), graph),
          objectParam(gwtDate(Date.now()), graph),
          { kind: "double", value },
          { kind: "double", value: secondaryValue ?? -1 },
        ]);
        const after = await loadDayGraph(client, dayNumber, ["CustomGoal", "CustomGoalValue"]);
        const saved = describeGoal(after, findGoal(after, query), dayNumber);
        if (saved.value === null || Math.abs(saved.value - value) > 1e-6 ||
          (secondaryValue === undefined ? saved.secondaryValue !== null :
            saved.secondaryValue === null || Math.abs(saved.secondaryValue - secondaryValue) > 1e-6)) {
          throw new StructParseError("Lose It did not record the value; check loseit_get_custom_goals");
        }
        return textResponse({ recorded: true, date: isoDate(dayNumber), previousValue: before.value, goal: saved });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_delete_custom_goal_value",
    {
      title: "Delete Custom Goal Value",
      description: "Removes a custom goal's recorded value for a date.",
      inputSchema: { goal: goalSchema, date: dateSchema },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ goal: query, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Deleting a goal value");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, ["CustomGoal", "CustomGoalValue"]);
        const goal = findGoal(graph, query);
        const value = valueFor(graph, goal, dayNumber);
        if (!value) throw new StructParseError(`${String(goal.f10)} has no value on ${isoDate(dayNumber)}`);
        await client.gwtWriteWithParams("deleteCustomGoalValue", [objectParam(value, graph)]);
        const after = await loadDayGraph(client, dayNumber, ["CustomGoal", "CustomGoalValue"]);
        if (valueFor(after, findGoal(after, query), dayNumber)) {
          throw new StructParseError("Lose It did not delete the value; check loseit_get_custom_goals");
        }
        return textResponse({ deleted: true, date: isoDate(dayNumber), goal: String(goal.f10), value: value.f5 });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
