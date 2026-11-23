import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { pushKey, pushSubscription } from '../../db/schema';
import { b64url } from '../../lib/web-push';

const KEY_ID = 'vapid';
const AT_REST_PURPOSE = 'huddle:push-key-at-rest:v1';

export type VapidKeys = { publicKey: string; privateKey: CryptoKey };

/** An AES key, derived from the server secret for this one purpose, that seals the stored private key. */
async function sealingKey(secret: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(AT_REST_PURPOSE),
    },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function create(db: Db, secret: string): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await sealingKey(secret),
      new TextEncoder().encode(JSON.stringify(jwk)),
    ),
  );
  const stored = new Uint8Array(iv.byteLength + sealed.byteLength);
  stored.set(iv);
  stored.set(sealed, iv.byteLength);
  // Two requests racing to create the key: the first one wins and both use it.
  await db
    .insert(pushKey)
    .values({ id: KEY_ID, publicKey: b64url.encode(publicKey), privateKey: b64url.encode(stored) })
    .onConflictDoNothing();
}

async function open(secret: string, stored: string): Promise<CryptoKey> {
  const bytes = b64url.decode(stored);
  const jwk = JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12) },
        await sealingKey(secret),
        bytes.slice(12),
      ),
    ),
  ) as JsonWebKey;
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * The server's push signing key, made the first time anyone needs it. If the server secret has
 * changed since, the old key can't be opened: it is replaced, and every device subscription made for
 * it is dropped (browsers would reject pushes signed with a new key anyway), so people simply turn
 * notifications on again.
 */
export async function vapidKeys(db: Db, secret: string): Promise<VapidKeys> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let row = await db.query.pushKey.findFirst({ where: eq(pushKey.id, KEY_ID) });
    if (!row) {
      await create(db, secret);
      row = await db.query.pushKey.findFirst({ where: eq(pushKey.id, KEY_ID) });
      if (!row) break;
    }
    try {
      return { publicKey: row.publicKey, privateKey: await open(secret, row.privateKey) };
    } catch {
      console.warn('push key could not be opened (server secret changed?); making a new one');
      await db.batch([db.delete(pushSubscription), db.delete(pushKey).where(eq(pushKey.id, KEY_ID))]);
    }
  }
  throw new Error('push key unavailable');
}
