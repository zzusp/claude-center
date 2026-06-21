import pg from "pg";

const { Pool } = pg;

// 连接池上限。pg 运行时不回吐配置的 max，单独留常量供 getPoolStats 上报。
const POOL_MAX = 10;

let pool: pg.Pool | null = null;
// 进程内显式配置的连接串（桌面端在 UI 里填、持久化进 worker.json 后注入）。
// 优先级高于 process.env.DATABASE_URL，让桌面端配置覆盖 env；为空时回退 env，保持 Console / 脚本的纯 env 工作流不变。
let configuredUrl: string | null = null;

// 设置（或清空）进程内连接串。仅改后续 getPool 的取串来源，不动已建连接池——
// 运行时换库请用 reconfigureDatabase（它会关掉旧池，下次 getPool 按新串重建）。
export function setDatabaseUrl(url: string | null): void {
  const trimmed = url?.trim();
  configuredUrl = trimmed ? trimmed : null;
}

// 运行时切换连接串：设新串 + 关旧连接池，下一次 getPool 用新串重建。桌面端保存数据库配置后调用。
export async function reconfigureDatabase(url: string | null): Promise<void> {
  setDatabaseUrl(url);
  await closePool();
}

export function getDatabaseUrl(explicitUrl?: string): string {
  const databaseUrl = explicitUrl ?? configuredUrl ?? process.env.DATABASE_URL;
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
