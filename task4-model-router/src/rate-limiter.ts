import { DatabaseSync } from "node:sqlite";

const LIMIT = 50_000;
const WINDOW_MS = 60_000;

export type Reservation =
  | { status: "ok"; id: number; remaining: number }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "too_large" };

export class RateLimiter {
  private db: DatabaseSync;
  private now: () => number;

  constructor(path: string, now = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY,
        tenant TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS token_usage_tenant_ts ON token_usage (tenant, ts_ms);
      CREATE INDEX IF NOT EXISTS token_usage_ts ON token_usage (ts_ms);
    `);
  }

  reserve(tenant: string, tokens: number): Reservation {
    if (tokens > LIMIT) return { status: "too_large" };

    // IMMEDIATE takes the write lock before the read, so two processes can't both pass the check
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.reserveLocked(tenant, tokens);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  reconcile(id: number, actualTokens: number) {
    this.db.prepare("UPDATE token_usage SET tokens = ? WHERE id = ?").run(actualTokens, id);
  }

  remaining(tenant: string) {
    return Math.max(0, LIMIT - this.used(tenant, this.now()));
  }

  close() {
    this.db.close();
  }

  private reserveLocked(tenant: string, tokens: number): Reservation {
    const now = this.now();
    this.db.prepare("DELETE FROM token_usage WHERE ts_ms <= ?").run(now - WINDOW_MS);
    const used = this.used(tenant, now);

    if (used + tokens <= LIMIT) {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO token_usage (tenant, ts_ms, tokens) VALUES (?, ?, ?)")
        .run(tenant, now, tokens);
      return { status: "ok", id: Number(lastInsertRowid), remaining: LIMIT - used - tokens };
    }

    // walk the oldest rows until enough tokens would have expired
    const rows = this.db
      .prepare("SELECT ts_ms, tokens FROM token_usage WHERE tenant = ? ORDER BY ts_ms")
      .all(tenant) as { ts_ms: number; tokens: number }[];
    let toFree = used + tokens - LIMIT;
    for (const row of rows) {
      toFree -= row.tokens;
      if (toFree <= 0) return { status: "rate_limited", retryAfterMs: row.ts_ms + WINDOW_MS - now };
    }
    return { status: "rate_limited", retryAfterMs: WINDOW_MS };
  }

  private used(tenant: string, now: number) {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE tenant = ? AND ts_ms > ?")
      .get(tenant, now - WINDOW_MS) as { used: number };
    return row.used;
  }
}
