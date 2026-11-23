// The raw email message (RFC 5322): text and HTML alternatives, safe headers.
import type { Email } from '../../lib/email';

const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** A header value that may contain any characters (RFC 2047), never a line break. */
const headerText = (value: string) => {
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
};
const quotedName = (name: string) => {
  const clean = name.replace(/[\r\n"\\]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : headerText(clean);
};
/** Base64 body lines of at most 76 characters, as MIME requires. */
const wrapped = (text: string) => b64(text).replace(/.{76}/g, '$&\r\n');

/** The raw message (RFC 5322) with text and HTML alternatives. */
export function buildMessage(email: Email, from: { name: string; address: string }): string {
  const to = email.to.replace(/[\r\n<>,;"]/g, '');
  const boundary = `huddle-${crypto.randomUUID()}`;
  const extra = Object.entries(email.headers ?? {})
    .filter(([k]) => /^[A-Za-z][A-Za-z0-9-]*$/.test(k))
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}`);
  return [
    `From: ${quotedName(from.name)} <${from.address}>`,
    `To: ${to}`,
    `Subject: ${headerText(email.subject)}`,
    'MIME-Version: 1.0',
    ...extra,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(email.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(email.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
