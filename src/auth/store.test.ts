import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { EncryptedStore } from "./store.js";

describe("EncryptedStore", () => {
  it("persists sensitive values encrypted and reloads them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loseit-mcp-store-"));
    const path = join(directory, "server.enc.json");
    const secret = "test-secret-that-is-at-least-32-characters";

    try {
      const store = new EncryptedStore(path, secret);
      await store.update((state) => {
        state.users["user-1"] = {
          id: "user-1",
          email: "friend@example.com",
          password: "super-secret-password",
          timezone: "America/New_York",
          createdAt: 1,
          updatedAt: 1,
        };
      });

      const onDisk = await readFile(path, "utf8");
      assert.doesNotMatch(onDisk, /friend@example\.com/);
      assert.doesNotMatch(onDisk, /super-secret-password/);

      const reloaded = new EncryptedStore(path, secret);
      const user = await reloaded.read((state) => state.users["user-1"]);
      assert.equal(user?.email, "friend@example.com");
      assert.equal(user?.password, "super-secret-password");

      const wrongSecret = new EncryptedStore(path, "x".repeat(32));
      await assert.rejects(() => wrongSecret.initialize(), /Could not open/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
