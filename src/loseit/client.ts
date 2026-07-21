import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoseItConfig } from "../config.js";
import { fetchGwtBuildInfo } from "./gwtBuild.js";
import { buildGwtRegistryFromCacheJs } from "./gwtRegistry.js";
import type { StructFieldDef } from "./structReader.js";
import {
  parseGwtResponse,
  GwtReader,
  GwtParseError,
  getTimezoneOffset,
  type GwtResponse,
} from "./gwt.js";

export class LoseItApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "LoseItApiError";
  }
}

export class LoseItNetworkError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly cause: unknown,
  ) {
    super(message, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "LoseItNetworkError";
  }
}

interface SessionCache {
  cookies: Record<string, string>;
  userId: number;
  username: string;
  timestamp: number;
}

export class LoseItClient {
  private cookies = new Map<string, string>();
  private userId: number | null = null;
  private username: string | null = null;
  private policyHash: string | null = null;
  private permutation: string | null = null;
  private gwtRegistry: Map<string, StructFieldDef[]> | null = null;

  constructor(private readonly config: LoseItConfig) {}

  async initialize(): Promise<void> {
    await this.resolveGwtBuildInfo();

    const cached = await this.loadSession();
    if (cached) {
      this.cookies = new Map(Object.entries(cached.cookies));
      this.userId = cached.userId;
      this.username = cached.username;

      // Validate session is still alive
      try {
        await this.gwtRpc("getGoalsData", []);
        console.error(
          `Loaded cached session for ${this.username} (user ${this.userId})`,
        );
        return;
      } catch {
        console.error("Cached session expired, re-authenticating...");
      }
    }

    await this.login();
  }

  /**
   * Determine the GWT permutation + serialization-policy hash to use.
   * Precedence: explicit env override > live auto-discovery > last-resort
   * fallback constants. Any discovery failure degrades gracefully.
   */
  private async resolveGwtBuildInfo(): Promise<void> {
    const { gwt } = this.config;

    let permutation = gwt.permutationOverride;
    let policyHash = gwt.policyHashOverride;

    const needsDiscovery =
      gwt.autoFetch && (permutation === null || policyHash === null);

    if (needsDiscovery) {
      try {
        const info = await fetchGwtBuildInfo(
          gwt.moduleBase,
          gwt.serviceClass,
          this.config.requestTimeoutMs,
        );
        permutation = permutation ?? info.permutation;
        policyHash = policyHash ?? info.policyHash;
        console.error(
          `Discovered GWT build: permutation=${info.permutation} policyHash=${info.policyHash}`,
        );
        try {
          this.gwtRegistry = buildGwtRegistryFromCacheJs(info.cacheJs);
          console.error(
            `Built GWT model registry from permutation (${this.gwtRegistry.size} types).`,
          );
        } catch (regError) {
          const msg =
            regError instanceof Error ? regError.message : String(regError);
          console.error(
            `GWT registry auto-build failed (${msg}); food logs use the built-in registry.`,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `GWT build auto-discovery failed (${message}); falling back to last-known values.`,
        );
      }
    }

    this.permutation = permutation ?? gwt.fallbackPermutation;
    this.policyHash = policyHash ?? gwt.fallbackPolicyHash;
  }

  async login(): Promise<void> {
    const url = "https://api.loseit.com/account/login";
    const body = new URLSearchParams({
      username: this.config.email,
      password: this.config.password,
      grant_type: "password",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new LoseItApiError(
        `Login failed with ${response.status}`,
        response.status,
        url,
        text.slice(0, 500),
      );
    }

    // Extract cookies from Set-Cookie headers
    const setCookieHeaders = response.headers.getSetCookie();
    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match?.[1] && match[2] !== undefined) {
        this.cookies.set(match[1], match[2]);
      }
    }

    const data = (await response.json()) as {
      user_id: number;
      username: string;
    };
    this.userId = data.user_id;

    // The GWT-RPC calls use the user's first name (e.g., "Andrew").
    // The login response only returns email, so we need to get the name
    // from a profile call or config. For now, extract from email prefix
    // and capitalize first letter only. This may need to be a config value
    // if the email prefix doesn't match the Lose It display name.
    // TODO: fetch from getInitializationData or add LOSEIT_DISPLAY_NAME env var
    const emailPrefix = data.username.split("@")[0] ?? "User";
    // Capitalize first letter, keep rest as-is
    this.username =
      emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);

    console.error(
      `Authenticated as ${data.username} (user ${this.userId})`,
    );

