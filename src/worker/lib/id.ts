// ULID: 48 bits of millisecond time + 80 random bits, in Crockford base32 (26 characters).
// Sorts by creation time and cannot be guessed, so it is safe to show in URLs.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const b of bytes) random += ALPHABET.charAt(b % 32);
  return time + random;
}
