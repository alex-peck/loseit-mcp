/**
 * Minimal schema-less protobuf codec for Lose It's mobile sync gateway.
 *
 * The iOS app talks to `gateway.loseit.com` with protobuf messages whose
 * `.proto` definitions are not public. Field numbers were recovered from
 * captured app traffic, so this codec only needs the wire format: messages are
 * decoded into a field-number → values map and the typed views in
 * `fasting.ts` picks the fields it understands.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufError";
  }
}

/** A raw protobuf field value as it appears on the wire. */
export type ProtoValue =
  | { wire: 0; value: bigint }
  | { wire: 1; bytes: Uint8Array }
  | { wire: 2; bytes: Uint8Array }
  | { wire: 5; bytes: Uint8Array };

export type ProtoMessage = Map<number, ProtoValue[]>;

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    if (pos >= buf.length) throw new ProtobufError("Truncated varint");
    const byte = buf[pos++]!;
    if (shift === 63n && byte > 1) throw new ProtobufError("Varint exceeds uint64");
    result |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new ProtobufError("Varint is too long");
  }
}

export function decodeMessage(buf: Uint8Array): ProtoMessage {
  const message: ProtoMessage = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0 || field > 0x1fffffff) throw new ProtobufError("Invalid field number");
    let value: ProtoValue;
    switch (wire) {
      case 0: {
        const [v, next] = readVarint(buf, pos);
        pos = next;
        value = { wire: 0, value: v };
        break;
      }
      case 1:
      case 5: {
        const size = wire === 1 ? 8 : 4;
        if (pos + size > buf.length) throw new ProtobufError("Truncated fixed field");
        value = { wire, bytes: buf.subarray(pos, pos + size) };
        pos += size;
        break;
      }
      case 2: {
        const [len, next] = readVarint(buf, pos);
        if (len > BigInt(buf.length - next)) throw new ProtobufError("Truncated length-delimited field");
        const end = next + Number(len);
        if (end > buf.length) throw new ProtobufError("Truncated length-delimited field");
        value = { wire: 2, bytes: buf.subarray(next, end) };
        pos = end;
        break;
      }
      default:
        throw new ProtobufError(`Unsupported wire type ${wire}`);
    }
    const values = message.get(field);
    if (values) values.push(value);
    else message.set(field, [value]);
  }
  return message;
}

function only(message: ProtoMessage, field: number): ProtoValue | undefined {
  const values = message.get(field);
  return values?.[values.length - 1];
}

export function getVarint(message: ProtoMessage, field: number): bigint | undefined {
  const value = only(message, field);
  if (value === undefined) return undefined;
  if (value.wire !== 0) throw new ProtobufError(`Field ${field} is not a varint`);
  return value.value;
}

export function getNumber(message: ProtoMessage, field: number): number | undefined {
  const value = getVarint(message, field);
  if (value !== undefined && value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtobufError(`Field ${field} exceeds the safe integer range`);
  }
  return value === undefined ? undefined : Number(value);
}

export function getBool(message: ProtoMessage, field: number): boolean | undefined {
  const value = getVarint(message, field);
  return value === undefined ? undefined : value !== 0n;
}

export function getBytes(message: ProtoMessage, field: number): Uint8Array | undefined {
  const value = only(message, field);
  if (value === undefined) return undefined;
  if (value.wire !== 2) throw new ProtobufError(`Field ${field} is not length-delimited`);
  return value.bytes;
}

export function getString(message: ProtoMessage, field: number): string | undefined {
  const bytes = getBytes(message, field);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

export function getFloat(message: ProtoMessage, field: number): number | undefined {
  const value = only(message, field);
  if (value === undefined) return undefined;
  if (value.wire !== 5) throw new ProtobufError(`Field ${field} is not a float`);
  return new DataView(value.bytes.buffer, value.bytes.byteOffset, 4).getFloat32(0, true);
}

export function getMessage(message: ProtoMessage, field: number): ProtoMessage | undefined {
  const bytes = getBytes(message, field);
  return bytes === undefined ? undefined : decodeMessage(bytes);
}

export function getRepeatedMessages(message: ProtoMessage, field: number): ProtoMessage[] {
  return (message.get(field) ?? []).map((value) => {
    if (value.wire !== 2) throw new ProtobufError(`Field ${field} is not a message`);
    return decodeMessage(value.bytes);
  });
}

export function getRepeatedVarints(message: ProtoMessage, field: number): bigint[] {
  return (message.get(field) ?? []).flatMap((value) => {
    if (value.wire === 0) return [value.value];
    if (value.wire !== 2) throw new ProtobufError(`Field ${field} is not a varint`);
    const packed: bigint[] = [];
    let pos = 0;
    while (pos < value.bytes.length) {
      const [v, next] = readVarint(value.bytes, pos);
      packed.push(v);
      pos = next;
    }
    return packed;
  });
}

/** Builds a protobuf message field by field, in the order written. */
export class ProtoWriter {
  private readonly chunks: number[] = [];

  private varint(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) throw new ProtobufError("Value is outside uint64");
    let v = value;
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        this.chunks.push(byte);
        return;
      }
      this.chunks.push(byte | 0x80);
    }
  }

  private key(field: number, wire: number): void {
    if (!Number.isInteger(field) || field <= 0 || field > 0x1fffffff) {
      throw new ProtobufError("Invalid field number");
    }
    this.varint((BigInt(field) << 3n) | BigInt(wire));
  }

  uint(field: number, value: number | bigint): this {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new ProtobufError("Integer value must be a safe integer");
    }
    const v = typeof value === "bigint" ? value : BigInt(value);
    this.key(field, 0);
    this.varint(v);
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.uint(field, value ? 1 : 0);
  }

  float(field: number, value: number): this {
    if (!Number.isFinite(value)) throw new ProtobufError("Float value must be finite");
    this.key(field, 5);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.chunks.push(...bytes);
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.key(field, 2);
    this.varint(BigInt(value.length));
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  message(field: number, value: ProtoWriter): this {
    return this.bytes(field, value.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}
