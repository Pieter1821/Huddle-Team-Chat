// Web Push with the platform's own crypto, no library: the message is encrypted for one browser
// (RFC 8291, aes128gcm) and the request is signed with the server's key (VAPID, RFC 8292), so the
// push service in between can deliver it but never read it.

const enc = new TextEncoder();

export const b64url = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array {
    const s = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

/** HKDF-SHA256 (extract and expand in one step), `length` bytes. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
}

const RECORD_SIZE = 4096;

/**
 * Encrypts `plaintext` for the browser that owns `p256dh` (its public key) and `auth` (its shared
 * secret). Returns the request body: the aes128gcm header (salt, record size, our one-off public
 * key) followed by the single encrypted record.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  /** Fixed values for tests only; normally both are fresh and random for every message. */
  fixed?: { salt: Uint8Array; keys: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublic = b64url.decode(p256dh);
  const authSecret = b64url.decode(auth);
  if (uaPublic.byteLength !== 65 || authSecret.byteLength !== 16) throw new Error('bad subscription keys');
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const keys =
    fixed?.keys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The runtime reads `public`; its type definitions spell it `$public`.
      { name: 'ECDH', public: ua } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      keys.privateKey,
      256,
    ),
  );

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // One record holds the whole message; 0x02 marks it as the last record.
  const record = concat(plaintext, new Uint8Array([2]));
  if (record.byteLength + 16 > RECORD_SIZE) throw new Error('push payload too large');
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.byteLength;
  return concat(header, asPublic, sealed);
}

/** The VAPID `Authorization` header value for a request to `endpoint`, valid for 12 hours. */
export async function vapidAuthorization(
  endpoint: string,
  keys: { publicKey: string; privateKey: CryptoKey },
  subject: string,
  now = Date.now(),
): Promise<string> {
  const header = b64url.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url.encode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is already the raw r||s form that JWS (ES256) expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${b64url.encode(signature)}, k=${keys.publicKey}`;
}

/**
 * Push services Huddle will talk to. The browser chooses the endpoint, so without this list a
 * signed-in person could make the server send requests anywhere.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, most Chromium browsers
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/, // Safari, and installed web apps on iPhone and iPad
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/, // Edge on Windows
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443') &&
    PUSH_HOSTS.some((h) => h.test(url.hostname))
  );
}
