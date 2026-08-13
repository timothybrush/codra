// Hex helpers, shared so the webhook verifier, the job store and the token minters agree.

// Trims first: leading/trailing whitespace on a header-supplied value would shift every byte since length drives the slice offsets.
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