    await this.saveSession();
  }

  async gwtRpc(
    method: string,
    extraParams: string[],
    retried = false,
    dayNumber?: number,
  ): Promise<{ raw: GwtResponse; reader: GwtReader }> {
    if (!this.userId || !this.username) {
      throw new Error("Not authenticated — call initialize() first");
    }

    const timezoneOffset = getTimezoneOffset(this.config.timezone);
    const requestBody = this.buildGwtRequest(
      method,
      extraParams,
      timezoneOffset,
      dayNumber,
    );

    const url = "https://www.loseit.com/web/service";
    const cookieHeader = Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/x-gwt-rpc; charset=utf-8",
          "X-GWT-Module-Base": this.config.gwt.moduleBase,
          "X-GWT-Permutation": this.permutation ?? this.config.gwt.fallbackPermutation,
          "x-Loseit-GWTVersion": "devmode",
          "x-Loseit-HoursFromGMT": String(timezoneOffset),
          Cookie: cookieHeader,
        },
        body: requestBody,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (!retried && error instanceof Error && error.name !== "TimeoutError") {
        await new Promise((r) => setTimeout(r, 1000));
        return this.gwtRpc(method, extraParams, true, dayNumber);
      }
      throw new LoseItNetworkError(
        `GWT-RPC request failed for ${method}`,
        url,
        error,
      );
    }

    if (response.status === 401 && !retried) {
      await this.login();
      return this.gwtRpc(method, extraParams, true, dayNumber);
    }

    if (response.status >= 500 && !retried) {
      await new Promise((r) => setTimeout(r, 1000));
      return this.gwtRpc(method, extraParams, true, dayNumber);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new LoseItApiError(
        `GWT-RPC ${method} failed with ${response.status}`,
        response.status,
        url,
        text.slice(0, 500),
      );
    }

    const text = await response.text();
    const parsed = parseGwtResponse(text);
    const reader = new GwtReader(parsed.values, parsed.stringTable);

    return { raw: parsed, reader };
  }

  getUserId(): number {
    if (!this.userId) throw new Error("Not authenticated");
    return this.userId;
  }

  getUsername(): string {
    if (!this.username) throw new Error("Not authenticated");
    return this.username;
  }

  /** The IANA timezone configured for this account (e.g. "America/New_York"). */
  getTimezone(): string {
    return this.config.timezone;
  }

  /**
   * The GWT model field registry auto-derived from the live permutation, or
   * `null` if discovery/parsing failed (callers fall back to the built-in
   * hand-maintained registry).
   */
  getGwtRegistry(): Map<string, StructFieldDef[]> | null {
    return this.gwtRegistry;
  }

  private buildGwtRequest(
    method: string,
    _extraParams: string[],
    timezoneOffset: number,
    dayNumber?: number,
  ): string {
    // Exact format captured from Proxyman traffic for getGoalsData:
    // 7|0|7|moduleBase|policyHash|serviceClass|getGoalsData|tokenType|userIdType|username|1|2|3|4|1|5|5|0|6|21078800|7|-5|
    //
    // String table (indices 1-7):
    //   1=moduleBase, 2=policyHash, 3=serviceClass, 4=method,
    //   5=ServiceRequestToken type, 6=UserId type, 7=username
    //
    // Call section:
    //   1|2|3|4  = refs to moduleBase, policyHash, serviceClass, method
    //   1        = param count (1 = ServiceRequestToken)
    //   5        = ServiceRequestToken type ref
    //   5|0      = token instance (type ref 5, field value 0)
    //   6        = UserId type ref
    //   21078800 = userId value
    //   7        = username string ref
    //   -5       = timezone offset
    const { moduleBase, serviceClass } = this.config.gwt;
    const policyHash = this.policyHash ?? this.config.gwt.fallbackPolicyHash;

    const SERVICE_REQUEST_TOKEN =
      "com.loseit.core.client.service.ServiceRequestToken/1076571655";
    const USER_ID = "com.loseit.core.client.model.UserId/4281239478";
    const DAY_DATE = "com.loseit.core.shared.model.DayDate/1611136587";

    // ServiceRequestToken value: concrete type ref, int flag 0, UserId
    // (type ref + int userId), username string ref, int timezone offset.
    const serviceRequestTokenValue = [
      "5",
      "0",
      "6",
      String(this.userId!),
      "7",
      String(timezoneOffset),
    ];

    if (dayNumber === undefined) {
      const parts = [
        "7", // version
        "0", // flags
        "7", // string table size
        moduleBase, // string 1
        policyHash, // string 2
        serviceClass, // string 3
        method, // string 4
        SERVICE_REQUEST_TOKEN, // string 5
        USER_ID, // string 6
        this.username!, // string 7
        "1", "2", "3", "4", // call refs: moduleBase, policyHash, service, method
        "1", // param count
        "5", // param type: ServiceRequestToken
        ...serviceRequestTokenValue,
      ];
      return parts.join("|") + "|";
    }

    // Two-param methods like getDailyDetailsForDate(ServiceRequestToken,
    // DayDate). DayDate serializes as { Date a; int dayNumber; int gmtOffset }.
    // The app sends a null Date and keys the day off the day number, so the
    // value is: concrete type ref, null Date (0), dayNumber, gmtOffset.
    const parts = [
      "7", // version
      "0", // flags
      "8", // string table size
      moduleBase, // string 1
      policyHash, // string 2
      serviceClass, // string 3
      method, // string 4
      SERVICE_REQUEST_TOKEN, // string 5
      USER_ID, // string 6
      this.username!, // string 7
      DAY_DATE, // string 8
      "1", "2", "3", "4", // call refs: moduleBase, policyHash, service, method
      "2", // param count
      "5", // param 1 type: ServiceRequestToken
      "8", // param 2 type: DayDate
      ...serviceRequestTokenValue, // param 1 value
      "8", // param 2 value: concrete DayDate type ref
      "0", // Date a = null
      String(dayNumber), // int dayNumber
      String(timezoneOffset), // int gmtOffset
    ];

    return parts.join("|") + "|";
  }

  private async loadSession(): Promise<SessionCache | null> {
    try {
      const data = await readFile(this.config.sessionPath, "utf-8");
      return JSON.parse(data) as SessionCache;
    } catch {
      return null;
    }
  }

  private async saveSession(): Promise<void> {
    const cache: SessionCache = {
      cookies: Object.fromEntries(this.cookies),
      userId: this.userId!,
      username: this.username!,
      timestamp: Date.now(),
    };

    const dir = dirname(this.config.sessionPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(this.config.sessionPath, JSON.stringify(cache), {
      mode: 0o600,
    });
  }
}
