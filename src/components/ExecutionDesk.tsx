import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  FlaskConical,
  Gauge,
  Play,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { User, ToastMessage } from '../types';
import { api, ApiError } from '../lib/api';

// ---------------------------------------------------------------- types
interface Instrument {
  symbol: string;
  name: string;
  asset_class: string;
  tick_size: number;
  lot_size: number;
  min_quantity: number;
  buy_fee_rate: number;
  sell_fee_rate: number;
  is_guaranteed: boolean;
  fundamentals_intact: boolean;
}

interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  receivedAt: string;
  source: string;
}

interface Position {
  symbol: string;
  quantity: number;
  averageCost: number;
  realisedPnl: number;
  feesPaid: number;
  cashFlow: number;
  fillCount: number;
}

interface Plan {
  action: 'place_order' | 'hold';
  side?: 'buy' | 'sell';
  quantity?: number;
  type?: 'market' | 'limit';
  limitPrice?: number;
  timeInForce?: 'gtc' | 'ioc' | 'fok';
  reason: string;
  zeroLossSatisfied: boolean;
}

interface Order {
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  type: string;
  limitPrice?: number;
  status: string;
  filledQuantity: number;
  averageFillPrice: number;
  feesPaid: number;
  createdAt: string;
  actorName: string | null;
  rejectReason?: string | null;
}

interface FillRow {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fee: number;
  timestamp: string;
}

interface RiskState {
  halted: boolean;
  haltReason?: string;
  maxOrderNotional: number;
  maxDailyNotional: number;
  maxPositionNotional: number;
  maxQuoteAgeMs: number;
  dailyNotionalUsed: number;
}

interface DeskRow {
  instrument: Instrument;
  quote: Quote | null;
  position: Position;
  unrealisedPnl: number;
  plan: Plan;
}

interface DeskState {
  mode: 'paper' | 'live';
  venue: string;
  dataSource: string;
  risk: RiskState;
  lastReconciliation: {
    ranAt: string;
    fillsReplayed: number;
    ordersUpdated: number;
    discrepancies: { clientOrderId: string; issue: string }[];
  } | null;
  rows: DeskRow[];
  orders: Order[];
  fills: FillRow[];
}

// ---------------------------------------------------------------- helpers
const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const signed = (n: number) => `${n >= 0 ? '+' : ''}${usd(n)}`;

const STATUS_STYLE: Record<string, string> = {
  pending: 'text-amber-300 border-amber-500/40 bg-amber-950/40',
  working: 'text-cyan-300 border-cyan-500/40 bg-cyan-950/40',
  partially_filled: 'text-cyan-200 border-cyan-400/50 bg-cyan-950/60',
  filled: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40',
  cancelled: 'text-zinc-400 border-zinc-700 bg-zinc-900',
  rejected: 'text-red-300 border-red-500/50 bg-red-950/50',
  expired: 'text-zinc-400 border-zinc-700 bg-zinc-900',
};

const TRADE_ROLES = ['Executive', 'Arbitrage Trader', 'System Admin'];
const RESUME_ROLES = ['Executive', 'System Admin'];

interface Props {
  user: User | null;
  onOpenAuth: () => void;
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
}

