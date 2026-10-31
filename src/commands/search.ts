/**
 * Search Command - Web search with AI synthesis
 */

import { Command } from 'commander';
import { dedicatedWebSearch, webSearch } from '../lib/api.js';
import { getDefaultModel } from '../lib/config.js';
import { parseIntegerOption } from '../lib/options.js';
import {
  formatUsage,
  formatError,
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query...>')
    .description('Web search with AI-powered synthesis')
    .option('-m, --model <model>', 'Model to use')
    .option('-n, --results <number>', 'Number of search results', '5')
    .option('--citations', 'Include source citations in response')
    .option('--scrape', 'Enable web scraping for deeper content')
    .option('--raw', 'Use the dedicated search API without AI synthesis')
    .option('--provider <provider>', 'Raw search provider (brave|google)')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (queryParts: string[], options) => {
      const query = queryParts.join(' ');
      const model = options.model || getDefaultModel();
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const maxResults = parseIntegerOption(options.results, '--results', { min: 1, max: 20 });
        if (!options.raw && options.provider) {
          throw new Error('--provider can only be used with --raw');
        }

        if (options.raw) {
          if (
            options.provider !== undefined &&
            options.provider !== 'brave' &&
            options.provider !== 'google'
          ) {
            throw new Error('--provider must be either "brave" or "google"');
          }

          const result = await dedicatedWebSearch(query, {
            limit: maxResults,
            provider: options.provider ?? 'brave',
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
          model,
          maxResults,
          enableCitations: options.citations,
          enableScraping: options.scrape,
        });

        if (format === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(terminalSafe(result.content));

          if (result.citations?.length && format === 'pretty') {
            console.log('\n' + c.bold('📚 Sources:'));
            for (const citation of result.citations.slice(0, 5)) {
              console.log(`  ${c.dim('•')} ${c.cyan(terminalSafe(citation.title))}`);
              console.log(`    ${c.dim(terminalSafe(citation.url))}`);
            }
          }

          if (result.usage && format === 'pretty') {
            console.log(formatUsage(result.usage));
          }
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
