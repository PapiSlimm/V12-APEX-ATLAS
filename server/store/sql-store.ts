/**
 * Shared SQL implementation of `Store`.
 *
 * The SQLite and Postgres backends differ in three ways and no more: their DDL
 * types, their placeholder syntax, and how they take a lock. Everything else —
 * every query string, every mapping, the whole audit-chain protocol — lives
 * here once. Portability is enforced by construction rather than by discipline.
 *
 * TENANCY
 * -------
 * Every scoped method takes `TenantId` first, and every scoped query carries
 * `tenant_id = ?` in its WHERE clause. There is no code path that reads a
 * scoped table without a tenant, because there is no method signature that
 * permits one. A route that forgets to scope does not leak — it fails to
 * compile.
 *
 * JSON-shaped columns are stored as TEXT in both dialects rather than
 * jsonb/JSON. It gives up in-database querying of those fields, which nothing
 * needs, and buys byte-identical round-tripping across backends, which the
 * audit hash chain does need.
 */

import crypto from 'crypto';
import type {
  AuditEntry,
  ChainVerification,
  LiquidationResult,
  NewAuditEntry,
  Store,
  TradeRecord,
  TwinNode,
  UserRecord,
  UserRole,
} from './types';
import type { Tenant, TenantId, TenantPlan } from './tenancy';
import { PLAN_DEFAULTS, asTenantId } from './tenancy';
import type { MarketAsset, AssetClass } from '../hermes';
import type { Fill, Order } from '../assets/types';
import { GENESIS_HASH, hashEntry, verifyChain } from './chain';
import { migrateToTenancy, type MigrationReport } from './migrate';

export type Row = Record<string, any>;