export const ExecutionDesk: React.FC<Props> = ({ user, onOpenAuth, addToast }) => {
  const [state, setState] = useState<DeskState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const canTrade = Boolean(user && TRADE_ROLES.includes(user.role));
  const canResume = Boolean(user && RESUME_ROLES.includes(user.role));

  const load = useCallback(async () => {
    try {
      const data = await api.get<DeskState>('/api/execution/state');
      setState(data);
      setSelected((cur) => cur ?? data.rows[0]?.instrument.symbol ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the desk.');
    }
  }, []);

  // Quotes and fills move on their own; poll rather than pretending it is static.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const selectedRow = useMemo(
    () => state?.rows.find((r) => r.instrument.symbol === selected) ?? null,
    [state, selected],
  );

  const act = async (label: string, fn: () => Promise<void>) => {
    if (!user) {
      onOpenAuth();
      return;
    }
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed.';
      setError(message);
      addToast?.({
        type: err instanceof ApiError && err.status === 409 ? 'warning' : 'error',
        title: err instanceof ApiError && err.status === 409 ? 'Refused by risk controls' : 'Request failed',
        description: message,
        duration: 7000,
      });
    } finally {
      setBusy(null);
    }
  };

  const executePlan = (row: DeskRow) =>
    act('plan', async () => {
      const { plan, instrument } = row;
      if (plan.action !== 'place_order') return;
      const result = await api.post<{ order: Order; resolvedAfterFailure: string | null }>(
        '/api/execution/order',
        {
          symbol: instrument.symbol,
          side: plan.side,
          quantity: plan.quantity,
          type: plan.type,
          limitPrice: plan.limitPrice,
          timeInForce: plan.timeInForce,
          reason: `strategy: ${plan.reason.slice(0, 120)}`,
        },
      );
      addToast?.({
        type: 'success',
        title: `Order ${result.order.status}`,
        description: `${plan.side} ${plan.quantity} ${instrument.symbol}${
          result.resolvedAfterFailure ? ' — recovered after a venue failure' : ''
        }`,
      });
    });

  const cancelOrder = (clientOrderId: string) =>
    act(clientOrderId, async () => {
      await api.post(`/api/execution/order/${clientOrderId}/cancel`);
    });

  const toggleHalt = () =>
    act('halt', async () => {
      if (state?.risk.halted) {
        await api.post('/api/execution/resume');
        addToast?.({ type: 'success', title: 'Trading resumed', description: 'Risk controls released.' });
      } else {
        await api.post('/api/execution/halt', { reason: 'Halted from the execution desk.' });
        addToast?.({
          type: 'warning',
          title: 'Trading halted',
          description: 'All execution is refused until resumed.',
        });
      }
    });

  const reconcile = () =>
    act('reconcile', async () => {
      const { report } = await api.post<{ report: DeskState['lastReconciliation'] }>(
        '/api/execution/reconcile',
      );
      addToast?.({
        type: (report?.discrepancies.length ?? 0) > 0 ? 'warning' : 'success',
        title: 'Reconciliation complete',
        description: `${report?.fillsReplayed ?? 0} fills replayed, ${report?.discrepancies.length ?? 0} discrepancies.`,
      });
    });

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950 text-xs text-zinc-500 font-mono">
        {error ?? 'Loading execution desk…'}
      </div>
    );
  }

  const working = state.orders.filter(
    (o) => !['filled', 'cancelled', 'rejected', 'expired'].includes(o.status),
  );

  return (
    <div className="flex-1 p-4 md:p-6 space-y-5 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      {/* Halt banner. The kill switch must be impossible to miss. */}
      {state.risk.halted && (
        <div className="p-3 rounded-xl bg-red-950/70 border border-red-500/60 text-red-100 flex items-start gap-2.5">
          <Ban className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="text-xs font-sans">
            <strong className="font-bold">Execution halted.</strong>{' '}
            {state.risk.haltReason ?? 'All order placement is refused.'}
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200">
        <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-[11px] font-sans leading-relaxed">
          <strong className="font-bold">Paper mode, simulated venue.</strong> Quotes come from the built-in
          simulator and orders reach a simulated venue that partially fills, rejects and occasionally drops
          the connection on purpose. No order reaches a real market.
        </p>
      </div>

      {/* Header */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-950 border border-cyan-500/40 text-cyan-400">
              <Gauge className="w-6 h-6" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-100">Execution desk</h2>
              <p className="text-[11px] text-zinc-400 font-sans">
                Venue <span className="text-zinc-200">{state.venue}</span> · mode{' '}
                <span className="text-zinc-200">{state.mode}</span> · data{' '}
                <span className="text-zinc-200">{state.dataSource}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void reconcile()}
              disabled={!canResume || busy === 'reconcile'}
              title={canResume ? 'Reconcile against the venue' : 'Requires Executive or System Admin'}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs text-zinc-300 border border-zinc-700 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy === 'reconcile' ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>Reconcile</span>
            </button>

            <button
              type="button"
              onClick={() => void toggleHalt()}
              disabled={busy === 'halt' || (state.risk.halted ? !canResume : !canTrade)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors ${
                state.risk.halted
                  ? 'bg-emerald-700 hover:bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-red-700 hover:bg-red-600 border-red-500 text-white'
              }`}
            >
              {state.risk.halted ? (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Ban className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{state.risk.halted ? 'Resume trading' : 'Halt trading'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 pt-3 border-t border-zinc-800/80 text-[11px]">
          <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Daily notional</div>
            <div className="text-zinc-100 font-bold">
              {usd(state.risk.dailyNotionalUsed)}{' '}
              <span className="text-zinc-500 font-normal">/ {usd(state.risk.maxDailyNotional)}</span>
            </div>
          </div>
          <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Max order</div>
            <div className="text-zinc-100 font-bold">{usd(state.risk.maxOrderNotional)}</div>
          </div>
          <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Max position</div>
            <div className="text-zinc-100 font-bold">{usd(state.risk.maxPositionNotional)}</div>
          </div>
          <div className="bg-zinc-950 p-2.5 rounded-lg border border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase">Quote staleness gate</div>
            <div className="text-zinc-100 font-bold">{state.risk.maxQuoteAgeMs} ms</div>
          </div>
        </div>

        {state.lastReconciliation && (
          <div className="mt-3 text-[10px] text-zinc-500 font-sans">
            Last reconciliation {new Date(state.lastReconciliation.ranAt).toLocaleTimeString()} —{' '}
            {state.lastReconciliation.fillsReplayed} fills replayed,{' '}
            {state.lastReconciliation.ordersUpdated} orders updated,{' '}
            <span
              className={state.lastReconciliation.discrepancies.length > 0 ? 'text-amber-400 font-bold' : ''}
            >
              {state.lastReconciliation.discrepancies.length} discrepancies
            </span>
            .
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-950/60 border border-red-600/50 text-red-200 text-xs font-sans flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Instruments */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-3">
          {state.rows.map((row) => {
            const isSelected = selected === row.instrument.symbol;
            const q = row.quote;
            const actionable = row.plan.action === 'place_order';

            return (
              <div
                key={row.instrument.symbol}
                onClick={() => setSelected(row.instrument.symbol)}
                className={`p-4 rounded-xl border transition-all cursor-pointer ${
                  isSelected ? 'bg-zinc-900 border-emerald-500/50' : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-zinc-100 truncate">{row.instrument.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 shrink-0">
                      {row.instrument.symbol}
                    </span>
                  </div>
                  {q && (
                    <div className="text-[11px] font-mono flex items-center gap-2 shrink-0">
                      <span className="text-zinc-500">bid</span>
                      <span className="text-emerald-400 font-bold">{q.bid.toFixed(4)}</span>
                      <span className="text-zinc-500">ask</span>
                      <span className="text-rose-400 font-bold">{q.ask.toFixed(4)}</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] mb-3">
                  <div>
                    <div className="text-[10px] text-zinc-500">Position</div>
                    <div className={row.position.quantity === 0 ? 'text-zinc-500' : 'text-zinc-100 font-bold'}>
                      {row.position.quantity.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Avg cost</div>
                    <div className="text-zinc-300">
                      {row.position.quantity === 0 ? '—' : row.position.averageCost.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Unrealised</div>
                    <div className={row.unrealisedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {row.position.quantity === 0 ? '—' : signed(row.unrealisedPnl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Realised</div>
                    <div className={row.position.realisedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {signed(row.position.realisedPnl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-500">Fees</div>
                    <div className="text-zinc-400">{usd(row.position.feesPaid)}</div>
                  </div>
                </div>

                <div
                  className={`p-2.5 rounded-lg border text-[11px] flex items-start justify-between gap-3 ${
                    actionable
                      ? row.plan.zeroLossSatisfied
                        ? 'bg-emerald-950/40 border-emerald-500/40'
                        : 'bg-red-950/40 border-red-500/40'
                      : 'bg-zinc-950 border-zinc-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div
                      className={`font-bold ${
                        actionable ? (row.plan.zeroLossSatisfied ? 'text-emerald-300' : 'text-red-300') : 'text-zinc-400'
                      }`}
                    >
                      {actionable
                        ? `${row.plan.side?.toUpperCase()} ${row.plan.quantity} ${row.plan.type === 'limit' ? `@ ${row.plan.limitPrice}` : '@ market'}`
                        : 'HOLD'}
                    </div>
                    <p className="text-zinc-400 font-sans mt-0.5">{row.plan.reason}</p>
                  </div>

                  {actionable && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void executePlan(row);
                      }}
                      disabled={busy !== null || state.risk.halted || !canTrade}
                      title={
                        state.risk.halted
                          ? 'Trading is halted'
                          : canTrade
                            ? 'Place this order'
                            : 'Your role cannot place orders'
                      }
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:cursor-not-allowed text-white text-[11px] font-bold cursor-pointer"
                    >
                      {busy === 'plan' ? 'Placing…' : 'Execute'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Working orders + fills */}
        <div className="space-y-5">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" aria-hidden="true" />
              <span>Working orders ({working.length})</span>
            </h3>

            {working.length === 0 ? (
              <p className="text-[11px] text-zinc-500 font-sans text-center py-4">Nothing working.</p>
            ) : (
              <ul className="space-y-2">
                {working.map((order) => (
                  <li key={order.clientOrderId} className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-[11px] font-bold text-zinc-200 truncate">
                        {order.side.toUpperCase()} {order.quantity} {order.symbol}
                      </span>
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded border font-bold shrink-0 ${
                          STATUS_STYLE[order.status] ?? 'text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {order.status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-zinc-500">
                        filled {order.filledQuantity}/{order.quantity}
                        {order.averageFillPrice > 0 && ` @ ${order.averageFillPrice.toFixed(4)}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => void cancelOrder(order.clientOrderId)}
                        disabled={busy !== null || !canTrade}
                        className="text-[10px] text-zinc-400 hover:text-red-300 flex items-center gap-1 cursor-pointer disabled:opacity-40"
                      >
                        <X className="w-3 h-3" aria-hidden="true" />
                        cancel
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>Recent fills</span>
            </h3>

            {state.fills.length === 0 ? (
              <p className="text-[11px] text-zinc-500 font-sans text-center py-4">No fills yet.</p>
            ) : (
              <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                {state.fills.slice(0, 20).map((fill) => (
                  <li
                    key={fill.id}
                    className="flex items-center justify-between gap-2 text-[10px] p-2 rounded bg-zinc-950 border border-zinc-800"
                  >
                    <span
                      className={`font-bold shrink-0 ${fill.side === 'buy' ? 'text-cyan-400' : 'text-emerald-400'}`}
                    >
                      {fill.side.toUpperCase()}
                    </span>
                    <span className="text-zinc-300 flex-1 truncate">
                      {fill.quantity} @ {fill.price.toFixed(4)}
                    </span>
                    <span className="text-zinc-500 shrink-0">fee {fill.fee.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {selectedRow && (
            <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl text-[11px] space-y-1.5">
              <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-2 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" aria-hidden="true" />
                <span>Instrument rules</span>
              </h3>
              {[
                ['Tick size', selectedRow.instrument.tick_size],
                ['Lot size', selectedRow.instrument.lot_size],
                ['Min quantity', selectedRow.instrument.min_quantity],
                ['Buy fee', `${(selectedRow.instrument.buy_fee_rate * 100).toFixed(2)}%`],
                ['Sell fee', `${(selectedRow.instrument.sell_fee_rate * 100).toFixed(2)}%`],
                ['Guaranteed', selectedRow.instrument.is_guaranteed ? 'yes' : 'no'],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between">
                  <span className="text-zinc-500">{label}</span>
                  <span className="text-zinc-300">{String(value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
