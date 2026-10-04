import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import { accountDayDate, isGwtObject, loadDayGraph, objectParam, requireRegistry } from "../loseit/dayGraph.js";
import { dayNumberToDate, GwtParseError } from "../loseit/gwt.js";
import { StructParseError } from "../loseit/structReader.js";
import { WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { errorResponse, textResponse } from "./response.js";
import { writeScopeError, writeToolMeta, type WriteAuth } from "./writeAuth.js";

const POUNDS_PER_KG = 2.2046226218;

/** The weight recorded on a day, in pounds (Lose It's storage unit), if any. */
export async function recordedWeight(client: LoseItClient, dayNumber: number): Promise<number | null> {
  const graph = await loadDayGraph(client, dayNumber);
  for (const object of graph.objects) {
    if (!isGwtObject(object, "RecordedWeight")) continue;
    const day = object.dayDate;
    if (isGwtObject(day, "DayDate") && day.dayNumber === dayNumber && typeof object.weight === "number") {
      return object.weight;
    }
  }
  return null;
}

export function registerRecordWeightTool(server: McpServer, client: LoseItClient, writeAuth: WriteAuth): void {
  server.registerTool(
    "loseit_record_weight",
    {
      title: "Record Weight",
      description:
        "Records a weigh-in for a date (default today), replacing any weight already " +
        "recorded that day. Lose It stores weights in pounds; kilograms are converted.",
      inputSchema: {
        weight: z.number().positive().max(1500),
        unit: z.enum(["lb", "kg"]).optional().describe("Unit of weight (default lb)."),
        date: z.string().optional().describe("YYYY-MM-DD in the account timezone. Defaults to today."),
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ weight, unit, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Recording a weight");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const pounds = Math.round((unit === "kg" ? weight * POUNDS_PER_KG : weight) * 10) / 10;
        if (pounds <= 0) throw new StructParseError("Weight must round to at least 0.1 lb");
        const previous = await recordedWeight(client, dayNumber);
        const graph = { registry: requireRegistry(client), signatures: new Map(client.getGwtSignatures()) };
        await client.gwtWriteWithParams("saveRecordedWeight", [
          { kind: "double", value: pounds },
          objectParam(accountDayDate(client, dayNumber), graph),
        ]);
        const saved = await recordedWeight(client, dayNumber);
        if (saved === null || Math.abs(saved - pounds) > 0.05) {
          throw new StructParseError("Lose It did not record the weight; check loseit_get_weight_history");
        }
        return textResponse({
          recorded: true,
          date: dayNumberToDate(dayNumber).toISOString().slice(0, 10),
          weightLb: saved,
          previousWeightLb: previous,
        });
      } catch (error) {
        if (error instanceof StructParseError || error instanceof GwtParseError || error instanceof DateRangeError) {
          return errorResponse(error);
        }
        throw error;
      }
    },
  );
}
