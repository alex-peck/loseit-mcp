import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LoseItClient, LoseItApiError, LoseItNetworkError, type GwtParam } from "./client.js";
import { loadConfig } from "../config.js";

const config = loadConfig({
  LOSEIT_EMAIL: "test@example.com",
  LOSEIT_PASSWORD: "secret",
  LOSEIT_TIMEZONE: "America/Chicago",
  LOSEIT_GWT_AUTOFETCH: "false",
  LOSEIT_GWT_POLICY_HASH: "POLICY",
  LOSEIT_GWT_PERMUTATION: "PERM",
});

/** Build a request without touching the network or authenticating. */
function buildRequest(method: string, params: GwtParam[]): string {
  const client = new LoseItClient(config) as unknown as {
    userId: number;
    username: string;
    policyHash: string;
    buildGwtRequest(m: string, p: GwtParam[], tz: number): string;
  };
  client.userId = 21078800;
  client.username = "Andrew";
  client.policyHash = "POLICY";
  return client.buildGwtRequest(method, params, -5);
}

describe("buildGwtRequest", () => {
  it("serializes a token-only call exactly as the web app does", () => {
    const body = buildRequest("getGoalsData", []);

    assert.equal(
      body,
      "7|0|7|" +
        "https://d3hsih69yn4d89.cloudfront.net/web/|POLICY|" +
        "com.loseit.core.client.service.LoseItRemoteService|getGoalsData|" +
        "com.loseit.core.client.service.ServiceRequestToken/1076571655|" +
        "com.loseit.core.client.model.UserId/4281239478|Andrew|" +
        "1|2|3|4|1|5|5|0|6|21078800|7|-5|",
    );
  });

  it("appends a DayDate parameter with a null Date and the day number", () => {
    const body = buildRequest("getDailyDetailsForDate", [
      { kind: "dayDate", dayNumber: 9359 },
    ]);
    const parts = body.split("|");

    // String table gains DayDate at index 8; two params are declared.
    assert.equal(parts[2], "8");
    assert.equal(parts[10], "com.loseit.core.shared.model.DayDate/1611136587");
    assert.equal(parts.slice(11, 15).join("|"), "1|2|3|4");
    assert.equal(parts[15], "2", "param count");
    assert.equal(parts.slice(16, 18).join("|"), "5|8", "declared param types");
    // token value, then DayDate: type ref, null Date, day number, gmt offset.
    assert.equal(parts.slice(18, 24).join("|"), "5|0|6|21078800|7|-5");
    assert.equal(parts.slice(24, 28).join("|"), "8|0|9359|-5");
  });

  it("serializes the four-parameter date-range call", () => {
    const body = buildRequest("getDailyDetailsIncludingPendingForDateRange", [
      { kind: "integer", value: 21078800 },
      { kind: "dayDate", dayNumber: 9300 },
      { kind: "dayDate", dayNumber: 9359 },
    ]);
    const parts = body.split("|");

    assert.equal(parts[2], "9", "string table size");
    assert.equal(parts[10], "java.lang.Integer/3438268394");
    assert.equal(parts[11], "com.loseit.core.shared.model.DayDate/1611136587");
    assert.equal(parts[16], "4", "param count including the token");
    assert.equal(
      parts.slice(17, 21).join("|"),
      "5|8|9|9",
      "token, Integer, DayDate, DayDate",
    );
    // The two DayDate types dedupe to a single string-table entry.
    assert.ok(body.endsWith("8|21078800|9|0|9300|-5|9|0|9359|-5|"), body);
  });

  it("serializes a food search with primitive arguments and escaped strings", () => {
    const body = buildRequest("searchFoods", [
      { kind: "string", value: "Apple | Pear\\🍐" },
      { kind: "string", value: "en-US" },
      { kind: "int", value: 20 },
      { kind: "boolean", value: true },
      { kind: "boolean", value: false },
    ]);
    assert.ok(body.includes("java.lang.String/2004016611|I|Z|"));
    assert.ok(body.includes("Apple \\! Pear\\\\\\ud83c\\udf50|en-US|"));
    assert.ok(body.endsWith("|6|5|8|8|9|10|10|5|0|6|21078800|7|-5|11|12|20|1|0|"), body);
  });
});

describe("gwtWriteWithParams", () => {
  it("does not retry a failed HTTP response", async () => {
    const client = new LoseItClient(config);
    client.restoreSession({
      cookies: { session: "test" },
      userId: 21078800,
      username: "Andrew",
      timestamp: 0,
    });
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("failure", { status: 503 });
    };
    try {
      await assert.rejects(client.gwtWriteWithParams("write", []), LoseItApiError);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not retry when the response is lost", async () => {
    const client = new LoseItClient(config);
    client.restoreSession({
      cookies: { session: "test" },
      userId: 21078800,
      username: "Andrew",
      timestamp: 0,
    });
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("connection reset");
    };
    try {
      await assert.rejects(client.gwtWriteWithParams("write", []), LoseItNetworkError);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
