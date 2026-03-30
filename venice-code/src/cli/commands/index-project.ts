/**
 * Index command - create embeddings index for project
 */

import { Command } from 'commander';
import { loadConfig } from '../../config/config.js';
import { scanProject } from '../../embeddings/scanner.js';
import { buildVectorStore, saveVectorStore, getVectorStoreStats } from '../../embeddings/vector-store.js';
import { logInfo, logSuccess, logError, startSpinner, stopSpinner, chalk } from '../../utils/logger.js';

export function registerIndexCommand(program: Command): void {
  program
    .command('index')
    .description('Index project files for semantic search')
    .option('-d, --directory <path>', 'Directory to index (default: current directory)', '.')
    .option('-p, --patterns <patterns>', 'Comma-separated file patterns to include')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const directory = options.directory;

        logInfo(`Indexing project in: ${directory}`);

        startSpinner('Scanning project files...');

        // Scan project
        const filePatterns = options.patterns 
          ? options.patterns.split(',').map((p: string) => p.trim())
          : undefined;

        const chunks = await scanProject(directory, {
          ignorePatterns: config.ignore_patterns,
          filePatterns,
          maxFileSize: config.max_file_size,
        });

        stopSpinner(true, `Found ${chunks.length} chunks in ${new Set(chunks.map(c => c.file)).size} files`);

        if (chunks.length === 0) {
          logError('No files found to index');
          process.exit(1);
        }

        // Build vector store
        startSpinner('Generating embeddings...');

        const store = await buildVectorStore(chunks);

        stopSpinner(true, `Generated embeddings for ${store.entries.length} chunks`);

        // Save vector store
        await saveVectorStore(store, config.index_path);

        const stats = getVectorStoreStats(store);

        logSuccess('Project indexed successfully!');
        console.log('\n' + chalk.bold('Index Statistics:'));
        console.log(chalk.cyan('  Total files:') + ` ${stats.totalFiles}`);
        console.log(chalk.cyan('  Total chunks:') + ` ${stats.totalChunks}`);
        console.log(chalk.cyan('  Indexed at:') + ` ${stats.indexedAt}`);
        console.log(chalk.cyan('  Index path:') + ` ${config.index_path}`);
      } catch (error) {
        stopSpinner(false);
        logError(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
