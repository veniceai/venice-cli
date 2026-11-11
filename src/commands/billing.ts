import { Command } from 'commander';
import {
  BillingAnalyticsQuery,
  BillingCurrency,
  BillingUsageEntry,
  BillingUsageQuery,
  getBillingAnalytics,
  getBillingBalance,
  getBillingUsage,
  getBillingUsageCsv,
  MAX_BILLING_USAGE_PAGE_SIZE,
} from '../lib/account-api.js';
import {
  detectOutputFormat,
  formatJson,
  formatOutput,
  formatTable,
  getChalk,
  terminalSafe,
} from '../lib/output.js';
import { parseIntegerOption } from '../lib/options.js';

const CURRENCIES = ['USD', 'DIEM', 'BUNDLED_CREDITS'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

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
        console.log(formatJson(balance));
        return;
      }

      const c = getChalk();
      console.log(c.bold('\nVenice Balance\n'));
      console.log(`Can consume: ${balance.canConsume ? c.green('yes') : c.red('no')}`);
      console.log(`Consumption currency: ${terminalSafe(balance.consumptionCurrency ?? 'none')}`);
      console.log(`USD: ${formatAmount(balance.balances.usd)}`);
      console.log(`DIEM: ${formatAmount(balance.balances.diem)}`);
      console.log(`DIEM epoch allocation: ${formatAmount(balance.diemEpochAllocation)}`);
    });

  billing
    .command('usage')
    .description('Show billed usage from all API clients')
    .option('-d, --days <number>', 'Number of days to show', '7')
    .option('--start <timestamp>', 'Inclusive start, ISO 8601 UTC such as 2026-11-01T00:00:00Z (instead of --days)')
    .option('--end <timestamp>', 'Exclusive end, ISO 8601 UTC such as 2026-11-08T00:00:00Z (instead of --days)')
    .option('-c, --currency <currency>', 'Filter by USD, DIEM, or BUNDLED_CREDITS')
    .option(
      '--page-size <number>',
      `Entries fetched per API page (10-${MAX_BILLING_USAGE_PAGE_SIZE})`,
      String(MAX_BILLING_USAGE_PAGE_SIZE)
    )
    .option('-f, --format <format>', 'Output format (pretty|json|csv)')
    .action(async (options, command: Command) => {
      const format = options.format === 'csv' ? 'csv' : detectOutputFormat(options.format);
      const range = parseUsageRange(options, command.getOptionValueSource('days') === 'cli');
      const pageSize = parseIntegerOption(options.pageSize, '--page-size', {
        min: 10,
        max: MAX_BILLING_USAGE_PAGE_SIZE,
      });
      const query: BillingUsageQuery = {
        ...range.query,
        currency: parseCurrency(options.currency),
        pageSize,
      };

      if (format === 'csv') {
        process.stdout.write(terminalSafe(await getBillingUsageCsv(query)));
        return;
      }

      const entries = await getBillingUsage(query);
      if (format === 'json') {
        console.log(formatJson(entries));
        return;
      }

      printUsageSummary(entries, range.title);
    });

  billing
    .command('analytics')
    .description('Show aggregated usage analytics by date, model, and API key')
    .option('-l, --lookback <period>', 'Lookback period from 1d to 90d', '30d')
    .option('--start <date>', 'First day, YYYY-MM-DD (with --end, instead of --lookback)')
    .option('--end <date>', 'Last day, YYYY-MM-DD (with --start, instead of --lookback)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options, command: Command) => {
      const query = parseAnalyticsQuery(options, command.getOptionValueSource('lookback') === 'cli');
      const analytics = await getBillingAnalytics(query);
      console.log(formatOutput(analytics, detectOutputFormat(options.format)));
    });
}

function parseUsageRange(
  options: { days: string; start?: string; end?: string },
  daysGiven: boolean
): { query: Pick<BillingUsageQuery, 'startTimestamp' | 'endTimestamp'>; title: string } {
  const { start, end } = options;
  if (start === undefined && end === undefined) {
    const days = parseIntegerOption(options.days, '--days', { min: 1, max: 3650 });
    const now = new Date();
    return {
      query: {
        startTimestamp: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
        endTimestamp: now.toISOString(),
      },
      title: `Last ${days} days`,
    };
  }

  if (daysGiven) {
    throw new Error('Choose either --days or --start/--end, not both.');
  }
  if (start !== undefined) assertUtcTimestamp(start, '--start');
  if (end !== undefined) assertUtcTimestamp(end, '--end');
  if (start !== undefined && end !== undefined && Date.parse(start) >= Date.parse(end)) {
    throw new Error('--end must be later than --start.');
  }

  return {
    query: { startTimestamp: start, endTimestamp: end },
    title: start && end ? `${start} to ${end}` : start ? `Since ${start}` : `Until ${end}`,
  };
}

function parseAnalyticsQuery(
  options: { lookback: string; start?: string; end?: string },
  lookbackGiven: boolean
): BillingAnalyticsQuery {
  const { start, end } = options;
  if (start === undefined && end === undefined) {
    const lookback = String(options.lookback);
    validateLookback(lookback);
    return { lookback };
  }

  if (lookbackGiven) {
    throw new Error('Choose either --lookback or --start/--end, not both.');
  }
  if (start === undefined || end === undefined) {
    throw new Error('--start and --end must be given together.');
  }
  assertCalendarDate(start, '--start');
  assertCalendarDate(end, '--end');
  if (start > end) {
    throw new Error('--start cannot be later than --end.');
  }
  return { startDate: start, endDate: end };
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertCalendarDate(value: string, option: string): void {
  if (!DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    throw new Error(`${option} must be a calendar date in YYYY-MM-DD format (got ${JSON.stringify(value)}).`);
  }
}

// Date.parse rolls impossible days such as Feb 30 into the next month.
function assertUtcTimestamp(value: string, option: string): void {
  if (
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !isCalendarDate(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(
      `${option} must be an ISO 8601 UTC timestamp with a Z suffix, such as 2026-11-01T00:00:00Z ` +
      `(got ${JSON.stringify(value)}).`
    );
  }
}

function printUsageSummary(entries: BillingUsageEntry[], title: string): void {
  const c = getChalk();
  const totals = new Map<BillingCurrency, number>();
  for (const entry of entries) {
    totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amount);
  }

  console.log(c.bold(`\nBilled Usage - ${title}\n`));
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

// Billing responses are not shape-checked, so an amount can arrive as any JSON value.
function formatAmount(value: unknown): string {
  if (value === null) return 'n/a';
  if (typeof value !== 'number') return terminalSafe(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
