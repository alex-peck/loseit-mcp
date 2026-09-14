import { createHmac } from "node:crypto";

import type { HttpServerConfig } from "../config.js";
import { createUserConfig } from "../config.js";
import {
  LoseItClient,
  type LoseItSession,
} from "../loseit/client.js";
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
    const existing = await this.store.read((state) => state.users[userId]);
    const client = this.createClient(
      userId,
      normalizedEmail,
      password,
      timezone,
    );

    if (existing?.password === password && existing.session) {
      client.restoreSession(existing.session);
      const user = await this.store.update((state) => {
        const stored = state.users[userId]!;
        stored.timezone = timezone;
        stored.updatedAt = Date.now();
        return stored;
      });
      this.clients.set(userId, Promise.resolve(client));
      this.startPreparation(client);
      return user;
    }

    await client.login();

    const now = Date.now();
    const user = await this.store.update((state) => {
      const existing = state.users[userId];
      const stored: StoredUser = {
        id: userId,
        email: normalizedEmail,
        password,
        timezone,
        session: client.exportSession(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.users[userId] = stored;
      return stored;
    });

    this.clients.set(userId, Promise.resolve(client));
    this.startPreparation(client);
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

    const client = this.createClient(
      user.id,
      user.email,
      user.password,
      user.timezone,
    );
    if (user.session) {
      client.restoreSession(user.session);
      this.startPreparation(client);
    } else {
      await client.initialize();
    }
    return client;
  }

  private createClient(
    userId: string,
    email: string,
    password: string,
    timezone: string,
  ): LoseItClient {
    return new LoseItClient(
      createUserConfig(
        { ...this.config.loseIt, timezone },
        email,
        password,
      ),
      async (session: LoseItSession) => {
        await this.store.update((state) => {
          const user = state.users[userId];
          if (user) {
            user.session = session;
            user.updatedAt = Date.now();
          }
        });
      },
    );
  }

  private startPreparation(client: LoseItClient): void {
    void client.prepare().catch((error: unknown) => {
      console.error("Lose It background preparation failed:", error);
    });
  }

  private userIdForEmail(email: string): string {
    return createHmac("sha256", this.config.encryptionSecret)
      .update(email, "utf8")
      .digest("base64url");
  }
}
