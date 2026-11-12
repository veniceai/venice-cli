/**
 * Characters Command - List and inspect Venice API characters
 */

import { Command } from 'commander';
import {
  CHARACTER_SORT_FIELDS,
  getCharacter,
  getCharacterReviews,
  listCharacters,
  type ListCharactersOptions,
} from '../lib/api.js';
import { formatError, formatJson, getChalk, detectOutputFormat, terminalSafe } from '../lib/output.js';
import { parseIntegerOption } from '../lib/options.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Character, CharacterReview, CharacterReviewsPage } from '../types/index.js';

const MAX_FILTER_VALUES = 20;
const CHARACTER_SLUG = /^[A-Za-z0-9_-]{1,200}$/;

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export function registerCharactersCommand(program: Command): void {
  const characters = program
    .command('characters')
    .description('List characters from the Venice API catalog')
    .option('-s, --search <query>', 'Search by name, description, or tags')
    .option('--tag <tag>', 'Only characters with this tag (repeatable)', collect, [])
    .option('--category <category>', 'Only characters in this category (repeatable)', collect, [])
    .option('--model <id>', 'Only characters using this model ID (repeatable)', collect, [])
    .option('--adult', 'Only adult characters')
    .option('--no-adult', 'Exclude adult characters')
    .option('--pro', 'Only Pro characters')
    .option('--no-pro', 'Exclude Pro characters')
    .option('--web-enabled', 'Only characters with web search enabled')
    .option('--no-web-enabled', 'Exclude characters with web search enabled')
    .option('--sort <field>', `Sort by (${CHARACTER_SORT_FIELDS.join('|')})`)
    .option('--order <order>', 'Sort order (asc|desc)')
    .option('--limit <n>', 'Number of characters to return (max 100)', '50')
    .option('--offset <n>', 'Number of characters to skip', '0')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const results = await listCharacters({
          ...parseCharacterFilters(options),
          limit: parseIntegerOption(options.limit, '--limit', { min: 1, max: 100 }),
          offset: parseIntegerOption(options.offset, '--offset', { min: 0 }),
        });

        if (format === 'json') {
          console.log(formatJson(results));
          return;
        }

        if (results.length === 0) {
          console.log(c.yellow('No characters found matching your criteria.'));
          return;
        }

        console.log(c.bold(`\n🎭 Characters (${results.length})\n`));
        console.log(c.dim('Use a slug with: venice chat -c <slug> "Your message"\n'));

        for (const character of results) {
          printCharacterSummary(character);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  characters
    .command('show <slug>')
    .description('Show details for a character slug')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (slug: string, _options, command: Command) => {
      // `characters` also defines -f, so commander gives the flag to the parent command.
      const format = detectOutputFormat(command.optsWithGlobals().format);
      const c = getChalk();

      try {
        const character = await getCharacter(slug);
        const reviews = await fetchReviewsOptional(slug);

        if (format === 'json') {
          console.log(formatJson({ ...character, reviews }));
          return;
        }

        printCharacterDetails(character);

        if (reviews && reviews.data.length > 0) {
          console.log(c.bold('Reviews'));
          console.log(c.dim('─'.repeat(50)));
          printReviewSummary(reviews);
          printReviewList(reviews.data);
        }

        console.log(c.dim(`Usage: ${shellCommand`venice chat -c ${apiId(character.slug)} "Your message"`}`));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  characters
    .command('reviews <slug>')
    .description('List reviews for a character slug, one page at a time')
    .option('--page <n>', 'Page number, from 1')
    .option('--page-size <n>', 'Reviews per page (1-100)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (slug: string, options, command: Command) => {
      // `characters` also defines -f, so commander gives the flag to the parent command.
      const format = detectOutputFormat(command.optsWithGlobals().format);
      const c = getChalk();

      try {
        if (!CHARACTER_SLUG.test(slug)) {
          throw new Error('Character slug must be 1-200 letters, digits, hyphens, or underscores.');
        }
        const page = parseIntegerOption(options.page, '--page', { min: 1 });
        const pageSize = parseIntegerOption(options.pageSize, '--page-size', { min: 1, max: 100 });
        const reviews = await getCharacterReviews(slug, { page, pageSize });

        if (format === 'json') {
          console.log(formatJson(reviews));
          return;
        }

        const pagination = reviews.pagination;
        console.log(c.bold(`\nReviews for ${terminalSafe(slug)}`));
        if (pagination) {
          console.log(c.dim(`Page ${terminalSafe(pagination.page)} of ${terminalSafe(pagination.totalPages)}`));
        }
        if (reviews.summary) printReviewSummary(reviews);
        if (!Array.isArray(reviews.data) || reviews.data.length === 0) {
          console.log(c.yellow('No reviews on this page.'));
          return;
        }
        printReviewList(reviews.data);

        if (
          pagination &&
          Number.isSafeInteger(pagination.page) &&
          Number.isSafeInteger(pagination.totalPages) &&
          pagination.page < pagination.totalPages
        ) {
          const next = String(pagination.page + 1);
          const nextCommand = pageSize === undefined
            ? shellCommand`venice characters reviews ${slug} --page ${next}`
            : shellCommand`venice characters reviews ${slug} --page ${next} --page-size ${String(pageSize)}`;
          console.log(c.dim(`Next page: ${nextCommand}`));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

function parseCharacterFilters(options: {
  search?: string;
  tag: string[];
  category: string[];
  model: string[];
  adult?: boolean;
  pro?: boolean;
  webEnabled?: boolean;
  sort?: string;
  order?: string;
}): Omit<ListCharactersOptions, 'limit' | 'offset' | 'showSpinner'> {
  if (options.search !== undefined && options.search.length > 200) {
    throw new Error('--search must be at most 200 characters.');
  }
  const sortBy = options.sort as ListCharactersOptions['sortBy'];
  if (sortBy !== undefined && !CHARACTER_SORT_FIELDS.includes(sortBy)) {
    throw new Error(`--sort must be one of: ${CHARACTER_SORT_FIELDS.join(', ')}`);
  }
  if (options.order !== undefined && options.order !== 'asc' && options.order !== 'desc') {
    throw new Error('--order must be asc or desc');
  }
  return {
    search: options.search,
    tags: filterValues(options.tag, '--tag', 100),
    categories: filterValues(options.category, '--category', 100),
    modelIds: filterValues(options.model, '--model', 200),
    isAdult: options.adult,
    isPro: options.pro,
    isWebEnabled: options.webEnabled,
    sortBy,
    sortOrder: options.order as ListCharactersOptions['sortOrder'],
  };
}

function filterValues(values: string[], option: string, maxLength: number): string[] {
  if (values.length > MAX_FILTER_VALUES) {
    throw new Error(`${option} can be given at most ${MAX_FILTER_VALUES} times.`);
  }
  for (const value of values) {
    if (value.length === 0 || value.length > maxLength) {
      throw new Error(`${option} values must be 1-${maxLength} characters.`);
    }
  }
  return values;
}

function printReviewSummary(reviews: CharacterReviewsPage): void {
  const total = reviews.summary.totalReviews;
  console.log(
    getChalk().dim(
      `Average ${terminalSafe(reviews.summary.averageRating)} · ${terminalSafe(total)} review${total === 1 ? '' : 's'}`
    )
  );
  console.log('');
}

function printReviewList(reviews: CharacterReview[]): void {
  const c = getChalk();
  for (const review of reviews) {
    const rating = Number.isFinite(review.rating)
      ? Math.min(5, Math.max(0, Math.round(review.rating)))
      : 0;
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    console.log(`  ${c.yellow(stars)}  ${c.cyan(terminalSafe(review.username))}`);
    if (review.message) {
      console.log(`    ${terminalSafe(review.message)}`);
    }
    console.log('');
  }
}

async function fetchReviewsOptional(slug: string): Promise<CharacterReviewsPage | undefined> {
  try {
    return await getCharacterReviews(slug);
  } catch {
    return undefined;
  }
}

function printCharacterSummary(character: Character): void {
  const c = getChalk();
  const featured = character.featured ? ` ${c.yellow('★')}` : '';
  const slug = terminalSafe(character.slug);
  const name = terminalSafe(character.name);
  console.log(`${c.cyan(c.bold(slug))} — ${name}${featured}`);
  if (character.description) {
    console.log(`  ${c.dim(truncate(terminalSafe(character.description), 140))}`);
  }
  if (character.tags?.length) {
    console.log(`  ${c.dim(character.tags.slice(0, 6).map((tag) => terminalSafe(tag)).join(', '))}`);
  }
  console.log('');
}

function printCharacterDetails(character: Character): void {
  const c = getChalk();
  const slug = terminalSafe(character.slug);
  const name = terminalSafe(character.name);

  console.log('');
  console.log(`${c.cyan(c.bold(slug))} — ${c.bold(name)}`);
  console.log('');

  if (character.description) {
    console.log(terminalSafe(character.description));
    console.log('');
  }

  if (character.tags?.length) {
    console.log(`${c.dim('Tags:')} ${character.tags.map((tag) => terminalSafe(tag)).join(', ')}`);
  }
  if (character.modelId) {
    console.log(`${c.dim('Model:')} ${terminalSafe(character.modelId)}`);
  }
  if (character.stats) {
    console.log(
      `${c.dim('Rating:')} ${terminalSafe(character.stats.averageRating)} (${terminalSafe(character.stats.ratingCount)} ratings)`
    );
  }
  console.log(`${c.dim('Featured:')} ${character.featured ? 'yes' : 'no'}`);
  console.log(`${c.dim('Adult:')} ${character.adult ? 'yes' : 'no'}`);
  if (character.shareUrl) {
    console.log(`${c.dim('Share:')} ${terminalSafe(character.shareUrl)}`);
  }
  console.log('');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
