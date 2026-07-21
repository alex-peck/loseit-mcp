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

const envSchema = z.object({
  LOSEIT_EMAIL: z.string().trim().min(1),
  LOSEIT_PASSWORD: z.string().trim().min(1),
  LOSEIT_TIMEZONE: z.string().trim().min(1).default("America/Chicago"),
  LOSEIT_SESSION_PATH: z
    .string()
    .trim()
    .min(1)
    .default("~/.loseit-mcp/session.json"),
  LOSEIT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(15_000),
  // When true (default), the policy hash + permutation are discovered from
  // Lose It's live web build at startup. Set to "false" to skip discovery and
  // use the explicit overrides / fallbacks below.
  LOSEIT_GWT_AUTOFETCH: booleanEnv(true),
  // Explicit overrides. When set, they win over auto-discovery.
  LOSEIT_GWT_POLICY_HASH: z.string().trim().min(1).optional(),
  LOSEIT_GWT_PERMUTATION: z.string().trim().min(1).optional(),
});

export interface LoseItConfig {
  email: string;
  password: string;
  timezone: string;
  sessionPath: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoseItConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Lose It MCP configuration: ${message}`);
  }

  const sessionPath = parsed.data.LOSEIT_SESSION_PATH.replace(
    /^~/,
    process.env["HOME"] ?? "",
  );

  return {
    email: parsed.data.LOSEIT_EMAIL,
    password: parsed.data.LOSEIT_PASSWORD,
    timezone: parsed.data.LOSEIT_TIMEZONE,
    sessionPath,
    requestTimeoutMs: parsed.data.LOSEIT_REQUEST_TIMEOUT_MS,
    gwt: {
      moduleBase: "https://d3hsih69yn4d89.cloudfront.net/web/",
      serviceClass: "com.loseit.core.client.service.LoseItRemoteService",
      autoFetch: parsed.data.LOSEIT_GWT_AUTOFETCH,
      policyHashOverride: parsed.data.LOSEIT_GWT_POLICY_HASH ?? null,
      permutationOverride: parsed.data.LOSEIT_GWT_PERMUTATION ?? null,
      fallbackPolicyHash: FALLBACK_POLICY_HASH,
      fallbackPermutation: FALLBACK_PERMUTATION,
    },
  };
}
