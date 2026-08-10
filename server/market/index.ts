/**
 * Trading runtime wiring.
 *
 * Chooses the venue and data source, builds the instrument universe, runs
 * boot-time reconciliation, and drives the fill-ingestion loop. One place so
 * that swapping in a live venue is a change here and nowhere else.
 */

import type { Store, TenantId } from '../store/types';
import { ExecutionService, type ReconciliationReport } from './execution';
import { RiskController, limitsFromEnv } from './risk';
import { SimulatedMarketData, SimulatedVenue, REALISTIC, CALM, type SimulatorBehaviour } from './simulated';
import { HttpTransport, RevolutXVenue, RevolutXMarketData, credentialsFromEnv } from './revolutx';
import type { ExecutionVenue, MarketDataSource } from './venue';
import type { Instrument } from './types';

export * from './types';
export * from './venue';
export { ExecutionService } from './execution';
export { RiskController, assess, DEFAULT_LIMITS, type RiskLimits, type RiskVerdict } from './risk';
export { plan, DEFAULT_STRATEGY, netProceedsPerUnit, type StrategyPolicy } from './strategy';
export { derivePosition, applyFill, unrealisedPnl, reconciles, remainingQuantity } from './ledger';
export { RevolutXVenue, RevolutXMarketData, HttpTransport, credentialsFromEnv, WIRE } from './revolutx';

/**
 * Instrument universe.
 *
 * Derived from the seeded assets for now so the existing modules keep working.
 * When a real venue arrives this comes from its instrument endpoint instead —
 * which is why nothing outside this file constructs an `Instrument`.
 */
export async function loadInstruments(store: Store, tenantId: TenantId): Promise<Map<string, Instrument>> {
  const assets = await store.assets.list(tenantId);
  const map = new Map<string, Instrument>();

  for (const a of assets) {
    map.set(a.asset_id, {
      symbol: a.asset_id,
      name: a.name,
      asset_class: a.asset_class,
      // Sensible defaults until a venue tells us otherwise.
      tick_size: 0.01,
      lot_size: 1,
      min_quantity: 1,
      buy_fee_rate: a.buy_fees,
      sell_fee_rate: a.sell_fees,
      is_guaranteed: a.is_guaranteed,
      fundamentals_intact: a.fundamentals_intact,
      simulated: a.simulated ?? true,
    });
  }

  return map;
}

export interface TradingRuntime {
  tenantId: TenantId;
  execution: ExecutionService;
  risk: RiskController;
  venue: ExecutionVenue;
  marketData: MarketDataSource;
  instruments: Map<string, Instrument>;
  lastReconciliation: ReconciliationReport | null;
  stop(): Promise<void>;
}

function behaviourFromEnv(): SimulatorBehaviour {
  return process.env.SIM_BEHAVIOUR === 'calm' ? CALM : REALISTIC;
}

