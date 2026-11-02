/**
 * Characters Command - List and inspect Venice API characters
 */

import { Command } from 'commander';
import { getCharacter, getCharacterReviews, listCharacters } from '../lib/api.js';
import { formatError, formatJson, getChalk, detectOutputFormat, terminalSafe } from '../lib/output.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Character, CharacterReviewsPage } from '../types/index.js';

export function registerCharactersCommand(program: Command): void {
  const characters = program
    .command('characters')
    .description('List characters from the Venice API catalog')
    .option('-s, --search <query>', 'Search by name, description, or tags')
    .option('--limit <n>', 'Number of characters to return (max 100)', '50')
    .option('--offset <n>', 'Number of characters to skip', '0')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const results = await listCharacters({
          search: options.search,
          limit: parseInt(options.limit, 10),
          offset: parseInt(options.offset, 10),
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
    .action(async (slug: string, options) => {
      const format = detectOutputFormat(options.format);
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
          console.log(
            c.dim(
              `Average ${terminalSafe(reviews.summary.averageRating)} · ${terminalSafe(reviews.summary.totalReviews)} review${reviews.summary.totalReviews === 1 ? '' : 's'}`
            )
          );
          console.log('');

          for (const review of reviews.data) {
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

        console.log(c.dim(`Usage: ${shellCommand`venice chat -c ${apiId(character.slug)} "Your message"`}`));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
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
