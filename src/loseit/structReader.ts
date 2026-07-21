/**
 * Structural GWT-RPC deserializer.
 *
 * Unlike the heuristic positional extractors, this reads the response as a
 * proper object graph. GWT-RPC payload tokens are consumed **backward**: the
 * last element of the `values` array is the outermost object's class ref, and
 * the reader walks toward index 0. Within an object the class ref is read
 * first, then each field in Java declaration order (superclass first).
 *
 * Token encoding:
 *   - int / double : one numeric token
 *   - boolean      : one int (0/1)
 *   - string       : one int index into the string table (0 = null,
 *                    else stringTable[index - 1])
 *   - long         : one string token (GWT base64 long; kept as raw string —
 *                    we never need the numeric value)
 *   - byte[] ([B)  : one string token
 *   - object       : one int class ref. Positive = 1-based string-table index
 *                    of the class name; negative = back-reference to a
 *                    previously read object (by object id); 0 = null.
 *   - arrays ([L..;) & collections (ArrayList/HashSet/HashMap/...):
 *                    class ref, then an int count, then that many elements
 *                    (maps read count key/value pairs).
 *   - enums        : class ref then one int ordinal.
 *
 * Field layouts for the model classes live in {@link STRUCT_TYPES} /
 * {@link STRUCT_ENUMS} (see structTypes.ts), derived empirically and validated
 * by fully consuming a real response (`pos === -1`).
 */

export type StructFieldType =
  | "int"
  | "double"
  | "boolean"
  | "string"
  | "long"
  | "bytes"
  | "obj";

export interface StructFieldDef {
  name: string;
  type: StructFieldType;
}

export type StructValue = unknown;

export class StructParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructParseError";
  }
}

const LIST_CLASSES = new Set([
  "ArrayList",
  "LinkedList",
  "Vector",
  "Arrays$ArrayList",
  "Collections$UnmodifiableRandomAccessList",
  "Collections$UnmodifiableCollection",
  "Collections$SingletonList",
]);
const SET_CLASSES = new Set(["HashSet", "LinkedHashSet", "TreeSet"]);
const MAP_CLASSES = new Set([
  "HashMap",
  "LinkedHashMap",
  "TreeMap",
  "IdentityHashMap",
]);

function shortClassName(fqcnWithHash: string): string {
  const slash = fqcnWithHash.indexOf("/");
  const fqcn = slash >= 0 ? fqcnWithHash.slice(0, slash) : fqcnWithHash;
  const dot = fqcn.lastIndexOf(".");
  return dot >= 0 ? fqcn.slice(dot + 1) : fqcn;
}

/**
 * A string-table entry is a JVM class name iff it is an array descriptor
 * ("[...") or contains a package separator before the "/hash" suffix. Any
 * other string literal that appears in an Object-typed slot is a String
 * *instance* (which still consumes an object id in the GWT seen-list).
 */
function isClassName(fqcnWithHash: string): boolean {
  if (fqcnWithHash.startsWith("[")) return true;
  const parts = fqcnWithHash.split("/");
  if (parts.length < 2) return false;
  return parts[0]!.includes(".");
}

export class StructReader {
  private pos: number;
  private readonly objects = new Map<number, unknown>();
  private counter = 0;

  constructor(
    private readonly values: readonly unknown[],
    private readonly stringTable: readonly string[],
    private readonly types: ReadonlyMap<string, StructFieldDef[]>,
    private readonly enums: ReadonlySet<string>,
  ) {
    this.pos = values.length - 1;
  }

  /** Number of tokens still unread (0 means the graph was fully consumed). */
  get remaining(): number {
    return this.pos + 1;
  }

  private next(): unknown {
    const v = this.values[this.pos];
    this.pos -= 1;
    return v;
  }

  readInt(): number {
    const v = this.next();
    if (typeof v !== "number") {
      throw new StructParseError(
        `Expected int at token ${this.pos + 1}, got ${typeof v}: ${String(v)}`,
      );
    }
    return v;
  }

