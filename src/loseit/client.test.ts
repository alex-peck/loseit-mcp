import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LoseItClient,
  LoseItApiError,
  LoseItNetworkError,
  type GwtParam,
  type LoseItSession,
} from "./client.js";
import { loadConfig } from "../config.js";
import { GwtAuthenticationError } from "./gwt.js";

const config = { ...loadConfig({
  LOSEIT_EMAIL: "test@example.com",
  LOSEIT_PASSWORD: "secret",
  LOSEIT_TIMEZONE: "America/Chicago",
  LOSEIT_GWT_AUTOFETCH: "false",
  LOSEIT_GWT_POLICY_HASH: "POLICY",
  LOSEIT_GWT_PERMUTATION: "PERM",
}), sessionPath: null };

/** Build a request without touching the network or authenticating. */
function buildRequest(method: string, params: GwtParam[]): string {
  const client = new LoseItClient(config) as unknown as {
    userId: number;
    username: string;
    policyHash: string;
    buildGwtRequest(m: string, p: GwtParam[], tz: number): string;
  };
  client.userId = 42;
  client.username = "Test";
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
        "com.loseit.core.client.model.UserId/4281239478|Test|" +
        "1|2|3|4|1|5|5|0|6|42|7|-5|",
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
    assert.equal(parts.slice(18, 24).join("|"), "5|0|6|42|7|-5");
    assert.equal(parts.slice(24, 28).join("|"), "8|0|9359|-5");
  });

  it("serializes the four-parameter date-range call", () => {
    const body = buildRequest("getDailyDetailsIncludingPendingForDateRange", [
      { kind: "integer", value: 42 },
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
    assert.ok(body.endsWith("8|42|9|0|9300|-5|9|0|9359|-5|"), body);
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
    assert.ok(body.endsWith("|6|5|8|8|9|10|10|5|0|6|42|7|-5|11|12|20|1|0|"), body);
  });
});