const bool = (v: unknown) => (v ? 1 : 0);
const unbool = (v: unknown) => v === 1 || v === true || v === '1' || v === 't';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export abstract class SqlStore implements Store {
  abstract readonly dialect: 'sqlite' | 'postgres';

  /** Run a query returning rows. Placeholders are always `?`. */
  protected abstract query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement for effect. */
  protected abstract exec(sql: string, params?: unknown[]): Promise<void>;
  /** Run `fn` inside a transaction that serialises audit appends. */
  protected abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Statements creating the schema, in order. */
  protected abstract ddl(): string[];
  /** Statements dropping the schema, in order. */
  protected abstract dropSql(): string[];

  abstract close(): Promise<void>;

  /** Backend-specific introspection, used only by the migration. */
  protected abstract tableExists(table: string): Promise<boolean>;
  protected abstract columnsOf(table: string): Promise<string[]>;

  async init(): Promise<void> {
    // Upgrade a pre-tenancy database BEFORE creating the schema: on an existing
    // install `CREATE TABLE IF NOT EXISTS` is a no-op, so without this the
    // server boots fine and then fails on the first query.
    const report = await migrateToTenancy({
      tableExists: (t) => this.tableExists(t),
      columnsOf: (t) => this.columnsOf(t),
      exec: (sql, params) => this.exec(sql, params),
      createSchema: async () => {
        for (const statement of this.ddl()) await this.exec(statement);
      },
    });

    if (!report.ran) {
      for (const statement of this.ddl()) await this.exec(statement);
    }
  }

  /** Exposed for the migration test. */
  async lastMigration(): Promise<MigrationReport> {
    return migrateToTenancy({
      tableExists: (t) => this.tableExists(t),
      columnsOf: (t) => this.columnsOf(t),
      exec: (sql, params) => this.exec(sql, params),
      createSchema: async () => {
        for (const statement of this.ddl()) await this.exec(statement);
      },
    });
  }

  async reset(): Promise<void> {
    for (const statement of this.dropSql()) await this.exec(statement);
    await this.init();
  }

  private async one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- tenants
  private toTenant = (r: Row | null): Tenant | null =>
    r
      ? {
          id: asTenantId(r.id),
          slug: r.slug,
          name: r.name,
          plan: r.plan as TenantPlan,
          status: r.status,
          seatLimit: num(r.seat_limit),
          monthlyAiCreditCents: num(r.monthly_ai_credit_cents),
          tradingEnabled: unbool(r.trading_enabled),
          createdAt: r.created_at,
        }
      : null;

  tenants = {
    create: async (tenant: Tenant) => {
      await this.exec(
        `INSERT INTO tenants
           (id, slug, name, plan, status, seat_limit, monthly_ai_credit_cents, trading_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenant.id,
          tenant.slug,
          tenant.name,
          tenant.plan,
          tenant.status,
          tenant.seatLimit,
          tenant.monthlyAiCreditCents,
          bool(tenant.tradingEnabled),
          tenant.createdAt,
        ],
      );
      return tenant;
    },

    get: async (id: TenantId) => this.toTenant(await this.one('SELECT * FROM tenants WHERE id = ?', [id])),

    getBySlug: async (slug: string) =>
      this.toTenant(await this.one('SELECT * FROM tenants WHERE slug = ?', [slug.toLowerCase()])),

    list: async () =>
      (await this.query('SELECT * FROM tenants ORDER BY created_at')).map((r) => this.toTenant(r) as Tenant),

    setPlan: async (id: TenantId, plan: TenantPlan) => {
      const defaults = PLAN_DEFAULTS[plan];
      await this.exec(
        `UPDATE tenants SET plan = ?, seat_limit = ?, monthly_ai_credit_cents = ?, trading_enabled = ?
         WHERE id = ?`,
        [plan, defaults.seatLimit, defaults.monthlyAiCreditCents, bool(defaults.tradingEnabled), id],
      );
      return this.tenants.get(id);
    },

    count: async () => num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM tenants'))?.n),
  };

  // ------------------------------------------------------------------ users
  private toUser = (r: Row | null): UserRecord | null =>
    r
      ? {
          id: r.id,
          tenantId: asTenantId(r.tenant_id),
          email: r.email,
          name: r.name,
          passwordHash: r.password_hash,
          role: r.role as UserRole,
          createdAt: r.created_at,
        }
      : null;

  users = {
    // Global lookup by design: sign-in has an email and a password, no tenant
    // selector, so the email must resolve to exactly one account.
    findByEmail: async (email: string) =>
      this.toUser(await this.one('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()])),

    findById: async (id: string) => this.toUser(await this.one('SELECT * FROM users WHERE id = ?', [id])),

    create: async (user: UserRecord) => {
      await this.exec(
        `INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.tenantId,
          user.email.trim().toLowerCase(),
          user.name,
          user.passwordHash,
          user.role,
          user.createdAt,
        ],
      );
      return user;
    },

    countForTenant: async (tenantId: TenantId) =>
      num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [tenantId]))?.n),

    listForTenant: async (tenantId: TenantId) =>
      (await this.query('SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at', [tenantId])).map(
        (r) => this.toUser(r) as UserRecord,
      ),

    count: async () => num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n),
  };

  // ------------------------------------------------------------------ nodes
  private toNode = (r: Row | null): TwinNode | null =>
    r
      ? {
          id: r.id,
          name: r.name,
          type: r.type,
          node_id: r.node_id,
          parent_hub: r.parent_hub ?? undefined,
          filePath: r.file_path,
          coordinates: r.coordinates ? JSON.parse(r.coordinates) : undefined,
          connectedNodes: JSON.parse(r.connected_nodes || '[]'),
          metrics: JSON.parse(r.metrics || '{}'),
          content: r.content,
          updatedAt: r.updated_at ?? undefined,
          updatedBy: r.updated_by ?? undefined,
        }
      : null;

  nodes = {
    list: async (tenantId: TenantId) =>
      (
        await this.query('SELECT * FROM twin_nodes WHERE tenant_id = ? ORDER BY sort_order, id', [tenantId])
      ).map((r) => this.toNode(r) as TwinNode),

    get: async (tenantId: TenantId, id: string) =>
      this.toNode(await this.one('SELECT * FROM twin_nodes WHERE tenant_id = ? AND id = ?', [tenantId, id])),

    update: async (
      tenantId: TenantId,
      id: string,
      patch: { content?: string; metrics?: Record<string, unknown> },
      actor: string,
    ) => {
      const existing = await this.nodes.get(tenantId, id);
      if (!existing) return null;

      const content = patch.content ?? existing.content;
      const metrics = patch.metrics ? { ...existing.metrics, ...patch.metrics } : existing.metrics;
      const updatedAt = new Date().toISOString();

      await this.exec(
        `UPDATE twin_nodes SET content = ?, metrics = ?, updated_at = ?, updated_by = ?
         WHERE tenant_id = ? AND id = ?`,
        [content, JSON.stringify(metrics), updatedAt, actor, tenantId, id],
      );

      return { ...existing, content, metrics: metrics as TwinNode['metrics'], updatedAt, updatedBy: actor };
    },
  };

  // ----------------------------------------------------------------- assets
  private toAsset = (r: Row | null): MarketAsset | null =>
    r
      ? {
          asset_id: r.asset_id,
          name: r.name,
          asset_class: r.asset_class as AssetClass,
          acquisition_price: num(r.acquisition_price),
          current_price: num(r.current_price),
          buy_fees: num(r.buy_fees),
          sell_fees: num(r.sell_fees),
          is_guaranteed: unbool(r.is_guaranteed),
          fundamentals_intact: unbool(r.fundamentals_intact),
          quantity: num(r.quantity),
          active_offer:
            r.active_offer === null || r.active_offer === undefined ? undefined : num(r.active_offer),
          simulated: unbool(r.simulated),
        }
      : null;

  assets = {
    list: async (tenantId: TenantId) =>
      (
        await this.query('SELECT * FROM assets WHERE tenant_id = ? ORDER BY sort_order, asset_id', [tenantId])
      ).map((r) => this.toAsset(r) as MarketAsset),

    get: async (tenantId: TenantId, id: string) =>
      this.toAsset(
        await this.one('SELECT * FROM assets WHERE tenant_id = ? AND asset_id = ?', [tenantId, id]),
      ),

    /**
     * Single-statement compare-and-swap, scoped to the tenant. The
     * `quantity > 0` predicate is the double-spend guard; the `tenant_id`
     * predicate means one tenant cannot liquidate another's inventory even by
     * guessing an asset id.
     */
    liquidate: async (tenantId: TenantId, id: string): Promise<LiquidationResult | null> => {
      const before = await this.assets.get(tenantId, id);
      if (!before || before.quantity <= 0) return null;

      const rows = await this.query(
        `UPDATE assets SET quantity = 0, active_offer = NULL
         WHERE tenant_id = ? AND asset_id = ? AND quantity > 0
         RETURNING *`,
        [tenantId, id],
      );
      if (rows.length === 0) return null;

      const after = this.toAsset(rows[0]) as MarketAsset;
      return {
        asset: after,
        quantity: before.quantity,
        unitPrice: before.active_offer ?? before.current_price,
      };
    },
  };

  // ----------------------------------------------------------------- trades
  private toTrade = (r: Row): TradeRecord => ({
    id: r.id,
    asset_id: r.asset_id,
    action: r.action,
    quantity: num(r.quantity),
    unit_price: num(r.unit_price),
    realized_net_per_unit: num(r.realized_net_per_unit),
    realized_net_total: num(r.realized_net_total),
    executedBy: r.executed_by,
    executedById: r.executed_by_id,
    timestamp: r.timestamp,
    simulated: unbool(r.simulated),
  });

  trades = {
    record: async (tenantId: TenantId, trade: TradeRecord) => {
      await this.exec(
        `INSERT INTO trades
           (id, tenant_id, asset_id, action, quantity, unit_price, realized_net_per_unit,
            realized_net_total, executed_by, executed_by_id, timestamp, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trade.id,
          tenantId,
          trade.asset_id,
          trade.action,
          trade.quantity,
          trade.unit_price,
          trade.realized_net_per_unit,
          trade.realized_net_total,
          trade.executedBy,
          trade.executedById,
          trade.timestamp,
          bool(trade.simulated),
        ],
      );
      return trade;
    },

    list: async (tenantId: TenantId, limit = 100) =>
      (
        await this.query(
          'SELECT * FROM trades WHERE tenant_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toTrade),
  };

  // ------------------------------------------------------------------ audit
  private toAudit = (r: Row): AuditEntry => ({
    seq: num(r.seq),
    id: r.id,
    timestamp: r.timestamp,
    event: r.event,
    actorId: r.actor_id ?? null,
    actorName: r.actor_name ?? null,
    actorRole: r.actor_role ?? null,
    subject: r.subject ?? null,
    outcome: r.outcome,
    detail: JSON.parse(r.detail || '{}'),
    prevHash: r.prev_hash,
    hash: r.hash,
  });

  audit = {
    /**
     * Appends inside a transaction holding an exclusive lock, because the
     * sequence number and previous hash must be read and committed without
     * another append interleaving. A gap or fork in the chain is
     * indistinguishable from tampering, so this path trades throughput for
     * correctness deliberately.
     *
     * Sequence numbers restart per tenant: each tenant owns an independently
     * verifiable chain, and a shared counter would leak other customers'
     * activity volume through the gaps in your own numbering.
     */
    append: async (tenantId: TenantId, entry: NewAuditEntry): Promise<AuditEntry> =>
      this.transaction(async () => {
        const last = await this.one<{ seq: number; hash: string }>(
          'SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
          [tenantId],
        );

        const seq = last ? num(last.seq) + 1 : 1;
        const prevHash = last ? last.hash : GENESIS_HASH;

        const base = {
          seq,
          id: `aud-${crypto.randomUUID()}`,
          timestamp: new Date().toISOString(),
          event: entry.event,
          actorId: entry.actorId,
          actorName: entry.actorName,
          actorRole: entry.actorRole,
          subject: entry.subject,
          outcome: entry.outcome,
          detail: entry.detail,
        };

        const hash = hashEntry(base, prevHash);

        await this.exec(
          `INSERT INTO audit_log
             (tenant_id, seq, id, timestamp, event, actor_id, actor_name, actor_role,
              subject, outcome, detail, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tenantId,
            base.seq,
            base.id,
            base.timestamp,
            base.event,
            base.actorId,
            base.actorName,
            base.actorRole,
            base.subject,
            base.outcome,
            JSON.stringify(base.detail),
            prevHash,
            hash,
          ],
        );

        return { ...base, prevHash, hash };
      }),

    list: async (tenantId: TenantId, limit = 100) =>
      (
        await this.query('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?', [
          tenantId,
          limit,
        ])
      ).map(this.toAudit),

    verify: async (tenantId: TenantId): Promise<ChainVerification> => {
      const rows = await this.query('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC', [
        tenantId,
      ]);
      return verifyChain(rows.map(this.toAudit));
    },

    verifyAll: async () => {
      const tenants = await this.tenants.list();
      const broken: TenantId[] = [];
      for (const tenant of tenants) {
        const result = await this.audit.verify(tenant.id);
        if (!result.ok) broken.push(tenant.id);
      }
      return { ok: broken.length === 0, tenants: tenants.length, broken };
    },
  };

  // ----------------------------------------------------------------- orders
  private toOrder = (r: Row): Order => ({
    id: r.id,
    clientOrderId: r.client_order_id,
    assetId: r.symbol,
    side: r.side,
    quantity: num(r.quantity),
    type: r.order_type,
    limitPrice: r.limit_price === null || r.limit_price === undefined ? undefined : num(r.limit_price),
    timeInForce: r.time_in_force,
    reason: r.reason,
    status: r.status,
    marketplaceOrderId: r.venue_order_id ?? null,
    filledQuantity: num(r.filled_quantity),
    averageFillPrice: num(r.average_fill_price),
    feesPaid: num(r.fees_paid),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    actorId: r.actor_id ?? null,
    actorName: r.actor_name ?? null,
    marketplace: r.venue,
    mode: r.mode,
    rejectReason: r.reject_reason ?? null,
  });

  orders = {
    /**
     * Idempotent on clientOrderId within a tenant. The intent is written here
     * BEFORE the venue is contacted, so a timeout on `place()` leaves a durable
     * record to reconcile against instead of an unanswerable question.
     */
    create: async (tenantId: TenantId, order: Order) => {
      const existing = await this.orders.get(tenantId, order.clientOrderId);
      if (existing) return { order: existing, created: false };

      await this.exec(
        `INSERT INTO orders
           (id, tenant_id, client_order_id, symbol, side, quantity, order_type, limit_price,
            time_in_force, reason, status, venue_order_id, filled_quantity,
            average_fill_price, fees_paid, created_at, updated_at, actor_id,
            actor_name, venue, mode, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          tenantId,
          order.clientOrderId,
          order.assetId,
          order.side,
          order.quantity,
          order.type,
          order.limitPrice ?? null,
          order.timeInForce,
          order.reason,
          order.status,
          order.marketplaceOrderId,
          order.filledQuantity,
          order.averageFillPrice,
          order.feesPaid,
          order.createdAt,
          order.updatedAt,
          order.actorId,
          order.actorName,
          order.marketplace,
          order.mode,
          order.rejectReason ?? null,
        ],
      );
      return { order, created: true };
    },

    get: async (tenantId: TenantId, clientOrderId: string) => {
      const row = await this.one('SELECT * FROM orders WHERE tenant_id = ? AND client_order_id = ?', [
        tenantId,
        clientOrderId,
      ]);
      return row ? this.toOrder(row) : null;
    },

    update: async (tenantId: TenantId, clientOrderId: string, patch: Partial<Order>) => {
      const existing = await this.orders.get(tenantId, clientOrderId);
      if (!existing) return null;

      const next: Order = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      await this.exec(
        `UPDATE orders SET status = ?, venue_order_id = ?, filled_quantity = ?,
           average_fill_price = ?, fees_paid = ?, updated_at = ?, reject_reason = ?
         WHERE tenant_id = ? AND client_order_id = ?`,
        [
          next.status,
          next.marketplaceOrderId,
          next.filledQuantity,
          next.averageFillPrice,
          next.feesPaid,
          next.updatedAt,
          next.rejectReason ?? null,
          tenantId,
          clientOrderId,
        ],
      );
      return next;
    },

    list: async (tenantId: TenantId, limit = 200) =>
      (
        await this.query(
          'SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toOrder),

    open: async (tenantId: TenantId) =>
      (
        await this.query(
          `SELECT * FROM orders
           WHERE tenant_id = ? AND status NOT IN ('filled','cancelled','rejected','expired')
           ORDER BY created_at ASC`,
          [tenantId],
        )
      ).map(this.toOrder),
  };

  // ------------------------------------------------------------------ fills
  private toFill = (r: Row): Fill => ({
    id: r.id,
    clientOrderId: r.client_order_id,
    marketplaceFillId: r.venue_fill_id,
    assetId: r.symbol,
    side: r.side,
    quantity: num(r.quantity),
    price: num(r.price),
    fee: num(r.fee),
    timestamp: r.timestamp,
    receivedAt: r.received_at,
    sequence: r.sequence === null || r.sequence === undefined ? null : num(r.sequence),
  });

  fills = {
    /**
     * Idempotent on (tenant, marketplaceFillId). Reconciliation replays fills from a
     * cursor and the push and pull paths overlap, so the same fill WILL arrive
     * twice; counting it twice would silently double a position.
     */
    record: async (tenantId: TenantId, fill: Fill) => {
      const existing = await this.one('SELECT * FROM fills WHERE tenant_id = ? AND venue_fill_id = ?', [
        tenantId,
        fill.marketplaceFillId,
      ]);
      if (existing) return { fill: this.toFill(existing), created: false };

      await this.exec(
        `INSERT INTO fills
           (id, tenant_id, client_order_id, venue_fill_id, symbol, side, quantity, price, fee,
            timestamp, received_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fill.id,
          tenantId,
          fill.clientOrderId,
          fill.marketplaceFillId,
          fill.assetId,
          fill.side,
          fill.quantity,
          fill.price,
          fill.fee,
          fill.timestamp,
          fill.receivedAt,
          fill.sequence,
        ],
      );
      return { fill, created: true };
    },

    forOrder: async (tenantId: TenantId, clientOrderId: string) =>
      (
        await this.query('SELECT * FROM fills WHERE tenant_id = ? AND client_order_id = ?', [
          tenantId,
          clientOrderId,
        ])
      ).map(this.toFill),

    forAsset: async (tenantId: TenantId, assetId: string) =>
      (await this.query('SELECT * FROM fills WHERE tenant_id = ? AND symbol = ?', [tenantId, assetId])).map(
        this.toFill,
      ),

    list: async (tenantId: TenantId, limit = 200) =>
      (
        await this.query(
          'SELECT * FROM fills WHERE tenant_id = ? ORDER BY sequence DESC, received_at DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toFill),

    notionalSince: async (tenantId: TenantId, isoTimestamp: string) => {
      const row = await this.one<{ total: number }>(
        `SELECT COALESCE(SUM(price * quantity), 0) AS total FROM fills
         WHERE tenant_id = ? AND received_at >= ?`,
        [tenantId, isoTimestamp],
      );
      return num(row?.total);
    },
  };

  // ------------------------------------------------------------------- meta
  meta = {
    get: async (tenantId: TenantId, key: string) => {
      const row = await this.one<{ value: string }>(
        'SELECT value FROM meta WHERE tenant_id = ? AND key = ?',
        [tenantId, key],
      );
      return row ? row.value : null;
    },
    set: async (tenantId: TenantId, key: string, value: string) => {
      const existing = await this.meta.get(tenantId, key);
      if (existing === null) {
        await this.exec('INSERT INTO meta (tenant_id, key, value) VALUES (?, ?, ?)', [tenantId, key, value]);
      } else {
        await this.exec('UPDATE meta SET value = ? WHERE tenant_id = ? AND key = ?', [value, tenantId, key]);
      }
    },
  };

  // -------------------------------------------------------------- bootstrap
  bootstrap = {
    isEmpty: async (tenantId: TenantId) =>
      num(
        (
          await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM twin_nodes WHERE tenant_id = ?', [
            tenantId,
          ])
        )?.n,
      ) === 0,

    seed: async (tenantId: TenantId, nodes: TwinNode[], assets: MarketAsset[]) => {
      for (const [i, n] of nodes.entries()) {
        await this.exec(
          `INSERT INTO twin_nodes
             (id, tenant_id, name, type, node_id, parent_hub, file_path, coordinates,
              connected_nodes, metrics, content, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            n.id,
            tenantId,
            n.name,
            n.type,
            n.node_id,
            n.parent_hub ?? null,
            n.filePath,
            n.coordinates ? JSON.stringify(n.coordinates) : null,
            JSON.stringify(n.connectedNodes ?? []),
            JSON.stringify(n.metrics ?? {}),
            n.content,
            i,
          ],
        );
      }

      for (const [i, a] of assets.entries()) {
        await this.exec(
          `INSERT INTO assets
             (asset_id, tenant_id, name, asset_class, acquisition_price, current_price, buy_fees,
              sell_fees, is_guaranteed, fundamentals_intact, quantity, active_offer,
              simulated, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.asset_id,
            tenantId,
            a.name,
            a.asset_class,
            a.acquisition_price,
            a.current_price,
            a.buy_fees,
            a.sell_fees,
            bool(a.is_guaranteed),
            bool(a.fundamentals_intact),
            a.quantity,
            a.active_offer ?? null,
            bool(a.simulated ?? true),
            i,
          ],
        );
      }
    },

    importUsers: async (users: UserRecord[]) => {
      for (const u of users) {
        if (await this.users.findByEmail(u.email)) continue;
        await this.users.create(u);
      }
    },

    importTrades: async (tenantId: TenantId, trades: TradeRecord[]) => {
      for (const t of trades) await this.trades.record(tenantId, t);
    },
  };
}