  readDouble(): number {
    const v = this.next();
    if (typeof v !== "number") {
      throw new StructParseError(
        `Expected double at token ${this.pos + 1}, got ${typeof v}: ${String(v)}`,
      );
    }
    return v;
  }

  readBoolean(): boolean {
    return this.readInt() !== 0;
  }

  readString(): string | null {
    const idx = this.readInt();
    if (idx === 0) return null;
    const s = this.stringTable[idx - 1];
    if (s === undefined) {
      throw new StructParseError(`String index ${idx} out of bounds`);
    }
    return s;
  }

  /** GWT longs are base64-encoded strings; we keep the raw token. */
  readLong(): string | null {
    const v = this.next();
    return typeof v === "string" ? v : v === 0 ? null : String(v);
  }

  readBytes(): unknown {
    return this.next();
  }

  private readField(type: StructFieldType): StructValue {
    switch (type) {
      case "int":
        return this.readInt();
      case "double":
        return this.readDouble();
      case "boolean":
        return this.readBoolean();
      case "string":
        return this.readString();
      case "long":
        return this.readLong();
      case "bytes":
        return this.readBytes();
      case "obj":
        return this.readObject();
    }
  }

  readObject(): StructValue {
    const ref = this.next();
    if (ref === 0) return null;
    if (typeof ref !== "number" || Number.isNaN(ref)) {
      throw new StructParseError(
        `Expected class ref at token ${this.pos + 1}, got ${String(ref)}`,
      );
    }
    if (ref < 0) {
      return this.objects.get(-ref) ?? null;
    }

    const rawName = this.stringTable[ref - 1];
    if (rawName === undefined) {
      throw new StructParseError(`Class ref ${ref} out of bounds`);
    }

    // String literal in an Object-typed slot: a String instance. It still
    // consumes an object id, which is essential for correct back-ref counting.
    if (!isClassName(rawName)) {
      this.counter += 1;
      this.objects.set(this.counter, rawName);
      return rawName;
    }

    const short = shortClassName(rawName);

    // byte array
    if (rawName.startsWith("[B")) {
      this.counter += 1;
      const holder = { _bytes: undefined as unknown };
      this.objects.set(this.counter, holder);
      holder._bytes = this.readBytes();
      return holder;
    }

    // object / primitive arrays
    if (rawName.startsWith("[")) {
      this.counter += 1;
      const arr: unknown[] = [];
      this.objects.set(this.counter, arr);
      const n = this.readInt();
      for (let i = 0; i < n; i++) arr.push(this.readObject());
      return arr;
    }

    // collections
    if (LIST_CLASSES.has(short) || SET_CLASSES.has(short)) {
      this.counter += 1;
      const arr: unknown[] = [];
      this.objects.set(this.counter, arr);
      const n = this.readInt();
      for (let i = 0; i < n; i++) arr.push(this.readObject());
      return arr;
    }
    if (MAP_CLASSES.has(short)) {
      this.counter += 1;
      const entries: Array<[unknown, unknown]> = [];
      this.objects.set(this.counter, entries);
      const n = this.readInt();
      for (let i = 0; i < n; i++) {
        const k = this.readObject();
        const v = this.readObject();
        entries.push([k, v]);
      }
      return entries;
    }

    if (this.enums.has(short)) {
      this.counter += 1;
      const e = { _enum: short, ordinal: 0 };
      this.objects.set(this.counter, e);
      e.ordinal = this.readInt();
      return e;
    }

    const fields = this.types.get(short);
    if (!fields) {
      throw new StructParseError(
        `Unregistered GWT type "${short}" at token ${this.pos + 1}`,
      );
    }

    this.counter += 1;
    const obj: Record<string, unknown> = { _cls: short };
    this.objects.set(this.counter, obj);
    for (const f of fields) {
      obj[f.name] = this.readField(f.type);
    }
    return obj;
  }

  /** All objects created during the read, keyed by GWT object id. */
  allObjects(): IterableIterator<unknown> {
    return this.objects.values();
  }
}
