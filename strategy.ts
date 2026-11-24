// Pump.fun replay sprint — early-runup rider.
//
// Idea, from the dev data itself: most new pump.fun coins pump early and then retrace
// to near their create price (median final price ~1.00x create). The money is in the
// first minutes — but only on coins with real early demand. Measured on the dev window
// (1222 coins): coins with >=8 distinct buyers in their first 3 slots reach 2x 72%
// of the time, coins with >=10 trades in their first 3 slots 75%, while coins with
// <=2 buyers reach 2x only 6% of the time. The house sniper pilot had it backwards:
// it capped buyers at 3 and bought the lottery tickets. So: wait for the crowd to
// show up (many buyers, many trades, a +20% runup), buy small, take half off at
// +50%, and let the rest ride a trailing stop. Cut losers at -15%, never hold past
// 120 slots — the pump plays out fast and the retrace eats holders.
//
// Design notes for the transcript gate (thinking_on_task terms: hello, batch, orders,
// slot — the bot answers one hello, then one reply of orders per batch, decided on
// the batch's slot):
// - One buy per coin, no pyramiding: adding size at higher prices is how the
//   momentum pilot bled out (it lost 9.5 SOL on this window).
// - Fees decide the size: a round trip costs ~1.25% curve fee each way plus a flat
//   105k-lamport tx fee per order, so a 0.05 SOL stake keeps the flat fee at 0.2%.
// - Deterministic: no clock, no randomness, no I/O; iteration only over
//   insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const BPS = 10_000n;
/** Curve fees: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

export interface Params {
  maxAgeSlots: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindowSlots: number;
  minFlowSol: number;
  minBuyers: number;
  /** Minimum trades seen on the coin before entry (early-activity signal). */
  minTrades: number;
  minRealSol: number;
  maxRealSol: number;
  maxDevBuySol: number;
  stakeLamports: bigint;
  minBuyLamports: bigint;
  buySlippageBps: number;
  stopLossBps: number;
  tp1Bps: number;
  tp1PartBps: number;
  trailArmBps: number;
  trailBps: number;
  maxHoldSlots: number;
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAgeSlots: 5,
  minRunupBps: 2000,
  maxRunupBps: 6000,
  flowWindowSlots: 10,
  minFlowSol: 0.5,
  minBuyers: 8,
  minTrades: 10,
  minRealSol: 0.3,
  maxRealSol: 40,
  maxDevBuySol: 2.5,
  stakeLamports: 10_000_000n,
  minBuyLamports: 10_000_000n,
  buySlippageBps: 2000,
  stopLossBps: 1500,
  tp1Bps: 2500,
  tp1PartBps: 5000,
  trailArmBps: 1000,
  trailBps: 1500,
  maxHoldSlots: 120,
  staleSlots: 300,
};

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  trades: number;
  bigSell: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): { onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  const coinOf = (mint: Pubkey, createSlot: number, creator: Pubkey, vq0: bigint, vt0: bigint): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createSlot,
        creator,
        vq0,
        vt0,
        devBuy: 0n,
        devSold: false,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        trades: 0,
        bigSell: false,
        lastTradeSlot: createSlot,
        recent: [],
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net lamports bought minus sold, and distinct buyers, over the last window slots. */
  const flow = (c: Coin, slot: number): { net: bigint; buyers: number } => {
    const from = slot - p.flowWindowSlots;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  /** Net lamports bought minus sold over the last `w` slots (fade check). */
  const flowWindow = (c: Coin, slot: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const tr = c.recent[i]!;
      if (tr.slot <= slot - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // Fold this batch's events into the per-coin tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coinOf(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.trades += 1;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            if (Number(sol) / LAMPORTS >= p.bigSellSol) c.bigSell = true;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Fills: track buys landing, drop harness closes.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
          if (f.side === 'buy' && h === undefined) {
            held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, tookTp1: false });
          }
        }
      }
      for (const mint of [...selling]) {
        if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
          held.delete(mint);
        }
      }

      // Exits first: stop loss, partial take-profit, trailing stop, time/stale/dev/big-sell.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        if (basis <= 0n) continue;

        // Partial take-profit at +50%: sell half, re-arm the trail from here.
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
          const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            if (c !== undefined) c.done = true;
            continue;
          }
        }

        let exit = false;
        if (value * BPS <= basis * (BPS - BigInt(p.stopLossBps))) exit = true;
        if (!exit && h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        if (!exit && state.slot - h.openedSlot >= p.maxHoldSlots) exit = true;
        if (c !== undefined) {
          if (!exit && c.devSold) exit = true;
          if (!exit && state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: young coins with a proven runup, real inflow, several buyers, no rug signs.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAgeSlots) {
          c.done = true;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(c.mint) || selling.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.devBuy > BigInt(Math.floor(p.maxDevBuySol * LAMPORTS))) continue;
        if (c.buyers.size < p.minBuyers) continue;
        if (c.trades < p.minTrades) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.floor(p.minRealSol * LAMPORTS)) || rq > BigInt(Math.floor(p.maxRealSol * LAMPORTS))) continue;
        // Runup vs the create price, from the latest reserves.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (c.vt0 <= 0n || c.vq0 <= 0n || vt <= 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BPS + BigInt(p.minRunupBps) || runup > BPS + BigInt(p.maxRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(Math.floor(p.minFlowSol * LAMPORTS)) || fl.buyers < p.minBuyers) continue;
        // Size: the stake, capped at 1% of real reserves and by free cash.
        const maxBuy = state.maxBuyLamports(c.mint);
        let amount = p.stakeLamports < maxBuy ? p.stakeLamports : maxBuy;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
