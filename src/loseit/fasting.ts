/**
 * Fasting, via the mobile sync gateway.
 *
 * The web app has no fasting RPCs; fasting exists only in the iOS/Android
 * apps, which sync through `gateway.loseit.com/user/loseItTransactionBundle`.
 * Field numbers below were recovered from captured app traffic (iOS 18.5.400).
 *
 * Bundle request:   1 = transaction (repeated), 2 = sync cursor (epoch ms),
 *                   4 = user id
 * Bundle response:  1 = acknowledged transaction sequence numbers (repeated),
 *                   3 = server changes since the cursor, 4 = next cursor
 * Transaction:      1 = sequence number, 15 = 0, 16 = 2, plus one entity field
 *                   (25 = fasting log entry)
 * Changes:          one field per entity type (25 = fast, 26 = schedule day)
 *
 * Fasting log entry (25):
 *   1 id (16 bytes)       2 revision id (16 bytes, new on start and on end)
 *   3 scheduled start ("YYYY-MM-DD HH:MM:SS", only when started from schedule)
 *   4 target minutes      5 start {1 epoch ms, 2 float hours from GMT}
 *   6 end (same shape; absent while the fast is running)
 *   7 deleted             8 created ms           9 modified ms
 *
 * Fasting schedule day (26):
 *   1 id   2 day of week (numbering unverified)   3 start "HH:MM:SS"   4 target minutes
 *   5 deleted   6 created ms   7 modified ms
 *
 * Every change is an upsert of the whole entry keyed by id, so starting,
 * ending, editing and deleting a fast are all the same write.
 */
import { randomBytes } from "node:crypto";

import type { LoseItClient } from "./client.js";
import {
  decodeMessage,
  getBool,
  getBytes,
  getFloat,
  getMessage,
  getNumber,
  getRepeatedMessages,
  getRepeatedVarints,
  getString,
  getVarint,
  ProtoWriter,
  type ProtoMessage,
} from "./protobuf.js";

const FIELD_FAST = 25;
const FIELD_SCHEDULE_DAY = 26;

/** A full download returns the account's whole history (megabytes); allow time. */
const FULL_SYNC_TIMEOUT_MS = 120_000;

export class FastingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastingError";
  }
}

export interface FastTime {
  ms: number;
  hoursFromGmt: number;
}

export interface Fast {
  id: string;
  revisionId: string;
  scheduledStart: string | null;
  targetMinutes: number;
  start: FastTime;
  end: FastTime | null;
  deleted: boolean;
  createdMs: number;
  modifiedMs: number;
}

export interface FastingScheduleDay {
  id: string;
  dayOfWeek: number;
  startTime: string;
  targetMinutes: number;
  deleted: boolean;
  modifiedMs: number;
}

/** Entity ids are 16 random bytes; tools show them as base64url like other ids. */
function idString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function idBytes(id: string): Buffer {
  const bytes = Buffer.from(id, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== id) {
    throw new FastingError("Invalid fasting entity id");
  }
  return bytes;
}

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new FastingError(`Fasting entry is missing ${name}`);
  return value;
}

function decodeTime(message: ProtoMessage | undefined): FastTime | null {
  if (!message) return null;
  return {
    ms: requireField(getNumber(message, 1), "a timestamp"),
    hoursFromGmt: getFloat(message, 2) ?? 0,
  };
}

export function decodeFast(message: ProtoMessage): Fast {
  const start = decodeTime(getMessage(message, 5));
  return {
    id: idString(requireField(getBytes(message, 1), "an id")),
    revisionId: idString(getBytes(message, 2) ?? new Uint8Array()),
    scheduledStart: getString(message, 3) ?? null,
    targetMinutes: getNumber(message, 4) ?? 0,
    start: requireField(start ?? undefined, "a start time"),
    end: decodeTime(getMessage(message, 6)),
    deleted: getBool(message, 7) ?? false,
    createdMs: getNumber(message, 8) ?? 0,
    modifiedMs: getNumber(message, 9) ?? 0,
  };
}

export function decodeScheduleDay(message: ProtoMessage): FastingScheduleDay {
  return {
    id: idString(requireField(getBytes(message, 1), "an id")),
    dayOfWeek: getNumber(message, 2) ?? 0,
    startTime: getString(message, 3) ?? "",
    targetMinutes: getNumber(message, 4) ?? 0,
    deleted: getBool(message, 5) ?? false,
    modifiedMs: getNumber(message, 7) ?? 0,
  };
}

function encodeTime(time: FastTime): ProtoWriter {
  return new ProtoWriter().uint(1, time.ms).float(2, time.hoursFromGmt);
}

