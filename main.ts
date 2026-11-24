// Pump.fun replay sprint — early-demand sniper (see strategy.ts for the idea).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
// Final tune (dev window, grade-local --driver process): net -0.0143 SOL over
// 34 round trips / 34 coins, max drawdown 0.21%, guardrails met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
