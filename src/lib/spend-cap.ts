/**
 * Spend caps for paid jobs: the job is quoted first and refused, before anything is charged, when the quote
 * is above the cap or can't be fetched.
 */

import { parseDecimalOption } from './options.js';

export type SpendCap = { kind: 'uncapped' } | { kind: 'capped'; maxUsd: number };

export function parseSpendCap(value: string | undefined): SpendCap {
  return value === undefined
    ? { kind: 'uncapped' }
    : { kind: 'capped', maxUsd: parseDecimalOption(value, '--max-usd', { min: 0, exclusiveMin: true }) };
}

/**
 * Quotes the job when there is a cap or the caller wants the price. Without a cap, a failed quote only means
 * there's no price to show. With one, a failed or higher quote stops the job, because the cap can't be
 * checked any other way.
 */
export async function quoteWithinCap(
  fetchQuote: () => Promise<{ quote: number }>,
  cap: SpendCap,
  options: { wantPrice: boolean }
): Promise<number | undefined> {
  if (cap.kind === 'uncapped') {
    return options.wantPrice ? fetchQuote().then((result) => result.quote, () => undefined) : undefined;
  }
  let quote: number;
  try {
    quote = (await fetchQuote()).quote;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't get a price to check against --max-usd, so nothing was queued. ${reason}`);
  }
  if (quote > cap.maxUsd) {
    throw new Error(`The job is quoted at $${quote}, above --max-usd ${cap.maxUsd}, so nothing was queued.`);
  }
  return quote;
}
