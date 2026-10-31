/**
 * Augment Commands - Document parsing and standalone web scraping
 */

import { Command } from 'commander';
import * as path from 'path';
import { parseDocument, scrapeWebPage } from '../lib/api.js';
import { writeOutputFile } from '../lib/safe-write.js';
import {
  detectOutputFormat,
  formatError,
  formatSuccess,
  getChalk,
} from '../lib/output.js';

export function registerAugmentCommands(program: Command): void {
  program
    .command('parse <document>')
    .description('Extract text from a document without model inference')
    .option('-o, --output <path>', 'Save extracted text to a file')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (documentPath: string, options) => {
      const format = detectOutputFormat(options.format);
      const resolvedPath = path.resolve(documentPath);

      try {
        const result = await parseDocument(resolvedPath);
        const output = format === 'json'
          ? JSON.stringify(result, null, 2)
          : result.text;

        if (options.output) {
          writeOutputFile(options.output, output);
          console.log(formatSuccess(`Saved parsed document to ${options.output}`));
          return;
        }

        console.log(output);
        if (format === 'pretty') {
          console.log(getChalk().dim(`\nTokens: ${result.tokens}`));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program
    .command('scrape <url>')
    .description('Scrape a public web page to Markdown without model inference')
    .option('-o, --output <path>', 'Save scraped content to a file')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (url: string, options) => {
      const format = detectOutputFormat(options.format);

      try {
        assertPublicWebUrl(url);
        const result = await scrapeWebPage(url);
        const output = format === 'json'
          ? JSON.stringify(result, null, 2)
          : result.content;

        if (options.output) {
          writeOutputFile(options.output, output);
          console.log(formatSuccess(`Saved scraped page to ${options.output}`));
          return;
        }

        console.log(output);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

function assertPublicWebUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL must be a valid public HTTP or HTTPS URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use HTTP or HTTPS');
  }
}