describe("gwtWriteWithParams", () => {
  it("does not retry a failed HTTP response", async () => {
    const client = new LoseItClient(config);
    client.restoreSession({
      cookies: { session: "test" },
      userId: 42,
      username: "Test",
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
      userId: 42,
      username: "Test",
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

  it("does not retry or log in after a GWT authentication exception", async () => {
    const client = new LoseItClient(config);
    client.restoreSession({
      cookies: { session: "expired" },
      userId: 42,
      username: "Test",
      timestamp: 0,
    });
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        '//EX[1,["com.loseit.core.UserAuthenticationFailedException/123"],0,7]',
      );
    };
    try {
      await assert.rejects(
        client.gwtWriteWithParams("write", []),
        GwtAuthenticationError,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("gwtRpcWithParams", () => {
  it("re-authenticates a rejected cached session and repeats a read once", async () => {
    const saved: LoseItSession[] = [];
    const client = new LoseItClient(
      config,
      async (session) => { saved.push(session); },
    );
    client.restoreSession({
      cookies: { session: "expired", obsolete: "old" },
      userId: 42,
      username: "Test",
      timestamp: 0,
    });
    const previousFetch = globalThis.fetch;
    const sentCookies: string[] = [];
    let logins = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/account/login")) {
        logins++;
        return new Response(JSON.stringify({
          user_id: 42,
          username: "test@example.com",
        }), { headers: { "Set-Cookie": "session=fresh; Path=/" } });
      }
      sentCookies.push(new Headers(init?.headers).get("Cookie") ?? "");
      return new Response(sentCookies.length === 1
        ? '//EX[1,["com.loseit.core.UserAuthenticationFailedException/123"],0,7]'
        : "//OK[1,[],0,7]");
    };
    try {
      await client.gwtRpc("getGoalsData", []);
      assert.deepEqual(sentCookies, ["session=expired; obsolete=old", "session=fresh"]);
      assert.equal(logins, 1);
      assert.equal(saved[0]?.cookies["session"], "fresh");
      assert.equal(saved[0]?.cookies["obsolete"], undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not retry indefinitely if the new session is rejected", async () => {
    const client = new LoseItClient(config);
    client.restoreSession({
      cookies: { session: "expired" },
      userId: 42,
      username: "Test",
      timestamp: 0,
    });
    const previousFetch = globalThis.fetch;
    let logins = 0;
    let reads = 0;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/account/login")) {
        logins++;
        return new Response(JSON.stringify({
          user_id: 42,
          username: "test@example.com",
        }), { headers: { "Set-Cookie": "session=fresh; Path=/" } });
      }
      reads++;
      return new Response(
        '//EX[1,["com.loseit.core.UserAuthenticationFailedException/123"],0,7]',
      );
    };
    try {
      await assert.rejects(client.gwtRpc("getGoalsData", []), GwtAuthenticationError);
      assert.equal(logins, 1);
      assert.equal(reads, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

it("does not password-login when validating a cached session hits a network failure", async () => {
  const client = new LoseItClient(config);
  (client as unknown as { loadSession(): Promise<LoseItSession> }).loadSession = async () => ({
    cookies: { session: "cached" }, userId: 42, username: "Test", timestamp: 0,
  });
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    assert.ok(!String(input).endsWith("/account/login"));
    throw new DOMException("timed out", "TimeoutError");
  };
  try {
    await assert.rejects(client.initialize(), LoseItNetworkError);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; }
});

it("shares one password login across concurrent expired-session reads", async () => {
  const client = new LoseItClient(config);
  client.restoreSession({ cookies: { session: "expired" }, userId: 42, username: "Test", timestamp: 0 });
  const previousFetch = globalThis.fetch;
  let logins = 0;
  let expiredReads = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/account/login")) {
      logins++;
      return new Response(JSON.stringify({ user_id: 42, username: "test@example.com" }), { headers: { "Set-Cookie": "session=fresh; Path=/" } });
    }
    if (new Headers(init?.headers).get("Cookie") === "session=expired") {
      if (++expiredReads === 2) await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("expired", { status: 401 });
    }
    return new Response("//OK[1,[],0,7]");
  };
  try {
    await Promise.all([client.gwtRpc("getGoalsData", []), client.gwtRpc("getGoalsData", [])]);
    assert.equal(logins, 1);
    assert.equal(expiredReads, 2);
  } finally { globalThis.fetch = previousFetch; }
});

it("deduplicates simultaneous password logins", async () => {
  const client = new LoseItClient(config);
  const previousFetch = globalThis.fetch;
  let logins = 0;
  globalThis.fetch = async () => {
    logins++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ user_id: 42, username: "test@example.com" }), { headers: { "Set-Cookie": "session=fresh; Path=/" } });
  };
  try {
    await Promise.all([client.login(), client.login()]);
    assert.equal(logins, 1);
  } finally { globalThis.fetch = previousFetch; }
});

it("refreshes a rejected gateway token once and uses the replacement", async () => {
  const client = new LoseItClient(config);
  client.restoreSession({ cookies: { liauth: "expired" }, userId: 42, username: "Test", timestamp: 0 });
  const previousFetch = globalThis.fetch;
  const tokens: string[] = [];
  let logins = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/account/login")) {
      logins++;
      return new Response(JSON.stringify({ user_id: 42, username: "test@example.com" }), { headers: { "Set-Cookie": "liauth=fresh; Path=/" } });
    }
    tokens.push(new Headers(init?.headers).get("Authorization")!);
    return tokens.length === 1 ? new Response("expired", { status: 401 }) : new Response(Uint8Array.of(32, 1));
  };
  try {
    assert.deepEqual(await client.gatewayBundle(Uint8Array.of(32, 42)), Uint8Array.of(32, 1));
    assert.deepEqual(tokens, ["Bearer expired", "Bearer fresh"]);
    assert.equal(logins, 1);
  } finally { globalThis.fetch = previousFetch; }
});

it("does not retry gateway writes when the response body is lost", async () => {
  const client = new LoseItClient(config);
  client.restoreSession({ cookies: { liauth: "valid" }, userId: 42, username: "Test", timestamp: 0 });
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } }));
  };
  try {
    await assert.rejects(client.gatewayBundle(Uint8Array.of(32, 42)), LoseItNetworkError);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; }
});
