/**
 * Revolut X execution venue and market data adapter.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ENABLING LIVE TRADING
 * ────────────────────────────────────────────────────────────────────────────
 * This adapter was written against Revolut X's documented API shape, but it has
 * NOT been executed against the live API. Everything uncertain is deliberately
 * confined to one place — `RevolutXTransport` and the `WIRE` mapping tables
 * below — so correcting the wire format is a small, local edit rather than a
 * rewrite. The domain mapping (their model → our ledger) is the part I am
 * confident in, and it is covered by the venue conformance suite.
 *
 * Before pointing this at real money, run:
 *
 *     npm run verify:venue
 *
 * It exercises every READ path against your live account and reports any field
 * that does not match this adapter's expectations. It never places an order.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DESIGN NOTES
 * ────────────────────────────────────────────────────────────────────────────
 * 1. **Market orders are sent as marketable limits.** Revolut X's documented
 *    order types are limit / conditional / tpsl. Rather than reach for a market
 *    type, a "market" intent becomes an IOC limit priced through the touch by a
 *    bounded slippage allowance. That is strictly safer: a naked market order in
 *    a thin crypto book can fill arbitrarily far away, which is incompatible
 *    with a zero-loss mandate. The bound is explicit and configurable.
 *
 * 2. **Fills are order-centric.** Their API exposes fills per order rather than
 *    a global fill stream, so `fillsSince` walks recently-active orders and
 *    collects their fills, using a timestamp cursor. Fill identity comes from
 *    the venue's own fill id, so the pull overlapping with a previous pull is
 *    deduplicated upstream rather than double-counted.
 *
 * 3. **Their `client_order_id` is our idempotency key.** We generate it, they
 *    honour it. A duplicate submission returns the original order.
 */

import crypto from 'crypto';
import {
  round,
  type Instrument,
  type OrderIntent,
  type OrderStatus,
  type Quote,
  type Unsubscribe,
} from './types';
import type {
  CancelResult,
  ExecutionVenue,
  MarketDataSource,
  PlacedOrder,
  VenueFill,
  VenueOrder,
} from './venue';
import { VenueError } from './venue';

// ---------------------------------------------------------------------------
// WIRE — everything that depends on Revolut X's exact API shape lives here.
// If the live probe disagrees with the adapter, the fix is almost certainly in
// this section and nowhere else.
// ---------------------------------------------------------------------------

export const WIRE = {
  defaultBaseUrl: 'https://exchange.revolut.com',

  paths: {
    currencyPairs: '/api/crypto-exchange/api/v1/instruments',
    ticker: '/api/crypto-exchange/api/v1/ticker',
    orderBook: '/api/crypto-exchange/api/v1/orderbook',
    placeOrder: '/api/crypto-exchange/api/v1/orders',
    cancelOrder: (venueOrderId: string) => `/api/crypto-exchange/api/v1/orders/${venueOrderId}`,
    orderById: (venueOrderId: string) => `/api/crypto-exchange/api/v1/orders/${venueOrderId}`,
    orderByClientId: (clientOrderId: string) =>
      `/api/crypto-exchange/api/v1/orders/client-order-id/${clientOrderId}`,
    activeOrders: '/api/crypto-exchange/api/v1/orders/active',
    historicalOrders: '/api/crypto-exchange/api/v1/orders/history',
    orderFills: (venueOrderId: string) => `/api/crypto-exchange/api/v1/orders/${venueOrderId}/fills`,
  },

  /**
   * Their order states → ours. Unknown states map to `working` rather than a
   * terminal status: treating an unrecognised state as terminal would abandon a
   * live order, which is the more expensive mistake.
   */
  orderState: {
    pending_new: 'pending',
    new: 'working',
    open: 'working',
    partially_filled: 'partially_filled',
    filled: 'filled',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    rejected: 'rejected',
    expired: 'expired',
  } as Record<string, OrderStatus>,

  /** Our time-in-force → theirs. */
  timeInForce: { gtc: 'good_till_cancelled', ioc: 'immediate_or_cancel', fok: 'fill_or_kill' } as const,
} as const;

