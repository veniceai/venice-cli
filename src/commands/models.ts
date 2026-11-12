/**
 * Models Command - List and filter available models
 */

import { Command } from 'commander';
import {
  getModelCompatibilityMapping,
  getModelTraits,
  listModels,
  type ModelNameMapping,
} from '../lib/api.js';
import {
  formatError,
  formatJson,
  formatTable,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';
import { assertModelNameMapping } from '../lib/response-checks.js';
import type { Model } from '../types/index.js';
import { isE2EEModel, isTEEModel } from '../types/index.js';

export function registerModelsCommand(program: Command): void {
  const models = program
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
        const models = applyModelFilters(await listModels(), options);

        // Sort by id
        models.sort((a: Model, b: Model) => (a.id || '').localeCompare(b.id || ''));

        if (format === 'json') {
          console.log(formatJson(models));
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

            console.log(`  ${badges.join(' ')} ${c.cyan(terminalSafe(model.id))}`);
            
            if (model.model_spec?.description) {
              const desc = terminalSafe(model.model_spec.description);
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

  // `models` also defines -t and -f, so commander gives those flags to the parent
  // command wherever they appear; subcommands read them with optsWithGlobals().
  models
    .command('show <id>')
    .description("Show one model's full catalog entry: capabilities, constraints and pricing")
    .option('-t, --type <type>', 'Model type to search (default: all types)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (id: string, _options, command: Command) => {
      const options = command.optsWithGlobals();
      const format = detectOutputFormat(options.format);

      try {
        const type = normalizeType(options.type);
        const wanted = id.trim().toLowerCase();
        const catalog = await listModels(type ? { type } : {});
        const model = catalog.find((m: Model) => typeof m.id === 'string' && m.id.toLowerCase() === wanted);
        if (!model) {
          const where = type ? `the "${type}" catalog` : 'the model catalog';
          throw new Error(
            `No model "${id}" in ${where}. List available ids with: venice models -t <type>`
          );
        }

        if (format === 'json') {
          console.log(formatJson(model));
          return;
        }
        printModelDetails(model);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  registerModelMappingCommand(models, {
    name: 'traits',
    description: 'Show which model each trait (such as default or fastest) selects',
    label: 'model traits',
    keyLabel: 'Trait',
    fetch: getModelTraits,
  });

  registerModelMappingCommand(models, {
    name: 'compat',
    description: 'Show which Venice model each compatible model name (such as an OpenAI id) maps to',
    label: 'model compatibility mapping',
    keyLabel: 'Compatible name',
    fetch: getModelCompatibilityMapping,
  });
}

function registerModelMappingCommand(
  models: Command,
  spec: {
    name: string;
    description: string;
    label: string;
    keyLabel: string;
    fetch: (type?: string) => Promise<ModelNameMapping>;
  }
): void {
  models
    .command(spec.name)
    .description(spec.description)
    .option('-t, --type <type>', 'Model type (default: text)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals();
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const mapping = await spec.fetch(normalizeType(options.type));
        assertModelNameMapping(mapping, spec.label);

        if (format === 'json') {
          console.log(formatJson(mapping));
          return;
        }

        const entries = Object.entries(mapping.data).sort(([a], [b]) => a.localeCompare(b));
        const type = typeof mapping.type === 'string' ? ` (${terminalSafe(mapping.type)})` : '';
        console.log(c.bold(`\n${capitalizeFirst(spec.label)}${type}\n`));
        if (entries.length === 0) {
          console.log(c.yellow('No entries returned.'));
          return;
        }
        console.log(formatTable(
          entries.map(([name, model]) => ({ name, model })),
          [
            { key: 'name', label: spec.keyLabel },
            { key: 'model', label: 'Model' },
          ]
        ));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

function normalizeType(type: unknown): string | undefined {
  if (type === undefined) return undefined;
  const normalized = String(type).toLowerCase().trim();
  return normalized === '' || normalized === 'all' ? undefined : normalized;
}

const SPEC_SECTIONS = ['capabilities', 'constraints', 'pricing'] as const;
const SPEC_SUMMARY_FIELDS = new Set<string>(['name', 'description', 'privacy', 'traits', ...SPEC_SECTIONS]);

function printModelDetails(model: Model): void {
  const c = getChalk();
  const spec = (model.model_spec ?? {}) as Record<string, unknown>;
  const field = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && value.length === 0) return;
    console.log(`${c.dim(`${label}:`)} ${formatValue(value)}`);
  };

  console.log('');
  const name = typeof spec.name === 'string' ? ` — ${c.bold(terminalSafe(spec.name))}` : '';
  console.log(`${c.cyan(c.bold(terminalSafe(model.id)))}${name}`);
  console.log('');

  if (typeof spec.description === 'string' && spec.description) {
    console.log(terminalSafe(spec.description));
    console.log('');
  }

  const raw = model as unknown as Record<string, unknown>;
  field('Type', model.type);
  field('Owned by', raw.owned_by);
  field('Privacy', spec.privacy);
  field('Traits', spec.traits);

  const details = Object.entries(spec).filter(([key]) => !SPEC_SUMMARY_FIELDS.has(key));
  printSection('Specification', details);
  for (const section of SPEC_SECTIONS) {
    const value = spec[section];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      printSection(capitalizeFirst(section), Object.entries(value));
    }
  }
  console.log('');
  console.log(c.dim('Full entry: venice models show <id> -f json'));
}

function printSection(title: string, entries: Array<[string, unknown]>): void {
  const lines = flattenEntries(entries);
  if (lines.length === 0) return;
  const c = getChalk();
  console.log(`\n${c.bold(title)}`);
  console.log(c.dim('─'.repeat(50)));
  for (const [key, value] of lines) {
    console.log(`  ${c.dim(`${terminalSafe(key)}:`)} ${formatValue(value)}`);
  }
}

function flattenEntries(entries: Array<[string, unknown]>, prefix = ''): Array<[string, unknown]> {
  return entries.flatMap(([key, value]): Array<[string, unknown]> => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined || value === null) return [];
    if (typeof value === 'object' && !Array.isArray(value)) {
      return flattenEntries(Object.entries(value), path);
    }
    return [[path, value]];
  });
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item)))
      .map((item) => terminalSafe(item))
      .join(', ');
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return terminalSafe(value);
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
