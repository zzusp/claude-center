import pg from "pg";

const { Pool } = pg;

// 连接池上限。pg 运行时不回吐配置的 max，单独留常量供 getPoolStats 上报。
const POOL_MAX = 10;

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
      max: POOL_MAX,
      // 连接建立上限：DB 主机不可达时若不设，pg 走 OS TCP 默认（macOS 约 75s）才失败——
      // 桌面 Worker 的状态查询会被拖死。8s 足够区分「慢」与「连不上」，让调用方尽快走容错分支。
      connectionTimeoutMillis: 8_000
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

export type PoolStats = {
  total: number;
  idle: number;
  waiting: number;
  max: number;
};

// 连接池实时计数（同步、零查询）：total=已建连接，idle=空闲，waiting=排队等连接的请求。
export function getPoolStats(explicitPool?: pg.Pool): PoolStats {
  const p = explicitPool ?? getPool();
  return {
    total: p.totalCount,
    idle: p.idleCount,
    waiting: p.waitingCount,
    max: POOL_MAX
  };
}

// 探活并返回往返毫秒数；连不上时抛出，由调用方决定降级。
export async function pingDatabase(explicitPool?: pg.Pool): Promise<number> {
  const p = explicitPool ?? getPool();
  const start = Date.now();
  await p.query("SELECT 1");
  return Date.now() - start;
}
