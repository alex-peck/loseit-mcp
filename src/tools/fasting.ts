import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import {
  fastingStore,
  FastingError,
  newEntityId,
  type Fast,
  type FastingScheduleDay,
  type FastTime,
} from "../loseit/fasting.js";
import {
  formatZoned,
  offsetMinutes,
  parseZonedDateTime,
  ZonedTimeError,
} from "../loseit/zonedTime.js";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from "./common.js";
import {
  DateRangeError,
  dateRangeInputSchema,
  resolveDateRange,
} from "./dateRange.js";
import { errorResponse, textResponse } from "./response.js";
import { writeToolMeta, writeScopeError, type WriteAuth } from "./writeAuth.js";

const DEFAULT_TARGET_MINUTES = 16 * 60;
/** Clock skew tolerated before a start or end time counts as "in the future". */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const dateTimeSchema = z.string().describe(
  "YYYY-MM-DDTHH:MM in the account timezone (or with an explicit Z/±HH:MM offset).",
);
const fastIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/).describe(
  "fastId returned by loseit_get_fasts.",
);
const targetHoursSchema = z.number().min(1 / 60).max(168).describe(
  "Fasting goal in hours (for example 16 or 22).",
);

function fastTime(ms: number, timezone: string): FastTime {
  return { ms, hoursFromGmt: offsetMinutes(timezone, ms) / 60 };
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function describeFast(fast: Fast, timezone: string, now = Date.now()) {
  const endMs = fast.end?.ms ?? now;
  const hours = (endMs - fast.start.ms) / 3_600_000;
  const targetHours = fast.targetMinutes / 60;
  return {
    fastId: fast.id,
    active: fast.end === null,
    start: formatZoned(fast.start.ms, timezone),
    end: fast.end ? formatZoned(fast.end.ms, timezone) : null,
    durationHours: round(hours),
    targetHours: round(targetHours),
    percentOfTarget: targetHours > 0 ? round((hours / targetHours) * 100, 1) : null,
    reachedTarget: targetHours > 0 && hours >= targetHours,
    targetEnd: formatZoned(fast.start.ms + fast.targetMinutes * 60_000, timezone),
    startedFromSchedule: fast.scheduledStart,
  };
}

/** Active schedule days grouped by start time and goal. */
export function describeSchedule(days: Iterable<FastingScheduleDay>) {
  const groups = new Map<string, { startTime: string; targetHours: number; days: number[] }>();
  for (const day of days) {
    if (day.deleted) continue;
    const key = `${day.startTime}|${day.targetMinutes}`;
    const group = groups.get(key) ??
      { startTime: day.startTime, targetHours: round(day.targetMinutes / 60), days: [] };
    group.days.push(day.dayOfWeek);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    days: group.days.sort((a, b) => a - b),
    everyDay: new Set(group.days).size === 7,
  }));
}

function activeFasts(fasts: Iterable<Fast>): Fast[] {
  return [...fasts].filter((fast) => !fast.deleted && fast.end === null);
}

function findFast(fasts: Map<string, Fast>, fastId: string): Fast {
  const fast = fasts.get(fastId);
  if (!fast || fast.deleted) {
    throw new FastingError(`No fast ${fastId}; list fasts with loseit_get_fasts`);
  }
  return fast;
}

function defaultTargetMinutes(fasts: Iterable<Fast>, schedule: Iterable<FastingScheduleDay>): number {
  // The gateway's weekday numbering is unverified. Use the most common
  // scheduled goal without mapping its day numbers to calendar weekdays.
  const counts = new Map<number, number>();
  for (const day of schedule) {
    if (!day.deleted && day.targetMinutes > 0) {
      counts.set(day.targetMinutes, (counts.get(day.targetMinutes) ?? 0) + 1);
    }
  }
  const scheduled = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (scheduled) return scheduled[0];
  const latest = [...fasts]
    .filter((fast) => !fast.deleted && fast.targetMinutes > 0)
    .sort((a, b) => b.start.ms - a.start.ms)[0];
  return latest?.targetMinutes ?? DEFAULT_TARGET_MINUTES;
}

