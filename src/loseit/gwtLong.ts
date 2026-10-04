/**
 * GWT-RPC serializes a Java `long` as a base-64 string (most significant digit
 * first, leading zero digits dropped) over the alphabet below. Lose It uses
 * longs for epoch-millisecond timestamps.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";

export function toGwtLong(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unsupported GWT long ${value}`);
  }
  let n = BigInt(value);
  let out = "";
  do {
    out = ALPHABET[Number(n & 63n)]! + out;
    n >>= 6n;
  } while (n > 0n);
  return out;
}

export function fromGwtLong(token: string): number {
  let n = 0n;
  for (const char of token) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`Invalid GWT long "${token}"`);
    n = (n << 6n) | BigInt(digit);
  }
  return Number(n);
}
