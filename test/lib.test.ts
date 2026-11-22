import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, type Config } from '../src/worker/config';
import { sendEmail } from '../src/worker/lib/email';
import { newId } from '../src/worker/lib/id';
import { randomToken, sha256Hex } from '../src/worker/lib/crypto';

const baseEnv = {
  APP_URL: 'https://chat.example.com/',
  ADMIN_EMAIL: 'Owner@Example.com',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
} as unknown as Env;

afterEach(() => vi.restoreAllMocks());

describe('newId', () => {
  it('is 26 Crockford characters and sorts by creation time', () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe('tokens', () => {
  it('are URL-safe, long and hash to 64 hex characters', async () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sha256Hex(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('getConfig', () => {
  it('normalises the URL and admin email and treats empty optionals as unset', () => {
    const cfg = getConfig(baseEnv);
    expect(cfg.appUrl).toBe('https://chat.example.com');
    expect(cfg.adminEmail).toBe('owner@example.com');
    expect(cfg.email).toBeNull();
    expect(cfg.google).toBeNull();
    expect(cfg.isLocal).toBe(false);
  });

  it('fails loudly with a readable message when misconfigured', () => {
    expect(() => getConfig({ ...baseEnv, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => getConfig({ ...baseEnv, APP_URL: 'not a url' })).toThrow(/APP_URL/);
  });
});

describe('sendEmail', () => {
  const prodConfig = (email: Config['email']): Config => ({ ...getConfig(baseEnv), email });

  it('refuses to print emails when not running locally', async () => {
    await expect(
      sendEmail(prodConfig(null), { to: 'a@b.c', subject: 's', text: 't', html: 'h' }),
    ).rejects.toMatchObject({
      code: 'email_not_configured',
    });
  });

  it('sends through Resend with the API key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await sendEmail(prodConfig({ apiKey: 're_test', from: 'Huddle <a@b.c>' }), {
      to: 'x@y.z',
      subject: 'Hi',
      text: 't',
      html: 'h',
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_test');
    expect(JSON.parse(init?.body as string)).toMatchObject({ to: ['x@y.z'], subject: 'Hi' });
  });

  it('reports a failed send without leaking the provider response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"to":"x@y.z"}', { status: 422 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      sendEmail(prodConfig({ apiKey: 're_test', from: 'a@b.c' }), {
        to: 'x@y.z',
        subject: 's',
        text: 't',
        html: 'h',
      }),
    ).rejects.toMatchObject({ code: 'email_failed' });
  });
});
