/**
 * Search command - semantic search in codebase
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { loadVectorStore, searchVectorStore } from '../../embeddings/vector-store.js';
import { logError, logInfo, logSuccess, chalk } from '../../utils/logger.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Semantic search in indexed codebase')
    .option('-k, --top <number>', 'Number of results to return', '5')
    .option('-s, --similarity <threshold>', 'Minimum similarity threshold (0-1)', '0.7')
    .action(async (query: string, options) => {
      try {
        const config = await loadConfig();

        logInfo('Searching codebase...');

        // Load vector store
        const store = await loadVectorStore(config.index_path);
        
        if (!store) {
          logError('No index found. Run "venice-code index" first.');
          process.exit(1);
        }

        // Search
        const results = await searchVectorStore(store, query, {
          topK: parseInt(options.top, 10),
          minSimilarity: parseFloat(options.similarity),
        });

        if (results.length === 0) {
          logInfo('No results found');
          return;
        }

        logSuccess(`Found ${results.length} results:\n`);

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          
          console.log(chalk.bold(`${i + 1}. ${result.file}`) + chalk.gray(` (lines ${result.start_line}-${result.end_line})`));
          console.log(chalk.cyan(`   Similarity: ${(result.similarity * 100).toFixed(1)}%`));
          console.log();
          console.log(chalk.gray('   ') + result.chunk.split('\n').slice(0, 5).join('\n   '));
          console.log();
        }
      } catch (error) {
        logError(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
