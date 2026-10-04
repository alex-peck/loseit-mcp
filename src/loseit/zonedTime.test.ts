import assert from "node:assert/strict";
import { it } from "node:test";

import { exerciseCalories } from "../tools/exercise.js";
import { fromGwtLong, toGwtLong } from "./gwtLong.js";
import { formatZoned, parseZonedDateTime } from "./zonedTime.js";

it("round-trips synthetic GWT long values", () => {
  assert.equal(fromGwtLong("YvP5WgA"), 1700000000000);
  assert.equal(fromGwtLong("XSHboAA"), 1600000000000);
  assert.equal(toGwtLong(1700000000000), "YvP5WgA");
  assert.equal(toGwtLong(0), "A");
});

it("parses wall-clock times in the account timezone across DST", () => {
  // Mountain Daylight Time (UTC-6) and Mountain Standard Time (UTC-7).
  assert.equal(
    parseZonedDateTime("2026-10-03T17:00", "America/Denver"),
    Date.UTC(2026, 9, 3, 23, 0),
  );
  assert.equal(
    parseZonedDateTime("2026-12-01T17:00", "America/Denver"),
    Date.UTC(2026, 11, 2, 0, 0),
  );
  assert.equal(
    parseZonedDateTime("2026-10-03T17:00Z", "America/Denver"),
    Date.UTC(2026, 9, 3, 17, 0),
  );
  assert.equal(
    parseZonedDateTime("2026-10-03 17:00:30-05:00", "America/Denver"),
    Date.UTC(2026, 9, 3, 22, 0, 30),
  );
  assert.throws(() => parseZonedDateTime("2026-02-30T10:00", "America/Denver"));
  assert.throws(() => parseZonedDateTime("yesterday", "America/Denver"));
});

it("formats times with the zone's offset", () => {
  assert.equal(formatZoned(Date.UTC(2026, 9, 3, 23, 0), "America/Denver"), "2026-10-03T17:00:00-06:00");
  assert.equal(formatZoned(Date.UTC(2026, 11, 2, 0, 0), "America/Denver"), "2026-12-01T17:00:00-07:00");
});

it("rejects nonexistent and ambiguous local times instead of shifting them", () => {
  assert.throws(() => parseZonedDateTime("2026-03-08T02:30", "America/Denver"), /does not exist/);
  assert.throws(() => parseZonedDateTime("2026-11-01T01:30", "America/Denver"), /occurs twice/);
  assert.equal(parseZonedDateTime("2026-11-01T01:30-06:00", "America/Denver"), Date.UTC(2026, 10, 1, 7, 30));
  assert.equal(parseZonedDateTime("2026-11-01T01:30-07:00", "America/Denver"), Date.UTC(2026, 10, 1, 8, 30));
  assert.throws(() => parseZonedDateTime("2026-10-03T12:00+99:00", "America/Denver"), /Invalid UTC offset/);
  assert.throws(() => parseZonedDateTime("2026-10-03T12:00-06:99", "America/Denver"), /Invalid UTC offset/);
  assert.equal(new Date(parseZonedDateTime("0099-01-01T00:00Z", "UTC")).getUTCFullYear(), 99);
});

it("estimates exercise calories like Lose It", () => {
  // Synthetic MET, duration, and weight examples using the verified formula.
  assert.equal(exerciseCalories(3.5, 30, 200).toFixed(0), "119");
  assert.equal(exerciseCalories(2.8, 20, 180).toFixed(4), "51.4374");
  assert.equal(exerciseCalories(7.0, 20, 180).toFixed(3), "171.458");
  assert.equal(exerciseCalories(3.3, 300, 190).toFixed(2), "1040.65");
  assert.equal(exerciseCalories(3.3, 180, 190).toFixed(3), "624.393");

});
