/**
 * Models Command - List and filter available models
 */

import { Command } from 'commander';
import { listModels } from '../lib/api.js';
import {
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import type { Model } from '../types/index.js';
import { isE2EEModel, isTEEModel } from '../types/index.js';

export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('List available models')
    .option('-t, --type <type>', 'Filter by type (all|text|image|tts|asr|music|embedding|video|upscale|inpaint)')
    .option('-s, --search <query>', 'Search models by name')
    .option('--privacy', 'Show only privacy-preserving models')
    .option('--tee', 'Show only TEE-attestable models')
    .option('--e2ee', 'Show only E2EE-capable models')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        let models = applyModelFilters(await listModels(), options);

        // Sort by id
        models.sort((a: Model, b: Model) => (a.id || '').localeCompare(b.id || ''));

        if (format === 'json') {
          console.log(JSON.stringify(models, null, 2));
          return;
        }

        if (models.length === 0) {
          console.log(c.yellow('No models found matching your criteria.'));
          return;
        }

        console.log(c.bold(`\n📋 Available Models (${models.length})\n`));

        // Group by type
        const grouped = groupModelsByType(models);

        for (const [type, typeModels] of Object.entries(grouped)) {
          console.log(c.bold(`\n${getTypeEmoji(type)} ${capitalizeFirst(type)} Models`));
          console.log(c.dim('─'.repeat(50)));

          for (const model of typeModels) {
            const badges: string[] = [];
            if (isPrivacyPreserving(model)) {
              badges.push(c.green('🔒'));
            }
            if (isE2EEModel(model)) {
              badges.push(c.magenta('🔐'));
            } else if (isTEEModel(model)) {
              badges.push(c.blue('🛡️'));
            }
            if (badges.length === 0) {
              badges.push(c.dim('📊'));
            }

            console.log(`  ${badges.join(' ')} ${c.cyan(model.id)}`);
            
            if (model.model_spec?.description) {
              const desc = model.model_spec.description;
              const indent = '     ';
              const maxWidth = Math.max(60, (process.stdout.columns || 80) - indent.length - 2);
              const wrapped = wrapText(desc, maxWidth);
              for (const line of wrapped) {
                console.log(`${indent}${c.dim(line)}`);
              }
            }
          }
        }

        console.log(`\n${c.dim('🔒 = Privacy-preserving    🛡️ = TEE attestation    🔐 = E2EE encrypted')}`);
        console.log(c.dim('📊 = Standard model'));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

export function applyModelFilters(
  models: Model[],
  options: {
    type?: string;
    search?: string;
    privacy?: boolean;
    tee?: boolean;
    e2ee?: boolean;
  }
): Model[] {
  let filtered = models;

  if (options.type) {
    const requestedType = String(options.type).toLowerCase().trim();
    if (requestedType !== 'all') {
      filtered = filtered.filter((m) => m.type?.toLowerCase() === requestedType);
    }
  }

  if (options.search) {
    const query = options.search.toLowerCase();
    filtered = filtered.filter((m) =>
      m.id?.toLowerCase().includes(query) ||
      m.model_spec?.description?.toLowerCase().includes(query)
    );
  }

  if (options.privacy) {
    filtered = filtered.filter((m) => isPrivacyPreserving(m));
  }

  if (options.tee) {
    filtered = filtered.filter((m) => isTEEModel(m));
  }

  if (options.e2ee) {
    filtered = filtered.filter((m) => isE2EEModel(m));
  }

  return filtered;
}

function groupModelsByType(models: Model[]): Record<string, Model[]> {
  const groups: Record<string, Model[]> = {};

  for (const model of models) {
    let type = 'other';
    const apiType = (model.type || '').toLowerCase();

    // Group strictly by API type families from docs
    if (apiType === 'text') {
      type = 'text';
    } else if (apiType === 'image') {
      type = 'image';
    } else if (apiType === 'inpaint') {
      type = 'inpaint';
    } else if (apiType === 'upscale') {
      type = 'upscale';
    } else if (apiType === 'tts' || apiType === 'asr') {
      type = 'audio';
    } else if (apiType === 'embedding') {
      type = 'embedding';
    } else if (apiType === 'video') {
      type = 'video';
    } else if (apiType === 'music') {
      type = 'music';
    }

    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(model);
  }

  return groups;
}

function getTypeEmoji(type: string): string {
  const emojis: Record<string, string> = {
    text: '💬',
    image: '🖼️',
    inpaint: '🖼️',
    upscale: '🖼️',
    audio: '🎵',
    music: '🎶',
    embedding: '📐',
    video: '🎬',
    other: '📦',
  };
  return emojis[type] || '📦';
}

function isPrivacyPreserving(model: Model): boolean {
  // Current API shape exposes privacy at model_spec.privacy
  // Legacy compatibility: older payloads may have capabilities.privacy
  const privacy = (model.model_spec as { privacy?: string } | undefined)?.privacy;
  if (typeof privacy === 'string') {
    return privacy.toLowerCase() === 'private';
  }

  return Boolean((model.model_spec?.capabilities as { privacy?: boolean } | undefined)?.privacy);
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxWidth) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}
