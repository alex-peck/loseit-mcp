import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig, loadHttpConfig } from "./config.js";

describe("configuration modes", () => {
  it("keeps stdio credentials and session caching", () => {
    const config = loadConfig({
      HOME: "/tmp/test-home",
      LOSEIT_EMAIL: "person@example.com",
      LOSEIT_PASSWORD: "secret",
      LOSEIT_GWT_AUTOFETCH: "false",
    });

    assert.equal(config.email, "person@example.com");
    assert.equal(config.sessionPath, "/tmp/test-home/.loseit-mcp/session.json");
  });

  it("loads HTTP mode without global Lose It credentials", () => {
    const config = loadHttpConfig({
      HOME: "/tmp/test-home",
      MCP_PUBLIC_URL: "https://loseit.example.com",
      MCP_ENCRYPTION_SECRET: "a".repeat(32),
      MCP_TRUST_PROXY: "true",
    });

    assert.equal(config.publicUrl.href, "https://loseit.example.com/");
    assert.equal(config.dataPath, "/tmp/test-home/.loseit-mcp/server.enc.json");
    assert.deepEqual(config.allowedHosts, ["loseit.example.com"]);
    assert.equal(config.trustProxy, true);
  });

  it("rejects a public URL with a path", () => {
    assert.throws(
      () =>
        loadHttpConfig({
          MCP_PUBLIC_URL: "https://loseit.example.com/base",
          MCP_ENCRYPTION_SECRET: "a".repeat(32),
        }),
      /must not include a path/,
    );
  });
});
