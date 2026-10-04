import type { GwtResponse } from "./gwt.js";
import { GWT_ARRAY_CLASS, StructParseError, type StructFieldDef } from "./structReader.js";
import { preferGwtSignature } from "./gwtSignatures.js";

export function responseSignatures(raw: GwtResponse): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const signature of raw.stringTable) {
    if (!/^.+\/\d+$/.test(signature)) continue;
    const name = signature.slice(0, signature.lastIndexOf("/"));
    const shortName = name.slice(name.lastIndexOf(".") + 1);
    const existing = signatures.get(shortName);
    if (!existing || preferGwtSignature(signature, existing)) signatures.set(shortName, signature);
  }
  return signatures;
}

export function writeGwtObject(
  value: unknown,
  ref: (value: string) => string,
  registry: ReadonlyMap<string, StructFieldDef[]>,
  signatures: ReadonlyMap<string, string>,
): string[] {
  const active = new Set<object>();
  const write = (item: unknown): string[] => {
    if (item === null) return ["0"];
    if (typeof item === "string") return [ref(item)];
    if (typeof item !== "object") {
      throw new StructParseError("Expected a GWT object");
    }
    if (active.has(item)) {
      throw new StructParseError("Cyclic food model cannot be serialized");
    }
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const signature = (item as typeof item & { [GWT_ARRAY_CLASS]?: string })[
          GWT_ARRAY_CLASS
        ];
        if (!signature) throw new StructParseError("Missing GWT collection signature");
        const name = signature.slice(0, signature.lastIndexOf("/"));
        if (name === "[B") {
          if (!item.every((b) => Number.isInteger(b) && b >= -128 && b <= 127)) {
            throw new StructParseError("Invalid GWT byte array");
          }
          return [ref(signature), String(item.length), ...item.map(String)];
        }
        const parts = [ref(signature), String(item.length)];
        if (/(?:HashMap|LinkedHashMap|TreeMap|IdentityHashMap)$/.test(name)) {
          for (const pair of item) {
            if (!Array.isArray(pair) || pair.length !== 2) {
              throw new StructParseError("Invalid GWT map entry");
            }
            parts.push(...write(pair[0]), ...write(pair[1]));
          }
        } else {
          for (const element of item) parts.push(...write(element));
        }
        return parts;
      }

      const record = item as Record<string, unknown>;
      const className = record._cls;
      if (typeof className !== "string") {
        throw new StructParseError("Missing GWT model class");
      }
      const signature = signatures.get(className);
      const fields = registry.get(className);
      if (!signature || !fields) {
        throw new StructParseError(`Missing GWT serializer for ${className}`);
      }
      const parts = [ref(signature)];
      for (const field of fields) {
        const fieldValue = record[field.name];
        switch (field.type) {
          case "obj":
            parts.push(...write(fieldValue));
            break;
          case "string":
            parts.push(fieldValue === null ? "0" : ref(requireString(fieldValue)));
            break;
          case "long":
            parts.push(requireString(fieldValue));
            break;
          case "double":
          case "int":
            if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
              throw new StructParseError(`Invalid ${className}.${field.name}`);
            }
            parts.push(String(fieldValue));
            break;
          case "boolean":
            if (typeof fieldValue !== "boolean") {
              throw new StructParseError(`Invalid ${className}.${field.name}`);
            }
            parts.push(fieldValue ? "1" : "0");
            break;
          case "bytes":
            throw new StructParseError(`Unsupported GWT bytes field ${className}.${field.name}`);
        }
      }
      return parts;
    } finally {
      active.delete(item);
    }
  };
  return write(value);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new StructParseError("Expected GWT string");
  return value;
}
