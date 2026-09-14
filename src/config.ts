import { z } from "zod";

// Last-resort GWT values, only used if auto-discovery fails AND no explicit
// override is provided. These track a specific Lose It web build and WILL go
// stale when Lose It recompiles — auto-discovery (see gwtBuild.ts) is the
// primary source of truth.
const FALLBACK_POLICY_HASH = "8F87EC8969F17AE77B6283D3A83F6D4C";
const FALLBACK_PERMUTATION = "351AE5DC0CA36AD3BA9C7CBA7B0E07B8";

const booleanEnv = (defaultValue: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) =>
      v === undefined || v === "" ? defaultValue : v.toLowerCase() !== "false",
    );

const commonEnvSchema = z.object({
  LOSEIT_TIMEZONE: z.string().trim().min(1).default("America/Chicago"),
  LOSEIT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(15_000),
  LOSEIT_GWT_AUTOFETCH: booleanEnv(true),
  LOSEIT_GWT_POLICY_HASH: z.string().trim().min(1).optional(),
  LOSEIT_GWT_PERMUTATION: z.string().trim().min(1).optional(),
});

const stdioEnvSchema = commonEnvSchema.extend({
  LOSEIT_EMAIL: z.string().trim().min(1),
  LOSEIT_PASSWORD: z.string().trim().min(1),
  LOSEIT_SESSION_PATH: z
    .string()
    .trim()
    .min(1)
    .default("~/.loseit-mcp/session.json"),
});

const httpEnvSchema = commonEnvSchema.extend({
  MCP_PUBLIC_URL: z.string().trim().url(),
  MCP_ENCRYPTION_SECRET: z.string().min(32),
  MCP_HTTP_HOST: z.string().trim().min(1).default("0.0.0.0"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  MCP_TRUST_PROXY: booleanEnv(false),
  MCP_DATA_PATH: z
    .string()
    .trim()
    .min(1)
    .default("~/.loseit-mcp/server.enc.json"),
  MCP_ALLOWED_HOSTS: z.string().trim().optional(),
});

export interface LoseItConfig {
  email: string;
  password: string;
  timezone: string;
  sessionPath: string | null;
  requestTimeoutMs: number;
  gwt: {
    moduleBase: string;
    serviceClass: string;
    autoFetch: boolean;
    /** Explicit override for the policy hash, or null to auto-discover. */
    policyHashOverride: string | null;
    /** Explicit override for the permutation, or null to auto-discover. */
    permutationOverride: string | null;
    /** Last-resort values if discovery fails and no override is set. */
    fallbackPolicyHash: string;
    fallbackPermutation: string;
  };
}

export interface HttpServerConfig {
  mode: "http";
  host: string;
  port: number;
  publicUrl: URL;
  dataPath: string;
  encryptionSecret: string;
  allowedHosts: string[];
  trustProxy: boolean;
  loseIt: Omit<LoseItConfig, "email" | "password" | "sessionPath">;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path.replace(/^~/, env["HOME"] ?? process.env["HOME"] ?? "");
}

function commonConfig(
  data: z.infer<typeof commonEnvSchema>,
): Omit<LoseItConfig, "email" | "password" | "sessionPath"> {
  return {
    timezone: data.LOSEIT_TIMEZONE,
    requestTimeoutMs: data.LOSEIT_REQUEST_TIMEOUT_MS,
    gwt: {
      moduleBase: "https://d3hsih69yn4d89.cloudfront.net/web/",
      serviceClass: "com.loseit.core.client.service.LoseItRemoteService",
      autoFetch: data.LOSEIT_GWT_AUTOFETCH,
      policyHashOverride: data.LOSEIT_GWT_POLICY_HASH ?? null,
      permutationOverride: data.LOSEIT_GWT_PERMUTATION ?? null,
      fallbackPolicyHash: FALLBACK_POLICY_HASH,
      fallbackPermutation: FALLBACK_PERMUTATION,
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoseItConfig {
  const parsed = stdioEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(
      `Invalid Lose It MCP configuration: ${formatIssues(parsed.error)}`,
    );
  }

  return {
    ...commonConfig(parsed.data),
    email: parsed.data.LOSEIT_EMAIL,
    password: parsed.data.LOSEIT_PASSWORD,
    sessionPath: expandHome(parsed.data.LOSEIT_SESSION_PATH, env),
  };
}

export function loadHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpServerConfig {
  const parsed = httpEnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(
      `Invalid Lose It MCP HTTP configuration: ${formatIssues(parsed.error)}`,
    );
  }

  const publicUrl = new URL(parsed.data.MCP_PUBLIC_URL);
  publicUrl.hash = "";
  publicUrl.search = "";
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, "") || "/";
  if (publicUrl.pathname !== "/") {
    throw new Error(
      "Invalid Lose It MCP HTTP configuration: MCP_PUBLIC_URL must not include a path",
    );
  }

  const configuredHosts = parsed.data.MCP_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    mode: "http",
    host: parsed.data.MCP_HTTP_HOST,
    port: parsed.data.MCP_HTTP_PORT,
    publicUrl,
    dataPath: expandHome(parsed.data.MCP_DATA_PATH, env),
    encryptionSecret: parsed.data.MCP_ENCRYPTION_SECRET,
    trustProxy: parsed.data.MCP_TRUST_PROXY,
    allowedHosts:
      configuredHosts && configuredHosts.length > 0
        ? configuredHosts
        : [publicUrl.hostname],
    loseIt: commonConfig(parsed.data),
  };
}

export function createUserConfig(
  base: HttpServerConfig["loseIt"],
  email: string,
  password: string,
): LoseItConfig {
  return {
    ...base,
    email,
    password,
    sessionPath: null,
  };
}
