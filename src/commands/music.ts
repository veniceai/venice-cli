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
  type Lyrics,
} from '../lib/api.js';
import {
  DEFAULT_JOB_WAIT_TIMEOUT_SECONDS,
  MAX_JOB_WAIT_TIMEOUT_SECONDS,
  classifyJobStatus,
  cleanupFields,
  colorForJobStatus,
  rejectWaitOnlyFlags,
  waitForJobStatus,
  type Cleanup,
} from '../lib/job-status.js';
import { MAX_AUDIO_DOWNLOAD_BYTES, formatBytes, writeResponseToFile } from '../lib/media.js';
import { outputTarget, saveToTarget } from '../lib/safe-write.js';
import { parseDecimalOption, parseIntegerOption } from '../lib/options.js';
import { parseSpendCap, quoteWithinCap } from '../lib/spend-cap.js';
import {
  detectOutputFormat,
  formatError,
  reportError,
  formatJson,
  formatSuccess,
  getChalk,
  terminalSafe,
} from '../lib/output.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Model, OutputFormat } from '../types/index.js';

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

type MusicMode =
  | { kind: 'queue' }
  | { kind: 'wait'; output: string | undefined; timeoutSeconds: number; afterSave: 'delete' | 'keep' };

/** Reads the flags into one mode, so options that only mean something with --wait can't reach a queue-only run. */
function parseMusicMode(options: { wait?: boolean; output?: string; timeout?: string; keep?: boolean }): MusicMode {
  if (!options.wait) {
    rejectWaitOnlyFlags({ '--output': options.output, '--timeout': options.timeout, '--keep': options.keep });
    return { kind: 'queue' };
  }
  return {
    kind: 'wait',
    output: options.output,
    timeoutSeconds: parseDecimalOption(
      options.timeout ?? String(DEFAULT_JOB_WAIT_TIMEOUT_SECONDS),
      '--timeout',
      { min: 0, exclusiveMin: true, max: MAX_JOB_WAIT_TIMEOUT_SECONDS }
    ),
    afterSave: options.keep ? 'keep' : 'delete',
  };
}

type MusicSpec = {
  pricing: 'per-character' | 'other';
  lyrics: 'unsupported' | 'optional' | 'required';
  lyricsOptimizer: boolean;
  loop: boolean;
  forceInstrumental: boolean;
  speed?: { min: number; max: number };
  voices: { listed: string[]; custom: boolean };
};

/** What the live catalog says about a music model, or undefined when it can't be read or doesn't list the model. */
async function fetchMusicSpec(model: string): Promise<MusicSpec | undefined> {
  let models: Model[];
  try {
    models = await listModels({ type: 'music', showSpinner: false });
  } catch {
    return undefined;
  }
  const spec = models.find((entry) => entry.id === model)?.model_spec as Record<string, unknown> | undefined;
  if (!spec) return undefined;
  const pricing = spec.pricing as Record<string, unknown> | undefined;
  const { min_speed: minSpeed, max_speed: maxSpeed, voices } = spec;
  return {
    pricing: pricing && 'per_thousand_characters' in pricing ? 'per-character' : 'other',
    lyrics: spec.supports_lyrics !== true ? 'unsupported' : spec.lyrics_required === true ? 'required' : 'optional',
    lyricsOptimizer: spec.supports_lyrics_optimizer === true,
    loop: spec.supports_loop === true,
    forceInstrumental: spec.supports_force_instrumental === true,
    speed: spec.supports_speed === true && typeof minSpeed === 'number' && typeof maxSpeed === 'number'
      ? { min: minSpeed, max: maxSpeed }
      : undefined,
    voices: {
      listed: Array.isArray(voices) ? voices.filter((voice): voice is string => typeof voice === 'string') : [],
      custom: spec.supports_custom_voice_id === true,
    },
  };
}

