let buffer = new Uint8Array(256);

function ensure(size: number): Uint8Array {
  if (buffer.length < size) {
    let next = buffer.length;
    while (next < size) next *= 2;
    buffer = new Uint8Array(next);
  }
  return buffer;
}

export function encodeUtf8Into(input: string): number {
  const max = input.length * 3;
  const out = ensure(max);
  let pos = 0;
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      out[pos++] = code;
      continue;
    }
    if (code < 0x800) {
      out[pos++] = 0xc0 | (code >> 6);
      out[pos++] = 0x80 | (code & 0x3f);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out[pos++] = 0xf0 | (code >> 18);
        out[pos++] = 0x80 | ((code >> 12) & 0x3f);
        out[pos++] = 0x80 | ((code >> 6) & 0x3f);
        out[pos++] = 0x80 | (code & 0x3f);
        continue;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    out[pos++] = 0xe0 | (code >> 12);
    out[pos++] = 0x80 | ((code >> 6) & 0x3f);
    out[pos++] = 0x80 | (code & 0x3f);
  }
  return pos;
}

export function utf8Bytes(input: string): Uint8Array {
  const length = encodeUtf8Into(input);
  return buffer.slice(0, length);
}

export function murmurhash3Bytes(bytes: Uint8Array, length: number = bytes.length, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h1 = seed >>> 0;
  const blocks = length & ~3;
  for (let i = 0; i < blocks; i += 4) {
    let k1 = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }
  let k1 = 0;
  const rem = length & 3;
  if (rem === 3) k1 ^= bytes[blocks + 2]! << 16;
  if (rem >= 2) k1 ^= bytes[blocks + 1]! << 8;
  if (rem >= 1) {
    k1 ^= bytes[blocks]!;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

export function murmurhash3(input: string, seed = 0): number {
  const length = encodeUtf8Into(input);
  return murmurhash3Bytes(buffer, length, seed);
}
