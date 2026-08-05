// Hex helpers, shared so the webhook verifier, the job store and the token minters agree.

// Trims first, because the length drives both the output size and the slice offsets: leading or
// trailing whitespace on a header-supplied value shifts every byte. `parseInt` is already
// case-insensitive, so the lower-casing is belt and braces.
export function hexToBytes(hex: string) {
  const clean = hex.trim().toLowerCase();
  const bytes = new Uint8Array(clean.length / 2);

  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  }

  return bytes;
}

// Cryptographically random hex, for OAuth state and session tokens.
export function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
