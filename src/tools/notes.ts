import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { LoseItClient } from "../loseit/client.js";
import {
  isGwtObject,
  loadDayGraph,
  newPrimaryKey,
  objectParam,
  primaryKeyId,
  type DayGraph,
  type GwtObject,
} from "../loseit/dayGraph.js";
import { dayNumberToDate, GwtParseError } from "../loseit/gwt.js";
import { toGwtLong } from "../loseit/gwtLong.js";
import { StructParseError } from "../loseit/structReader.js";
import { READ_ONLY_TOOL_ANNOTATIONS, WRITE_TOOL_ANNOTATIONS } from "./common.js";
import { DateRangeError, resolveDayNumber } from "./dateRange.js";
import { errorResponse, textResponse } from "./response.js";
import { writeScopeError, writeToolMeta, type WriteAuth } from "./writeAuth.js";

// Note fields (from the web app's updateNoteLogEntry traffic):
//   f0 body, f1 day number, f2 deleted, f3 0, f4 title, f5 0,
//   f6 last updated (GWT long ms), f7 primary key.

const dateSchema = z.string().optional().describe("YYYY-MM-DD in the account timezone. Defaults to today.");
const noteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/).describe("noteId returned by loseit_get_notes.");

function isoDate(dayNumber: number): string {
  return dayNumberToDate(dayNumber).toISOString().slice(0, 10);
}

function dayNotes(graph: DayGraph, dayNumber: number): GwtObject[] {
  const byId = new Map<string, GwtObject>();
  for (const object of graph.objects) {
    if (!isGwtObject(object, "Note") || object.f1 !== dayNumber || object.f2 === true) continue;
    const id = primaryKeyId(object.f7);
    if (id) byId.set(id, object);
  }
  return [...byId.values()];
}

function describeNote(note: GwtObject) {
  return {
    noteId: primaryKeyId(note.f7),
    title: typeof note.f4 === "string" ? note.f4 : "",
    body: typeof note.f0 === "string" ? note.f0 : "",
  };
}

async function findNote(client: LoseItClient, dayNumber: number, noteId: string) {
  const graph = await loadDayGraph(client, dayNumber, ["Note"]);
  const note = dayNotes(graph, dayNumber).find((n) => primaryKeyId(n.f7) === noteId);
  if (!note) {
    throw new StructParseError(`No note ${noteId} on ${isoDate(dayNumber)}; list notes with loseit_get_notes`);
  }
  return { graph, note };
}

/** Save a note and confirm it by reading the day back. */
async function saveNote(
  client: LoseItClient,
  dayNumber: number,
  graph: DayGraph,
  note: GwtObject,
  method: "updateNoteLogEntry" | "deleteNoteLogEntry",
) {
  await client.gwtWriteWithParams(method, [objectParam(note, graph)]);
  const after = dayNotes(await loadDayGraph(client, dayNumber, ["Note"]), dayNumber)
    .find((n) => primaryKeyId(n.f7) === primaryKeyId(note.f7));
  if (method === "deleteNoteLogEntry" ? after :
    !after || after.f0 !== note.f0 || after.f4 !== note.f4) {
    throw new StructParseError("Lose It did not apply the note change; check loseit_get_notes");
  }
  return after;
}

function handleError(error: unknown) {
  if (error instanceof StructParseError || error instanceof GwtParseError || error instanceof DateRangeError) {
    return errorResponse(error);
  }
  throw error;
}

export function registerNoteTools(server: McpServer, client: LoseItClient, writeAuth: WriteAuth): void {
  server.registerTool(
    "loseit_get_notes",
    {
      title: "Get Notes",
      description: "Returns the daily notes (title and body) logged on a date.",
      inputSchema: { date: dateSchema },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ date }) => {
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, ["Note"]);
        return textResponse({ date: isoDate(dayNumber), notes: dayNotes(graph, dayNumber).map(describeNote) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_add_note",
    {
      title: "Add Note",
      description: "Adds a daily note with a title and body to a date's log. Creates a new note; after a timeout or lost response, check loseit_get_notes before retrying.",
      inputSchema: {
        title: z.string().max(200),
        body: z.string().max(10_000),
        date: dateSchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
      ...writeToolMeta(writeAuth),
    },
    async ({ title, body, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Adding a note");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const graph = await loadDayGraph(client, dayNumber, ["Note"]);
        const note: GwtObject = {
          _cls: "Note",
          f0: body,
          f1: dayNumber,
          f2: false,
          f3: 0,
          f4: title,
          f5: 0,
          f6: toGwtLong(Date.now()),
          f7: newPrimaryKey(graph.signatures),
        };
        const saved = await saveNote(client, dayNumber, graph, note, "updateNoteLogEntry");
        return textResponse({ added: true, date: isoDate(dayNumber), note: describeNote(saved!) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_update_note",
    {
      title: "Update Note",
      description: "Changes the title and/or body of a daily note.",
      inputSchema: {
        noteId: noteIdSchema,
        title: z.string().max(200).optional(),
        body: z.string().max(10_000).optional(),
        date: dateSchema,
      },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ noteId, title, body, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Editing a note");
      if (denied) return denied;
      try {
        if (title === undefined && body === undefined) throw new StructParseError("Specify title or body");
        const dayNumber = resolveDayNumber(date, client);
        const { graph, note } = await findNote(client, dayNumber, noteId);
        const updated = {
          ...note,
          ...(title === undefined ? {} : { f4: title }),
          ...(body === undefined ? {} : { f0: body }),
          f6: toGwtLong(Date.now()),
        };
        const saved = await saveNote(client, dayNumber, graph, updated, "updateNoteLogEntry");
        return textResponse({ updated: true, date: isoDate(dayNumber), note: describeNote(saved!) });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  server.registerTool(
    "loseit_delete_note",
    {
      title: "Delete Note",
      description: "Deletes a daily note.",
      inputSchema: { noteId: noteIdSchema, date: dateSchema },
      annotations: { ...WRITE_TOOL_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
      ...writeToolMeta(writeAuth),
    },
    async ({ noteId, date }, extra) => {
      const denied = writeScopeError(writeAuth, extra, "Deleting a note");
      if (denied) return denied;
      try {
        const dayNumber = resolveDayNumber(date, client);
        const { graph, note } = await findNote(client, dayNumber, noteId);
        await saveNote(client, dayNumber, graph, note, "deleteNoteLogEntry");
        return textResponse({ deleted: true, date: isoDate(dayNumber), note: describeNote(note) });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
