/**
 * Augment Commands - Document parsing and standalone web scraping
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument, scrapeWebPage } from '../lib/api.js';
import { downloadToFile, MAX_DOCUMENT_PARSE_BYTES } from '../lib/media.js';
import {
  detectOutputFormat,
  formatError,
  formatJson,
  formatSuccess,
  getChalk,
  startSpinner,
  stopSpinner,
  terminalSafe,
  writeOutputText,
} from '../lib/output.js';

const DOCUMENT_URL_CONTENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.',
  'application/vnd.ms-',
  'application/epub+zip',
  'text/',
];
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function registerAugmentCommands(program: Command): void {
  program
    .command('parse <document>')
    .description('Extract text from a document file or https URL without model inference')
    .option('-o, --output <path>', 'Save extracted text to a file')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .action(async (documentPath: string, options) => {
      const format = detectOutputFormat(options.format);

      try {
        const result = /^https?:\/\//i.test(documentPath)
          ? await parseDocumentUrl(documentPath)
          : await parseDocument(path.resolve(documentPath));
        const output = format === 'json'
          ? formatJson(result)
          : result.text;

        if (options.output) {
          writeOutputText(options.output, output);
          console.log(formatSuccess(`Saved parsed document to ${options.output}`));
          return;
        }

        console.log(terminalSafe(output));
        if (format === 'pretty') {
          console.log(getChalk().dim(`\nTokens: ${terminalSafe(result.tokens)}`));
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
          ? formatJson(result)
          : result.content;

        if (options.output) {
          writeOutputText(options.output, output);
          console.log(formatSuccess(`Saved scraped page to ${options.output}`));
          return;
        }

        console.log(terminalSafe(output));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

// The download is refused unless it is https to a public address, as for
// media URLs that API responses name.
async function parseDocumentUrl(url: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'venice-parse-'));
  try {
    const filePath = path.join(directory, 'document');
    const spinner = startSpinner('Downloading document...');
    let contentType: string;
    try {
      ({ contentType } = await downloadToFile(url, filePath, {
        maxBytes: MAX_DOCUMENT_PARSE_BYTES,
        expectedContentTypePrefixes: DOCUMENT_URL_CONTENT_TYPES,
      }));
      if (spinner) stopSpinner(true);
    } catch (error) {
      if (spinner) stopSpinner(false);
      throw error;
    }
    return await parseDocument(filePath, {
      filename: filenameFromUrl(url),
      mimeType: MEDIA_TYPE.test(contentType) ? contentType : 'application/octet-stream',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function filenameFromUrl(url: string): string {
  const segment = new URL(url).pathname.split('/').pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // Keep the encoded form of a malformed escape.
  }
  return name.replace(/[/\\]/g, '_') || 'document';
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