export function encodeFast(fast: Fast): ProtoWriter {
  const writer = new ProtoWriter()
    .bytes(1, idBytes(fast.id))
    .bytes(2, idBytes(fast.revisionId));
  if (fast.scheduledStart !== null) writer.string(3, fast.scheduledStart);
  writer.uint(4, fast.targetMinutes).message(5, encodeTime(fast.start));
  if (fast.end) writer.message(6, encodeTime(fast.end));
  return writer
    .bool(7, fast.deleted)
    .uint(8, fast.createdMs)
    .uint(9, fast.modifiedMs);
}

export function newEntityId(): string {
  return randomBytes(16).toString("base64url");
}

export function buildBundle(
  userId: number,
  cursor: bigint,
  fasts: readonly Fast[],
): Uint8Array {
  const bundle = new ProtoWriter();
  fasts.forEach((fast, index) => {
    bundle.message(
      1,
      new ProtoWriter()
        .uint(1, index + 1)
        .uint(15, 0)
        .uint(16, 2)
        .message(FIELD_FAST, encodeFast(fast)),
    );
  });
  return bundle.uint(2, cursor).uint(4, userId).finish();
}

export interface BundleResponse {
  acknowledged: number[];
  fasts: Fast[];
  scheduleDays: FastingScheduleDay[];
  cursor: bigint | undefined;
}

export function parseBundleResponse(buf: Uint8Array): BundleResponse {
  const response = decodeMessage(buf);
  const fasts: Fast[] = [];
  const scheduleDays: FastingScheduleDay[] = [];
  for (const changes of getRepeatedMessages(response, 3)) {
    for (const fast of getRepeatedMessages(changes, FIELD_FAST)) {
      fasts.push(decodeFast(fast));
    }
    for (const day of getRepeatedMessages(changes, FIELD_SCHEDULE_DAY)) {
      scheduleDays.push(decodeScheduleDay(day));
    }
  }
  return {
    acknowledged: getRepeatedVarints(response, 1).map(Number),
    fasts,
    scheduleDays,
    cursor: getVarint(response, 4),
  };
}

interface FastingState {
  fasts: Map<string, Fast>;
  schedule: Map<string, FastingScheduleDay>;
  cursor: bigint;
}

/**
 * Keeps an account's fasts in memory.
 *
 * The gateway only offers "every change since a cursor", so the first sync
 * downloads the account's whole history (a few megabytes, ~20 s) and later
 * syncs fetch only what changed. Requests for one account are serialized so
 * two tool calls never race the cursor.
 */
export class FastingStore {
  private state: FastingState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: LoseItClient) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private apply(state: FastingState, response: BundleResponse): void {
    for (const fast of response.fasts) {
      const existing = state.fasts.get(fast.id);
      if (!existing || existing.modifiedMs <= fast.modifiedMs) {
        state.fasts.set(fast.id, fast);
      }
    }
    for (const day of response.scheduleDays) {
      const existing = state.schedule.get(day.id);
      if (!existing || existing.modifiedMs <= day.modifiedMs) state.schedule.set(day.id, day);
    }
    if (response.cursor !== undefined && response.cursor > state.cursor) {
      state.cursor = response.cursor;
    }
  }

  private async syncLocked(): Promise<FastingState> {
    const state = this.state ?? {
      fasts: new Map(),
      schedule: new Map(),
      cursor: 0n,
    };
    const body = buildBundle(this.client.getUserId(), state.cursor, []);
    const raw = await this.client.gatewayBundle(
      body,
      state.cursor === 0n ? FULL_SYNC_TIMEOUT_MS : undefined,
    );
    this.apply(state, parseBundleResponse(raw));
    this.state = state;
    return state;
  }

  /** Bring the cache up to date and return every known fast and schedule day. */
  sync(): Promise<FastingState> {
    return this.serialize(() => this.syncLocked());
  }

  /**
   * Upsert a fast. Upserts are keyed by id, so resending the same entry is
   * harmless; the write is confirmed only when the gateway acknowledges it.
   */
  save(build: (state: FastingState) => Fast): Promise<Fast> {
    return this.serialize(async () => {
      const state = await this.syncLocked();
      const fast = build(state);
      const body = buildBundle(this.client.getUserId(), state.cursor, [fast]);
      const response = parseBundleResponse(await this.client.gatewayBundle(body));
      if (!response.acknowledged.includes(1)) {
        throw new FastingError(
          "Lose It did not acknowledge the fasting change; check loseit_get_fasts before retrying",
        );
      }
      state.fasts.set(fast.id, fast);
      this.apply(state, response);
      return state.fasts.get(fast.id)!;
    });
  }
}

const stores = new WeakMap<LoseItClient, FastingStore>();

export function fastingStore(client: LoseItClient): FastingStore {
  let store = stores.get(client);
  if (!store) {
    store = new FastingStore(client);
    stores.set(client, store);
  }
  return store;
}
