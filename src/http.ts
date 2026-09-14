import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { HttpServerConfig } from "./config.js";
import { LoseItApiError } from "./loseit/client.js";
import { APP_NAME } from "./meta.js";
import { createServer } from "./server.js";
import { LoseItOAuthProvider, MCP_SCOPE } from "./auth/provider.js";
import { EncryptedStore } from "./auth/store.js";
import { UserClientManager } from "./auth/userClients.js";

interface AuthenticatedRequest extends express.Request {
  auth?: AuthInfo;
}

interface ActiveSession {
  userId: string;
  transport: StreamableHTTPServerTransport;
}

export interface RunningHttpServer {
  server: HttpServer;
  close(): Promise<void>;
}

const loginSchema = z.object({
  login_id: z.string().min(1),
  email: z.string().trim().email(),
  password: z.string().min(1),
  timezone: z.string().trim().min(1).refine(isValidTimezone, {
    message: "Enter a valid IANA timezone, such as America/New_York",
  }),
});

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function authenticatedUserId(req: AuthenticatedRequest): string | null {
  const userId = req.auth?.extra?.["userId"];
  return typeof userId === "string" ? userId : null;
}

function sendMcpError(
  res: express.Response,
  status: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

export async function startHttpServer(
  config: HttpServerConfig,
): Promise<RunningHttpServer> {
  const store = new EncryptedStore(config.dataPath, config.encryptionSecret);
  await store.initialize();
  const userClients = new UserClientManager(config, store);
  const authProvider = new LoseItOAuthProvider(config, store, userClients);
  const mcpUrl = new URL("/mcp", config.publicUrl);

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts,
  });
  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.post(
    "/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (req, res) => {
      const startedAt = Date.now();
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        const loginId =
          typeof req.body?.login_id === "string" ? req.body.login_id : "";
        const html = await authProvider.renderLoginError(
          loginId,
          parsed.error.issues[0]?.message ?? "Invalid sign-in details",
        );
        res.status(400).type("html").send(html);
        return;
      }

      try {
        const redirect = await authProvider.completeLogin(
          parsed.data.login_id,
          parsed.data.email,
          parsed.data.password,
          parsed.data.timezone,
        );
        console.error("OAuth login endpoint redirecting", {
          redirectHost: redirect.hostname,
          durationMs: Date.now() - startedAt,
        });
        res.redirect(302, redirect.href);
      } catch (error) {
        const publicMessage =
          error instanceof LoseItApiError &&
          (error.status === 400 || error.status === 401)
            ? "Lose It rejected those credentials. Check your email and password."
            : error instanceof Error &&
                error.message.startsWith("This sign-in request has expired")
              ? error.message
              : "Could not connect to Lose It right now. Please try again.";
        console.error("Lose It sign-in failed:", error);
        const html = await authProvider.renderLoginError(
          parsed.data.login_id,
          publicMessage,
        );
        res.status(401).type("html").send(html);
      }
    },
  );

  app.use("/token", (req, res, next) => {
    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const startedAt = Date.now();
    console.error("OAuth token endpoint request", {
      grantType: body["grant_type"],
      hasClientId:
        typeof body["client_id"] === "string" && body["client_id"].length > 0,
      hasCode: typeof body["code"] === "string" && body["code"].length > 0,
      hasCodeVerifier:
        typeof body["code_verifier"] === "string" &&
        body["code_verifier"].length > 0,
      redirectUri: body["redirect_uri"],
      resource: body["resource"],
      scope: body["scope"],
    });
    res.on("finish", () => {
      console.error("OAuth token endpoint response", {
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: authProvider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: "Lose It MCP",
    }),
  );

  const bearerAuth = requireBearerAuth({
    verifier: authProvider,
    requiredScopes: [MCP_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  const sessions = new Map<string, ActiveSession>();

  const getSession = (
    req: AuthenticatedRequest,
    res: express.Response,
  ): ActiveSession | null => {
    const sessionId = headerValue(req.headers["mcp-session-id"]);
    const userId = authenticatedUserId(req);
    if (!sessionId || !userId) {
      sendMcpError(res, 400, "Missing MCP session or authenticated user");
      return null;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      sendMcpError(res, 404, "MCP session not found");
      return null;
    }
    if (session.userId !== userId) {
      sendMcpError(res, 403, "MCP session belongs to another user");
      return null;
    }
    return session;
  };

  app.post("/mcp", bearerAuth, async (request, res) => {
    const req = request as AuthenticatedRequest;
    const userId = authenticatedUserId(req);
    if (!userId) {
      sendMcpError(res, 401, "Authenticated user is missing");
      return;
    }

    const sessionId = headerValue(req.headers["mcp-session-id"]);
    if (sessionId) {
      const session = getSession(req, res);
      if (session) {
        await session.transport.handleRequest(req, res, req.body);
      }
      return;
    }

    if (!isInitializeRequest(req.body)) {
      sendMcpError(res, 400, "Initialize the MCP session first");
      return;
    }

    try {
      const client = await userClients.getClient(userId);
      const mcpServer = createServer(client);
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            userId,
            transport,
          });
        },
      });
      transport.onclose = () => {
        const initializedSessionId = transport.sessionId;
        if (initializedSessionId) {
          sessions.delete(initializedSessionId);
        }
      };
      await mcpServer.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Could not initialize MCP session:", error);
      if (!res.headersSent) {
        sendMcpError(res, 500, "Could not initialize MCP session");
      }
    }
  });

  app.get("/mcp", bearerAuth, async (request, res) => {
    const session = getSession(request as AuthenticatedRequest, res);
    if (session) {
      await session.transport.handleRequest(request, res);
    }
  });

  app.delete("/mcp", bearerAuth, async (request, res) => {
    const session = getSession(request as AuthenticatedRequest, res);
    if (session) {
      await session.transport.handleRequest(request, res);
    }
  });

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const listening = app.listen(config.port, config.host, () => {
      resolve(listening);
    });
    listening.once("error", reject);
  });

  console.error(`${APP_NAME} is running at ${mcpUrl.href}`);
  return {
    server,
    async close() {
      await Promise.allSettled(
        Array.from(sessions.values(), (session) => session.transport.close()),
      );
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
