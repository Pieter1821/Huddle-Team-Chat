/// <reference types="vite/client" />
import { AppError } from '../lib/errors';
// Huddle sets up and updates its own database tables the first time it runs after a deploy, so a
// one-click deploy works whatever command deployed it. Applied migrations are recorded in the same
// table `wrangler d1 migrations apply` uses, so the two never disagree or apply anything twice.

const files = import.meta.glob<string>('../../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The migrations in order, each split into the statements drizzle-kit separated. */
export const MIGRATIONS = Object.entries(files)
  .map(([path, sql]) => ({
    name: path.split('/').at(-1)!,
    statements: sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const applied = async (db: D1Database) =>
  new Set(
    (await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map((r) => r.name),
  );

/**
 * Applies every migration not yet applied, each in one atomic batch with its record. If two copies
 * of the Worker start at once, one wins each migration and the other sees it applied.
 */
export async function migrate(db: D1Database): Promise<string[]> {
  await db.prepare(TABLE).run();
  let done = await applied(db);
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    try {
      await db.batch([
        ...m.statements.map((s) => db.prepare(s)),
        db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name),
      ]);
      ran.push(m.name);
    } catch (err) {
      done = await applied(db);
      if (!done.has(m.name)) throw err; // a real failure, not a race with another copy
    }
  }
  return ran;
}

let ready: Promise<void> | null = null;

/** Runs the migrations once per Worker instance; a failure is retried on the next request. */
export function ensureMigrated(db: D1Database): Promise<void> {
  ready ??= migrate(db).then(
    (ran) => {
      if (ran.length) console.warn(`database updated: ${ran.join(', ')}`);
    },
    (err: unknown) => {
      ready = null;
      console.error('database setup failed', err);
      throw new AppError(
        503,
        'database_setup_failed',
        'Huddle couldn’t set up its database. Check that the D1 database exists and is bound as DB.',
      );
    },
  );
  return ready;
}
