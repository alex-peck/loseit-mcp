import assert from "node:assert/strict";
import { it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { MCP_SCOPE, MCP_WRITE_SCOPE } from "../auth/scopes.js";
import { loadConfig } from "../config.js";
import { LoseItClient } from "../loseit/client.js";
import { createServer } from "../server.js";

it("exposes food discovery and a non-read-only logging tool through MCP", async () => {
  const loseIt = new LoseItClient(loadConfig({
    LOSEIT_EMAIL: "test@example.com",
    LOSEIT_PASSWORD: "secret",
    LOSEIT_GWT_AUTOFETCH: "false",
  }));
  const server = createServer(loseIt, { writeAuth: null });
  const client = new Client({ name: "test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    for (const name of [
      "loseit_get_food_model",
      "loseit_search_foods",
      "loseit_get_food",
      "loseit_log_food",
      "loseit_get_food_log",
    ]) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
    const logTool = tools.find((tool) => tool.name === "loseit_log_food");
    assert.equal(logTool?.annotations?.readOnlyHint, false);
    assert.equal(logTool?.annotations?.idempotentHint, false);

    const result = await client.callTool({
      name: "loseit_get_food_model",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const data = z.object({
      result: z.object({
        meals: z.array(z.string()),
        servingUnits: z.array(z.object({ id: z.number(), unit: z.string() })),
        timezone: z.string(),
      }),
    }).parse(result.structuredContent).result;
    assert.deepEqual(data.meals, ["breakfast", "lunch", "dinner", "snacks"]);
    assert.equal(data.servingUnits.find((unit) => unit.id === 27)?.unit, "Serving");
    assert.equal(data.timezone, "America/Chicago");

    const invalidDate = await client.callTool({
      name: "loseit_log_food",
      arguments: {
        foodId: "AAAAAAAAAAAAAAAAAAAAAA",
        name: "Test",
        source: null,
        meal: "dinner",
        date: "2026-02-30",
      },
    });
    assert.equal(invalidDate.isError, true);
    assert.match(
      JSON.stringify(invalidDate.content),
      /date is not a valid date/,
    );

    const invalidLogDate = await client.callTool({
      name: "loseit_get_food_log",
      arguments: { date: "2026-02-30" },
    });
    assert.equal(invalidLogDate.isError, true);

    const conflictingPortion = await client.callTool({
      name: "loseit_log_food",
      arguments: {
        foodId: "AAAAAAAAAAAAAAAAAAAAAA",
        name: "Test",
        source: null,
        meal: "snacks",
        servings: 2,
        portion: { amount: 30, unit: "grams" },
      },
    });
    assert.equal(conflictingPortion.isError, true);
    assert.match(JSON.stringify(conflictingPortion.content), /either servings or portion/);
  } finally {
    await client.close();
    await server.close();
  }
});

it("denies food writes when a hosted client lacks the write scope", async () => {
  const loseIt = new LoseItClient(loadConfig({
    LOSEIT_EMAIL: "test@example.com",
    LOSEIT_PASSWORD: "secret",
    LOSEIT_GWT_AUTOFETCH: "false",
  }));
  const server = createServer(loseIt, {
    writeAuth: {
      resourceMetadataUrl: "https://loseit.example.com/.well-known/oauth-protected-resource/mcp",
    },
  });
  const client = new Client({ name: "test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, {
    ...options,
    authInfo: {
      token: "read-only-token",
      clientId: "test-client",
      scopes: [MCP_SCOPE],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const logTool = tools.find((tool) => tool.name === "loseit_log_food");
    assert.deepEqual(logTool?._meta?.["securitySchemes"], [
      { type: "oauth2", scopes: [MCP_SCOPE, MCP_WRITE_SCOPE] },
    ]);
    const result = await client.callTool({
      name: "loseit_log_food",
      arguments: {
        foodId: "AAAAAAAAAAAAAAAAAAAAAA",
        name: "Test",
        source: null,
        meal: "snacks",
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /mcp:tools:write/);
    assert.deepEqual(result._meta?.["mcp/www_authenticate"], [
      'Bearer resource_metadata="https://loseit.example.com/.well-known/oauth-protected-resource/mcp", ' +
      'error="insufficient_scope", error_description="Food logging requires write access", ' +
      'scope="mcp:tools mcp:tools:write"',
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("accepts the write scope at the hosted tool boundary", async () => {
  const loseIt = new LoseItClient(loadConfig({
    LOSEIT_EMAIL: "test@example.com",
    LOSEIT_PASSWORD: "secret",
    LOSEIT_GWT_AUTOFETCH: "false",
  }));
  const server = createServer(loseIt, {
    writeAuth: {
      resourceMetadataUrl: "https://loseit.example.com/.well-known/oauth-protected-resource/mcp",
    },
  });
  const client = new Client({ name: "test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => send(message, {
    ...options,
    authInfo: {
      token: "test-access-token",
      clientId: "test-client",
      scopes: [MCP_SCOPE, MCP_WRITE_SCOPE],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "loseit_log_food",
      arguments: {
        foodId: "AAAAAAAAAAAAAAAAAAAAAA",
        name: "Test",
        source: null,
        meal: "snacks",
        date: "2026-02-30",
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /date is not a valid date/);
  } finally {
    await client.close();
    await server.close();
  }
});
