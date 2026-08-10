/**
 * Storage contract.
 *
 * Everything above this line in the stack talks to `Store` and nothing else, so
 * swapping SQLite for Postgres — or Postgres for something else later — is a
 * factory change rather than a rewrite. Two implementations ship and both are
 * exercised by the same conformance suite (`tests/store.test.ts`), which is the
 * only way an interface like this stays honest.
 *
 * All methods are async even where the backing driver is synchronous. A
 * synchronous interface would have made the Postgres implementation impossible
 * without changing every call site.
 */

import type { MarketAsset } from '../hermes';
import type { Fill, Order, OrderStatus } from '../assets/types';
import type { Tenant, TenantId, TenantPlan } from './tenancy';

export * from './tenancy';

export type UserRole = 'Executive' | 'Arbitrage Trader' | 'LoRABlender Engineer' | 'System Admin';

export interface UserRecord {
  id: string;
  tenantId: TenantId;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface TwinNode {
  id: string;
  name: string;
  type: 'city_hub' | 'factory_node' | 'warehouse_node';
  node_id: string;
  parent_hub?: string;
  filePath: string;
  coordinates?: [number, number];
  connectedNodes: string[];
  metrics: Record<string, unknown> & { status: 'operational' | 'degraded' | 'maintenance' };
  content: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TradeRecord {
  id: string;
  asset_id: string;
  action: string;
  quantity: number;
  unit_price: number;
  realized_net_per_unit: number;
  realized_net_total: number;
  executedBy: string;
  executedById: string;
  timestamp: string;
  simulated: boolean;
}

/**
 * One link in the audit chain. Refusals are recorded with the same weight as
 * fills: for anything money-adjacent, "why did the system say no" is as much a
 * compliance question as "why did it say yes".
 */
export interface AuditEntry {
  seq: number;
  id: string;
  timestamp: string;
  /** e.g. 'trade.executed', 'trade.refused', 'vault.updated', 'auth.login' */
  event: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  subject: string | null;
  outcome: 'allowed' | 'refused' | 'info';
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type NewAuditEntry = Omit<AuditEntry, 'seq' | 'id' | 'timestamp' | 'prevHash' | 'hash'>;

export interface ChainVerification {
  ok: boolean;
  entries: number;
  /** Sequence number of the first entry whose hash does not match. */
  brokenAt?: number;
  reason?: string;
}

/** Result of an atomic liquidation attempt. */
export interface LiquidationResult {
  asset: MarketAsset;
  quantity: number;
  unitPrice: number;
}

export type { Order, Fill, OrderStatus };

export interface Store {
  readonly dialect: 'sqlite' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;
  /** Drop and recreate every table. Test-only. */
  reset(): Promise<void>;

  /** Tenants themselves are the one collection that is not tenant-scoped. */
  tenants: {
    create(tenant: Tenant): Promise<Tenant>;
    get(id: TenantId): Promise<Tenant | null>;
    getBySlug(slug: string): Promise<Tenant | null>;
    list(): Promise<Tenant[]>;
    setPlan(id: TenantId, plan: TenantPlan): Promise<Tenant | null>;
    count(): Promise<number>;
  };

  users: {
    /**
     * Email is unique GLOBALLY, not per tenant. Two tenants cannot both own
     * alice@example.com: a login form takes an email and a password with no
     * tenant selector, so a per-tenant unique constraint would make sign-in
     * ambiguous. Revisit only alongside multi-org membership.
     */
    findByEmail(email: string): Promise<UserRecord | null>;
    findById(id: string): Promise<UserRecord | null>;
    create(user: UserRecord): Promise<UserRecord>;
    /** Seats currently consumed by a tenant, for seat-limit enforcement. */
    countForTenant(tenantId: TenantId): Promise<number>;
    listForTenant(tenantId: TenantId): Promise<UserRecord[]>;
    count(): Promise<number>;
  };

  nodes: {
    list(tenantId: TenantId): Promise<TwinNode[]>;
    get(tenantId: TenantId, id: string): Promise<TwinNode | null>;
    update(
      tenantId: TenantId,
      id: string,
      patch: { content?: string; metrics?: Record<string, unknown> },
      actor: string,
    ): Promise<TwinNode | null>;
  };

  assets: {
    list(tenantId: TenantId): Promise<MarketAsset[]>;
    get(tenantId: TenantId, id: string): Promise<MarketAsset | null>;
    /**
     * Compare-and-swap liquidation: zeroes the position only if it still has
     * inventory, and reports what it actually took.
     *
     * This has to be one statement. With the previous in-memory store the
     * check-then-write pair happened without an await between them, so it was
     * accidentally safe; the moment storage became async, two concurrent
     * requests could both pass the Hermes gate and both "sell" the same
     * position — double-spending the inventory and booking the profit twice.
     * Returns null when another request got there first.
     */
    liquidate(tenantId: TenantId, id: string): Promise<LiquidationResult | null>;
  };

  trades: {
    record(tenantId: TenantId, trade: TradeRecord): Promise<TradeRecord>;
    list(tenantId: TenantId, limit?: number): Promise<TradeRecord[]>;
  };

  /** One independently-verifiable hash chain per tenant. */
  audit: {
    append(tenantId: TenantId, entry: NewAuditEntry): Promise<AuditEntry>;
    list(tenantId: TenantId, limit?: number): Promise<AuditEntry[]>;
    verify(tenantId: TenantId): Promise<ChainVerification>;
    /** Platform-level health: verifies every tenant's chain. */
    verifyAll(): Promise<{ ok: boolean; tenants: number; broken: TenantId[] }>;
  };

  /**
   * Order book. `create` is idempotent on clientOrderId — the intent is
   * persisted BEFORE the venue is called, so a timeout is recoverable.
   */
  orders: {
    create(tenantId: TenantId, order: Order): Promise<{ order: Order; created: boolean }>;
    get(tenantId: TenantId, clientOrderId: string): Promise<Order | null>;
    update(tenantId: TenantId, clientOrderId: string, patch: Partial<Order>): Promise<Order | null>;
    list(tenantId: TenantId, limit?: number): Promise<Order[]>;
    /** Orders that are not in a terminal state — the reconciliation working set. */
    open(tenantId: TenantId): Promise<Order[]>;
  };

  fills: {
    /** Idempotent on marketplaceFillId: a replayed fill must not be counted twice. */
    record(tenantId: TenantId, fill: Fill): Promise<{ fill: Fill; created: boolean }>;
    forOrder(tenantId: TenantId, clientOrderId: string): Promise<Fill[]>;
    forAsset(tenantId: TenantId, assetId: string): Promise<Fill[]>;
    list(tenantId: TenantId, limit?: number): Promise<Fill[]>;
    /** Notional traded since a timestamp, for the rolling daily limit. */
    notionalSince(tenantId: TenantId, isoTimestamp: string): Promise<number>;
  };

  /** Small key/value store for cursors and operational flags. */
  meta: {
    get(tenantId: TenantId, key: string): Promise<string | null>;
    set(tenantId: TenantId, key: string, value: string): Promise<void>;
  };

  /** First-run population and legacy import. Not used during normal operation. */
  bootstrap: {
    isEmpty(tenantId: TenantId): Promise<boolean>;
    seed(tenantId: TenantId, nodes: TwinNode[], assets: MarketAsset[]): Promise<void>;
    importUsers(users: UserRecord[]): Promise<void>;
    importTrades(tenantId: TenantId, trades: TradeRecord[]): Promise<void>;
  };
}
