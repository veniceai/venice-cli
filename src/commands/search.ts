/**
 * Search Command - Web search with AI synthesis
 */

import { Command } from 'commander';
import { webSearch } from '../lib/api.js';
import { getDefaultModel } from '../lib/config.js';
import {
  formatUsage,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query...>')
    .description('Web search with AI-powered synthesis')
    .option('-m, --model <model>', 'Model to use')
    .option('-n, --results <number>', 'Number of search results', '5')
    .option('--citations', 'Include source citations in response')
    .option('--scrape', 'Enable web scraping for deeper content')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (queryParts: string[], options) => {
      const query = queryParts.join(' ');
      const model = options.model || getDefaultModel();
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const result = await webSearch(query, {
          model,
          maxResults: parseInt(options.results, 10),
          enableCitations: options.citations,
          enableScraping: options.scrape,
        });

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.content);

          if (result.citations?.length && format === 'pretty') {
            console.log('\n' + c.bold('📚 Sources:'));
            for (const citation of result.citations.slice(0, 5)) {
              console.log(`  ${c.dim('•')} ${c.cyan(citation.title)}`);
              console.log(`    ${c.dim(citation.url)}`);
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
