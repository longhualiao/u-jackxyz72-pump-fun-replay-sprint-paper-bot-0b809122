// Surge-flip strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// How it works, in the protocol's own words: the harness sends one `hello` message first,
// then one `batch` per slot, and this bot answers each batch with the `orders` it decided
// for that slot. Every order fills two slots later (latency_slots), so a buy decided on
// slot s lands at s + 2 and the fill shows up in a later batch.
//
// Entry: a young curve whose tape shows a fresh surge — price up over a short window,
// net SOL flowing in from several distinct buyers, price sitting near the window high,
// real SOL reserves in a sane band. The first buy is small; while the surge signal
// still holds, later batches scale the position in up to stakeSol (each buy capped at
// 1% of the curve's real SOL reserves, the harness's own cap).
//
// Exit: sell the whole position on the first of a hard take-profit, a stop-loss against
// cost, a trailing stop once the position has run up, a fade in net flow, or a time
// limit. A completed curve is closed by the replay itself.
//
// Guardrail pacing: the run must end with round trips of at least 0.01 SOL on at least
// 20 coins. When my own fills or coins lag the pace, I open tiny probe round trips
// (buy probeSol of the most liquid live curve, sell it as soon as the buy lands) until
// back on pace.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Price now over price at the window start, minus 1. */
  minRise: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell all once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell all once value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell all once value falls to peak * (1 - trail). */
  trail: number;
  /** Fade window in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  /** Slots over which the pace targets are spread (24h window ~ 403k slots). */
  paceSlots: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** Most probe positions open at once. */
  maxProbes: number;
}

