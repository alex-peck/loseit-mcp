/**
 * Auto-discovery of the current GWT-RPC permutation strong name and
 * serialization-policy hash from Lose It's compiled web app.
 *
 * These two values are tied to whatever web build Lose It has deployed and
 * change every time they recompile. Hardcoding them means the MCP silently
 * breaks after a Lose It deploy. Instead we derive them at runtime from the
 * public CloudFront assets under the module base:
 *
 *   1. `<moduleBase><module>.nocache.js` — the GWT bootstrap. It maps browser
 *      properties (user.agent, locale) to permutation strong names. We pick
 *      the `safari` (WebKit) permutation because a plain HTTP client behaves
 *      like WebKit as far as GWT deferred binding is concerned, and that is
 *      the permutation the working captured traffic used.
 *   2. `<moduleBase><permutation>.cache.js` — the compiled permutation. The
 *      generated `<Service>_Proxy` constructor passes the serialization-policy
 *      strong name to the RemoteServiceProxy super constructor. We locate that
 *      constructor via the stable `"<Service>_Proxy"` string literal (the GWT
 *      runtime registers the class by this name) and read the 32-hex policy
 *      hash literal out of its body.
 *
 * Both extractors rely ONLY on stable GWT string literals and the shape of the
 * generated code — never on the per-build minified identifier names — so they
 * survive recompiles.
 */

const HEX32 = "[0-9A-Fa-f]{32}";

export interface GwtBuildInfo {
  permutation: string;
  policyHash: string;
}

/**
 * Derive the module short-name (used for `<name>.nocache.js`) from the module
 * base URL, e.g. `https://cdn/web/` -> `web`.
 */
export function moduleNameFromBase(moduleBase: string): string {
  const segments = moduleBase.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] ?? "";
}

/** Short (unqualified) class name of a fully-qualified Java class. */
function shortClassName(fqcn: string): string {
  const idx = fqcn.lastIndexOf(".");
  return idx >= 0 ? fqcn.slice(idx + 1) : fqcn;
}

/**
 * Extract the WebKit/Safari permutation strong name from a `*.nocache.js`.
 *
 * The bootstrap defines a table of `var X='...'` string constants and then a
 * series of calls of the form `k([<locale>,<userAgent>],<strongNameVar>)`.
 * We locate the token whose value is `'safari'`, then find the strong name
 * assigned for that user.agent. The strong name argument may be either a bare
 * 32-hex literal or a reference to one of the `var X='...'` constants.
 */
export function extractPermutation(nocacheJs: string): string | null {
  // Map every  X='...'  single-quoted string constant.
  const vars = new Map<string, string>();
  for (const m of nocacheJs.matchAll(/([A-Za-z_$][\w$]*)='([^']*)'/g)) {
    vars.set(m[1]!, m[2]!);
  }

  const safariTokens = [...vars.entries()]
    .filter(([, v]) => v === "safari")
    .map(([k]) => k);
  if (safariTokens.length === 0) return null;

  for (const token of safariTokens) {
    // Match  [ <anything-but-brackets> , <token> ] , <arg> )
    const re = new RegExp(
      "\\[[^\\[\\]]*," + token + "\\],([A-Za-z_$][\\w$]*|" + HEX32 + ")\\)",
    );
    const m = nocacheJs.match(re);
    if (!m?.[1]) continue;
    const arg = m[1];
    // Bare hex literal, or a reference to a string constant.
    const resolved = /^[0-9A-Fa-f]{32}$/.test(arg) ? arg : vars.get(arg);
    if (resolved && /^[0-9A-Fa-f]{32}$/.test(resolved)) {
      return resolved.toUpperCase();
    }
  }
  return null;
}

/**
 * Extract the serialization-policy strong name for `serviceClass` from a
 * compiled `*.cache.js`.
 *
 * GWT registers the generated proxy runtime-class under the literal
 * `"<ShortService>_Proxy"`. We walk from that literal to the class id, to the
 * constructor function that the runtime registers for that id, and read the
 * 32-hex policy literal the constructor passes to the RemoteServiceProxy base.
 */
export function extractPolicyHash(
  cacheJs: string,
  serviceClass: string,
): string | null {
  const proxyName = shortClassName(serviceClass) + "_Proxy";

  // 1. var holding the "<Service>_Proxy" literal, e.g.  A7v='LoseItRemoteService_Proxy'
  const nameVarMatch = cacheJs.match(
    new RegExp("([A-Za-z_$][\\w$]*)='" + escapeRegExp(proxyName) + "'"),
  );
  if (!nameVarMatch?.[1]) return null;
  const nameVar = nameVarMatch[1];

  // 2. runtime-class registration references that var with a numeric class id,
  //    e.g.  QDv(z7v,A7v,1548)  ->  capture 1548
  const classIdMatch = cacheJs.match(
    new RegExp("," + escapeRegExp(nameVar) + ",(\\d+)\\)"),
  );
  if (!classIdMatch?.[1]) return null;
  const classId = classIdMatch[1];

  // 3. class-setup registration binds the id to a constructor function,
  //    e.g.  evd(1548,734,{...},Mfr)  ->  capture Mfr
  const ctorMatch = cacheJs.match(
    new RegExp(
      "\\(" + classId + ",\\d+,\\{[^}]*\\},([A-Za-z_$][\\w$]*)\\)",
    ),
  );
  if (!ctorMatch?.[1]) return null;
  const ctor = ctorMatch[1];

  // 4. read the 32-hex policy literal from the constructor body,
  //    e.g.  function Mfr(){...call(this,ai(),null,'8F87...',Ocr)...}
  const bodyMatch = cacheJs.match(
    new RegExp("function " + escapeRegExp(ctor) + "\\(\\)\\{.*?\\}"),
  );
  if (!bodyMatch) return null;
  const hex = bodyMatch[0].match(new RegExp("'(" + HEX32 + ")'"));
  return hex?.[1] ? hex[1].toUpperCase() : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  return response.text();
}

/**
 * Fetch and derive the live GWT permutation + serialization-policy hash for
 * `serviceClass` from the app hosted under `moduleBase`. Throws on any failure
 * so the caller can fall back to configured/last-resort values.
 */
export async function fetchGwtBuildInfo(
  moduleBase: string,
  serviceClass: string,
  timeoutMs: number,
): Promise<GwtBuildInfo> {
  const moduleName = moduleNameFromBase(moduleBase);
  const nocacheUrl = `${moduleBase}${moduleName}.nocache.js`;

  const nocacheJs = await fetchText(nocacheUrl, timeoutMs);
  const permutation = extractPermutation(nocacheJs);
  if (!permutation) {
    throw new Error(`Could not extract permutation from ${nocacheUrl}`);
  }

  const cacheUrl = `${moduleBase}${permutation}.cache.js`;
  const cacheJs = await fetchText(cacheUrl, timeoutMs);
  const policyHash = extractPolicyHash(cacheJs, serviceClass);
  if (!policyHash) {
    throw new Error(
      `Could not extract policy hash for ${serviceClass} from ${cacheUrl}`,
    );
  }

  return { permutation, policyHash };
}