export function mapOrderState(raw: string | undefined): OrderStatus {
  if (!raw) return 'working';
  return WIRE.orderState[String(raw).toLowerCase()] ?? 'working';
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface RevolutXCredentials {
  apiKey: string;
  /** PEM-encoded Ed25519 private key matching the public key registered with Revolut X. */
  privateKeyPem: string;
}

export interface RevolutXTransport {
  request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

/**
 * HTTP transport with Ed25519 request signing.
 *
 * The canonical string being signed is the one detail most likely to need
 * correcting against the live API; it is a single line here on purpose.
 */
export class HttpTransport implements RevolutXTransport {
  private privateKey: crypto.KeyObject;

  constructor(
    private credentials: RevolutXCredentials,
    private baseUrl: string = WIRE.defaultBaseUrl,
    private timeoutMs = 10_000,
  ) {
    this.privateKey = crypto.createPrivateKey(credentials.privateKeyPem);
  }

  private sign(timestamp: string, method: string, path: string, body: string): string {
    const canonical = `${timestamp}${method}${path}${body}`;
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), this.privateKey).toString('base64');
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now().toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'API-Key': this.credentials.apiKey,
          'API-Timestamp': timestamp,
          'API-Signature': this.sign(timestamp, method, path, payload),
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(payload ? { body: payload } : {}),
      });
    } catch (err) {
      // A timeout or connection reset is retryable, and — critically — leaves
      // the order state UNKNOWN. The execution service resolves that by
      // querying, never by resubmitting.
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new VenueError(
        aborted ? `Request to ${path} timed out after ${this.timeoutMs}ms.` : `Network failure calling ${path}.`,
        true,
        aborted ? 'timeout' : 'network',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as Record<string, unknown>).message)
          : null) ?? `Revolut X returned ${response.status} for ${path}`;

      // 5xx and 429 are worth retrying; 4xx means we asked for something wrong.
      const retryable = response.status >= 500 || response.status === 429;
      throw new VenueError(message, retryable, `http_${response.status}`);
    }

    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface RawInstrument {
  symbol?: string;
  base_currency?: string;
  quote_currency?: string;
  quantity_step?: string | number;
  price_step?: string | number;
  min_quantity?: string | number;
  max_quantity?: string | number;
  status?: string;
  taker_fee?: string | number;
  maker_fee?: string | number;
}

interface RawOrder {
  id?: string;
  order_id?: string;
  client_order_id?: string;
  symbol?: string;
  side?: string;
  state?: string;
  status?: string;
  quantity?: string | number;
  filled_quantity?: string | number;
  remaining_quantity?: string | number;
  average_price?: string | number;
  reject_reason?: string;
  created_at?: string;
  updated_at?: string;
}

interface RawFill {
  id?: string;
  fill_id?: string;
  trade_id?: string;
  order_id?: string;
  client_order_id?: string;
  symbol?: string;
  side?: string;
  quantity?: string | number;
  price?: string | number;
  fee?: string | number;
  created_at?: string;
  timestamp?: string;
  sequence?: number;
}

/** Their numbers arrive as strings often enough that this is not optional. */
const num = (v: unknown, fallback = 0): number => {
  if (v === null || v === undefined || v === '') return fallback;
  const parsed = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
};

export interface RevolutXOptions {
  /**
   * How far through the touch a "market" intent is allowed to reach, as a
   * fraction. 0.005 = half a percent. Bounds worst-case slippage on an order
   * that would otherwise be unbounded.
   */
  marketSlippageAllowance?: number;
  /** How many recent orders to scan when collecting fills. */
  fillScanLimit?: number;
  /**
   * How far back before the cursor to re-check CLOSED orders, in milliseconds.
   * Small on purpose: open orders are never filtered by time, so this only
   * guards against a settled order's last fill landing on the boundary.
   */
  fillOverlapMs?: number;
}

export class RevolutXVenue implements ExecutionVenue {
  readonly id = 'revolutx';
  readonly mode: 'paper' | 'live';

  private slippage: number;
  private fillScanLimit: number;
  private fillOverlapMs: number;

  constructor(
    private transport: RevolutXTransport,
    mode: 'paper' | 'live' = 'live',
    options: RevolutXOptions = {},
  ) {
    this.mode = mode;
    this.slippage = options.marketSlippageAllowance ?? 0.005;
    this.fillScanLimit = options.fillScanLimit ?? 100;
    this.fillOverlapMs = options.fillOverlapMs ?? 250;
  }

