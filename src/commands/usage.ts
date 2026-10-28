/**
 * Usage Command - Track and display API usage statistics
 */

import { Command } from 'commander';
import { loadUsage, UsageEntry } from '../lib/config.js';
import {
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';

export function registerUsageCommand(program: Command): void {
  program
    .command('usage')
    .description('Show API usage statistics')
    .option('-d, --days <number>', 'Number of days to show', '7')
    .option('--today', 'Show only today\'s usage')
    .option('--month', 'Show this month\'s usage')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action((options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const usage = loadUsage();

      if (usage.length === 0) {
        console.log(c.dim('No usage data recorded yet.'));
        return;
      }

      // Filter by date range
      let filtered = usage;
      const now = new Date();

      if (options.today) {
        const today = now.toISOString().split('T')[0];
        filtered = usage.filter(u => u.timestamp.startsWith(today));
      } else if (options.month) {
        const month = now.toISOString().slice(0, 7);
        filtered = usage.filter(u => u.timestamp.startsWith(month));
      } else {
        const days = parseInt(options.days, 10);
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - days);
        filtered = usage.filter(u => new Date(u.timestamp) >= cutoff);
      }

      if (format === 'json') {
        console.log(formatJson(summarizeUsage(filtered)));
        return;
      }

      const summary = summarizeUsage(filtered);
      const periodLabel = options.today ? 'Today' : options.month ? 'This Month' : `Last ${options.days} days`;

      console.log(c.bold(`\n📊 Usage Summary - ${periodLabel}\n`));

      // Total tokens
      console.log(`${c.dim('Total Tokens:')} ${c.bold(summary.total_tokens.toLocaleString())}`);
      console.log(`  ${c.dim('Prompt:')} ${summary.prompt_tokens.toLocaleString()}`);
      console.log(`  ${c.dim('Completion:')} ${summary.completion_tokens.toLocaleString()}`);
      console.log('');

      // By command
      console.log(c.bold('By Command:'));
      for (const [cmd, stats] of Object.entries(summary.by_command)) {
        console.log(`  ${c.cyan(terminalSafe(cmd).padEnd(15))} ${stats.calls} calls, ${stats.tokens.toLocaleString()} tokens`);
      }
      console.log('');

      // By model
      console.log(c.bold('By Model:'));
      for (const [model, stats] of Object.entries(summary.by_model)) {
        console.log(`  ${c.cyan(terminalSafe(model).padEnd(25))} ${stats.calls} calls, ${stats.tokens.toLocaleString()} tokens`);
      }
      console.log('');

      // Daily breakdown
      console.log(c.bold('Daily:'));
      const daily = groupByDay(filtered);
      const days = Object.keys(daily).sort().slice(-7);
      
      for (const day of days) {
        const dayData = daily[day];
        const tokens = dayData.reduce((sum, u) => sum + tokenCount(u.total_tokens), 0);
        const bar = '█'.repeat(Math.min(20, Math.ceil(tokens / 1000)));
        console.log(`  ${c.dim(terminalSafe(day))} ${bar} ${tokens.toLocaleString()}`);
      }

      console.log(`\n${c.dim('Tip: Use "venice config set show_usage false" to hide per-request usage')}`);
    });
}

interface UsageSummary {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_calls: number;
  by_command: Record<string, { calls: number; tokens: number }>;
  by_model: Record<string, { calls: number; tokens: number }>;
}

function summarizeUsage(usage: UsageEntry[]): UsageSummary {
  const summary: UsageSummary = {
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_calls: usage.length,
    by_command: {},
    by_model: {},
  };

  for (const entry of usage) {
    const tokens = tokenCount(entry.total_tokens);
    
    summary.total_tokens += tokens;
    summary.prompt_tokens += tokenCount(entry.prompt_tokens);
    summary.completion_tokens += tokenCount(entry.completion_tokens);

    // By command
    if (!summary.by_command[entry.command]) {
      summary.by_command[entry.command] = { calls: 0, tokens: 0 };
    }
    summary.by_command[entry.command].calls++;
    summary.by_command[entry.command].tokens += tokens;

    // By model
    if (!summary.by_model[entry.model]) {
      summary.by_model[entry.model] = { calls: 0, tokens: 0 };
    }
    summary.by_model[entry.model].calls++;
    summary.by_model[entry.model].tokens += tokens;
  }

  return summary;
}

// usage.json can hold values the server sent in place of token counts.
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function groupByDay(usage: UsageEntry[]): Record<string, UsageEntry[]> {
  const groups: Record<string, UsageEntry[]> = {};

  for (const entry of usage) {
    const day = entry.timestamp.split('T')[0];
    if (!groups[day]) {
      groups[day] = [];
    }
    groups[day].push(entry);
  }

  return groups;
}
