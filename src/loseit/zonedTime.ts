/** Wall-clock times in the account's IANA timezone. */

const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

export class ZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZonedTimeError";
  }
}

/** Offset from UTC in minutes for `timezone` at the instant `ms`. */
export function offsetMinutes(timezone: string, ms: number): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(ms))
    .find((p) => p.type === "timeZoneName")?.value;
  if (!part || part === "GMT") return 0;
  const match = part.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new ZonedTimeError(`Unsupported offset for ${timezone}: ${part}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * Parse `YYYY-MM-DDTHH:MM[:SS]` as a wall-clock time in `timezone`, or as an
 * absolute time when it carries `Z` or an explicit `±HH:MM` offset.
 */
export function parseZonedDateTime(input: string, timezone: string): number {
  const match = input.trim().match(LOCAL_DATE_TIME);
  if (!match) {
    throw new ZonedTimeError(
      `Invalid date-time "${input}"; use YYYY-MM-DDTHH:MM in the account timezone`,
    );
  }
  const [, y, mo, d, h, mi, s, zone] = match;
  const wallMs = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}Z`);
  const check = new Date(wallMs);
  if (
    !Number.isFinite(wallMs) || check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d) ||
    Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59
  ) {
    throw new ZonedTimeError(`Invalid date-time "${input}"`);
  }
  if (zone === "Z") return wallMs;
  if (zone) {
    if (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59) {
      throw new ZonedTimeError(`Invalid UTC offset in "${input}"`);
    }
    const sign = zone.startsWith("-") ? -1 : 1;
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
    return wallMs - sign * minutes * 60_000;
  }
  // Consider both offsets around a transition. A gap has no matching instant;
  // a repeated hour has two and needs an explicit offset to select one.
  const offsets = new Set([-36, 0, 36].map((hours) =>
    offsetMinutes(timezone, wallMs + hours * 3_600_000)));
  const candidates = [...offsets]
    .map((offset) => wallMs - offset * 60_000)
    .filter((ms) => ms + offsetMinutes(timezone, ms) * 60_000 === wallMs);
  if (candidates.length !== 1) {
    throw new ZonedTimeError(
      candidates.length === 0
        ? `"${input}" does not exist in ${timezone} because the clocks change`
        : `"${input}" occurs twice in ${timezone}; supply an explicit UTC offset`,
    );
  }
  return candidates[0]!;
}

/** Format `ms` as `YYYY-MM-DDTHH:MM:SS±HH:MM` in `timezone`. */
export function formatZoned(ms: number, timezone: string): string {
  const offset = offsetMinutes(timezone, ms);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