  /** Instrument universe, including the venue's own precision and size rules. */
  async instruments(): Promise<Map<string, Instrument>> {
    const raw = await this.transport.request<RawInstrument[] | { instruments: RawInstrument[] }>(
      'GET',
      WIRE.paths.currencyPairs,
    );
    const list = Array.isArray(raw) ? raw : (raw?.instruments ?? []);
    const map = new Map<string, Instrument>();

    for (const item of list) {
      const symbol = firstString(item.symbol);
      if (!symbol) continue;
      // Never trade something the venue has taken offline.
      if (item.status && !['trading', 'active', 'enabled'].includes(String(item.status).toLowerCase())) continue;

      map.set(symbol, {
        symbol,
        name: symbol,
        // The existing asset-class enum does not describe spot crypto; this is
        // a placeholder until the enum is widened. It does not affect execution.
        asset_class: 'Compute_Matrix',
        tick_size: num(item.price_step, 0.01),
        lot_size: num(item.quantity_step, 0.00000001),
        min_quantity: num(item.min_quantity, 0),
        buy_fee_rate: num(item.taker_fee, 0),
        sell_fee_rate: num(item.taker_fee, 0),
        // Spot crypto carries no principal guarantee, so auto-strike stays off
        // unless an operator explicitly opts the symbol in.
        is_guaranteed: false,
        fundamentals_intact: true,
        simulated: false,
      });
    }

    return map;
  }

  async place(intent: OrderIntent): Promise<PlacedOrder> {
    const body: Record<string, unknown> = {
      client_order_id: intent.clientOrderId,
      symbol: intent.symbol,
      side: intent.side,
      quantity: String(intent.quantity),
      order_type: 'limit',
      time_in_force: WIRE.timeInForce[intent.timeInForce],
    };

    if (intent.type === 'limit') {
      if (!(intent.limitPrice! > 0)) {
        throw new VenueError('A limit order requires a positive limit price.', false, 'bad_request');
      }
      body.price = String(intent.limitPrice);
    } else {
      // Marketable limit rather than a naked market order — see the header note.
      const reference = await this.referencePrice(intent.symbol, intent.side);
      if (!(reference > 0)) {
        throw new VenueError(
          `Cannot price a market order for ${intent.symbol}: no usable reference price.`,
          true,
          'no_quote',
        );
      }
      const bound =
        intent.side === 'buy' ? reference * (1 + this.slippage) : reference * (1 - this.slippage);
      body.price = String(round(bound, 8));
      body.time_in_force = WIRE.timeInForce.ioc;
    }

    try {
      const raw = await this.transport.request<RawOrder>('POST', WIRE.paths.placeOrder, body);
      return {
        venueOrderId: firstString(raw.order_id, raw.id) ?? intent.clientOrderId,
        status: mapOrderState(firstString(raw.state, raw.status)),
        deduplicated: false,
        rejectReason: raw.reject_reason ?? null,
      };
    } catch (err) {
      // A duplicate client_order_id is not a failure — it is the idempotency
      // guarantee working. Recover the original order instead of surfacing it
      // as an error.
      if (err instanceof VenueError && /duplicate|already exists|conflict/i.test(err.message)) {
        const existing = await this.get(intent.clientOrderId);
        if (existing) {
          return {
            venueOrderId: existing.venueOrderId,
            status: existing.status,
            deduplicated: true,
            rejectReason: existing.rejectReason ?? null,
          };
        }
      }
      throw err;
    }
  }

  async cancel(clientOrderId: string): Promise<CancelResult> {
    const existing = await this.get(clientOrderId);
    if (!existing) return { ok: false, status: 'rejected', reason: 'Unknown order.' };

    if (['filled', 'cancelled', 'rejected', 'expired'].includes(existing.status)) {
      return { ok: false, status: existing.status, reason: `Order is already ${existing.status}.` };
    }

    await this.transport.request('DELETE', WIRE.paths.cancelOrder(existing.venueOrderId));

    // Re-read rather than assume: a cancel racing a fill is normal, and the
    // venue's answer is the only authority on which won.
    const after = await this.get(clientOrderId);
    const status = after?.status ?? 'cancelled';
    return { ok: status === 'cancelled', status, reason: status === 'cancelled' ? undefined : `Order is ${status}.` };
  }

