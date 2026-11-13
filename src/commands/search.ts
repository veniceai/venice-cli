/**
 * Search Command - Web search with AI synthesis
 */

import { Command, Option } from 'commander';
import { dedicatedWebSearch, webSearch, SEARCH_PROVIDERS, type SearchProvider } from '../lib/api.js';
import { getDefaultModel } from '../lib/config.js';
import { parseIntegerOption } from '../lib/options.js';
import {
  formatUsage,
  reportError,
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';
import type { OutputFormat } from '../types/index.js';

interface SearchFlags {
  model?: string;
  results: string;
  citations?: true;
  scrape?: true;
  raw?: true;
  provider?: SearchProvider;
  format?: OutputFormat;
}

type SearchRequest =
  | { mode: 'raw'; limit: number; provider: SearchProvider }
  | { mode: 'synthesis'; model: string; maxResults: number; citations: boolean; scrape: boolean };

function toSearchRequest(flags: SearchFlags): SearchRequest {
  const results = parseIntegerOption(flags.results, '--results', { min: 1, max: 20 });
  if (flags.raw) {
    return { mode: 'raw', limit: results, provider: flags.provider ?? 'brave' };
  }
  if (flags.provider !== undefined) {
    throw new Error('--provider can only be used with --raw');
  }
  return {
    mode: 'synthesis',
    model: flags.model ?? getDefaultModel(),
    maxResults: results,
    citations: flags.citations ?? false,
    scrape: flags.scrape ?? false,
  };
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query...>')
    .description('Web search with AI-powered synthesis')
    .option('-m, --model <model>', 'Model to use')
    .option('-n, --results <number>', 'Number of search results', '5')
    .option('--citations', 'Include source citations in response')
    .option('--scrape', 'Enable web scraping for deeper content')
    .addOption(
      new Option('--raw', 'Use the dedicated search API without AI synthesis').conflicts([
        'model',
        'citations',
        'scrape',
      ])
    )
    .addOption(
      new Option('--provider <provider>', 'Raw search provider (default: brave)').choices(SEARCH_PROVIDERS)
    )
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (queryParts: string[], flags: SearchFlags) => {
      const query = queryParts.join(' ');
      const c = getChalk();

      try {
        const format = detectOutputFormat(flags.format);
        const request = toSearchRequest(flags);

        if (request.mode === 'raw') {
          const result = await dedicatedWebSearch(query, {
            limit: request.limit,
            provider: request.provider,
          });

          if (format === 'json') {
            console.log(formatJson(result));
          } else if (format === 'raw') {
            console.log(formatJson(result, 0));
          } else {
            for (const [index, item] of result.results.entries()) {
              console.log(`${c.bold(`${index + 1}. ${terminalSafe(item.title)}`)}`);
              console.log(c.cyan(terminalSafe(item.url)));
              if (item.content) console.log(terminalSafe(item.content));
              if (item.date) console.log(c.dim(terminalSafe(item.date)));
              if (index < result.results.length - 1) console.log();
            }
          }
          return;
        }

        const result = await webSearch(query, {
          model: request.model,
          maxResults: request.maxResults,
          enableCitations: request.citations,
          enableScraping: request.scrape,
        });

        if (format === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(terminalSafe(result.content));

          if (result.usage && format === 'pretty') {
            console.log(formatUsage(result.usage));
          }
        }
      } catch (error) {
        reportError(error, flags.format === 'json' ? 'json' : undefined);
        process.exit(1);
      }
    });
}
