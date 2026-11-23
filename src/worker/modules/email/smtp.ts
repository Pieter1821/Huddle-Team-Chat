// Sending through Gmail with an app password: Huddle talks to Gmail's mail server directly (SMTP
// over TLS, port 465). No Google Cloud project, consent screen or verification: the team turns on
// 2-Step Verification, creates an app password, and pastes it into Huddle's settings.
import { connect } from 'cloudflare:sockets';
import type { Config } from '../../config';
import { AppError } from '../../lib/errors';
import type { Email } from '../../lib/email';
import { buildMessage } from './mime';

export const SMTP_HOST = 'smtp.gmail.com';
export const SMTP_PORT = 465;

/** A duplex connection: what `connect()` from cloudflare:sockets returns (replaced in tests). */
export type Connection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};
export type Connector = () => Connection;

const defaultConnector: Connector = () =>
  connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: 'on', allowHalfOpen: false });

let connector: Connector = defaultConnector;
export function useSmtpConnector(next: Connector | null) {
  connector = next ?? defaultConnector;
}

const TIMEOUT_MS = 20_000;

/** One SMTP conversation: reads full (possibly multi-line) replies and writes commands. */
class Session {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private conn: Connection) {
    this.reader = conn.readable.getReader();
    this.writer = conn.writable.getWriter();
  }

  /** The next complete reply: its code and text. "250-…" lines continue until "250 …". */
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\r\n');
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          return { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') };
        }
        continue;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('connection closed by the mail server');
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async send(line: string) {
    await this.writer.write(this.encoder.encode(`${line}\r\n`));
  }

  /** Sends a command and checks the reply code. */
  async command(line: string, expected: number, what: string) {
    if (line) await this.send(line);
    const r = await this.reply();
    if (r.code !== expected) throw new SmtpError(r.code, r.text, what);
    return r;
  }

  async close() {
    try {
      await this.send('QUIT');
    } catch {
      // already closed
    }
    await this.conn.close().catch(() => undefined);
  }
}

class SmtpError extends Error {
  constructor(
    readonly code: number,
    readonly text: string,
    readonly step: string,
  ) {
    super(`${step}: ${code} ${text}`);
  }
}

/** Lines starting with "." get an extra one, so none can end the message early (RFC 5321 4.5.2). */
const dotStuffed = (message: string) => message.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');

/** Sends one email from the Gmail account with its app password. Throws a readable AppError. */
export async function sendWithAppPassword(config: Config, email: Email): Promise<void> {
  const account = config.gmailAppPassword;
  if (!account)
    throw new AppError(503, 'email_not_configured', 'Email is not set up for this workspace yet.');
  const to = email.to.replace(/[\r\n<>]/g, '');
  const session = new Session(connector());
  const work = (async () => {
    await session.command('', 220, 'greeting');
    await session.command('EHLO huddle', 250, 'hello');
    const credentials = btoa(
      String.fromCharCode(...new TextEncoder().encode(`\0${account.address}\0${account.password}`)),
    );
    await session.command(`AUTH PLAIN ${credentials}`, 235, 'sign in');
    await session.command(`MAIL FROM:<${account.address}>`, 250, 'sender');
    await session.command(`RCPT TO:<${to}>`, 250, 'recipient');
    await session.command('DATA', 354, 'message');
    const raw = buildMessage(email, { name: config.emailName, address: account.address });
    await session.send(`${dotStuffed(raw.replace(/\r\n$/, ''))}\r\n.`);
    await session.command('', 250, 'delivery');
  })();
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS)),
    ]);
  } catch (err) {
    if (err instanceof SmtpError && err.step === 'sign in') {
      throw new AppError(
        503,
        'email_auth_failed',
        'Gmail didn’t accept the app password. Check GMAIL_ADDRESS and GMAIL_APP_PASSWORD in Cloudflare, or create a new app password.',
      );
    }
    if (err instanceof SmtpError && err.code === 550 && err.step === 'recipient') {
      throw new AppError(400, 'email_bad_recipient', 'Gmail refused that email address.');
    }
    if (
      err instanceof SmtpError &&
      (err.code === 421 || err.code === 450 || err.code === 451 || err.code === 452)
    ) {
      throw new AppError(503, 'email_limit', 'Gmail is limiting sending right now. It will be tried again.');
    }
    console.warn('gmail smtp failed', err instanceof Error ? err.message : err);
    throw new AppError(503, 'email_unavailable', 'Gmail didn’t send the email. It will be tried again.');
  } finally {
    await session.close();
  }
}