function resolveTime(input: string | undefined, timezone: string, now: number): number {
  const ms = input === undefined ? now : parseZonedDateTime(input, timezone);
  if (ms < 0) throw new FastingError("Fasting times must be on or after 1970-01-01 UTC");
  if (ms > now + FUTURE_TOLERANCE_MS) {
    throw new FastingError(`${formatZoned(ms, timezone)} is in the future`);
  }
  return ms;
}

function assertOrder(start: number, end: number | undefined): void {
  if (end !== undefined && end <= start) {
    throw new FastingError("A fast must end after it starts");
  }
}

function handleError(error: unknown) {
  if (
    error instanceof FastingError ||
    error instanceof ZonedTimeError ||
    error instanceof DateRangeError
  ) {
    return errorResponse(error);
  }
  throw error;
}

export function registerFastingTools(
  server: McpServer,
  client: LoseItClient,
  writeAuth: WriteAuth,
): void {
  server.registerTool(
    "loseit_get_fasts",
    {
      title: "Get Fasts",
      description:
        "Lists intermittent fasts that started within a date range, newest first, " +
        "with start/end in the account timezone, duration, goal, and whether the " +
        "goal was reached. Also returns the fast in progress (if any) and the " +
        "fasting schedule (day numbers are raw gateway values; weekday numbering " +
        "is unverified). The first call downloads the account's sync history " +
        "and can take about 20 seconds; later calls are fast.",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async (args) => {
      try {
        const range = resolveDateRange(args, client);
        const timezone = client.getTimezone();
        const { fasts, schedule } = await fastingStore(client).sync();
        const now = Date.now();
        const listed = [...fasts.values()]
          .filter((fast) => {
            const date = formatZoned(fast.start.ms, timezone).slice(0, 10);
            return !fast.deleted && date >= range.startDate && date <= range.endDate;
          })
          .sort((a, b) => b.start.ms - a.start.ms)
          .map((fast) => describeFast(fast, timezone, now));
        const completed = listed.filter((fast) => !fast.active);
        const active = activeFasts(fasts.values())
          .sort((a, b) => b.start.ms - a.start.ms)
          .map((fast) => describeFast(fast, timezone, now));
        return textResponse({
          startDate: range.startDate,
          endDate: range.endDate,
          timezone,
          activeFast: active[0] ?? null,
          schedule: describeSchedule(schedule.values()),
          summary: {
            fasts: listed.length,
            completed: completed.length,
            reachedTarget: completed.filter((fast) => fast.reachedTarget).length,
            averageHours: completed.length
              ? round(completed.reduce((sum, fast) => sum + fast.durationHours, 0) / completed.length)
              : null,
            longestHours: completed.length
              ? Math.max(...completed.map((fast) => fast.durationHours))
              : null,
          },
          fasts: listed,
        });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_start_fast",
    {
      title: "Start Fast",
      description:
        "Starts an intermittent fast now, or at an earlier startTime. The goal " +
        "defaults to the most common scheduled goal, or the latest fast's goal " +
        "or 16 hours when no schedule exists. For a mixed schedule, supply " +
        "targetHours to choose a goal explicitly. Fails if a fast is already in " +
        "progress; end it with loseit_end_fast first. After an uncertain result, " +
        "check loseit_get_fasts before retrying.",
      inputSchema: {
        startTime: dateTimeSchema.optional(),
        targetHours: targetHoursSchema.optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
      ...writeToolMeta(writeAuth),
    },
    async ({ startTime, targetHours }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Starting a fast");
      if (denied) return denied;
      try {
        const timezone = client.getTimezone();
        const now = Date.now();
        const startMs = resolveTime(startTime, timezone, now);
        const fast = await fastingStore(client).save(({ fasts, schedule }) => {
          const running = activeFasts(fasts.values())[0];
          if (running) {
            throw new FastingError(
              `A fast is already in progress (started ${formatZoned(running.start.ms, timezone)}); end it first`,
            );
          }
          return {
            id: newEntityId(),
            revisionId: newEntityId(),
            scheduledStart: null,
            targetMinutes: targetHours === undefined
              ? defaultTargetMinutes(fasts.values(), schedule.values())
              : Math.round(targetHours * 60),
            start: fastTime(startMs, timezone),
            end: null,
            deleted: false,
            createdMs: now,
            modifiedMs: now,
          };
        });
        return textResponse({ started: true, fast: describeFast(fast, timezone) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_end_fast",
    {
      title: "End Fast",
      description:
        "Ends the fast in progress now, or at an earlier endTime.",
      inputSchema: { endTime: dateTimeSchema.optional() },
      annotations: WRITE_TOOL_ANNOTATIONS,
      ...writeToolMeta(writeAuth),
    },
    async ({ endTime }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Ending a fast");
      if (denied) return denied;
      try {
        const timezone = client.getTimezone();
        const now = Date.now();
        const endMs = resolveTime(endTime, timezone, now);
        const fast = await fastingStore(client).save(({ fasts }) => {
          const running = activeFasts(fasts.values())
            .sort((a, b) => b.start.ms - a.start.ms)[0];
          if (!running) throw new FastingError("No fast is in progress");
          assertOrder(running.start.ms, endMs);
          return {
            ...running,
            revisionId: newEntityId(),
            end: fastTime(endMs, timezone),
            modifiedMs: now,
          };
        });
        return textResponse({ ended: true, fast: describeFast(fast, timezone) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_update_fast",
    {
      title: "Update Fast",
      description:
        "Edits a fast's start time, end time, or goal. Set endTime to null to " +
        "resume a fast that was ended by mistake (only when no other fast is in " +
        "progress).",
      inputSchema: {
        fastId: fastIdSchema,
        startTime: dateTimeSchema.optional(),
        endTime: dateTimeSchema.nullable().optional().describe(
          "New end (YYYY-MM-DDTHH:MM in the account timezone), or null to resume the fast.",
        ),
        targetHours: targetHoursSchema.optional(),
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ fastId, startTime, endTime, targetHours }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Editing a fast");
      if (denied) return denied;
      try {
        if (startTime === undefined && endTime === undefined && targetHours === undefined) {
          throw new FastingError("Specify startTime, endTime, or targetHours");
        }
        const timezone = client.getTimezone();
        const now = Date.now();
        const startMs = startTime === undefined ? undefined : resolveTime(startTime, timezone, now);
        const endMs = endTime === undefined || endTime === null
          ? undefined
          : resolveTime(endTime, timezone, now);
        const fast = await fastingStore(client).save(({ fasts }) => {
          const existing = findFast(fasts, fastId);
          const start = startMs === undefined ? existing.start : fastTime(startMs, timezone);
          let end = existing.end;
          if (endTime === null) {
            const other = activeFasts(fasts.values()).find((fast) => fast.id !== fastId);
            if (other) throw new FastingError("Another fast is already in progress");
            end = null;
          } else if (endMs !== undefined) {
            end = fastTime(endMs, timezone);
          }
          assertOrder(start.ms, end?.ms);
          return {
            ...existing,
            revisionId: existing.end === null && end !== null ? newEntityId() : existing.revisionId,
            targetMinutes: targetHours === undefined
              ? existing.targetMinutes
              : Math.round(targetHours * 60),
            start,
            end,
            modifiedMs: now,
          };
        });
        return textResponse({ updated: true, fast: describeFast(fast, timezone) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_delete_fast",
    {
      title: "Delete Fast",
      description: "Deletes a fast from the fasting history.",
      inputSchema: { fastId: fastIdSchema },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ fastId }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Deleting a fast");
      if (denied) return denied;
      try {
        const timezone = client.getTimezone();
        const fast = await fastingStore(client).save(({ fasts }) => ({
          ...findFast(fasts, fastId),
          deleted: true,
          modifiedMs: Date.now(),
        }));
        return textResponse({ deleted: true, fast: describeFast(fast, timezone) });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