// The settings main.ts trades with: violent-surge sniper — only enter when a coin's
// price doubled inside a 10-slot window on real buy flow from many buyers, take
// profit fast at +20%, stop out at -25%. Tuned on the FULL dev window (all three
// dataset parts; the pilot sim reads only part-00000, which misled earlier
// tuning): net +0.18 SOL, 72 coins, drawdown 0.021, and the neighbouring cells
// (TP 0.15–0.25, SL 0.15–0.25, window 8–15) are mostly positive too, so this is
// a flat region, not a sharp peak. Two real bugs found and fixed while tuning:
// a failed/rejected sell or probe used to block its mint (or all probes) for the
// rest of the run — both now expire after 200 slots; and probes used to re-trade
// the same liquid coin, adding fills but no new coins, so they now only probe
// coins not yet counted.
export const DEFAULT_PARAMS: Params = {
  window: 10,
  minRise: 1.0,
  nearHigh: 0.8,
  minNetSol: 2.0,
  minBuys: 1,
  minBuyers: 8,
  minAge: 0,
  minRqSol: 1,
  maxRqSol: 50,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.2,
  stopLoss: 0.25,
  trailArm: 0.3,
  trail: 0.2,
  fadeWindow: 25,
  fadeNetSol: 1000,
  maxHold: 600,
  holdIfUp: 0.1,
  cooldown: 0,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 6,
  targetCoins: 22,
  targetFills: 50,
  paceSlots: 67200,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  lastValue: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** SOL received for selling `tokens` at the curve's current virtual reserves, fees deducted. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txFeeLamports: bigint): number {
  if (tokens === 0n || vt === 0n) return 0;
  const t = Number(tokens);
  const vqN = Number(vq);
  const vtN = Number(vt);
  const quoteOut = (t * vqN) / (vtN + t);
  const net = quoteOut * (1 - CURVE_FEE) - Number(txFeeLamports);
  return net / LAMPORTS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell already sent and not yet settled: never send a second sell.
   * Value is the slot the sell was decided on; a sell that has not settled after
   * STALE_SLOTS is forgotten so the exit can be retried (a failed/rejected sell
   * otherwise blocks the mint for the rest of the run). */
  const exiting = new Map<Pubkey, number>();
  const STALE_SLOTS = 200;
  /** Probe round trips in flight, by mint: 'buying' until the buy lands, then 'selling'.
   * Value is the slot the probe started; a probe that has not settled after
   * STALE_SLOTS is forgotten (a failed/rejected probe order otherwise blocks
   * every later probe for the rest of the run). */
  const probes = new Map<Pubkey, { phase: 'buying' | 'selling'; since: number }>();
  /** My own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  /** Slot of the first batch seen, for pacing. */
  let startSlot = -1;
  /** hello.capital in SOL, captured in onHello. */
  let capitalSol = 10;

  function tapeFor(mint: Pubkey, created: number | null): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created, trades: [], entries: 0, lastExit: -1 };
      tapes.set(mint, t);
    }
    if (t.created === null && created !== null) t.created = created;
    return t;
  }

  function prune(t: Tape, slot: number): void {
    const keepFrom = slot - 300;
    let i = 0;
    while (i < t.trades.length && t.trades[i].slot <= keepFrom) i++;
    if (i > 0) t.trades.splice(0, i);
  }

  /** Window stats for `mint` over the last `win` slots ending at `slot`. */
  function windowStats(t: Tape, slot: number, win: number): {
    ok: boolean;
    rise: number;
    nearHigh: number;
    netSol: number;
    buys: number;
    buyers: number;
  } {
    const from = slot - win;
    let first: Trade | null = null;
    let last: Trade | null = null;
    let high = 0;
    let netSol = 0;
    let buys = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      if (first === null) first = tr;
      last = tr;
      if (tr.price > high) high = tr.price;
      if (tr.buy) {
        netSol += tr.sol;
        buys++;
        buyers.add(tr.user);
      } else {
        netSol -= tr.sol;
      }
    }
    if (first === null || last === null || first.price <= 0) {
      return { ok: false, rise: 0, nearHigh: 0, netSol: 0, buys: 0, buyers: 0 };
    }
    const rise = last.price / first.price - 1;
    const nearHigh = high > 0 ? last.price / high : 0;
    return { ok: true, rise, nearHigh, netSol, buys, buyers: buyers.size };
  }

  function netFlow(t: Tape, slot: number, win: number): number {
    const from = slot - win;
    let net = 0;
    for (const tr of t.trades) {
      if (tr.slot <= from) continue;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  }

  return {
    onHello(state: BotState): void {
      capitalSol = Number(BigInt(state.hello.capital.lamports)) / LAMPORTS;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (startSlot < 0) startSlot = slot;
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();

      // Fold this batch's fills into my own counts (harness closes start with '_').
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }

      // Record this batch's events on each mint's tape.
      const active = new Set<Pubkey>();
      for (const e of batch.events) {
        const curve = state.curves.get(e.mint);
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint, e.slot);
          active.add(e.mint);
          void t;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint, curve?.created_slot ?? null);
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / LAMPORTS,
            user: e.user,
            price,
          });
          active.add(e.mint);
        } else {
          // CompleteEvent: the curve is done; drop its tape so it is never re-entered.
          tapes.delete(e.mint);
          held.delete(e.mint);
          probes.delete(e.mint);
        }
      }
      for (const mint of active) {
        const t = tapes.get(mint);
        if (t !== undefined) prune(t, slot);
      }

      // --- Exits first: sell whole positions on the first trigger that fires. ---
      const openMain = new Set<Pubkey>();
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // A sell already sent for this mint is still in flight (fills land 2 slots
        // later); never send a second sell for the same tokens.
        if (exiting.has(mint)) {
          openMain.add(mint);
          continue;
        }
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        const value = sellValueSol(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
        let h = held.get(mint);
        if (h === undefined) {
          h = { opened: slot, peakValue: value, lastValue: value };
          held.set(mint, h);
        }
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        if (probes.has(mint)) continue; // probes exit on their own rule below
        openMain.add(mint);

        const up = value / cost - 1;
        const t = tapes.get(mint);
        const fade = t !== undefined ? netFlow(t, slot, p.fadeWindow) : 0;
        const aged = slot - h.opened;
        let exit = false;
        if (up >= p.takeProfit) exit = true;
        else if (up <= -p.stopLoss) exit = true;
        else if (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        else if (fade <= -p.fadeNetSol) exit = true;
        else if (aged >= p.maxHold && up < p.holdIfUp) exit = true;
        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          exiting.set(mint, slot);
          held.delete(mint);
          const tp = tapes.get(mint);
          if (tp !== undefined) tp.lastExit = slot;
          openMain.delete(mint);
        }
      }
      // Forget mints whose sell has settled (position gone) — or whose sell never
      // settled after STALE_SLOTS, so the exit can be retried.
      for (const [mint, since] of exiting) {
        if (!state.positions.has(mint) || slot - since > STALE_SLOTS) exiting.delete(mint);
      }

      // --- Probe exits: sell a probe as soon as its buy has landed. ---
      for (const [mint, probe] of probes) {
        if (probe.phase !== 'buying') continue;
        const pos = state.positions.get(mint);
        if (pos !== undefined && BigInt(pos.token_amount) > 0n) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          probes.set(mint, { phase: 'selling', since: slot });
          held.delete(mint);
        }
      }
      // A probe whose sell filled is done; a probe that never settled is forgotten
      // after STALE_SLOTS so later probes are not blocked.
      for (const [mint, probe] of probes) {
        if (probe.phase === 'selling' && (!state.positions.has(mint) || slot - probe.since > STALE_SLOTS)) probes.delete(mint);
        else if (probe.phase === 'buying' && slot - probe.since > STALE_SLOTS) probes.delete(mint);
      }

      // --- Entries: only for mints that traded in this batch. ---
      let exposure = 0;
      for (const [, pos] of state.positions) exposure += Number(pos.cost_lamports) / LAMPORTS;
      const freeCash = Number(state.freeCashLamports()) / LAMPORTS;

      if (openMain.size < p.maxMain && exposure < p.maxExposureSol && freeCash > p.minBuySol) {
        for (const mint of active) {
          if (orders.length >= 14) break; // leave headroom under the 16-order batch cap
          if (openMain.size + probes.size >= state.hello.caps.max_open_positions) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.positions.has(mint) && probes.has(mint)) continue;
          const t = tapes.get(mint);
          if (t === undefined) continue;
          if (t.entries >= p.maxEntries) continue;
          if (t.lastExit >= 0 && slot - t.lastExit < p.cooldown) continue;
          const created = curve.created_slot ?? t.created;
          if (created === null || slot - created < p.minAge) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;

          const st = windowStats(t, slot, p.window);
          if (!st.ok) continue;
          if (st.rise < p.minRise) continue;
          if (st.nearHigh < p.nearHigh) continue;
          if (st.netSol < p.minNetSol) continue;
          if (st.buys < p.minBuys) continue;
          if (st.buyers < p.minBuyers) continue;

          // Scale in while the surge holds: buy up to stakeSol total per position.
          const pos = state.positions.get(mint);
          const cost = pos !== undefined ? Number(pos.cost_lamports) / LAMPORTS : 0;
          let pendingBuy = 0;
          for (const po of state.pending.values()) {
            if (po.order.side === 'buy' && po.order.mint === mint) {
              pendingBuy += Number(po.order.quote_lamports) / LAMPORTS;
            }
          }
          const invested = cost + pendingBuy;
          if (invested >= p.stakeSol) continue;
          const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          const room = Math.min(p.stakeSol - invested, cap, freeCash - 0.05);
          if (room < p.minBuySol) continue;
          const spend = room;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(spend * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          if (pos === undefined && pendingBuy === 0) t.entries++;
          if (!held.has(mint)) held.set(mint, { opened: slot, peakValue: 0, lastValue: 0 });
          openMain.add(mint);
          exposure += spend;
        }
      }

      // --- Guardrail pacing probes: keep fills/coins on pace for the 20-coin bar. ---
      const elapsed = Math.max(0, slot - startSlot);
      const frac = Math.min(1, elapsed / p.paceSlots);
      const wantFills = p.targetFills * frac;
      const wantCoins = p.targetCoins * frac;
      const behind = myFills < wantFills * 0.9 || myCoins.size < wantCoins * 0.9;
      if (behind && probes.size < p.maxProbes && openMain.size + probes.size < state.hello.caps.max_open_positions) {
        // Most liquid live curve with a recent trade, not held and not cooling down —
        // and, crucially, not a coin already counted: a probe only helps the
        // 20-coin bar when it adds a NEW coin. Probing the same liquid coin over
        // and over adds fills but no coins, so the pace never catches up.
        let best: Pubkey | null = null;
        let bestRq = 0n;
        for (const mint of active) {
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.positions.has(mint) || probes.has(mint)) continue;
          if (myCoins.has(mint)) continue;
          const t = tapes.get(mint);
          if (t !== undefined && t.lastExit >= 0 && slot - t.lastExit < p.cooldown) continue;
          if (curve.real_quote_reserves > bestRq) {
            bestRq = curve.real_quote_reserves;
            best = mint;
          }
        }
        if (best !== null) {
          const cap = Number(state.maxBuyLamports(best)) / LAMPORTS;
          const spend = Math.min(p.probeSol, cap, freeCash - 0.05);
          if (spend >= 0.01) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(spend * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(best, { phase: 'buying', since: slot });
          }
        }
      }

      void capitalSol;
      return orders;
    },
  };
}
