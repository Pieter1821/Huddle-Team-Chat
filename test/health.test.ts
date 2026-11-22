import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';

const api = (path: string) => exports.default.fetch(`https://huddle.test${path}`);

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('sends security headers and blocks indexing', async () => {
    const res = await api('/api/health');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('unknown routes', () => {
  it('return a JSON 404 without internals', async () => {
    const res = await api('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });
});
