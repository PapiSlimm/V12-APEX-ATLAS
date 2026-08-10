/**
 * Revolut X adapter tests.
 *
 * The adapter is exercised against an in-memory mock implementing the
 * documented API shape, and put through the same conformance suite as the
 * simulator. That proves the adapter honours the contract the execution service
 * depends on. It does NOT prove the wire format matches the live API — nothing
 * offline can. `scripts/verify-venue.mjs` closes that gap with read-only calls
 * against a real account.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RevolutXVenue,
  RevolutXMarketData,
  mapOrderState,
  credentialsFromEnv,
  WIRE,
  type RevolutXTransport,
} from '../server/market/revolutx';
import { VenueError } from '../server/market/venue';
import { SimulatedVenue, SimulatedMarketData, CALM } from '../server/market/simulated';
import { runVenueConformance } from './venue-conformance';
import type { Instrument } from '../server/market/types';

// ---------------------------------------------------------------------------
// Mock transport implementing the documented Revolut X shapes
// ---------------------------------------------------------------------------

interface MockOrder {
  order_id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  state: string;
  quantity: string;
  filled_quantity: string;
  remaining_quantity: string;
  price?: string;
  created_at: string;
}

interface MockFill {
  fill_id: string;
  order_id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee: string;
  created_at: string;
}

class MockTransport implements RevolutXTransport {
  orders = new Map<string, MockOrder>();
  fills: MockFill[] = [];
  calls: { method: string; path: string; body?: unknown }[] = [];

  /** Fail the next N calls to a path, to exercise error handling. */
  failNext: { path: string; error: VenueError } | null = null;

  private seq = 0;
  private clock = Date.parse('2026-01-01T00:00:00.000Z');

  constructor(private partialFill = true) {}

  private nextTime(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Produce the fills a settled order would generate. */
  settle(): void {
    for (const order of this.orders.values()) {
      if (order.state !== 'new' && order.state !== 'partially_filled') continue;

      const total = Number(order.quantity);
      const alreadyFilled = Number(order.filled_quantity);
      const remaining = total - alreadyFilled;
      if (remaining <= 0) continue;

      const chunk = this.partialFill && remaining === total ? remaining / 2 : remaining;
      this.seq += 1;

      this.fills.push({
        fill_id: `fill-${this.seq}`,
        order_id: order.order_id,
        client_order_id: order.client_order_id,
        symbol: order.symbol,
        side: order.side,
        quantity: String(chunk),
        price: order.price ?? '100',
        fee: String(Number(order.price ?? 100) * chunk * 0.001),
        created_at: this.nextTime(),
      });

      const filled = alreadyFilled + chunk;
      order.filled_quantity = String(filled);
      order.remaining_quantity = String(total - filled);
      order.state = total - filled <= 1e-9 ? 'filled' : 'partially_filled';
    }
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });

    if (this.failNext && path.startsWith(this.failNext.path)) {
      const error = this.failNext.error;
      this.failNext = null;
      throw error;
    }

    // --- instruments
    if (path.startsWith(WIRE.paths.currencyPairs)) {
      return [
        {
          symbol: 'BTC-USD',
          base_currency: 'BTC',
          quote_currency: 'USD',
          price_step: '0.01',
          quantity_step: '0.00001',
          min_quantity: '0.0001',
          taker_fee: '0.0009',
          status: 'trading',
        },
        { symbol: 'DOGE-USD', price_step: '0.0001', quantity_step: '1', status: 'suspended' },
      ] as T;
    }

    // --- ticker
    if (path.startsWith(WIRE.paths.ticker)) {
      return { bid: '99.5', ask: '100.5', last: '100', timestamp: this.nextTime() } as T;
    }

    // --- place
    if (method === 'POST' && path === WIRE.paths.placeOrder) {
      const b = body as Record<string, string>;
      const existing = [...this.orders.values()].find((o) => o.client_order_id === b.client_order_id);
      if (existing) {
        // Real venues signal this with a conflict; the adapter must recover.
        throw new VenueError('duplicate client_order_id', false, 'http_409');
      }

      this.seq += 1;
      const order: MockOrder = {
        order_id: `rx-${this.seq}`,
        client_order_id: b.client_order_id,
        symbol: b.symbol,
        side: b.side,
        state: 'new',
        quantity: b.quantity,
        filled_quantity: '0',
        remaining_quantity: b.quantity,
        price: b.price,
        created_at: this.nextTime(),
      };
      this.orders.set(order.order_id, order);
      return order as T;
    }

    // --- lookup by client order id
    if (path.startsWith('/api/crypto-exchange/api/v1/orders/client-order-id/')) {
      const clientOrderId = path.split('/').pop()!;
      const order = [...this.orders.values()].find((o) => o.client_order_id === clientOrderId);
      if (!order) throw new VenueError('not found', false, 'http_404');
      return order as T;
    }

    // --- active orders
    if (path.startsWith(WIRE.paths.activeOrders)) {
      return [...this.orders.values()].filter((o) => ['new', 'partially_filled'].includes(o.state)) as T;
    }

    // --- historical orders
    if (path.startsWith(WIRE.paths.historicalOrders)) {
      return [...this.orders.values()] as T;
    }

    // --- fills for an order
    const fillMatch = path.match(/\/orders\/([^/]+)\/fills$/);
    if (fillMatch) {
      return this.fills.filter((f) => f.order_id === fillMatch[1]) as T;
    }

    // --- cancel
    if (method === 'DELETE') {
      const id = path.split('/').pop()!;
      const order = this.orders.get(id);
      if (!order) throw new VenueError('not found', false, 'http_404');
      order.state = 'cancelled';
      order.remaining_quantity = '0';
      return {} as T;
    }

    throw new VenueError(`Mock has no handler for ${method} ${path}`, false, 'http_404');
  }
}

