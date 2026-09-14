import { randomBytes } from "node:crypto";

import type { Response } from "express";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { HttpServerConfig } from "../config.js";
import { EncryptedStore, hashToken, type PersistedState } from "./store.js";
import type { UserClientManager } from "./userClients.js";

const MCP_SCOPE = "mcp:tools";
const LOGIN_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface PendingLogin {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  userId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: EncryptedStore) {}

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.store.read((state) => state.clients[clientId]);
  }

  async registerClient(
    client: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >,
  ): Promise<OAuthClientInformationFull> {
    const registered = client as OAuthClientInformationFull;
    if (!registered.client_id) {
      throw new InvalidRequestError("OAuth client ID was not generated");
    }
    await this.store.update((state) => {
      state.clients[registered.client_id] = registered;
    });
    return registered;
  }
}

export class LoseItOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly resourceUrl: URL;

  constructor(
    private readonly config: HttpServerConfig,
    private readonly store: EncryptedStore,
    private readonly userClients: UserClientManager,
  ) {
    this.clientsStore = new PersistentClientsStore(store);
    this.resourceUrl = new URL("/mcp", config.publicUrl);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.pruneTransientData();
    this.validateScopes(params.scopes);
    this.validateResource(params.resource);

    const loginId = randomToken();
    this.pendingLogins.set(loginId, {
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    });

    res
      .status(200)
      .type("html")
      .send(this.renderSignInPage(loginId, client, params));
  }

  async completeLogin(
    loginId: string,
    email: string,
    password: string,
    timezone: string,
  ): Promise<URL> {
    this.pruneTransientData();
    const pending = this.pendingLogins.get(loginId);
    if (!pending) {
      throw new InvalidGrantError(
        "This sign-in request has expired. Return to ChatGPT and try again.",
      );
    }

    const client = await this.clientsStore.getClient(pending.clientId);
    if (!client) {
      throw new InvalidGrantError("OAuth client is no longer registered");
    }

    this.pendingLogins.delete(loginId);
    let user;
    try {
      user = await this.userClients.authenticate(email, password, timezone);
    } catch (error) {
      if (pending.expiresAt > Date.now()) {
        this.pendingLogins.set(loginId, pending);
      }
      throw error;
    }
    const code = randomToken();
    this.authorizationCodes.set(code, {
      clientId: pending.clientId,
      userId: user.id,
      params: pending.params,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      redirect.searchParams.set("state", pending.params.state);
    }
    return redirect;
  }

  async renderLoginError(loginId: string, message: string): Promise<string> {
    this.pruneTransientData();
    const pending = this.pendingLogins.get(loginId);
    if (!pending) {
      return this.renderExpiredPage();
    }
    const client = await this.clientsStore.getClient(pending.clientId);
    if (!client) {
      return this.renderExpiredPage();
    }
    return this.renderSignInPage(loginId, client, pending.params, message);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = this.getAuthorizationCode(client, authorizationCode);
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.getAuthorizationCode(client, authorizationCode);
    if (redirectUri && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match");
    }
    this.validateResource(resource ?? code.params.resource);
    this.authorizationCodes.delete(authorizationCode);
    return this.issueTokenPair(
      code.userId,
      code.clientId,
      this.normalizedScopes(code.params.scopes),
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshHash = hashToken(refreshToken);
    return this.store.update((state) => {
      const stored = state.refreshTokens[refreshHash];
      if (
        !stored ||
        stored.clientId !== client.client_id ||
        stored.expiresAt <= Math.floor(Date.now() / 1000)
      ) {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }

      this.validateResource(resource ?? new URL(stored.resource));
      const requestedScopes = scopes ?? stored.scopes;
      this.validateScopes(requestedScopes);
      if (requestedScopes.some((scope) => !stored.scopes.includes(scope))) {
        throw new InvalidScopeError(
          "Refresh token cannot be expanded to additional scopes",
        );
      }

      delete state.refreshTokens[refreshHash];
      return this.addTokenPair(
        state,
        stored.userId,
        stored.clientId,
        this.normalizedScopes(requestedScopes),
      );
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const stored = await this.store.read(
      (state) => state.accessTokens[tokenHash],
    );
    const now = Math.floor(Date.now() / 1000);
    if (!stored || stored.expiresAt <= now) {
      if (stored) {
        await this.store.update((state) => {
          delete state.accessTokens[tokenHash];
        });
      }
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      resource: new URL(stored.resource),
      extra: { userId: stored.userId },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    await this.store.update((state) => {
      if (state.accessTokens[tokenHash]?.clientId === client.client_id) {
        delete state.accessTokens[tokenHash];
      }
      if (state.refreshTokens[tokenHash]?.clientId === client.client_id) {
        delete state.refreshTokens[tokenHash];
      }
    });
  }

  private getAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCode {
    this.pruneTransientData();
    const code = this.authorizationCodes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return code;
  }

  private async issueTokenPair(
    userId: string,
    clientId: string,
    scopes: string[],
  ): Promise<OAuthTokens> {
    return this.store.update((state) =>
      this.addTokenPair(state, userId, clientId, scopes),
    );
  }

  private addTokenPair(
    state: PersistedState,
    userId: string,
    clientId: string,
    scopes: string[],
  ): OAuthTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = Math.floor(Date.now() / 1000);
    const resource = this.resourceUrl.href;

    state.accessTokens[hashToken(accessToken)] = {
      userId,
      clientId,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
      resource,
    };
    state.refreshTokens[hashToken(refreshToken)] = {
      userId,
      clientId,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
      resource,
    };

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private validateScopes(scopes: string[] | undefined): void {
    if (scopes?.some((scope) => scope !== MCP_SCOPE)) {
      throw new InvalidScopeError(`Only the ${MCP_SCOPE} scope is supported`);
    }
  }

  private normalizedScopes(scopes: string[] | undefined): string[] {
    return scopes && scopes.length > 0 ? scopes : [MCP_SCOPE];
  }

  private validateResource(resource: URL | undefined): void {
    if (resource && resource.href !== this.resourceUrl.href) {
      throw new InvalidRequestError(
        `Invalid resource; expected ${this.resourceUrl.href}`,
      );
    }
  }

  private pruneTransientData(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingLogins) {
      if (pending.expiresAt <= now) {
        this.pendingLogins.delete(id);
      }
    }
    for (const [code, authorization] of this.authorizationCodes) {
      if (authorization.expiresAt <= now) {
        this.authorizationCodes.delete(code);
      }
    }
  }

  private renderSignInPage(
    loginId: string,
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    error?: string,
  ): string {
    const clientName = client.client_name ?? "ChatGPT";
    const scopeDescription = this.normalizedScopes(params.scopes).join(", ");
    const errorMarkup = error
      ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
      : "";

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Lose It MCP</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #1d2733; }
    main { width: min(420px, calc(100% - 32px)); background: white; padding: 32px; border-radius: 16px; box-shadow: 0 12px 40px rgb(0 0 0 / 12%); }
    h1 { margin: 0 0 8px; font-size: 1.6rem; }
    p { line-height: 1.5; color: #52606d; }
    label { display: block; margin-top: 18px; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; margin-top: 6px; padding: 11px 12px; border: 1px solid #bcccdc; border-radius: 8px; font: inherit; background: white; color: #1d2733; }
    button { width: 100%; margin-top: 24px; padding: 12px; border: 0; border-radius: 8px; background: #1261a0; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .fine { font-size: .84rem; }
    .error { margin-top: 16px; padding: 12px; border-radius: 8px; background: #fde8e8; color: #9b1c1c; }
    @media (prefers-color-scheme: dark) {
      body { background: #101820; color: #f4f6f8; }
      main { background: #1d2733; }
      p { color: #bcccdc; }
      input { background: #101820; color: #f4f6f8; border-color: #52606d; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Connect your Lose It account</h1>
    <p><strong>${escapeHtml(clientName)}</strong> is requesting access to ${escapeHtml(scopeDescription)} through this MCP server.</p>
    ${errorMarkup}
    <form method="post" action="/login">
      <input type="hidden" name="login_id" value="${escapeHtml(loginId)}">
      <label>Email
        <input name="email" type="email" autocomplete="username" required autofocus>
      </label>
      <label>Password
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <label>Timezone
        <input name="timezone" value="${escapeHtml(this.config.loseIt.timezone)}" required>
      </label>
      <button type="submit">Connect Lose It</button>
    </form>
    <p class="fine">Your credentials are sent only to this server and Lose It. This server stores them encrypted so it can reconnect when Lose It sessions expire.</p>
  </main>
</body>
</html>`;
  }

  private renderExpiredPage(): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in expired</title></head>
<body><main><h1>Sign-in expired</h1><p>Return to ChatGPT and start the connection again.</p></main></body>
</html>`;
  }
}

export { MCP_SCOPE };
