const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58. Small enough to keep out of the bundle's deps. */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let i = 0; bytes[i] === 0 && i < bytes.length - 1; i++) out += ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

const INDEXES = new Map<string, number>(
  [...ALPHABET].map((char, index) => [char, index] as const),
);

/** Inverse of base58Encode. Throws on any character outside the alphabet. */
export function base58Decode(value: string): Uint8Array {
  const input = value.trim();
  if (!input) return new Uint8Array(0);

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === ALPHABET[0]) leadingZeros++;

  // Every character was '1', so the value is zero: the leading zeros are it all.
  if (leadingZeros === input.length) return new Uint8Array(leadingZeros);

  // Accumulate little-endian (index 0 is least significant). Carry propagates
  // upward, and the most significant byte produced is never zero, so the result
  // is already canonical and needs no trimming.
  const bytes: number[] = [0];
  for (let i = leadingZeros; i < input.length; i++) {
    const digit = INDEXES.get(input[i]!);
    if (digit === undefined) throw new Error(`Invalid base58 character: ${input[i]}`);

    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  return new Uint8Array([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}