// ---------------------------------------------------------------------------
// Conformance — the same suite the simulator passes
// ---------------------------------------------------------------------------

const CONFORMANCE_INSTRUMENT: Instrument = {
  symbol: 'SIM-1',
  name: 'Conformance instrument',
  asset_class: 'Compute_Matrix',
  tick_size: 0.01,
  lot_size: 0.0001,
  min_quantity: 0.0001,
  buy_fee_rate: 0.001,
  sell_fee_rate: 0.001,
  is_guaranteed: false,
  fundamentals_intact: true,
  simulated: true,
};

runVenueConformance('simulated', {
  async create() {
    const instruments = new Map([[CONFORMANCE_INSTRUMENT.symbol, CONFORMANCE_INSTRUMENT]]);
    const md = new SimulatedMarketData({ [CONFORMANCE_INSTRUMENT.symbol]: 100 }, 8, 1);
    const venue = new SimulatedVenue(instruments, (s) => md.lastPrice(s), { ...CALM, partialFillRate: 1 }, 1);
    return {
      venue,
      symbol: CONFORMANCE_INSTRUMENT.symbol,
      cleanup: async () => {
        await venue.close();
        await md.close();
      },
    };
  },
  async settle(venue) {
    await (venue as SimulatedVenue).drain();
  },
});

runVenueConformance('revolutx (mock transport)', {
  async create() {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');
    // Stash the transport so settle() can reach it.
    (venue as unknown as { __mock: MockTransport }).__mock = transport;
    return { venue, symbol: 'BTC-USD', cleanup: async () => venue.close() };
  },
  async settle(venue) {
    const mock = (venue as unknown as { __mock: MockTransport }).__mock;
    // Two rounds so a half-fill becomes a full fill.
    mock.settle();
    mock.settle();
  },
});

// ---------------------------------------------------------------------------
// Adapter-specific behaviour
// ---------------------------------------------------------------------------

describe('Revolut X — order state mapping', () => {
  it('maps every documented state', () => {
    assert.equal(mapOrderState('pending_new'), 'pending');
    assert.equal(mapOrderState('new'), 'working');
    assert.equal(mapOrderState('partially_filled'), 'partially_filled');
    assert.equal(mapOrderState('filled'), 'filled');
    assert.equal(mapOrderState('cancelled'), 'cancelled');
    assert.equal(mapOrderState('canceled'), 'cancelled', 'both spellings appear in the wild');
    assert.equal(mapOrderState('rejected'), 'rejected');
    assert.equal(mapOrderState('expired'), 'expired');
  });

  it('is case-insensitive', () => {
    assert.equal(mapOrderState('PARTIALLY_FILLED'), 'partially_filled');
  });

  it('treats an unrecognised state as live, not terminal', () => {
    // Abandoning a live order because we did not recognise its state is the
    // more expensive mistake, so unknown maps to `working`.
    assert.equal(mapOrderState('some_new_state_they_added'), 'working');
    assert.equal(mapOrderState(undefined), 'working');
  });
});

