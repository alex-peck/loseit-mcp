/**
 * Auto-generate the GWT-RPC model field registry from Lose It's compiled
 * permutation JavaScript.
 *
 * The hand-maintained {@link buildGwtTypeRegistry} in structTypes.ts had to
 * guess the field order/types of every class the reader walks past. Guesses
 * for the polymorphic exercise/goal records were only "good enough" to keep
 * the token stream in sync on days without workouts, and desynced (falling
 * back to names-only food logs) once a synced HealthKit/manual workout added
 * exercise objects to the graph.
 *
 * The permutation `*.cache.js` contains the *generated* field serializers,
 * which are the ground truth for field order and type. Each model class `X`
 * registers a type-serializer array `a[X_sig]=[instantiate,deserialize]`
 * (deserialize-only) or `[instantiate,deserialize,serialize]`. The
 * `instantiate`/`deserialize` function bodies read the fields, in declaration
 * order, via a small set of reader primitives. We fingerprint those primitives
 * by their (stable) body shapes — never their per-build minified names — then
 * parse each class's read calls into an ordered {@link StructFieldType} list.
 *
 * Only obj-vs-scalar matters for staying in sync, but we label scalars
 * precisely (string/double/long/int/boolean) because the food extractor reads
 * real values (names are strings, nutrients are doubles, longs are base64
 * string tokens that would crash a numeric read).
 *
 * The generic registry names fields `f0`, `f1`, … . A curated overlay
 * ({@link FOOD_OVERLAY}) renames the handful of fields the food extractor
 * actually reads, validating that the auto-derived type matches the expected
 * type — a mismatch means Lose It changed the model, so we throw and the
 * caller falls back to the hand registry.
 */

import type { StructFieldDef, StructFieldType } from "./structReader.js";

interface Triple {
  instantiate: string;
  deserialize: string;
}

interface FnBody {
  params: string[];
  body: string;
}

function escapeRe(s: string): string {
  return s.replace(/[$]/g, "\\$&");
}

/** Extract a function body by balanced-brace scan. */
function makeFnBody(js: string): (name: string) => FnBody | null {
  const cache = new Map<string, FnBody | null>();
  return (name: string): FnBody | null => {
    if (cache.has(name)) return cache.get(name)!;
    const re = new RegExp("function " + escapeRe(name) + "\\s*\\(([^)]*)\\)\\{");
    const m = re.exec(js);
    if (!m) {
      cache.set(name, null);
      return null;
    }
    const params = m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    for (; i < js.length && depth > 0; i++) {
      const c = js[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const result = { params, body: js.slice(start, i - 1) };
    cache.set(name, result);
    return result;
  };
}

/** Short (unqualified) class name of a `com.foo.Bar/12345` signature. */
function shortName(sig: string): string {
  const slash = sig.indexOf("/");
  const fqcn = slash >= 0 ? sig.slice(0, slash) : sig;
  const dot = fqcn.lastIndexOf(".");
  return dot >= 0 ? fqcn.slice(dot + 1) : fqcn;
}

/**
 * Curated semantic field names for the classes the food extractor reads.
 * Each entry maps a field index to a name + the type we expect the
 * auto-parser to have derived. A type mismatch signals a model change.
 */
const FOOD_OVERLAY: Record<
  string,
  Array<{ index: number; name: string; type: StructFieldType }>
> = {
  FoodLogEntry: [
    { index: 0, name: "identifier", type: "obj" },
    { index: 1, name: "context", type: "obj" },
    { index: 2, name: "serving", type: "obj" },
  ],
  FoodIdentifier: [
    { index: 3, name: "name", type: "string" },
    { index: 4, name: "brand", type: "string" },
  ],
  FoodServing: [
    { index: 0, name: "nutrients", type: "obj" },
    { index: 1, name: "servingSize", type: "obj" },
  ],
  FoodServingSize: [{ index: 0, name: "quantity", type: "double" }],
  FoodNutrients: [{ index: 2, name: "nutrients", type: "obj" }],
  FoodLogEntryContext: [{ index: 1, name: "dayDate", type: "obj" }],
  DayDate: [{ index: 1, name: "dayNumber", type: "int" }],
  FoodMeasurement: [{ index: 0, name: "nutrientTypeId", type: "int" }],
  Double: [{ index: 0, name: "v", type: "double" }],
};

export class GwtRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GwtRegistryError";
  }
}

