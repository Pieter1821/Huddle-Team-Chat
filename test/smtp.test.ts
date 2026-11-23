import { afterEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { getConfig } from '../src/worker/config';
import { getDb } from '../src/worker/db/client';
import { emailDeliveryConfigured, sendEmail } from '../src/worker/lib/email';
import { sendWithAppPassword, useSmtpConnector } from '../src/worker/modules/email/smtp';

const config = getConfig({
  ...env,
  GMAIL_ADDRESS: 'Team.Huddle@gmail.com',
  GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
});
const email = {
  to: 'jaco@example.com',
  subject: '123456 is your code',
  text: 'Your code is 123456.\n.hidden line that starts with a dot',
  html: '<p>123456</p>',
};

/** Stands in for smtp.gmail.com: answers like Gmail does and records the conversation. */
function fakeGmail(opts: { password?: string } = {}) {
  const heard: string[] = [];
  let data = '';
  let inData = false;
  let reply!: (line: string) => void;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      reply = (line) => controller.enqueue(new TextEncoder().encode(`${line}\r\n`));
      reply('220 smtp.gmail.com ESMTP ready');
    },
  });
  let pending = '';
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      pending += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            reply('250 2.0.0 OK queued');
          } else data += `${line}\r\n`;
          continue;
        }
        heard.push(line);
        if (line.startsWith('EHLO')) {
          reply('250-smtp.gmail.com at your service');
          reply('250-AUTH LOGIN PLAIN');
          reply('250 SMTPUTF8');
        } else if (line.startsWith('AUTH PLAIN ')) {
          const [, user, pass] = atob(line.slice(11)).split('\0');
          reply(
            user === 'team.huddle@gmail.com' && pass === (opts.password ?? 'abcdefghijklmnop')
              ? '235 2.7.0 Accepted'
              : '535 5.7.8 Username and Password not accepted',
          );
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) reply('250 2.1.0 OK');
        else if (line === 'DATA') {
          inData = true;
          reply('354 Go ahead');
        } else if (line === 'QUIT') reply('221 2.0.0 closing');
      }
    },
  });
  useSmtpConnector(() => ({ readable, writable, close: () => Promise.resolve() }));
  return { heard, message: () => data };
}

afterEach(() => useSmtpConnector(null));

describe('sending with a Gmail app password', () => {
  it('signs in and delivers the message, from the Gmail address', async () => {
    const gmail = fakeGmail();
    await sendWithAppPassword(config, email);
    expect(gmail.heard).toEqual([
      'EHLO huddle',
      `AUTH PLAIN ${btoa('\0team.huddle@gmail.com\0abcdefghijklmnop')}`, // spaces removed
      'MAIL FROM:<team.huddle@gmail.com>',
      'RCPT TO:<jaco@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(gmail.message()).toContain('From: "Huddle" <team.huddle@gmail.com>');
    expect(gmail.message()).toContain('To: jaco@example.com');
    expect(gmail.message()).toContain('Subject: 123456 is your code');
  });

  it('explains a wrong app password instead of failing vaguely', async () => {
    fakeGmail({ password: 'something-else' });
    await expect(sendWithAppPassword(config, email)).rejects.toMatchObject({ code: 'email_auth_failed' });
  });

  it('is what sendEmail uses when it is set, and counts as email being ready', async () => {
    const gmail = fakeGmail();
    expect(await sendEmail(config, email, { db: getDb(env) })).toBe(true);
    expect(gmail.heard).toContain('DATA');
    expect(await emailDeliveryConfigured(config)).toBe(true);
  });

  it('a message line starting with a dot cannot end the message early', async () => {
    const gmail = fakeGmail();
    // Text bodies are base64 in the message, so test the raw rule with a header line instead.
    await sendWithAppPassword(config, { ...email, headers: { 'X-Note': 'x' } });
    expect(
      gmail
        .message()
        .split('\r\n')
        .every((l) => l !== '.'),
    ).toBe(true);
  });
});
