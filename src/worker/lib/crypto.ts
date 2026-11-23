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

/** An AES-256-GCM key derived from the server secret for ONE purpose (data at rest). */
async function sealingKey(secret: string, purpose: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(purpose) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a secret (such as a stored OAuth token) for keeping in the database: a copy of the
 * database alone can't use it. Returns base64url(iv || ciphertext).
 */
export async function seal(secret: string, purpose: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await sealingKey(secret, purpose),
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv);
  out.set(sealed, iv.byteLength);
  return toBase64Url(out);
}

/** Reverses `seal`. Throws if the server secret has changed or the value was tampered with. */
export async function unseal(secret: string, purpose: string, stored: string): Promise<string> {
  const bytes = Uint8Array.from(atob(stored.replaceAll('-', '+').replaceAll('_', '/')), (ch) =>
    ch.charCodeAt(0),
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await sealingKey(secret, purpose),
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}
