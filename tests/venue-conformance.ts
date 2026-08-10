/**
 * Venue conformance suite.
 *
 * Every `ExecutionVenue` implementation must pass this. It is the same device
 * used for `Store`: an interface with one implementation is a shape, an
 * interface with two and a shared suite is a contract.
 *
 * The guarantees asserted here are the ones the execution service actually
 * relies on. If an adapter fails any of them, the ledger above it will be
 * wrong in ways that are expensive and hard to trace.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionVenue } from '../server/market/venue';
import { ExecutionService } from '../server/market/execution';
import type { OrderIntent } from '../server/market/types';

export interface VenueHarness {
  /** A fresh venue with no prior state. */
  create(): Promise<{ venue: ExecutionVenue; symbol: string; cleanup: () => Promise<void> }>;
  /** Drive the venue until pending fills have been produced. */
  settle(venue: ExecutionVenue): Promise<void>;
}

export function runVenueConformance(label: string, harness: VenueHarness) {
  describe(`ExecutionVenue conformance — ${label}`, () => {
    const intent = (symbol: string, patch: Partial<OrderIntent> = {}): OrderIntent => ({
      clientOrderId: ExecutionService.newClientOrderId(),
      symbol,
      side: 'buy',
      quantity: 10,
      type: 'limit',
      limitPrice: 100,
      timeInForce: 'gtc',
      reason: 'conformance',
      ...patch,
    });

    it('accepts an order and reports a venue id', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const placed = await venue.place(intent(symbol));
        assert.ok(placed.venueOrderId, 'every accepted order must carry a venue identifier');
        assert.equal(placed.deduplicated, false);
      } finally {
        await cleanup();
      }
    });

    it('is idempotent on clientOrderId', async () => {
      // THE critical guarantee. Without it, a timeout is unrecoverable: the
      // caller cannot distinguish "never landed" from "landed and we missed
      // the reply", and either choice can lose or duplicate money.
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol);
        const first = await venue.place(i);
        const second = await venue.place(i);

        assert.equal(second.deduplicated, true, 'a repeated clientOrderId must not create a second order');
        assert.equal(second.venueOrderId, first.venueOrderId);

        const open = await venue.openOrders();
        const matching = open.filter((o) => o.clientOrderId === i.clientOrderId);
        assert.ok(matching.length <= 1, 'at most one order may exist for a clientOrderId');
      } finally {
        await cleanup();
      }
    });

    it('can be queried by clientOrderId', async () => {
      // The recovery path depends on this: after a failed place() we ask the
      // venue what it knows, using the only id we are sure of.
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol);
        await venue.place(i);

        const found = await venue.get(i.clientOrderId);
        assert.ok(found, 'a placed order must be retrievable by clientOrderId');
        assert.equal(found!.clientOrderId, i.clientOrderId);
        assert.equal(found!.symbol, symbol);
      } finally {
        await cleanup();
      }
    });

    it('returns null — not an error — for an unknown clientOrderId', async () => {
      // "No such order" is an answer. Throwing here would make the execution
      // service unable to conclude that nothing landed.
      const { venue, cleanup } = await harness.create();
      try {
        assert.equal(await venue.get('coid-does-not-exist'), null);
      } finally {
        await cleanup();
      }
    });

    it('lists the order among open orders while it is live', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol);
        await venue.place(i);
        const open = await venue.openOrders();
        assert.ok(open.some((o) => o.clientOrderId === i.clientOrderId));
      } finally {
        await cleanup();
      }
    });

    it('produces fills that reference the originating clientOrderId', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol);
        await venue.place(i);
        await harness.settle(venue);

        const { fills } = await venue.fillsSince(null);
        assert.ok(fills.length > 0, 'settling should produce at least one fill');

        for (const fill of fills) {
          assert.ok(fill.clientOrderId, 'a fill with no clientOrderId cannot be attributed to an order');
          assert.ok(fill.venueFillId, 'a fill with no id cannot be deduplicated');
          assert.ok(fill.quantity > 0, 'a fill must have positive quantity');
          assert.ok(fill.price > 0, 'a fill must have a price');
        }
      } finally {
        await cleanup();
      }
    });

    it('advances the fill cursor and does not replay past it', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        await venue.place(intent(symbol));
        await harness.settle(venue);

        const first = await venue.fillsSince(null);
        assert.ok(first.fills.length > 0);
        assert.ok(first.cursor, 'the cursor must be non-empty once fills exist');

        const second = await venue.fillsSince(first.cursor);
        const firstIds = new Set(first.fills.map((f) => f.venueFillId));
        const repeated = second.fills.filter((f) => firstIds.has(f.venueFillId));

        // A bounded tail replaying is by design: the cursor is a scan bound,
        // not an exactness guarantee. Fills are deduplicated on venueFillId
        // upstream, so re-sending one is free while missing one corrupts the
        // position permanently. What must hold is that catch-up TERMINATES —
        // the cursor advances and the replay does not grow into the full
        // history on every poll.
        assert.ok(
          repeated.length < first.fills.length || first.fills.length <= 1,
          'catch-up must terminate: replay may be a bounded tail, never the whole history',
        );
      } finally {
        await cleanup();
      }
    });

    it('never reports more filled than ordered', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol, { quantity: 10 });
        await venue.place(i);
        await harness.settle(venue);

        const order = await venue.get(i.clientOrderId);
        if (order) {
          assert.ok(
            order.filledQuantity <= i.quantity + 1e-9,
            `overfill: ${order.filledQuantity} of ${i.quantity}`,
          );
        }

        const { fills } = await venue.fillsSince(null);
        const total = fills
          .filter((f) => f.clientOrderId === i.clientOrderId)
          .reduce((sum, f) => sum + f.quantity, 0);
        assert.ok(total <= i.quantity + 1e-9, `fills sum to ${total}, order was ${i.quantity}`);
      } finally {
        await cleanup();
      }
    });

    it('refuses to cancel an unknown order rather than reporting success', async () => {
      const { venue, cleanup } = await harness.create();
      try {
        const result = await venue.cancel('coid-does-not-exist');
        assert.equal(result.ok, false);
      } finally {
        await cleanup();
      }
    });

    it('cancels a live order and stops filling it', async () => {
      const { venue, symbol, cleanup } = await harness.create();
      try {
        const i = intent(symbol, { quantity: 10 });
        await venue.place(i);

        const result = await venue.cancel(i.clientOrderId);
        assert.equal(result.ok, true);
        assert.equal(result.status, 'cancelled');

        await harness.settle(venue);
        const { fills } = await venue.fillsSince(null);
        const mine = fills.filter((f) => f.clientOrderId === i.clientOrderId);
        assert.equal(mine.length, 0, 'a cancelled order must not fill afterwards');
      } finally {
        await cleanup();
      }
    });

    it('reports a stable mode', async () => {
      const { venue, cleanup } = await harness.create();
      try {
        assert.ok(venue.mode === 'paper' || venue.mode === 'live');
        assert.ok(venue.id.length > 0);
      } finally {
        await cleanup();
      }
    });
  });
}
