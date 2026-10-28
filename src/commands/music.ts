/**
 * Music Commands - asynchronous music and sound-effects generation
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  completeAudioGeneration,
  listModels,
  queueAudioGeneration,
  quoteAudioGeneration,
  retrieveGeneratedAudio,
  type AudioProcessingStatus,
} from '../lib/api.js';
import {
  DEFAULT_JOB_WAIT_TIMEOUT_SECONDS,
  classifyJobStatus,
  colorForJobStatus,
  waitForJobStatus,
} from '../lib/job-status.js';
import { MAX_AUDIO_DOWNLOAD_BYTES, writeResponseToFile } from '../lib/media.js';
import { parseIntegerOption } from '../lib/options.js';
import { detectOutputFormat, formatError, formatSuccess, getChalk } from '../lib/output.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Model } from '../types/index.js';

const DEFAULT_MUSIC_MODEL = 'elevenlabs-music';

type MusicJobStatus = AudioProcessingStatus & { content_type?: string; size_bytes?: number };

function extensionForContentType(contentType: string): string {
  const extensions: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
  };
  return extensions[contentType] || '.bin';
}

function printProcessingStatus(status: AudioProcessingStatus): void {
  const c = getChalk();
  const color = colorForJobStatus(status.status, c);

  console.log(`${c.dim('Status:')} ${color(status.status)}`);
  if (typeof status.average_execution_time === 'number') {
    const remainingMs = Math.max(
      0,
      status.average_execution_time - (status.execution_duration || 0)
    );
    console.log(`${c.dim('Estimated remaining:')} ~${Math.ceil(remainingMs / 1000)}s`);
  }
  if (status.error) {
    console.error(`${c.red('Error:')} ${status.error}`);
  }
}

export function registerMusicCommands(program: Command): void {
  const music = program
    .command('music')
    .description('Generate music and sound effects');

  music
    .command('generate <prompt...>')
    .alias('gen')
    .description('Queue a music or sound-effects generation job')
    .option('-m, --model <model>', 'Model to use', DEFAULT_MUSIC_MODEL)
    .option('-l, --lyrics <path>', 'Read song lyrics from a file')
    .option('-d, --duration <seconds>', 'Output duration in seconds')
    .option('-i, --instrumental', 'Force instrumental output (supported models only)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        let lyricsPrompt: string | undefined;
        if (options.lyrics) {
          const lyricsPath = path.resolve(options.lyrics);
          if (!fs.existsSync(lyricsPath)) {
            throw new Error(`Lyrics file not found: ${options.lyrics}`);
          }
          lyricsPrompt = await fs.promises.readFile(lyricsPath, 'utf8');
        }

        const result = await queueAudioGeneration(promptParts.join(' '), {
          model: options.model,
          durationSeconds: parseIntegerOption(options.duration, '--duration', { min: 1 }),
          lyricsPrompt,
          forceInstrumental: options.instrumental || undefined,
        });

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatSuccess('Audio generation queued!'));
        console.log(`\n${c.dim('Queue ID:')} ${c.cyan(result.queue_id)}`);
        console.log(`${c.dim('Model:')} ${result.model}`);
        console.log(
          `\n${c.dim('Check status with:')} ${shellCommand`venice music status ${apiId(result.queue_id)} -m ${apiId(result.model)}`}`
        );
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  music
    .command('quote')
    .description('Estimate the cost of an audio generation')
    .option('-m, --model <model>', 'Model to use', DEFAULT_MUSIC_MODEL)
    .option('-d, --duration <seconds>', 'Output duration in seconds')
    .option('--character-count <count>', 'Character count for character-priced models')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const result = await quoteAudioGeneration(options.model, {
          durationSeconds: parseIntegerOption(options.duration, '--duration', { min: 1 }),
          characterCount: parseIntegerOption(options.characterCount, '--character-count', { min: 1 }),
        });

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${c.dim('Estimated cost:')} ${c.green(`$${result.quote.toFixed(2)} USD`)}`);
          console.log(`${c.dim('Model:')} ${options.model}`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  music
    .command('status <queueId>')
    .description('Check the status of an audio generation job')
    .option('-m, --model <model>', 'Model used for generation', DEFAULT_MUSIC_MODEL)
    .option('-w, --wait', 'Wait for completion (poll every 5s)')
    .option(
      '-t, --timeout <seconds>',
      'Maximum time to wait in seconds',
      String(DEFAULT_JOB_WAIT_TIMEOUT_SECONDS)
    )
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);

      const fetchStatus = async (): Promise<MusicJobStatus> => {
        const result = await retrieveGeneratedAudio(queueId, options.model);
        if (result.kind === 'processing') {
          return result.status;
        }

        await result.response.body?.cancel();
        return {
          status: 'COMPLETED',
          content_type: result.contentType,
          size_bytes: result.sizeBytes,
        };
      };

      const printStatus = (status: MusicJobStatus): void => {
        if (format === 'json') {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        printProcessingStatus(status);
        if (classifyJobStatus(status.status) === 'completed') {
          console.log(
            `${getChalk().dim('Download with:')} ${shellCommand`venice music retrieve ${queueId} -m ${options.model}`}`
          );
        }
      };

      try {
        if (!options.wait) {
          printStatus(await fetchStatus());
          return;
        }

        const timeoutSeconds = Number(options.timeout);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          throw new Error('--timeout must be a positive number of seconds.');
        }

        const status = await waitForJobStatus(fetchStatus, {
          label: 'audio generation',
          timeoutMs: timeoutSeconds * 1000,
          onPoll: format === 'json' ? undefined : current => {
            printProcessingStatus(current);
            console.log(getChalk().dim('Waiting...'));
          },
        });
        const exitCode = classifyJobStatus(status.status) === 'completed' ? 0 : 1;

        printStatus(status);
        if (exitCode !== 0 && format !== 'json' && !status.error) {
          console.error(formatError(`Audio generation ended with status "${status.status}".`));
        }
        process.exitCode = exitCode;
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  music
    .command('retrieve <queueId>')
    .alias('download')
    .description('Download completed generated audio')
    .option('-m, --model <model>', 'Model used for generation', DEFAULT_MUSIC_MODEL)
    .option('-o, --output <path>', 'Output file path')
    .option('--keep', 'Keep generated media on Venice after downloading')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const result = await retrieveGeneratedAudio(queueId, options.model);
        if (result.kind === 'processing') {
          const notReady = classifyJobStatus(result.status.status) === 'processing';
          const exitCode = notReady ? 2 : 1;

          if (format === 'json') {
            console.log(JSON.stringify(result.status, null, 2));
          } else {
            printProcessingStatus(result.status);
            if (notReady) {
              console.log(c.yellow('Audio is not ready yet.'));
            } else {
              console.error(formatError('No audio was returned.'));
            }
          }
          process.exitCode = exitCode;
          return;
        }

        const outputPath = options.output ||
          `generated-audio${extensionForContentType(result.contentType)}`;
        const download = await writeResponseToFile(
          result.response,
          outputPath,
          {
            maxBytes: MAX_AUDIO_DOWNLOAD_BYTES,
            expectedContentTypePrefixes: ['audio/'],
          }
        );

        let cleanupSuccess: boolean | undefined;
        let cleanupError: string | undefined;
        if (!options.keep) {
          try {
            cleanupSuccess = (await completeAudioGeneration(queueId, options.model)).success;
          } catch (error) {
            cleanupSuccess = false;
            cleanupError = error instanceof Error ? error.message : String(error);
          }
        }

        if (format === 'json') {
          console.log(JSON.stringify({
            output: outputPath,
            content_type: result.contentType,
            size_bytes: download.bytesWritten,
            media_cleaned_up: cleanupSuccess,
            cleanup_error: cleanupError,
          }, null, 2));
          return;
        }

        console.log(formatSuccess(`Audio saved to ${outputPath}`));
        console.log(`${c.dim('Model:')} ${options.model}`);
        if (cleanupSuccess === false) {
          console.log(c.yellow(
            `Remote cleanup did not complete${cleanupError ? `: ${cleanupError}` : '.'}`
          ));
          console.log(c.dim(
            `Retry with: ${shellCommand`venice music complete ${queueId} -m ${options.model}`}`
          ));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  music
    .command('complete <queueId>')
    .description('Delete stored generated audio after downloading it')
    .option('-m, --model <model>', 'Model used for generation', DEFAULT_MUSIC_MODEL)
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);

      try {
        const result = await completeAudioGeneration(queueId, options.model);
        const exitCode = result.success ? 0 : 1;

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(formatSuccess('Generated audio removed from remote storage.'));
        } else {
          console.error(formatError('Remote audio cleanup did not complete. Please retry.'));
        }
        process.exitCode = exitCode;
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  music
    .command('models')
    .description('List available music and sound-effects models')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const models = (await listModels())
          .filter((model: Model) => model.type?.toLowerCase() === 'music')
          .sort((a: Model, b: Model) => a.id.localeCompare(b.id));

        if (format === 'json') {
          console.log(JSON.stringify(models, null, 2));
          return;
        }
        if (models.length === 0) {
          console.log(c.yellow('No music models are currently available.'));
          return;
        }

        console.log(c.bold(`Available Music & Sound Effects Models (${models.length})\n`));
        for (const model of models) {
          console.log(`  ${c.cyan(model.id)}`);
          if (model.model_spec?.description) {
            console.log(`    ${c.dim(model.model_spec.description)}`);
          }
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