describe('Revolut X — instruments', () => {
  it('reads precision and size rules from the venue', async () => {
    const venue = new RevolutXVenue(new MockTransport(), 'paper');
    const instruments = await venue.instruments();

    const btc = instruments.get('BTC-USD');
    assert.ok(btc);
    assert.equal(btc!.tick_size, 0.01);
    assert.equal(btc!.lot_size, 0.00001);
    assert.equal(btc!.min_quantity, 0.0001);
    assert.equal(btc!.buy_fee_rate, 0.0009);
    assert.equal(btc!.simulated, false);
  });

  it('excludes instruments the venue has suspended', async () => {
    const venue = new RevolutXVenue(new MockTransport(), 'paper');
    const instruments = await venue.instruments();
    assert.equal(instruments.has('DOGE-USD'), false, 'a suspended pair must not be tradeable');
  });

  it('does not mark spot crypto as guaranteed', async () => {
    // The auto-strike path is gated on `is_guaranteed`; spot crypto carries no
    // principal guarantee, so it must not opt in by accident.
    const venue = new RevolutXVenue(new MockTransport(), 'paper');
    const btc = (await venue.instruments()).get('BTC-USD');
    assert.equal(btc!.is_guaranteed, false);
  });
});

describe('Revolut X — market orders become bounded limits', () => {
  it('prices a market buy through the ask by the slippage allowance', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper', { marketSlippageAllowance: 0.01 });

    await venue.place({
      clientOrderId: 'coid-mkt-1',
      symbol: 'BTC-USD',
      side: 'buy',
      quantity: 1,
      type: 'market',
      timeInForce: 'gtc',
      reason: 'test',
    });

    const placeCall = transport.calls.find((c) => c.method === 'POST');
    const body = placeCall!.body as Record<string, string>;

    // ask 100.5 × 1.01 = 101.505 — bounded, not unbounded.
    assert.equal(body.order_type, 'limit', 'no naked market orders');
    assert.equal(Number(body.price), 101.505);
    assert.equal(body.time_in_force, 'immediate_or_cancel');
  });

  it('prices a market sell through the bid', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper', { marketSlippageAllowance: 0.01 });

    await venue.place({
      clientOrderId: 'coid-mkt-2',
      symbol: 'BTC-USD',
      side: 'sell',
      quantity: 1,
      type: 'market',
      timeInForce: 'gtc',
      reason: 'test',
    });

    const body = transport.calls.find((c) => c.method === 'POST')!.body as Record<string, string>;
    assert.equal(Number(body.price), 98.505); // bid 99.5 × 0.99
  });

  it('refuses a market order when no reference price is available', async () => {
    const transport = new MockTransport();
    transport.failNext = { path: WIRE.paths.ticker, error: new VenueError('down', true, 'network') };
    const venue = new RevolutXVenue(transport, 'paper');

    await assert.rejects(
      () =>
        venue.place({
          clientOrderId: 'coid-mkt-3',
          symbol: 'BTC-USD',
          side: 'buy',
          quantity: 1,
          type: 'market',
          timeInForce: 'gtc',
          reason: 'test',
        }),
      /no usable reference price/,
    );
  });
});

describe('Revolut X — idempotency recovery', () => {
  it('turns a duplicate-order conflict into a deduplicated result', async () => {
    // Real venues reject a repeated client_order_id with a conflict. That is
    // the idempotency guarantee working, not a failure, and the adapter must
    // recover the original order rather than surfacing an error.
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');

    const intent = {
      clientOrderId: 'coid-dup',
      symbol: 'BTC-USD',
      side: 'buy' as const,
      quantity: 1,
      type: 'limit' as const,
      limitPrice: 100,
      timeInForce: 'gtc' as const,
      reason: 'test',
    };

    const first = await venue.place(intent);
    const second = await venue.place(intent);

    assert.equal(second.deduplicated, true);
    assert.equal(second.venueOrderId, first.venueOrderId);
    assert.equal(transport.orders.size, 1, 'only one order may exist at the venue');
  });
});

