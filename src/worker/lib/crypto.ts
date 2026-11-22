/** A URL-safe random token with 256 bits of entropy (for invitation links and similar). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Tokens are stored only as this hash, so a database leak does not leak usable links. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/**
 * A signing key derived from the server secret for ONE purpose (HKDF-SHA256, purpose as the info
 * string). Signatures made for one purpose are useless for any other, and the raw secret itself never
 * signs anything.
 */
async function purposeKey(secret: string, purpose: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(purpose) },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** HMAC-SHA256 signature of `data` with the key for `purpose`, URL-safe. */
export async function sign(secret: string, purpose: string, data: string): Promise<string> {
  const key = await purposeKey(secret, purpose);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

/** Checks a signature without leaking, through timing, how much of it was right. */
export async function verify(
  secret: string,
  purpose: string,
  data: string,
  signature: string,
): Promise<boolean> {
  const expected = new TextEncoder().encode(await sign(secret, purpose, data));
  const given = new TextEncoder().encode(signature);
  if (expected.byteLength !== given.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, given);
}
