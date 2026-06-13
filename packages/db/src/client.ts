import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getDatabaseUrl(explicitUrl?: string): string {
  const databaseUrl = explicitUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function getPool(explicitUrl?: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(explicitUrl),
      max: 10
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
