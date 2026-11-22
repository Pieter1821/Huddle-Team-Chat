import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

// A D1 binding only exists inside a request, so the Drizzle client is created per request (cheap).
export const getDb = (env: Env) => drizzle(env.DB, { schema });

export type Db = ReturnType<typeof getDb>;
