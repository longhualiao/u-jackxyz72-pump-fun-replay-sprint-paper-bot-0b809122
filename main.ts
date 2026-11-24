// Surge-flip bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`. The hello message arrives first, then one
// batch per slot; this bot answers each batch with the orders decided for that slot.
// The strategy lives in strategy.ts and the wire shim is the kit's sdk/ts file,
// vendored byte for byte as vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
