import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { loadHttpConfig } from "../config.js";
import { EncryptedStore } from "./store.js";
import { UserClientManager } from "./userClients.js";

it("validates a cached session when reconnecting and persists its replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loseit-mcp-session-"));
  const secret = "session-test-secret-that-is-at-least-32-characters";
  const config = loadHttpConfig({
    MCP_PUBLIC_URL: "https://loseit.example.com",
    MCP_ENCRYPTION_SECRET: secret,
    MCP_DATA_PATH: join(directory, "server.enc.json"),
    LOSEIT_GWT_AUTOFETCH: "false",
  });
  const store = new EncryptedStore(config.dataPath, secret);
  const id = createHmac("sha256", secret)
    .update("test@example.com", "utf8")
    .digest("base64url");
  await store.update((state) => {
    state.users[id] = {
      id,
      email: "test@example.com",
      password: "secret",
      timezone: "America/Chicago",
      session: {
        cookies: { session: "expired" },
        userId: 42,
        username: "Test",
        timestamp: 0,
      },
      createdAt: 1,
      updatedAt: 1,
    };
  });

  const previousFetch = globalThis.fetch;
  let reads = 0;
  let logins = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/account/login")) {
      logins++;
      return new Response(JSON.stringify({
        user_id: 42,
        username: "test@example.com",
      }), { headers: { "Set-Cookie": "session=fresh; Path=/" } });
    }
    reads++;
    return new Response(reads === 1
      ? '//EX[1,["com.loseit.core.UserAuthenticationFailedException/123"],0,7]'
      : "//OK[1,[],0,7]");
  };
  try {
    const manager = new UserClientManager(config, store);
    const user = await manager.authenticate(
      "test@example.com", "secret", "America/Chicago",
    );
    assert.equal(user.session?.cookies["session"], "fresh");
    assert.equal(logins, 1);
    assert.equal(reads, 2);
    const persisted = await store.read((state) => state.users[id]);
    assert.equal(persisted?.session?.cookies["session"], "fresh");
  } finally {
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
