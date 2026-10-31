import { Command } from 'commander';
import {
  BillingCurrency,
  BillingUsageEntry,
  getBillingAnalytics,
  getBillingBalance,
  getBillingUsage,
} from '../lib/account-api.js';
import { detectOutputFormat, formatOutput, formatTable, getChalk } from '../lib/output.js';
import { parseIntegerOption } from '../lib/options.js';

const CURRENCIES = ['USD', 'DIEM', 'BUNDLED_CREDITS'] as const;

export function registerBillingCommand(program: Command): void {
  const billing = program
    .command('billing')
    .description('Show account balance and billed API usage');

  billing
    .command('balance')
    .description('Show current Venice account balances')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const balance = await getBillingBalance();
      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify(balance, null, 2));
        return;
      }

      const c = getChalk();
      console.log(c.bold('\nVenice Balance\n'));
      console.log(`Can consume: ${balance.canConsume ? c.green('yes') : c.red('no')}`);
      console.log(`Consumption currency: ${balance.consumptionCurrency ?? 'none'}`);
      console.log(`USD: ${formatAmount(balance.balances.usd)}`);
      console.log(`DIEM: ${formatAmount(balance.balances.diem)}`);
      console.log(`DIEM epoch allocation: ${formatAmount(balance.diemEpochAllocation)}`);
    });

  billing
    .command('usage')
    .description('Show billed usage from all API clients')
    .option('-d, --days <number>', 'Number of days to show', '7')
    .option('-c, --currency <currency>', 'Filter by USD, DIEM, or BUNDLED_CREDITS')
    .option('--page-size <number>', 'Entries fetched per API page (10-1000)', '1000')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const days = parseIntegerOption(options.days, '--days', { min: 1, max: 3650 });
      const pageSize = parseIntegerOption(options.pageSize, '--page-size', { min: 10, max: 1000 });
      const currency = parseCurrency(options.currency);
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      const entries = await getBillingUsage({
        startTimestamp: start.toISOString(),
        endTimestamp: end.toISOString(),
        currency,
        pageSize,
      });

      if (detectOutputFormat(options.format) === 'json') {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      printUsageSummary(entries, days);
    });

  billing
    .command('analytics')
    .description('Show aggregated usage analytics by date, model, and API key')
    .option('-l, --lookback <period>', 'Lookback period from 1d to 90d', '30d')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const lookback = String(options.lookback);
      validateLookback(lookback);
      const analytics = await getBillingAnalytics(lookback);
      console.log(formatOutput(analytics, detectOutputFormat(options.format)));
    });
}

function printUsageSummary(entries: BillingUsageEntry[], days: number): void {
  const c = getChalk();
  const totals = new Map<BillingCurrency, number>();
  for (const entry of entries) {
    totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amount);
  }

  console.log(c.bold(`\nBilled Usage - Last ${days} days\n`));
  console.log(`Entries: ${entries.length}`);
  for (const currency of CURRENCIES) {
    if (totals.has(currency)) {
      console.log(`${currency}: ${formatAmount(totals.get(currency) ?? 0)}`);
    }
  }

  if (entries.length === 0) return;

  const rows = entries.map((entry) => ({
    timestamp: entry.timestamp,
    sku: entry.sku,
    units: formatAmount(entry.units),
    amount: formatAmount(entry.amount),
    currency: entry.currency,
  }));
  console.log(`\n${formatTable(rows, [
    { key: 'timestamp', label: 'Timestamp', width: 24 },
    { key: 'sku', label: 'SKU', width: 34 },
    { key: 'units', label: 'Units', width: 12 },
    { key: 'amount', label: 'Amount', width: 12 },
    { key: 'currency', label: 'Currency', width: 16 },
  ])}`);
}

function parseCurrency(value?: string): BillingCurrency | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (!CURRENCIES.includes(normalized as BillingCurrency)) {
    throw new Error(`currency must be one of: ${CURRENCIES.join(', ')}`);
  }
  return normalized as BillingCurrency;
}

function validateLookback(value: string): void {
  const match = /^([1-9]\d*)d$/.exec(value);
  if (!match || Number(match[1]) > 90) {
    throw new Error('lookback must be between 1d and 90d');
  }
}

function formatAmount(value: number | null): string {
  if (value === null) return 'n/a';
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