/** Rejects options the catalog says the model doesn't support, before anything is quoted or queued. */
function checkMusicOptions(model: string, request: AudioRequest, spec: MusicSpec | undefined): void {
  if (!spec) return;
  if (request.lyrics.kind === 'written' && spec.lyrics === 'unsupported') {
    throw new Error(`${model} doesn't take lyrics (--lyrics).`);
  }
  if (request.lyrics.kind === 'none' && spec.lyrics === 'required') {
    throw new Error(spec.lyricsOptimizer
      ? `${model} needs lyrics: pass them with --lyrics, or let it write them with --lyrics-optimizer.`
      : `${model} needs lyrics: pass them with --lyrics.`);
  }
  if (request.lyrics.kind === 'optimized' && !spec.lyricsOptimizer) {
    throw new Error(`${model} can't write lyrics from the prompt (--lyrics-optimizer).`);
  }
  if (request.loop && !spec.loop) throw new Error(`${model} can't render a seamless loop (--loop).`);
  if (request.forceInstrumental && !spec.forceInstrumental) throw new Error(`${model} has no instrumental mode (--instrumental).`);
  if (request.speed !== undefined) {
    if (!spec.speed) throw new Error(`${model} doesn't take a speed (--speed).`);
    if (request.speed < spec.speed.min || request.speed > spec.speed.max) {
      throw new Error(`--speed for ${model} must be between ${spec.speed.min} and ${spec.speed.max}.`);
    }
  }
  if (request.voice !== undefined && !spec.voices.custom && !spec.voices.listed.includes(request.voice)) {
    throw new Error(spec.voices.listed.length > 0
      ? `Invalid --voice "${request.voice}" for ${model}. Use one of: ${spec.voices.listed.join(', ')}`
      : `${model} doesn't take a voice (--voice).`);
  }
}

type AudioRequest = Parameters<typeof queueAudioGeneration>[1];
type FinishedAudio = Extract<Awaited<ReturnType<typeof retrieveGeneratedAudio>>, { kind: 'audio' }>;
type MusicPoll = AudioProcessingStatus | { status: 'COMPLETED'; audio: FinishedAudio };