/**
 * Parse the compiled permutation JavaScript and produce the model field
 * registry consumed by {@link StructReader}. Throws {@link GwtRegistryError}
 * if the primitives can't be fingerprinted or a food class fails validation.
 */
export function buildGwtRegistryFromCacheJs(
  js: string,
): Map<string, StructFieldDef[]> {
  const fnBody = makeFnBody(js);

  // 1. signature var map: X='com.foo.Bar/123' or X='[Lcom...;/123'
  const sigByVar = new Map<string, string>();
  for (const m of js.matchAll(
    /([A-Za-z_$][\w$]*)='((?:\[+L?[\w./$]+;?|[\w.$]+)\/\d+)'/g,
  )) {
    sigByVar.set(m[1]!, m[2]!);
  }

  // 2. type-serializer triples: a[VAR]=[instantiate,deserialize(,serialize)]
  const triples = new Map<string, Triple>();
  for (const m of js.matchAll(
    /\[([A-Za-z_$][\w$]*)\]=\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(?:,([A-Za-z_$][\w$]*))?\]/g,
  )) {
    const sig = sigByVar.get(m[1]!);
    if (!sig) continue;
    triples.set(sig, {
      instantiate: m[2]!,
      deserialize: m[3]!,
    });
  }

  // 3. fingerprint the object reader + cast helper:
  //    readObject is the fn that dominates the `cast(readObject(p),int)` shape.
  const objCount = new Map<string, number>();
  let castFn: string | null = null;
  for (const m of js.matchAll(
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),\d+\)/g,
  )) {
    objCount.set(m[2]!, (objCount.get(m[2]!) ?? 0) + 1);
    castFn = m[1]!;
  }
  const readObjectFn = [...objCount.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  if (!castFn || !readObjectFn) {
    throw new GwtRegistryError(
      "Could not fingerprint GWT reader primitives (cast/readObject)",
    );
  }

  // classify a reader-primitive fn by its (stable) body shape
  const primCache = new Map<string, StructFieldType | null>();
  const classifyFn = (name: string): StructFieldType | null => {
    const fb = fnBody(name);
    if (!fb) return null;
    const p = fb.params[0];
    if (!p) return null;
    const pp = escapeRe(p);
    const b = fb.body;
    // readString(reader, token): return token>0 ? reader.d[token-1] : null
    if (
      fb.params.length === 2 &&
      /return\s+[\w$]+>0\?[\w$]+\.[\w$]+\[[\w$]+-1\]:null/.test(b)
    ) {
      return "string";
    }
    if (new RegExp("!!" + pp + "\\.[\\w$]+\\[--" + pp + "\\.[\\w$]+\\]").test(b)) {
      return "boolean";
    }
    if (
      new RegExp("Number\\(" + pp + "\\.[\\w$]+\\[--" + pp + "\\.[\\w$]+\\]\\)").test(
        b,
      )
    ) {
      return "double";
    }
    // long: pops one token then decodes it (not Number(...) / !!...)
    if (
      new RegExp("=\\s*" + pp + "\\.[\\w$]+\\[--" + pp + "\\.[\\w$]+\\]").test(b) &&
      !b.includes("Number(") &&
      !b.includes("!!")
    ) {
      return "long";
    }
    return null;
  };
  const primType = (name: string): StructFieldType | null => {
    if (name === readObjectFn) return "obj";
    if (primCache.has(name)) return primCache.get(name)!;
    const t = classifyFn(name);
    primCache.set(name, t);
    return t;
  };

  const castEsc = escapeRe(castFn);

  // 4. parse a serializer fn body into an ordered field-type list. Delegation
  //    (`fn(reader, instance)` calls into super-fragment serializers) is
  //    detected structurally and inlined.
  const parseReads = (
    name: string,
    readerParam?: string,
    instParam?: string,
    seen: Set<string> = new Set(),
  ): StructFieldType[] => {
    const fb = fnBody(name);
    if (!fb) return [];
    const p = readerParam ?? fb.params[0];
    const inst = instParam ?? fb.params[1];
    if (!p) return [];
    const pesc = escapeRe(p);
    const b = fb.body;
    const out: StructFieldType[] = [];

    const reCast = new RegExp(
      castEsc + "\\(([A-Za-z_$][\\w$]*)\\(" + pesc + "\\),\\d+\\)",
      "y",
    );
    const reInlineInt = new RegExp(
      pesc + "\\.[\\w$]+\\[--" + pesc + "\\.[\\w$]+\\]",
      "y",
    );
    const reCall2 = new RegExp(
      "([A-Za-z_$][\\w$]*)\\(" + pesc + ",([\\w$]+)\\.[\\w$]+\\[--\\2\\.[\\w$]+\\]\\)",
      "y",
    );
    const reCall1 = new RegExp("([A-Za-z_$][\\w$]*)\\(" + pesc + "\\)", "y");
    const reDeleg = inst
      ? new RegExp(
          "([A-Za-z_$][\\w$]*)\\(" + pesc + "," + escapeRe(inst) + "\\)",
          "y",
        )
      : null;

    let i = 0;
    while (i < b.length) {
      // delegation: fn(reader, instance) -> inline the referenced serializer
      if (reDeleg) {
        reDeleg.lastIndex = i;
        const m = reDeleg.exec(b);
        if (m && m.index === i) {
          const fn = m[1]!;
          if (fn !== name && !seen.has(fn)) {
            const child = fnBody(fn);
            if (child && child.params.length >= 2) {
              seen.add(fn);
              out.push(
                ...parseReads(fn, child.params[0], child.params[1], seen),
              );
              i = reDeleg.lastIndex;
              continue;
            }
          }
        }
      }

      reCast.lastIndex = i;
      let m = reCast.exec(b);
      if (m && m.index === i) {
        out.push("obj");
        i = reCast.lastIndex;
        continue;
      }

      reCall2.lastIndex = i;
      m = reCall2.exec(b);
      if (m && m.index === i) {
        const t = primType(m[1]!) ?? "string";
        out.push(t);
        i = reCall2.lastIndex;
        continue;
      }

      reCall1.lastIndex = i;
      m = reCall1.exec(b);
      if (m && m.index === i) {
        const t = primType(m[1]!);
        if (t) {
          out.push(t);
          i = reCall1.lastIndex;
          continue;
        }
      }

      reInlineInt.lastIndex = i;
      m = reInlineInt.exec(b);
      if (m && m.index === i) {
        out.push("int");
        i = reInlineInt.lastIndex;
        continue;
      }

      i++;
    }
    return out;
  };

  // 5. assemble the registry (first signature wins on short-name collision).
  const registry = new Map<string, StructFieldDef[]>();
  for (const [sig, tr] of triples) {
    const short = shortName(sig);
    if (registry.has(short)) continue;
    const types = [
      ...parseReads(tr.instantiate),
      ...parseReads(tr.deserialize),
    ];
    registry.set(
      short,
      types.map((type, idx) => ({ name: "f" + idx, type })),
    );
  }

  // 6. overlay curated semantic names on the food classes, validating types.
  for (const [cls, fields] of Object.entries(FOOD_OVERLAY)) {
    const auto = registry.get(cls);
    if (!auto) {
      throw new GwtRegistryError(`Food class "${cls}" not found in permutation`);
    }
    for (const { index, name, type } of fields) {
      const field = auto[index];
      if (!field) {
        throw new GwtRegistryError(
          `Food class "${cls}" field #${index} (${name}) missing (has ${auto.length} fields)`,
        );
      }
      if (field.type !== type) {
        throw new GwtRegistryError(
          `Food class "${cls}" field #${index} (${name}) type ${field.type}, expected ${type} — Lose It model changed`,
        );
      }
      field.name = name;
    }
  }

  return registry;
}
