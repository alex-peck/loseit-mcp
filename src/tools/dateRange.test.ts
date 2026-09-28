import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DateRangeError,
  MAX_RANGE_DAYS,
  resolveDayNumber,
  resolveDateRange,
} from "./dateRange.js";
import { dateToDayNumber } from "../loseit/gwt.js";
import type { LoseItClient } from "../loseit/client.js";

// resolveDateRange only needs the account timezone off the client.
const client = { getTimezone: () => "UTC" } as unknown as LoseItClient;

describe("resolveDateRange", () => {
  it("resolves an explicit start/end range inclusively", () => {
    const r = resolveDateRange(
      { startDate: "2026-01-01", endDate: "2026-01-31" },
      client,
    );

    assert.equal(r.startDate, "2026-01-01");
    assert.equal(r.endDate, "2026-01-31");
    assert.equal(r.dayCount, 31);
    assert.equal(r.endDayNumber - r.startDayNumber, 30);
  });

  it("counts `days` back from endDate, including endDate itself", () => {
    const r = resolveDateRange({ endDate: "2026-01-31", days: 7 }, client);

    assert.equal(r.startDate, "2026-01-25");
    assert.equal(r.endDate, "2026-01-31");
    assert.equal(r.dayCount, 7);
  });

  it("defaults to the last 30 days ending today", () => {
    const r = resolveDateRange({}, client);

    assert.equal(r.dayCount, 30);
    assert.equal(r.endDate, new Date().toISOString().slice(0, 10));
  });

  it("prefers an explicit startDate over `days`", () => {
    const r = resolveDateRange(
      { startDate: "2026-01-01", endDate: "2026-01-10", days: 99 },
      client,
    );

    assert.equal(r.startDate, "2026-01-01");
    assert.equal(r.dayCount, 10);
  });

  it("rejects an inverted range", () => {
    assert.throws(
      () =>
        resolveDateRange(
          { startDate: "2026-02-01", endDate: "2026-01-01" },
          client,
        ),
      DateRangeError,
    );
  });

  it("rejects a range longer than the maximum", () => {
    assert.throws(
      () =>
        resolveDateRange(
          { startDate: "2000-01-01", endDate: "2026-01-01" },
          client,
        ),
      (error: unknown) =>
        error instanceof DateRangeError &&
        error.message.includes(String(MAX_RANGE_DAYS)),
    );
  });

  it("allows a range exactly at the maximum", () => {
    const r = resolveDateRange(
      { endDate: "2026-01-31", days: MAX_RANGE_DAYS },
      client,
    );

    assert.equal(r.dayCount, MAX_RANGE_DAYS);
  });
});

describe("resolveDayNumber", () => {
  it("uses the requested day", () => {
    assert.equal(
      resolveDayNumber("2026-09-28", client),
      dateToDayNumber(new Date("2026-09-28")),
    );
  });

  it("rejects malformed and nonexistent dates", () => {
    for (const date of ["2026-2-03", "2026-02-30", "not-a-date"]) {
      assert.throws(() => resolveDayNumber(date, client), DateRangeError);
    }
  });
});