export async function startTradingRuntime(store: Store, tenantId: TenantId): Promise<TradingRuntime> {
  const instruments = await loadInstruments(store, tenantId);

  const seeds: Record<string, number> = {};
  for (const asset of await store.assets.list(tenantId)) {
    seeds[asset.asset_id] = asset.active_offer ?? asset.current_price;
  }

  const wantsLive = process.env.EXECUTION_MODE === 'live';
  const venueName = (process.env.VENUE || 'simulated').toLowerCase();

  let venue: ExecutionVenue;
  let marketData: MarketDataSource;
  let activeInstruments = instruments;

  if (venueName === 'revolutx') {
    const credentials = credentialsFromEnv();
    if (!credentials) {
      throw new Error(
        'VENUE=revolutx requires REVOLUTX_API_KEY and REVOLUTX_PRIVATE_KEY. ' +
          'See .env.example, and run `npm run verify:venue` before going live.',
      );
    }

    const transport = new HttpTransport(credentials, process.env.REVOLUTX_BASE_URL || undefined);
    const rx = new RevolutXVenue(transport, wantsLive ? 'live' : 'paper', {
      marketSlippageAllowance: Number(process.env.REVOLUTX_SLIPPAGE) || undefined,
    });

    // The venue's own instrument definitions replace the seeded ones: tick and
    // lot sizes must come from the venue, or orders get rejected on precision.
    activeInstruments = await rx.instruments();
    venue = rx;
    marketData = new RevolutXMarketData(transport, Number(process.env.REVOLUTX_POLL_MS) || 2000);

    if (!wantsLive) {
      // Reading a real venue while writing nowhere is a genuinely useful mode —
      // real prices and real instruments, no orders. But it must be impossible
      // to mistake for live, so it is stated at boot and surfaced in the UI.
      console.warn(
        '[trading] VENUE=revolutx with EXECUTION_MODE unset — real market data, but orders WILL be sent ' +
          'to Revolut X. Set EXECUTION_MODE=live only after `npm run verify:venue` passes.',
      );
    }
  } else {
    if (wantsLive) {
      // Live is deliberately awkward: it needs an actual venue, not just a flag.
      throw new Error(
        'EXECUTION_MODE=live is set but VENUE is not a live adapter. ' +
          'Set VENUE=revolutx (with credentials) or unset EXECUTION_MODE.',
      );
    }
    // Each tenant gets its own price series and its own simulated venue: two
    // tenants must never share an order book, even in simulation, or the
    // isolation tests would pass for the wrong reason.
    const seedNum = Array.from(tenantId).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const sim = new SimulatedMarketData(seeds, 8, seedNum);
    marketData = sim;
    venue = new SimulatedVenue(instruments, (s) => sim.lastPrice(s), behaviourFromEnv(), seedNum);
  }

  const execution = new ExecutionService(store, venue, marketData, tenantId);
  const risk = new RiskController(limitsFromEnv());

  // A live venue starts halted unless the operator explicitly says otherwise.
  // Booting straight into a state where an automated strategy can transact is
  // not a default anyone should get by accident.
  if (venue.mode === 'live' && process.env.RISK_START_HALTED !== 'false') {
    risk.halt('Live venue booted halted by default. Resume explicitly once you have checked the book.');
  }

  const runtime: TradingRuntime = {
    tenantId,
    execution,
    risk,
    venue,
    marketData,
    instruments: activeInstruments,
    lastReconciliation: null,
    stop: async () => {
      clearInterval(fillTimer);
      clearInterval(tickTimer);
      await venue.close();
      await marketData.close();
    },
  };

  // Boot-time reconciliation. Any disagreement with the venue is recorded to
  // the audit chain, and a material one halts trading rather than guessing.
  try {
    const report = await execution.reconcile();
    runtime.lastReconciliation = report;

    if (report.fillsReplayed > 0 || report.ordersUpdated > 0 || report.discrepancies.length > 0) {
      await store.audit.append(tenantId, {
        event: 'execution.reconciled',
        actorId: null,
        actorName: 'system',
        actorRole: null,
        subject: venue.id,
        outcome: report.discrepancies.length > 0 ? 'refused' : 'info',
        detail: { ...report },
      });
    }

    if (report.discrepancies.length > 0) {
      risk.halt(
        `Reconciliation found ${report.discrepancies.length} discrepancy(ies) against the venue. Trading halted pending review.`,
      );
      console.error('[trading] HALTED — reconciliation discrepancies:', report.discrepancies);
    }
  } catch (err) {
    risk.halt('Boot reconciliation failed; trading halted until the venue can be reached.');
    console.error('[trading] reconciliation failed:', err);
  }

  // Drive the simulator and pull fills. With a real venue the tick disappears
  // and only the ingestion loop remains.
  // Only the simulator needs driving; a real venue fills on its own.
  const tickTimer = setInterval(() => {
    if (venue instanceof SimulatedVenue) void venue.tick().catch(() => undefined);
  }, 1500);
  tickTimer.unref?.();

  const fillTimer = setInterval(() => {
    void execution.ingestFills().catch((err) => console.error('[trading] fill ingestion failed:', err));
  }, 2000);
  fillTimer.unref?.();

  return runtime;
}
