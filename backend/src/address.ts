const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** 32-byte public key to the 58-character Algorand address (key + 4 checksum bytes, base32). */
export function encodeAddress(pk: Uint8Array): string {
  if (pk.length !== 32) return '';
  const sum = new Bun.CryptoHasher('sha512-256').update(pk).digest();
  const full = new Uint8Array(36);
  full.set(pk);
  full.set(sum.subarray(28), 32);
  return base32(full);
}
