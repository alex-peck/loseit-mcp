import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Response } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { loadHttpConfig } from "../config.js";
import { LoseItOAuthProvider } from "./provider.js";
import { EncryptedStore } from "./store.js";
import type { UserClientManager } from "./userClients.js";

describe("LoseItOAuthProvider", () => {
  it("binds tokens to a user and rotates refresh tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loseit-mcp-oauth-"));
    const secret = "oauth-test-secret-that-is-at-least-32-characters";
    const config = loadHttpConfig({
      MCP_PUBLIC_URL: "https://loseit.example.com",
      MCP_ENCRYPTION_SECRET: secret,
      MCP_DATA_PATH: join(directory, "server.enc.json"),
    });

    try {
      const store = new EncryptedStore(config.dataPath, secret);
      const user = {
        id: "user-1",
        email: "friend@example.com",
        password: "password",
        timezone: "America/New_York",
        createdAt: 1,
        updatedAt: 1,
      };
      let authenticateCalls = 0;
      let markAuthenticationStarted!: () => void;
      let finishAuthentication!: () => void;
      const authenticationStarted = new Promise<void>((resolve) => {
        markAuthenticationStarted = resolve;
      });
      const authenticationReady = new Promise<void>((resolve) => {
        finishAuthentication = resolve;
      });
      const userClients = {
        authenticate: async () => {
          authenticateCalls += 1;
          markAuthenticationStarted();
          await authenticationReady;
          return user;
        },
      } as unknown as UserClientManager;
      const provider = new LoseItOAuthProvider(config, store, userClients);
      const client: OAuthClientInformationFull = {
        client_id: "chatgpt-client",
        client_id_issued_at: 1,
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      await store.update((state) => {
        state.clients[client.client_id] = client;
      });

      let signInPage = "";
      const response = {
        status() {
          return this;
        },
        type() {
          return this;
        },
        send(body: string) {
          signInPage = body;
          return this;
        },
      } as unknown as Response;

      await provider.authorize(
        client,
        {
          codeChallenge: "challenge",
          redirectUri: client.redirect_uris[0]!,
          resource: new URL("https://loseit.example.com/mcp"),
          scopes: ["mcp:tools"],
        },
        response,
      );
      const loginId = signInPage.match(/name="login_id" value="([^"]+)"/)?.[1];
      assert.ok(loginId);

      const firstLogin = provider.completeLogin(
        loginId,
        user.email,
        user.password,
        user.timezone,
      );
      const duplicateLogin = provider.completeLogin(
        loginId,
        user.email,
        user.password,
        user.timezone,
      );
      await authenticationStarted;
      assert.equal(authenticateCalls, 1);
      finishAuthentication();
      const [redirect, duplicateRedirect] = await Promise.all([
        firstLogin,
        duplicateLogin,
      ]);
      assert.equal(duplicateRedirect.href, redirect.href);
      const code = redirect.searchParams.get("code");
      assert.ok(code);
      assert.equal(
        await provider.challengeForAuthorizationCode(client, code),
        "challenge",
      );

      const firstTokens = await provider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        client.redirect_uris[0],
        new URL("https://loseit.example.com/mcp"),
      );
      const auth = await provider.verifyAccessToken(firstTokens.access_token);
      assert.equal(auth.extra?.["userId"], user.id);
      assert.ok(firstTokens.refresh_token);

      const secondTokens = await provider.exchangeRefreshToken(
        client,
        firstTokens.refresh_token,
      );
      assert.notEqual(secondTokens.refresh_token, firstTokens.refresh_token);
      await assert.rejects(
        () =>
          provider.exchangeRefreshToken(client, firstTokens.refresh_token!),
        /Invalid or expired refresh token/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