  async get(clientOrderId: string): Promise<VenueOrder | null> {
    try {
      const raw = await this.transport.request<RawOrder | null>(
        'GET',
        WIRE.paths.orderByClientId(clientOrderId),
      );
      return raw ? this.toVenueOrder(raw) : null;
    } catch (err) {
      // 404 means "no such order", which is an answer, not a failure. Anything
      // else is a genuine problem and must propagate — swallowing it would let
      // the execution service conclude an order never landed when in fact we
      // simply could not ask.
      if (err instanceof VenueError && err.code === 'http_404') return null;
      throw err;
    }
  }

  async openOrders(): Promise<VenueOrder[]> {
    const raw = await this.transport.request<RawOrder[] | { orders: RawOrder[] }>(
      'GET',
      `${WIRE.paths.activeOrders}?limit=300`,
    );
    const list = Array.isArray(raw) ? raw : (raw?.orders ?? []);
    return list.map((o) => this.toVenueOrder(o));
  }

  /**
   * Collect fills newer than the cursor.
   *
   * Their API is order-centric, so this walks recently-active orders and
   * gathers their fills. Two different rules apply, and the distinction matters:
   *
   *  - **Still-open orders: return every fill, ignoring the cursor.** An open
   *    order is where fills are actively arriving, and a fill whose venue
   *    timestamp predates our cursor — because of clock skew, or because it
   *    became visible late — would be silently dropped by a timestamp filter.
   *    Dropping a fill corrupts the position permanently. Re-sending one costs
   *    nothing, because the store deduplicates on `venueFillId`.
   *
   *  - **Closed orders: filter by timestamp with a small overlap.** These are
   *    settled and will not gain fills, so they can age out of the sweep. This
   *    is what lets the cursor make progress instead of re-fetching all history
   *    on every poll.
   *
   * An earlier version applied one blanket overlap window to everything. On a
   * venue whose fills are spaced closer together than the window, that replayed
   * the entire tail on every call and the cursor never advanced — caught by the
   * venue conformance suite rather than in production.
   */
  async fillsSince(cursor: string | null): Promise<{ fills: VenueFill[]; cursor: string }> {
    const since = cursor ? Number(cursor) : 0;
    const windowStart = since > 0 ? Math.max(0, since - this.fillOverlapMs) : 0;

    const raw = await this.transport.request<RawOrder[] | { orders: RawOrder[] }>(
      'GET',
      `${WIRE.paths.historicalOrders}?limit=${this.fillScanLimit}${windowStart ? `&from=${windowStart}` : ''}`,
    );
    const orders = Array.isArray(raw) ? raw : (raw?.orders ?? []);

    const active = await this.openOrders().catch(() => [] as VenueOrder[]);
    const openVenueIds = new Set(active.map((o) => o.venueOrderId));

    const candidateIds = new Set<string>();
    const clientIdByVenueId = new Map<string, string>();

    for (const order of orders) {
      const venueId = firstString(order.order_id, order.id);
      const clientId = firstString(order.client_order_id);
      if (!venueId || !clientId) continue;
      candidateIds.add(venueId);
      clientIdByVenueId.set(venueId, clientId);
    }
    for (const order of active) {
      candidateIds.add(order.venueOrderId);
      clientIdByVenueId.set(order.venueOrderId, order.clientOrderId);
    }

    const fills: VenueFill[] = [];
    let latest = since;

    for (const venueOrderId of candidateIds) {
      let rawFills: RawFill[];
      try {
        const response = await this.transport.request<RawFill[] | { fills: RawFill[] }>(
          'GET',
          WIRE.paths.orderFills(venueOrderId),
        );
        rawFills = Array.isArray(response) ? response : (response?.fills ?? []);
      } catch {
        // One order's fills failing must not abort the whole sweep; the next
        // pull will pick it up.
        continue;
      }

      const isOpen = openVenueIds.has(venueOrderId);

      for (const raw of rawFills) {
        const timestamp = firstString(raw.created_at, raw.timestamp) ?? new Date().toISOString();
        const at = Date.parse(timestamp);

        // Closed orders age out; open ones never do.
        if (!isOpen && Number.isFinite(at) && at < windowStart) continue;

        const venueFillId = firstString(raw.fill_id, raw.trade_id, raw.id);
        if (!venueFillId) continue;

        const clientOrderId =
          firstString(raw.client_order_id) ?? clientIdByVenueId.get(venueOrderId) ?? venueOrderId;

        fills.push({
          clientOrderId,
          venueFillId,
          symbol: firstString(raw.symbol) ?? '',
          side: (String(raw.side).toLowerCase() === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell',
          quantity: num(raw.quantity),
          price: num(raw.price),
          fee: num(raw.fee),
          timestamp,
          sequence: typeof raw.sequence === 'number' ? raw.sequence : null,
        });

        if (Number.isFinite(at) && at > latest) latest = at;
      }
    }

    return { fills, cursor: String(latest || since) };
  }

  async close(): Promise<void> {
    /* stateless */
  }

  private toVenueOrder(raw: RawOrder): VenueOrder {
    const quantity = num(raw.quantity);
    const filled = num(raw.filled_quantity);
    return {
      clientOrderId: firstString(raw.client_order_id) ?? '',
      venueOrderId: firstString(raw.order_id, raw.id) ?? '',
      symbol: firstString(raw.symbol) ?? '',
      status: mapOrderState(firstString(raw.state, raw.status)),
      filledQuantity: filled,
      remainingQuantity: num(raw.remaining_quantity, Math.max(0, quantity - filled)),
      rejectReason: raw.reject_reason ?? null,
    };
  }

  private async referencePrice(symbol: string, side: 'buy' | 'sell'): Promise<number> {
    try {
      const raw = await this.transport.request<Record<string, unknown>>(
        'GET',
        `${WIRE.paths.ticker}?symbol=${encodeURIComponent(symbol)}`,
      );
      // Buying crosses the ask; selling crosses the bid.
      const touch = side === 'buy' ? num(raw.ask ?? raw.best_ask) : num(raw.bid ?? raw.best_bid);
      return touch || num(raw.last ?? raw.last_price);
    } catch {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * Polling market data over the REST ticker.
 *
 * Polling rather than websocket on purpose for a first cut: the risk layer
 * already refuses to trade on a stale quote, so a slow feed degrades into
 * refusals rather than into bad fills. A streaming source can be swapped in
 * behind the same interface without touching anything above it.
 */
export class RevolutXMarketData implements MarketDataSource {
  readonly id = 'revolutx';
  readonly capabilities = { streaming: false, depth: true };

  private timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private transport: RevolutXTransport,
    private pollIntervalMs = 2000,
  ) {}

  async quote(symbol: string): Promise<Quote | null> {
    try {
      const raw = await this.transport.request<Record<string, unknown>>(
        'GET',
        `${WIRE.paths.ticker}?symbol=${encodeURIComponent(symbol)}`,
      );

      const bid = num(raw.bid ?? raw.best_bid);
      const ask = num(raw.ask ?? raw.best_ask);
      const last = num(raw.last ?? raw.last_price) || (bid && ask ? (bid + ask) / 2 : 0);
      if (!bid || !ask) return null;

      const venueTimestamp = firstString(raw.timestamp as string, raw.time as string);
      return {
        symbol,
        bid,
        ask,
        last,
        // Their clock and ours will disagree; keep both. Staleness is measured
        // on ours, so venue clock skew cannot defeat the staleness gate.
        timestamp: venueTimestamp ?? new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        source: this.id,
        simulated: false,
      };
    } catch {
      return null;
    }
  }

  subscribe(symbols: string[], onQuote: (quote: Quote) => void): Unsubscribe {
    const timer = setInterval(() => {
      for (const symbol of symbols) {
        void this.quote(symbol).then((q) => {
          if (q) onQuote(q);
        });
      }
    }, this.pollIntervalMs);
    timer.unref?.();
    this.timers.add(timer);

    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}

/** Build credentials from the environment, or null when not configured. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): RevolutXCredentials | null {
  const apiKey = env.REVOLUTX_API_KEY;
  const privateKeyPem = env.REVOLUTX_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!apiKey || !privateKeyPem) return null;
  return { apiKey, privateKeyPem };
}