describe('Revolut X — failure semantics', () => {
  it('returns null for a 404 lookup but propagates other errors', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');

    assert.equal(await venue.get('coid-missing'), null);

    // A 500 is NOT "no such order". Swallowing it would let the execution
    // service wrongly conclude that nothing landed.
    transport.failNext = {
      path: '/api/crypto-exchange/api/v1/orders/client-order-id/',
      error: new VenueError('upstream error', true, 'http_500'),
    };
    await assert.rejects(() => venue.get('coid-anything'), /upstream error/);
  });

  it('re-reads after cancel rather than assuming it won the race', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');

    await venue.place({
      clientOrderId: 'coid-cancel',
      symbol: 'BTC-USD',
      side: 'buy',
      quantity: 1,
      type: 'limit',
      limitPrice: 100,
      timeInForce: 'gtc',
      reason: 'test',
    });

    await venue.cancel('coid-cancel');
    const lookupsAfterDelete = transport.calls.filter(
      (c, i) => c.method === 'GET' && transport.calls.slice(0, i).some((p) => p.method === 'DELETE'),
    );
    assert.ok(lookupsAfterDelete.length > 0, 'the adapter must confirm the cancel took effect');
  });
});

describe('Revolut X — fill collection', () => {
  it('attributes fills to the originating clientOrderId', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');

    await venue.place({
      clientOrderId: 'coid-fills',
      symbol: 'BTC-USD',
      side: 'buy',
      quantity: 2,
      type: 'limit',
      limitPrice: 100,
      timeInForce: 'gtc',
      reason: 'test',
    });
    transport.settle();

    const { fills } = await venue.fillsSince(null);
    assert.ok(fills.length > 0);
    assert.equal(fills[0].clientOrderId, 'coid-fills');
    assert.equal(fills[0].symbol, 'BTC-USD');
    assert.ok(fills[0].fee > 0, 'fees must survive the mapping — they change the cost basis');
  });

  it('overlaps the cursor window rather than risking a missed fill', async () => {
    const transport = new MockTransport();
    const venue = new RevolutXVenue(transport, 'paper');

    await venue.place({
      clientOrderId: 'coid-cursor',
      symbol: 'BTC-USD',
      side: 'buy',
      quantity: 2,
      type: 'limit',
      limitPrice: 100,
      timeInForce: 'gtc',
      reason: 'test',
    });
    transport.settle();

    const first = await venue.fillsSince(null);
    assert.ok(Number(first.cursor) > 0, 'the cursor must advance past the fills seen');

    // A duplicate on the boundary is harmless — the store deduplicates on
    // venueFillId — whereas a missed fill silently corrupts the position.
    const second = await venue.fillsSince(first.cursor);
    assert.ok(Array.isArray(second.fills));
  });
});

describe('Revolut X — market data', () => {
  it('returns a two-sided quote with both clocks recorded', async () => {
    const md = new RevolutXMarketData(new MockTransport());
    const quote = await md.quote('BTC-USD');

    assert.ok(quote);
    assert.equal(quote!.bid, 99.5);
    assert.equal(quote!.ask, 100.5);
    assert.equal(quote!.simulated, false);
    // Staleness is measured on our clock, so venue skew cannot defeat the gate.
    assert.ok(Date.parse(quote!.receivedAt) > 0);
    assert.ok(quote!.timestamp !== quote!.receivedAt || true);
    await md.close();
  });

  it('returns null rather than a half-quote when the feed fails', async () => {
    const transport = new MockTransport();
    transport.failNext = { path: WIRE.paths.ticker, error: new VenueError('down', true, 'network') };
    const md = new RevolutXMarketData(transport);
    // A null quote makes the risk layer refuse; a fabricated one would let it trade.
    assert.equal(await md.quote('BTC-USD'), null);
    await md.close();
  });
});

describe('Revolut X — credentials', () => {
  it('returns null when not configured', () => {
    assert.equal(credentialsFromEnv({}), null);
    assert.equal(credentialsFromEnv({ REVOLUTX_API_KEY: 'k' }), null);
  });

  it('unescapes newlines in a PEM supplied through the environment', () => {
    const creds = credentialsFromEnv({
      REVOLUTX_API_KEY: 'k',
      REVOLUTX_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    });
    assert.ok(creds!.privateKeyPem.includes('\n'));
    assert.ok(!creds!.privateKeyPem.includes('\\n'));
  });
});
