/**
 * Live read-only probe for the Revolut X adapter.
 *
 * The adapter's domain mapping is covered by the offline conformance suite.
 * What no offline test can prove is that the *wire format* matches — endpoint
 * paths, field names, auth signing, value types. This script closes that gap by
 * calling every READ path against a real account and reporting anything the
 * adapter would misread.
 *
 * IT NEVER PLACES, AMENDS OR CANCELS AN ORDER. It is safe to run against a live
 * account, and it is the gate you should pass before setting EXECUTION_MODE=live.
 *
 * Usage:
 *   REVOLUTX_API_KEY=... REVOLUTX_PRIVATE_KEY="$(cat key.pem)" npm run verify:venue
 */

import {
  HttpTransport,
  RevolutXVenue,
  RevolutXMarketData,
  credentialsFromEnv,
  WIRE,
} from '../server/market/revolutx';

const results: { name: string; ok: boolean | null; detail: string }[] = [];
const note = (name: string, ok: boolean | null, detail = '') => {
  results.push({ name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === null ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const credentials = credentialsFromEnv();
if (!credentials) {
  console.error(
    'REVOLUTX_API_KEY and REVOLUTX_PRIVATE_KEY must be set.\n\n' +
      'To obtain them:\n' +
      '  1. Generate an Ed25519 keypair.\n' +
      '  2. Revolut X → Profile → API Keys → add the public key.\n' +
      '  3. Create the key with "Allow usage via Revolut X MCP and CLI" ticked.\n' +
      '  4. Export the API key and the PEM private key as the two variables above.\n',
  );
  process.exit(2);
}

const baseUrl = process.env.REVOLUTX_BASE_URL || WIRE.defaultBaseUrl;
console.log(`Probing ${baseUrl} (read-only)\n`);

const transport = new HttpTransport(credentials, baseUrl);
const venue = new RevolutXVenue(transport, 'live');
const marketData = new RevolutXMarketData(transport);

// ---------------------------------------------------------------- instruments
let symbol: string = process.env.REVOLUTX_SYMBOL || '';

try {
  const instruments = await venue.instruments();
  note('Instrument list reachable', instruments.size > 0, `${instruments.size} tradeable pairs`);

  if (instruments.size > 0) {
    const [first] = instruments.values();
    symbol = symbol && instruments.has(symbol) ? symbol : first.symbol;

    note('Instrument has a tick size', first.tick_size > 0, String(first.tick_size));
    note('Instrument has a lot size', first.lot_size > 0, String(first.lot_size));
    note(
      'Instrument carries a fee rate',
      first.buy_fee_rate > 0,
      first.buy_fee_rate > 0
        ? String(first.buy_fee_rate)
        : 'ZERO — the cost basis will be wrong; check the fee field name in WIRE',
    );
  }
} catch (err) {
  note('Instrument list reachable', false, (err as Error).message);
  console.error('\nCannot continue without instruments. Check auth and the currencyPairs path in WIRE.\n');
  process.exit(1);
}

// --------------------------------------------------------------------- quotes
try {
  const quote = await marketData.quote(symbol);
  if (!quote) {
    note('Quote available', false, `no two-sided quote for ${symbol} — check the ticker field names`);
  } else {
    note('Quote available', true, `${symbol} ${quote.bid} / ${quote.ask}`);
    note('Quote is two-sided and uncrossed', quote.bid > 0 && quote.ask >= quote.bid);
    note('Quote carries our receive clock', Boolean(Date.parse(quote.receivedAt)));

    const skewMs = Math.abs(Date.parse(quote.timestamp) - Date.parse(quote.receivedAt));
    note(
      'Venue clock skew is modest',
      skewMs < 60_000,
      `${Math.round(skewMs / 1000)}s — staleness is measured on our clock, so large skew is tolerable but worth knowing`,
    );
  }
} catch (err) {
  note('Quote available', false, (err as Error).message);
}

// -------------------------------------------------------------- open orders
try {
  const open = await venue.openOrders();
  note('Open orders reachable', true, `${open.length} live`);

  if (open.length === 0) {
    note('Open order field mapping', null, 'no live orders to inspect — re-run with one resting to verify');
  } else {
    const sample = open[0];
    note('Open order exposes clientOrderId', Boolean(sample.clientOrderId),
      sample.clientOrderId || 'MISSING — idempotency and fill attribution both depend on this');
    note('Open order exposes venueOrderId', Boolean(sample.venueOrderId), sample.venueOrderId);
    note('Open order status maps to a live state',
      ['working', 'partially_filled', 'pending'].includes(sample.status), sample.status);
  }
} catch (err) {
  note('Open orders reachable', false, (err as Error).message);
}

// -------------------------------------------------------- lookup by client id
try {
  const missing = await venue.get('coid-probe-definitely-does-not-exist');
  note('Unknown clientOrderId returns null, not an error', missing === null,
    missing === null ? '' : 'the recovery path depends on this distinction');
} catch (err) {
  note('Unknown clientOrderId returns null, not an error', false,
    `threw instead: ${(err as Error).message} — check that a 404 maps to code http_404`);
}

// --------------------------------------------------------------------- fills
try {
  const { fills, cursor } = await venue.fillsSince(null);
  note('Fill history reachable', true, `${fills.length} fills, cursor ${cursor}`);

  if (fills.length === 0) {
    note('Fill field mapping', null, 'no fill history on this account — re-run after a trade to verify');
  } else {
    const sample = fills[0];
    note('Fill attributes to a clientOrderId', Boolean(sample.clientOrderId),
      sample.clientOrderId || 'MISSING — fills cannot be matched to orders');
    note('Fill has a stable id', Boolean(sample.venueFillId), sample.venueFillId);
    note('Fill has positive quantity and price', sample.quantity > 0 && sample.price > 0,
      `${sample.quantity} @ ${sample.price}`);
    note('Fill carries a fee', sample.fee > 0,
      sample.fee > 0 ? String(sample.fee) : 'ZERO — if fees are real, the cost basis will be understated');

    // A bounded tail replaying is BY DESIGN, not a fault. The cursor is a scan
    // bound, not an exactness guarantee: fills are deduplicated on venueFillId
    // upstream, and re-sending one costs nothing while missing one corrupts the
    // position permanently. What must hold is that catch-up TERMINATES — the
    // cursor advances and the replayed set stays small rather than growing into
    // the whole history.
    const second = await venue.fillsSince(cursor);
    const firstIds = new Set(fills.map((f) => f.venueFillId));
    const replayed = second.fills.filter((f) => firstIds.has(f.venueFillId)).length;

    note('Cursor advances', Number(second.cursor) >= Number(cursor), `${cursor} -> ${second.cursor}`);
    note(
      'Catch-up terminates (replay is a bounded tail, not the full history)',
      replayed <= Math.max(1, Math.ceil(fills.length * 0.5)),
      `${replayed}/${fills.length} replayed — a small tail is expected and is deduplicated upstream`,
    );
  }
} catch (err) {
  note('Fill history reachable', false, (err as Error).message);
}

// ------------------------------------------------------------------- summary
await marketData.close();
await venue.close();

const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null);

console.log(
  `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
);

if (failed.length > 0) {
  console.log('\nEvery failure above is a wire-format mismatch. Fix them in the WIRE block of');
  console.log('server/market/revolutx.ts — the domain mapping below it should not need to change.');
  console.log('\nDO NOT set EXECUTION_MODE=live until this run is clean.');
  process.exit(1);
}

if (skipped.length > 0) {
  console.log('\nSome checks had no data to inspect. Re-run with a resting order and some fill');
  console.log('history to verify those mappings before going live.');
}

console.log('\nRead paths verified. Placement still needs a small live test with a minimum-size');
console.log('order before you trust it with size.');
