/**
 * Embeddings Command - Generate text embeddings
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { generateEmbeddings } from '../lib/api.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

export function registerEmbeddingsCommand(program: Command): void {
  program
    .command('embeddings [text...]')
    .alias('embed')
    .description('Generate text embeddings')
    .option('-m, --model <model>', 'Model to use', 'text-embedding-ada-002')
    .option('-o, --output <path>', 'Save embeddings to JSON file')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .option('--file <path>', 'Read text from file instead')
    .action(async (textParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

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
        });

        if (options.output) {
          fs.mkdirSync(path.dirname(options.output), { recursive: true });
          fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
          console.log(formatSuccess(`Saved embeddings to ${options.output}`));
          console.log(c.dim(`Dimension: ${result[0]?.embedding?.length || 0}`));
          return;
        }

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Pretty format - show summary
        for (const item of result) {
          console.log(c.bold(`Embedding ${item.index + 1}:`));
          console.log(`  ${c.dim('Dimension:')} ${item.embedding.length}`);
          console.log(`  ${c.dim('First 5 values:')} [${item.embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
          console.log(`  ${c.dim('Magnitude:')} ${magnitude(item.embedding).toFixed(6)}`);
        }

        console.log(c.dim('\nTip: Use --output file.json to save full embeddings'));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
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
