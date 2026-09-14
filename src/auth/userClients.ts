import { createHmac } from "node:crypto";

import type { HttpServerConfig } from "../config.js";
import { createUserConfig } from "../config.js";
import { LoseItClient } from "../loseit/client.js";
import type { EncryptedStore, StoredUser } from "./store.js";

export class UserClientManager {
  private readonly clients = new Map<string, Promise<LoseItClient>>();

  constructor(
    private readonly config: HttpServerConfig,
    private readonly store: EncryptedStore,
  ) {}

  async authenticate(
    email: string,
    password: string,
    timezone: string,
  ): Promise<StoredUser> {
    const normalizedEmail = email.trim().toLowerCase();
    const userId = this.userIdForEmail(normalizedEmail);
    const client = new LoseItClient(
      createUserConfig(
        { ...this.config.loseIt, timezone },
        normalizedEmail,
        password,
      ),
    );
    await client.initialize();

    const now = Date.now();
    const user = await this.store.update((state) => {
      const existing = state.users[userId];
      const stored: StoredUser = {
        id: userId,
        email: normalizedEmail,
        password,
        timezone,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.users[userId] = stored;
      return stored;
    });

    this.clients.set(userId, Promise.resolve(client));
    return user;
  }

  async getClient(userId: string): Promise<LoseItClient> {
    const existing = this.clients.get(userId);
    if (existing) {
      return existing;
    }

    const initialization = this.createStoredClient(userId);
    this.clients.set(userId, initialization);
    try {
      return await initialization;
    } catch (error) {
      this.clients.delete(userId);
      throw error;
    }
  }

  private async createStoredClient(userId: string): Promise<LoseItClient> {
    const user = await this.store.read((state) => state.users[userId]);
    if (!user) {
      throw new Error("Authenticated Lose It account no longer exists");
    }

    const client = new LoseItClient(
      createUserConfig(
        { ...this.config.loseIt, timezone: user.timezone },
        user.email,
        user.password,
      ),
    );
    await client.initialize();
    return client;
  }

  private userIdForEmail(email: string): string {
    return createHmac("sha256", this.config.encryptionSecret)
      .update(email, "utf8")
      .digest("base64url");
  }
}
