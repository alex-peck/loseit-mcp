import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const FILE_VERSION = 1;
const AAD = Buffer.from("loseit-mcp-encrypted-store-v1", "utf8");

interface EncryptedFile {
  version: typeof FILE_VERSION;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface StoredUser {
  id: string;
  email: string;
  password: string;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredToken {
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
}

export interface PersistedState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  users: Record<string, StoredUser>;
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

function emptyState(): PersistedState {
  return {
    version: 1,
    clients: {},
    users: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export class EncryptedStore {
  private readonly key: Buffer;
  private state: PersistedState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    secret: string,
  ) {
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  async initialize(): Promise<void> {
    if (this.state !== null) {
      return;
    }

    try {
      const encrypted = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as EncryptedFile;
      if (encrypted.version !== FILE_VERSION) {
        throw new Error(
          `Unsupported encrypted store version: ${String(encrypted.version)}`,
        );
      }

      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(encrypted.iv, "base64url"),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const state = JSON.parse(plaintext.toString("utf8")) as PersistedState;
      if (state.version !== 1) {
        throw new Error(`Unsupported data version: ${String(state.version)}`);
      }
      this.state = state;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(
          `Could not open encrypted data store at ${this.path}. Check MCP_ENCRYPTION_SECRET and file integrity.`,
          { cause: error },
        );
      }
      this.state = emptyState();
    }
  }

  async read<T>(reader: (state: Readonly<PersistedState>) => T): Promise<T> {
    await this.initialize();
    await this.writeQueue;
    return reader(this.requireState());
  }

  async update<T>(
    updater: (state: PersistedState) => T | Promise<T>,
  ): Promise<T> {
    await this.initialize();

    let result!: T;
    const write = this.writeQueue.then(async () => {
      result = await updater(this.requireState());
      await this.persist();
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return result;
  }

  private requireState(): PersistedState {
    if (this.state === null) {
      throw new Error("Encrypted store has not been initialized");
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.requireState()), "utf8"),
      cipher.final(),
    ]);

    const encrypted: EncryptedFile = {
      version: FILE_VERSION,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };

    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(encrypted), { mode: 0o600 });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}
