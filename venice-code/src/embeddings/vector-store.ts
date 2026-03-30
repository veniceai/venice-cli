/**
 * Vector store for semantic search
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { VectorStore, VectorStoreEntry, FileChunk, SearchResult } from '../types/index.js';
import { createEmbedding } from '../api/client.js';
import { getConfigValue } from '../config/config.js';

const VECTOR_STORE_VERSION = '1.0';

/**
 * Load vector store from disk
 */
export async function loadVectorStore(path: string): Promise<VectorStore | null> {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await readFile(path, 'utf-8');
    const store = JSON.parse(content) as VectorStore;
    return store;
  } catch {
    return null;
  }
}

/**
 * Save vector store to disk
 */
export async function saveVectorStore(store: VectorStore, path: string): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(path, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Create embeddings for chunks
 */
export async function embedChunks(chunks: FileChunk[]): Promise<VectorStoreEntry[]> {
  const embeddingsModel = await getConfigValue('embeddings_model');
  const entries: VectorStoreEntry[] = [];

  // Batch embeddings for efficiency (process 20 at a time)
  const batchSize = 20;
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map(chunk => chunk.content);

    try {
      const response = await createEmbedding({
        model: embeddingsModel,
        input: texts,
      });

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embedding = response.data[j].embedding;

        entries.push({
          id: chunk.id,
          file: chunk.file,
          chunk: chunk.content,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          embedding,
          updated: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error(`Failed to embed batch ${i}-${i + batchSize}:`, error);
      // Continue with next batch
    }
  }

  return entries;
}

/**
 * Build new vector store from chunks
 */
export async function buildVectorStore(chunks: FileChunk[]): Promise<VectorStore> {
  const entries = await embedChunks(chunks);

  return {
    version: VECTOR_STORE_VERSION,
    entries,
    indexed_at: new Date().toISOString(),
  };
}

/**
 * Update vector store with new chunks
 */
export async function updateVectorStore(
  store: VectorStore,
  newChunks: FileChunk[]
): Promise<VectorStore> {
  const newEntries = await embedChunks(newChunks);

  // Remove old entries for updated files
  const updatedFiles = new Set(newChunks.map(c => c.file));
  const filteredEntries = store.entries.filter(e => !updatedFiles.has(e.file));

  return {
    ...store,
    entries: [...filteredEntries, ...newEntries],
    indexed_at: new Date().toISOString(),
  };
}

/**
 * Search vector store for similar chunks
 */
export async function searchVectorStore(
  store: VectorStore,
  query: string,
  options: {
    topK?: number;
    minSimilarity?: number;
  } = {}
): Promise<SearchResult[]> {
  const { topK = 5, minSimilarity = 0.7 } = options;

  // Get query embedding
  const embeddingsModel = await getConfigValue('embeddings_model');
  const response = await createEmbedding({
    model: embeddingsModel,
    input: query,
  });

  const queryEmbedding = response.data[0].embedding;

  // Calculate similarities
  const results: SearchResult[] = [];

  for (const entry of store.entries) {
    const similarity = cosineSimilarity(queryEmbedding, entry.embedding);

    if (similarity >= minSimilarity) {
      results.push({
        file: entry.file,
        chunk: entry.chunk,
        start_line: entry.start_line,
        end_line: entry.end_line,
        similarity,
      });
    }
  }

  // Sort by similarity and return top K
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Get vector store statistics
 */
export function getVectorStoreStats(store: VectorStore): {
  totalChunks: number;
  totalFiles: number;
  indexedAt: string;
} {
  const files = new Set(store.entries.map(e => e.file));

  return {
    totalChunks: store.entries.length,
    totalFiles: files.size,
    indexedAt: store.indexed_at,
  };
}
