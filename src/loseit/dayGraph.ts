/**
 * A day's full object graph from `getDailyDetailsForDate`, for tools that edit
 * or delete log entries. Lose It's update/delete RPCs take model objects.
 * This graph supplies stored models and identifiers; food edits rebuild a
 * draft because stored serving totals and contexts differ from edit requests.
 */
import { randomBytes } from "node:crypto";

import type { GwtParam, LoseItClient } from "./client.js";
import { dayNumberToDate, getTimezoneOffset } from "./gwt.js";
import { toGwtLong } from "./gwtLong.js";
import { validateLoggingModels } from "./loggingModels.js";
import { responseSignatures } from "./gwtWriter.js";
import { GWT_ARRAY_CLASS, StructParseError, StructReader, type StructFieldDef } from "./structReader.js";

export type GwtObject = Record<string, unknown> & { _cls: string };

export interface DayGraph {
  objects: GwtObject[];
  registry: Map<string, StructFieldDef[]>;
  signatures: Map<string, string>;
}

export function requireRegistry(client: LoseItClient, models: readonly string[] = []): Map<string, StructFieldDef[]> {
  const registry = client.getGwtRegistry();
  if (!registry) {
    throw new StructParseError(
      "Editing the log requires the live GWT model registry; check GWT auto-discovery",
    );
  }
  validateLoggingModels(registry, models);
  return registry;
}

export function isGwtObject(value: unknown, cls?: string): value is GwtObject {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as GwtObject)._cls === "string" &&
    (cls === undefined || (value as GwtObject)._cls === cls);
}

export async function loadDayGraph(client: LoseItClient, dayNumber: number, models: readonly string[] = []): Promise<DayGraph> {
  await client.prepare();
  const registry = requireRegistry(client, models);
  const { raw } = await client.gwtRpc("getDailyDetailsForDate", [], false, dayNumber);
  const reader = new StructReader(raw.values, raw.stringTable, registry, new Set());
  reader.readObject();
  if (reader.remaining !== 0) {
    throw new StructParseError("Could not fully read the day's log; editing is unavailable");
  }
  const objects = [...reader.allObjects()].filter((o): o is GwtObject => isGwtObject(o));
  // Signatures from the live permutation cover classes absent from this day.
  const signatures = new Map(client.getGwtSignatures());
  for (const [name, signature] of responseSignatures(raw)) signatures.set(name, signature);
  return { objects, registry, signatures };
}

/** A primary key as the base64url id the tools expose (same form as foodId). */
export function primaryKeyId(key: unknown): string | null {
  if (!isGwtObject(key, "SimplePrimaryKey") || !Array.isArray(key.f0) || key.f0.length !== 16) return null;
  return Buffer.from((key.f0 as number[]).map((b) => b & 0xff)).toString("base64url");
}

/** A primary key object for 16 raw bytes. */
export function primaryKey(raw: Uint8Array, signatures: ReadonlyMap<string, string>): GwtObject {
  const bytesSignature = signatures.get("[B");
  if (!bytesSignature) throw new StructParseError("Missing GWT byte[] signature");
  if (raw.length !== 16) throw new StructParseError("A primary key is 16 bytes");
  const bytes = [...raw].map((b) => (b > 127 ? b - 256 : b));
  Object.defineProperty(bytes, GWT_ARRAY_CLASS, { value: bytesSignature });
  return { _cls: "SimplePrimaryKey", f0: bytes };
}

/** The primary key for a base64url id the tools expose. */
export function primaryKeyFromId(id: string, signatures: ReadonlyMap<string, string>): GwtObject {
  const raw = Buffer.from(id, "base64url");
  if (raw.length !== 16 || raw.toString("base64url") !== id) {
    throw new StructParseError(`Invalid id ${id}`);
  }
  return primaryKey(raw, signatures);
}

/** A new random primary key, as Lose It's clients generate them. */
export function newPrimaryKey(signatures: ReadonlyMap<string, string>): GwtObject {
  return primaryKey(randomBytes(16), signatures);
}

export function gwtDate(ms: number): GwtObject {
  return { _cls: "Date", f0: toGwtLong(ms) };
}

/** A DayDate for `dayNumber`, carrying the account timezone's offset that day. */
export function accountDayDate(client: LoseItClient, dayNumber: number): GwtObject {
  const noon = new Date(dayNumberToDate(dayNumber).getTime() + 12 * 3_600_000);
  return { _cls: "DayDate", f0: null, dayNumber, f2: getTimezoneOffset(client.getTimezone(), noon) };
}

/** A GWT-RPC parameter carrying a whole model object. */
export function objectParam(
  value: GwtObject,
  graph: Pick<DayGraph, "registry" | "signatures">,
): GwtParam {
  const declaredType = graph.signatures.get(value._cls);
  if (!declaredType) throw new StructParseError(`Missing GWT signature for ${value._cls}`);
  return {
    kind: "object",
    declaredType,
    value,
    registry: graph.registry,
    signatures: graph.signatures,
  };
}
