import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { MIGRATIONS, migrate } from '../src/worker/db/migrate';

describe('Huddle sets up its own database', () => {
  it('carries every migration file, in order', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names[0]).toBe('0000_init.sql');
    expect(names).toEqual([...names].sort());
    expect(names).toContain('0009_app_url.sql');
    expect(MIGRATIONS.every((m) => m.statements.length > 0)).toBe(true);
  });

  it('builds every table on an empty database (a first deploy), then does nothing', async () => {
    const db = env.FRESH_DB;
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.name));
    const tables = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const t of ['user', 'workspace', 'message', 'message_fts', 'push_subscription', 'totp_credential']) {
      expect(tables).toContain(t);
    }
    expect(await migrate(db)).toEqual([]); // already done: a restart changes nothing
  });

  it('agrees with `wrangler d1 migrations apply` (which set up the test database)', async () => {
    expect(await migrate(env.DB)).toEqual([]);
  });
});