async function generateAndSaveTrack(
  prompt: string,
  request: AudioRequest,
  quote: number | undefined,
  mode: Extract<MusicMode, { kind: 'wait' }>,
  format: OutputFormat
): Promise<void> {
  const c = getChalk();
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const queued = await queueAudioGeneration(prompt, request);
  if (format !== 'json') {
    console.log(formatSuccess('Audio generation queued!'));
    console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(queued.queue_id))}`);
    console.log(`${c.dim('Model:')} ${terminalSafe(queued.model)}`);
    if (quote !== undefined) console.log(`${c.dim('Price:')} ${c.cyan(`$${quote}`)}`);
  }

  let finished: MusicPoll;
  try {
    // A finished job answers the poll with the audio itself, which is kept for the download below.
    finished = await waitForJobStatus(async (): Promise<MusicPoll> => {
      const result = await retrieveGeneratedAudio(queued.queue_id, queued.model);
      return result.kind === 'processing' ? result.status : { status: 'COMPLETED', audio: result };
    }, {
      label: 'audio generation',
      timeoutMs: mode.timeoutSeconds * 1000,
      onPoll: format === 'json' ? undefined : current => {
        if ('audio' in current) return;
        printProcessingStatus(current);
        console.log(c.dim('Waiting...'));
      },
    });
  } catch (error) {
    throw new Error(
      `${message(error)}\nThe job is still on Venice. Keep waiting with: ` +
      shellCommand`venice music status ${apiId(queued.queue_id)} -m ${apiId(queued.model)} --wait`
    );
  }

  if (!('audio' in finished)) {
    if (format === 'json') {
      console.log(formatJson({ ...finished, queue_id: queued.queue_id, model: queued.model }));
    } else {
      printProcessingStatus(finished);
      if (!finished.error) {
        console.error(formatError(classifyJobStatus(finished.status) === 'completed'
          ? `Venice reports the job as ${finished.status} but returned no audio.`
          : `Audio generation ended with status "${finished.status}".`));
      }
    }
    process.exitCode = 1;
    return;
  }

  const { audio } = finished;
  const target = outputTarget(mode.output, `generated-audio${extensionForContentType(audio.contentType)}`);
  let outputPath: string;
  let saved: { bytesWritten: number; contentType: string };
  try {
    ({ outputPath, saved } = await saveToTarget(target, (filePath) => writeResponseToFile(audio.response, filePath, {
      maxBytes: MAX_AUDIO_DOWNLOAD_BYTES,
      expectedContentTypePrefixes: ['audio/'],
    })));
  } catch (error) {
    throw new Error(
      `${message(error)}\nThe track is still on Venice. Download it with: ` +
      shellCommand`venice music retrieve ${apiId(queued.queue_id)} -m ${apiId(queued.model)}`
    );
  }

  // The track is saved, so a failed cleanup is reported rather than raised as an error that invites a paid retry.
  const cleanup: Cleanup = mode.afterSave === 'keep'
    ? { kind: 'kept' }
    : await completeAudioGeneration(queued.queue_id, queued.model).then(
      ({ success }): Cleanup => (success ? { kind: 'deleted' } : { kind: 'failed', error: 'Venice did not confirm the cleanup.' }),
      (error: unknown): Cleanup => ({ kind: 'failed', error: message(error) })
    );

  if (format === 'json') {
    console.log(formatJson({
      status: 'completed',
      queue_id: queued.queue_id,
      model: queued.model,
      output: outputPath,
      size_bytes: saved.bytesWritten,
      content_type: saved.contentType,
      ...(request.durationSeconds !== undefined ? { duration_seconds: request.durationSeconds } : {}),
      quote_usd: quote ?? null,
      ...cleanupFields(cleanup),
    }));
    return;
  }

  console.log(formatSuccess(`Audio saved to ${outputPath}`));
  console.log(`${c.dim('Size:')} ${formatBytes(saved.bytesWritten)}`);
  if (cleanup.kind === 'failed') {
    console.log(c.yellow(`Remote cleanup did not complete: ${terminalSafe(cleanup.error)}`));
    console.log(c.dim(`Retry with: ${shellCommand`venice music complete ${apiId(queued.queue_id)} -m ${apiId(queued.model)}`}`));
  }
}

function printProcessingStatus(status: AudioProcessingStatus): void {
  const c = getChalk();
  const color = colorForJobStatus(status.status, c);

  console.log(`${c.dim('Status:')} ${color(terminalSafe(status.status))}`);
  if (typeof status.average_execution_time === 'number') {
    const remainingMs = Math.max(
      0,
      status.average_execution_time - (status.execution_duration || 0)
    );
    console.log(`${c.dim('Estimated remaining:')} ~${Math.ceil(remainingMs / 1000)}s`);
  }
  if (status.error) {
    console.error(`${c.red('Error:')} ${terminalSafe(status.error, process.stderr)}`);
  }
}

export function registerMusicCommands(program: Command): void {
  const music = program
    .command('music')
    .description('Generate music and sound effects');

  music
    .command('generate <prompt...>')
    .alias('gen')
    .description('Queue a music or sound-effects generation job, or with --wait, wait for it and save the track')
    .option('-m, --model <model>', 'Model to use', DEFAULT_MUSIC_MODEL)
    .option('-l, --lyrics <path>', 'Read song lyrics from a file')
    .option('-d, --duration <seconds>', 'Output duration in seconds')
    .option('-i, --instrumental', 'Force instrumental output (supported models only)')
    .option('--lyrics-optimizer', 'Let the model write the lyrics from the prompt (supported models only)')
    .option('--loop', 'Render a clip whose end joins its start without a seam (supported models only)')
    .option('--voice <voice>', "A voice from the model's list, or a custom voice ID where the model takes one")
    .option('--speed <multiplier>', 'Speed multiplier, within the range the model allows')
    .option('--max-usd <amount>', 'Quote the job first, and refuse it before anything is charged if it costs more than this many US dollars')
    .option('-w, --wait', 'Wait for the track and save it')
    .option('-o, --output <path>', 'With --wait, file to save the track to (default: generated-audio with the extension for its format, numbered if it exists)')
    .option(
      '-t, --timeout <seconds>',
      `With --wait, maximum time to wait in seconds (default: ${DEFAULT_JOB_WAIT_TIMEOUT_SECONDS}, at most 86400)`
    )
    .option('--keep', 'With --wait, keep the track on Venice after it is saved')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const mode = parseMusicMode(options);
        const cap = parseSpendCap(options.maxUsd as string | undefined);
        const durationSeconds = parseIntegerOption(options.duration, '--duration', { min: 1 });
        const speed = parseDecimalOption(options.speed as string | undefined, '--speed', { min: 0, exclusiveMin: true });
        if (options.lyricsOptimizer && options.lyrics) {
          throw new Error("--lyrics-optimizer writes the lyrics from the prompt, so it can't be used with --lyrics.");
        }
        let lyrics: Lyrics = options.lyricsOptimizer ? { kind: 'optimized' } : { kind: 'none' };
        if (options.lyrics) {
          const lyricsPath = path.resolve(options.lyrics);
          if (!fs.existsSync(lyricsPath)) {
            throw new Error(`Lyrics file not found: ${options.lyrics}`);
          }
          lyrics = { kind: 'written', text: await fs.promises.readFile(lyricsPath, 'utf8') };
        }

        const prompt = promptParts.join(' ');
        const request: AudioRequest = {
          model: options.model,
          lyrics,
          durationSeconds,
          forceInstrumental: options.instrumental || undefined,
          loop: options.loop || undefined,
          voice: options.voice as string | undefined,
          speed,
        };
        const spec = await fetchMusicSpec(options.model);
        checkMusicOptions(options.model, request, spec);
        const quote = await quoteWithinCap(
          () => quoteAudioGeneration(options.model, {
            durationSeconds,
            characterCount: spec?.pricing === 'per-character' ? prompt.length : undefined,
          }),
          cap,
          { wantPrice: mode.kind === 'wait' }
        );

        if (mode.kind === 'wait') {
          await generateAndSaveTrack(prompt, request, quote, mode, format);
          return;
        }

        const result = await queueAudioGeneration(prompt, request);

        if (format === 'json') {
          console.log(formatJson(quote === undefined ? result : { ...result, quote_usd: quote }));
          return;
        }

        console.log(formatSuccess('Audio generation queued!'));
        console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(result.queue_id))}`);
        console.log(`${c.dim('Model:')} ${terminalSafe(result.model)}`);
        if (quote !== undefined) console.log(`${c.dim('Price:')} ${c.cyan(`$${quote}`)}`);
        console.log(
          `\n${c.dim('Check status with:')} ${shellCommand`venice music status ${apiId(result.queue_id)} -m ${apiId(result.model)}`}`
        );
      } catch (error) {
        reportError(error, format);
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
          console.log(formatJson(result));
        } else {
          console.log(`${c.dim('Estimated cost:')} ${c.green(`$${result.quote.toFixed(2)} USD`)}`);
          console.log(`${c.dim('Model:')} ${options.model}`);
        }
      } catch (error) {
        reportError(error, format);
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
      'Maximum time to wait in seconds (at most 86400)',
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
          console.log(formatJson(status));
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

        const timeoutSeconds = parseDecimalOption(options.timeout, '--timeout', {
          min: 0,
          exclusiveMin: true,
          max: MAX_JOB_WAIT_TIMEOUT_SECONDS,
        });

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
        reportError(error, format);
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
            console.log(formatJson(result.status));
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
          console.log(formatJson({
            output: outputPath,
            content_type: result.contentType,
            size_bytes: download.bytesWritten,
            media_cleaned_up: cleanupSuccess,
            cleanup_error: cleanupError,
          }));
          return;
        }

        console.log(formatSuccess(`Audio saved to ${outputPath}`));
        console.log(`${c.dim('Model:')} ${options.model}`);
        if (cleanupSuccess === false) {
          console.log(c.yellow(
            `Remote cleanup did not complete${cleanupError ? `: ${terminalSafe(cleanupError)}` : '.'}`
          ));
          console.log(c.dim(
            `Retry with: ${shellCommand`venice music complete ${queueId} -m ${options.model}`}`
          ));
        }
      } catch (error) {
        reportError(error, format);
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
          console.log(formatJson(result));
        } else if (result.success) {
          console.log(formatSuccess('Generated audio removed from remote storage.'));
        } else {
          console.error(formatError('Remote audio cleanup did not complete. Please retry.'));
        }
        process.exitCode = exitCode;
      } catch (error) {
        reportError(error, format);
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
          console.log(formatJson(models));
          return;
        }
        if (models.length === 0) {
          console.log(c.yellow('No music models are currently available.'));
          return;
        }

        console.log(c.bold(`Available Music & Sound Effects Models (${models.length})\n`));
        for (const model of models) {
          console.log(`  ${c.cyan(terminalSafe(model.id))}`);
          if (model.model_spec?.description) {
            console.log(`    ${c.dim(terminalSafe(model.model_spec.description))}`);
          }
        }
      } catch (error) {
        reportError(error, format);
        process.exit(1);
      }
    });
}
