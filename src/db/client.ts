import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Uma única conexão partilhada por processo. Em serverless (Vercel), usa a
// connection string do Transaction Pooler do Supabase (Supavisor) para
// aguentar o fan-in de invocações. `prepare: false` é exigido pelo pooler
// em modo transaction.
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

const client =
  globalForDb.pgClient ??
  postgres(process.env.DATABASE_URL!, {
    prepare: false,
    max: 5
  });

if (process.env.NODE_ENV !== 'production') globalForDb.pgClient = client;

export const db = drizzle(client, { schema });
export { schema };
