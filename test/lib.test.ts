import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/worker/config';
import { emailDeliveryConfigured, sendEmail } from '../src/worker/lib/email';
import { newId } from '../src/worker/lib/id';
import { randomToken, sha256Hex } from '../src/worker/lib/crypto';

const baseEnv = {
  APP_URL: 'https://chat.example.com/',
  ADMIN_EMAIL: 'Owner@Example.com',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
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
  it('normalises the URL and admin email, and derives a sender address', () => {
    const cfg = getConfig(baseEnv);
    expect(cfg.appUrl).toBe('https://chat.example.com');
    expect(cfg.adminEmail).toBe('owner@example.com');
    expect(cfg.emailFrom).toBe('Huddle <no-reply@chat.example.com>');
    expect(cfg.google).toBeNull();
    expect(cfg.isLocal).toBe(false);
  });

  it('uses EMAIL_FROM when set', () => {
    const cfg = getConfig({ ...baseEnv, EMAIL_FROM: 'Brightwater <chat@brightwater.example>' });
    expect(cfg.emailFrom).toBe('Brightwater <chat@brightwater.example>');
  });

  it('fails loudly with a readable message when misconfigured', () => {
    expect(() => getConfig({ ...baseEnv, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => getConfig({ ...baseEnv, APP_URL: 'not a url' })).toThrow(/APP_URL/);
  });
});

describe('sendEmail with no delivery method configured', () => {
  const email = { to: 'a@b.c', subject: 's', text: 'Your code is 123456', html: 'h' };

  it('reports that email is not configured', () => {
    expect(emailDeliveryConfigured()).toBe(false);
  });

  it('refuses in production rather than printing sign-in codes into logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(sendEmail(getConfig(baseEnv), email)).rejects.toMatchObject({
      code: 'email_not_configured',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('prints to the terminal when running locally', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = getConfig({ ...baseEnv, APP_URL: 'http://localhost:8787' });
    expect(await sendEmail(local, email)).toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Your code is 123456');
  });
});
