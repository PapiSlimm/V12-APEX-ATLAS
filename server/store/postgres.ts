import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import { SqlStore, type Row } from './sql-store';

/**
 * Production backend. Set `DATABASE_URL` to select it.
 *
 * Shares every query string with the SQLite backend; only placeholder syntax,
 * DDL types and locking differ. Both are run against the same conformance suite
 * so the two cannot silently diverge.
 */
export class PostgresStore extends SqlStore {
  readonly dialect = 'postgres' as const;
  private pool: Pool;

  /**
   * Carries the transaction's client through the async call stack, so the
   * shared `SqlStore` methods do not need to thread a connection parameter
   * through every signature. Without this, a query issued inside
   * `transaction()` could be checked out on a different pooled connection and
   * silently run outside the transaction — which for the audit chain would mean
   * appends that look committed but are not covered by the lock.
   */
  private txClient = new AsyncLocalStorage<PoolClient>();

  constructor(connectionString: string, ssl?: boolean) {
    super();
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PGPOOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
    });
  }

  /** `?` → `$1, $2, …` so query strings stay dialect-neutral. */
  private static toPgPlaceholders(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  protected async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const text = PostgresStore.toPgPlaceholders(sql);
    const client = this.txClient.getStore();
    const result = client ? await client.query(text, params) : await this.pool.query(text, params);
    return result.rows as T[];
  }

  protected async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  protected async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialises audit appends against each other. Appends are infrequent and
      // a fork in the hash chain is unrecoverable, so the lock is the right
      // trade.
      await client.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
      const result = await this.txClient.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  protected async tableExists(table: string): Promise<boolean> {
    const rows = await this.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
      [table],
    );
    return rows.length > 0;
  }

  protected async columnsOf(table: string): Promise<string[]> {
    const rows = await this.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
      [table],
    );
    return rows.map((r) => String(r.column_name));
  }

  protected ddl(): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS tenants (
         id                      TEXT PRIMARY KEY,
         slug                    TEXT NOT NULL UNIQUE,
         name                    TEXT NOT NULL,
         plan                    TEXT NOT NULL,
         status                  TEXT NOT NULL DEFAULT 'active',
         seat_limit              INTEGER NOT NULL DEFAULT 1,
         monthly_ai_credit_cents INTEGER NOT NULL DEFAULT 0,
         trading_enabled         INTEGER NOT NULL DEFAULT 0,
         created_at              TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS users (
         id            TEXT PRIMARY KEY,
         tenant_id     TEXT NOT NULL,
         email         TEXT NOT NULL UNIQUE,
         name          TEXT NOT NULL,
         password_hash TEXT NOT NULL,
         role          TEXT NOT NULL,
         created_at    TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS twin_nodes (
         id              TEXT NOT NULL,
         tenant_id       TEXT NOT NULL,
         name            TEXT NOT NULL,
         type            TEXT NOT NULL,
         node_id         TEXT NOT NULL,
         parent_hub      TEXT,
         file_path       TEXT NOT NULL,
         coordinates     TEXT,
         connected_nodes TEXT NOT NULL DEFAULT '[]',
         metrics         TEXT NOT NULL DEFAULT '{}',
         content         TEXT NOT NULL,
         sort_order      INTEGER NOT NULL DEFAULT 0,
         updated_at      TEXT,
         updated_by      TEXT,
         PRIMARY KEY (tenant_id, id)
       )`,
      `CREATE TABLE IF NOT EXISTS assets (
         asset_id            TEXT NOT NULL,
         tenant_id           TEXT NOT NULL,
         name                TEXT NOT NULL,
         asset_class         TEXT NOT NULL,
         acquisition_price   DOUBLE PRECISION NOT NULL,
         current_price       DOUBLE PRECISION NOT NULL,
         buy_fees            DOUBLE PRECISION NOT NULL,
         sell_fees           DOUBLE PRECISION NOT NULL,
         is_guaranteed       INTEGER NOT NULL DEFAULT 0,
         fundamentals_intact INTEGER NOT NULL DEFAULT 1,
         quantity            DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (quantity >= 0),
         active_offer        DOUBLE PRECISION,
         simulated           INTEGER NOT NULL DEFAULT 1,
         sort_order          INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (tenant_id, asset_id)
       )`,
      `CREATE TABLE IF NOT EXISTS trades (
         id                    TEXT PRIMARY KEY,
         tenant_id             TEXT NOT NULL,
         asset_id              TEXT NOT NULL,
         action                TEXT NOT NULL,
         quantity              DOUBLE PRECISION NOT NULL,
         unit_price            DOUBLE PRECISION NOT NULL,
         realized_net_per_unit DOUBLE PRECISION NOT NULL,
         realized_net_total    DOUBLE PRECISION NOT NULL,
         executed_by           TEXT NOT NULL,
         executed_by_id        TEXT NOT NULL,
         timestamp             TEXT NOT NULL,
         simulated             INTEGER NOT NULL DEFAULT 1
       )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
         tenant_id  TEXT NOT NULL,
         seq        BIGINT NOT NULL,
         id         TEXT NOT NULL UNIQUE,
         timestamp  TEXT NOT NULL,
         event      TEXT NOT NULL,
         actor_id   TEXT,
         actor_name TEXT,
         actor_role TEXT,
         subject    TEXT,
         outcome    TEXT NOT NULL,
         detail     TEXT NOT NULL DEFAULT '{}',
         prev_hash  TEXT NOT NULL,
         hash       TEXT NOT NULL,
         PRIMARY KEY (tenant_id, seq)
       )`,
      `CREATE TABLE IF NOT EXISTS orders (
         id                 TEXT PRIMARY KEY,
         tenant_id          TEXT NOT NULL,
         client_order_id    TEXT NOT NULL UNIQUE,
         symbol             TEXT NOT NULL,
         side               TEXT NOT NULL,
         quantity           DOUBLE PRECISION NOT NULL,
         order_type         TEXT NOT NULL,
         limit_price        DOUBLE PRECISION,
         time_in_force      TEXT NOT NULL,
         reason             TEXT NOT NULL DEFAULT '',
         status             TEXT NOT NULL,
         venue_order_id     TEXT,
         filled_quantity    DOUBLE PRECISION NOT NULL DEFAULT 0,
         average_fill_price DOUBLE PRECISION NOT NULL DEFAULT 0,
         fees_paid          DOUBLE PRECISION NOT NULL DEFAULT 0,
         created_at         TEXT NOT NULL,
         updated_at         TEXT NOT NULL,
         actor_id           TEXT,
         actor_name         TEXT,
         venue              TEXT NOT NULL,
         mode               TEXT NOT NULL,
         reject_reason      TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS fills (
         id              TEXT PRIMARY KEY,
         tenant_id       TEXT NOT NULL,
         client_order_id TEXT NOT NULL,
         venue_fill_id   TEXT NOT NULL UNIQUE,
         symbol          TEXT NOT NULL,
         side            TEXT NOT NULL,
         quantity        DOUBLE PRECISION NOT NULL,
         price           DOUBLE PRECISION NOT NULL,
         fee             DOUBLE PRECISION NOT NULL DEFAULT 0,
         timestamp       TEXT NOT NULL,
         received_at     TEXT NOT NULL,
         sequence        BIGINT
       )`,
      `CREATE TABLE IF NOT EXISTS meta (
         tenant_id TEXT NOT NULL,
         key       TEXT NOT NULL,
         value     TEXT NOT NULL,
         PRIMARY KEY (tenant_id, key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders (tenant_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_order ON fills (tenant_id, client_order_id)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_tenant_symbol ON fills (tenant_id, symbol)`,
      `CREATE INDEX IF NOT EXISTS idx_trades_tenant ON trades (tenant_id, timestamp DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant_event ON audit_log (tenant_id, event)`,
      // Belt and braces: revoke the ability to rewrite history at the schema
      // level, not just by convention in application code.
      `CREATE OR REPLACE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING`,
      `CREATE OR REPLACE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING`,
    ];
  }

  protected dropSql(): string[] {
    return ['audit_log', 'fills', 'orders', 'meta', 'trades', 'assets', 'twin_nodes', 'users', 'tenants'].map(
      (t) => `DROP TABLE IF EXISTS ${t} CASCADE`,
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
