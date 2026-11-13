/**
 * Embeddings Command - Generate text embeddings
 */

import { Command } from 'commander';
import * as fs from 'fs';
import { generateEmbeddings } from '../lib/api.js';
import { writeOutputFile } from '../lib/safe-write.js';
import {
  formatSuccess,
  formatError,
  reportError,
  formatJson,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import { assertEmbeddings } from '../lib/response-checks.js';

export function registerEmbeddingsCommand(program: Command): void {
  program
    .command('embeddings [text...]')
    .alias('embed')
    .description('Generate text embeddings')
    .option('-m, --model <model>', 'Model to use', 'text-embedding-ada-002')
    .option('-o, --output <path>', 'Save embeddings to JSON file')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .option('--file <path>', 'Read text from file instead')
    .option('--encoding-format <encoding>', 'Embedding encoding returned by the API (float|base64)')
    .action(async (textParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      const encodingFormat = options.encodingFormat as 'float' | 'base64' | undefined;
      if (encodingFormat !== undefined && encodingFormat !== 'float' && encodingFormat !== 'base64') {
        console.error(formatError('--encoding-format must be float or base64'));
        process.exit(1);
      }

      let input: string | string[];

      // Read from file if specified
      if (options.file) {
        if (!fs.existsSync(options.file)) {
          console.error(formatError(`File not found: ${options.file}`));
          process.exit(1);
        }
        input = fs.readFileSync(options.file, 'utf-8').trim();
      } else if (textParts.length === 0 && !process.stdin.isTTY) {
        // Read from stdin
        input = await readStdin();
      } else {
        input = textParts.join(' ');
      }

      if (!input) {
        console.error(formatError('No text provided. Usage: venice embeddings "Your text"'));
        process.exit(1);
      }

      try {
        const result = await generateEmbeddings(input, {
          model: options.model,
          encodingFormat,
        });
        assertEmbeddings(result, encodingFormat);

        if (options.output) {
          writeOutputFile(options.output, formatJson(result));
          console.log(formatSuccess(`Saved embeddings to ${options.output}`));
          console.log(c.dim(`Dimension: ${result[0] ? vectorOf(result[0].embedding).length : 0}`));
          return;
        }

        if (format === 'json') {
          console.log(formatJson(result));
          return;
        }

        // Pretty format - show summary
        for (const item of result) {
          const vector = vectorOf(item.embedding);
          console.log(c.bold(`Embedding ${item.index + 1}:`));
          console.log(`  ${c.dim('Dimension:')} ${vector.length}`);
          console.log(`  ${c.dim('First 5 values:')} [${vector.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
          console.log(`  ${c.dim('Magnitude:')} ${magnitude(vector).toFixed(6)}`);
        }

        console.log(c.dim('\nTip: Use --output file.json to save full embeddings'));
      } catch (error) {
        reportError(error, format);
        process.exit(1);
      }
    });
}

// base64 embeddings are little-endian float32 values.
function vectorOf(embedding: number[] | string): number[] {
  if (Array.isArray(embedding)) return embedding;
  const bytes = Buffer.from(embedding, 'base64');
  return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
}

function magnitude(vec: number[]): number {
  return Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}
