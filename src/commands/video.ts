/**
 * Video Commands - AI video generation
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTranscribeOptions, transcribeAndPrint } from './audio.js';
import {
  queueVideoGeneration,
  getVideoStatus,
  retrieveVideo,
  quoteVideoGeneration,
  completeVideo,
  queueVideoUpscale,
  listModels,
  videoUrlFromStatus,
  type QueuedJob,
  type VideoStatusResult,
} from '../lib/api.js';
import {
  downloadToFile,
  assertFileSizeWithinLimit,
  fileToDataUrl,
  mimeTypeFromPath,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_VIDEO_DOWNLOAD_BYTES,
  MAX_VIDEO_REFERENCE_IMAGE_BYTES,
  MAX_VIDEO_UPSCALE_BYTES,
} from '../lib/media.js';
import { checkMp4Header, fileHasMp4Header } from '../lib/mp4.js';
import { onInterrupt } from '../lib/interrupt.js';
import {
  DEFAULT_JOB_WAIT_TIMEOUT_SECONDS,
  MAX_JOB_WAIT_TIMEOUT_SECONDS,
  classifyJobStatus,
  jobPollIntervalMs,
  waitForJobStatus,
  type JobStatusPhase,
} from '../lib/job-status.js';
import {
  formatSuccess,
  formatError,
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';
import { parseDecimalOption, parseIntegerOption } from '../lib/options.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Model } from '../types/index.js';

export const FALLBACK_VIDEO_MODELS: Array<{ id: string; name: string; type: string }> = [
  { id: 'wan-2.6-text-to-video', name: 'Wan 2.6 T2V', type: 'text-to-video' },
  { id: 'wan-2.6-image-to-video', name: 'Wan 2.6 I2V', type: 'image-to-video' },
  { id: 'veo3-fast-text-to-video', name: 'Veo3 Fast T2V', type: 'text-to-video' },
  { id: 'sora2-text-to-video', name: 'Sora2 T2V', type: 'text-to-video' },
  { id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro T2V', type: 'text-to-video' },
  { id: 'topaz-video-upscale', name: 'Topaz Video Upscale', type: 'upscale' },
];

const DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS = DEFAULT_JOB_WAIT_TIMEOUT_SECONDS;

export function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const TRANSCRIBABLE_EXTENSIONS = ['.mp4', '.webm', '.mp3', '.m4a', '.aac', '.wav', '.wave', '.flac', '.ogg', '.oga'];

// The containers Venice's transcription endpoint accepts, by the type a download reports.
const TRANSCRIBABLE_CONTENT_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
};

type TranscriptionSource = { kind: 'file'; path: string } | { kind: 'download'; path: string; remove: () => void };

/** A local file Venice can transcribe, or a public URL downloaded to a temporary one. */
async function transcriptionSource(source: string): Promise<TranscriptionSource> {
  if (!isPublicHttpUrl(source)) {
    const filePath = path.resolve(source);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${source}`);
    if (!TRANSCRIBABLE_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) {
      throw new Error(
        `Venice transcribes MP4 and WebM video, or WAV, FLAC, M4A, AAC, MP3 and OGG audio. Convert ${source} to MP4 first.`
      );
    }
    return { kind: 'file', path: filePath };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venice-transcribe-'));
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true });
  const stopInterruptCleanup = onInterrupt(removeDir);
  const remove = () => {
    stopInterruptCleanup();
    removeDir();
  };
  try {
    const downloaded = path.join(dir, 'media');
    const { contentType } = await downloadToFile(source, downloaded, {
      maxBytes: MAX_TRANSCRIPTION_AUDIO_BYTES,
      expectedContentTypePrefixes: ['video/', 'audio/'],
    });
    const extension = TRANSCRIBABLE_CONTENT_TYPES[contentType];
    if (!extension) {
      throw new Error(`Venice can't transcribe ${contentType}. Use an MP4 or WebM video, or a supported audio file.`);
    }
    fs.renameSync(downloaded, `${downloaded}${extension}`);
    return { kind: 'download', path: `${downloaded}${extension}`, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

export function parseUpscaleFactor(value: string | number | undefined): number {
  return parseIntegerOption(String(value ?? '2'), '--factor', { allowed: [1, 2, 4] });
}

export function videoModelKind(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized.includes('upscale')) return 'upscale';
  if (normalized.includes('image-to-video') || normalized.includes('i2v')) return 'image-to-video';
  if (normalized.includes('text-to-video') || normalized.includes('t2v')) return 'text-to-video';
  return 'video';
}

export const classifyVideoStatus = classifyJobStatus;

export function waitForVideoStatus(
  fetchStatus: () => Promise<VideoStatusResult>,
  timeoutMs: number,
  pollIntervalMs = jobPollIntervalMs(),
  onPoll?: (status: VideoStatusResult) => void
): Promise<VideoStatusResult> {
  return waitForJobStatus(fetchStatus, {
    label: 'video generation',
    timeoutMs,
    pollIntervalMs,
    onPoll,
  });
}

function downloadVideoFromUrl(url: string, outputPath: string) {
  return downloadToFile(url, outputPath, {
    maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
    expectedContentTypePrefixes: ['video/'],
    leadingBytes: {
      check: checkMp4Header,
      invalidMessage: 'Downloaded video is not a valid MP4 file.',
    },
  });
}

async function completeSavedVideo(queueId: string, model: string, outputPath: string): Promise<void> {
  if (!fileHasMp4Header(outputPath)) {
    throw new Error(`${outputPath} is not a valid MP4 file, so the remote media was kept.`);
  }
  const completion = await completeVideo(queueId, model);
  if (!completion.success) {
    throw new Error('Video cleanup did not succeed.');
  }
}

// The URL parser silently drops tabs and newlines, so control characters are checked on the raw string.
export function isPasteableHttpsUrl(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function printQueuedDownloadUrl(queued: QueuedJob): void {
  const downloadUrl = queued.download_url;
  if (downloadUrl === undefined) return;
  const c = getChalk();
  console.log(`\n${c.dim('Download URL:')} ${c.cyan(terminalSafe(downloadUrl))}`);
  if (!isPasteableHttpsUrl(downloadUrl)) {
    console.log(c.yellow('Venice returned a download_url that is not a valid https URL, so no download command is suggested. Use -f json to see it exactly.'));
    return;
  }
  console.log(c.yellow('Venice returns this link only once and it expires within 24 hours, so save it now.'));
  console.log(`${c.dim('Download with:')} ${shellCommand`venice video retrieve ${apiId(queued.queue_id)} -m ${apiId(queued.model)} --url ${downloadUrl}`}`);
}

export function registerVideoCommands(program: Command): void {
  const video = program
    .command('video')
    .description('AI video generation commands');

  // Queue video generation
  video
    .command('generate <prompt...>')
    .alias('gen')
    .description('Queue a video generation job')
    .option('-m, --model <model>', 'Model to use', 'wan-2.6-text-to-video')
    .option('-d, --duration <duration>', 'Video duration (e.g., 5s, 10s)')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1)')
    .option('-i, --image <path>', 'Reference image for image-to-video models')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const prompt = promptParts.join(' ');
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      let imageUrl: string | undefined;

      // Handle image input for I2V models
      if (options.image) {
        const imagePath = path.resolve(options.image);
        if (!fs.existsSync(imagePath)) {
          console.error(formatError(`Image file not found: ${options.image}`));
          process.exit(1);
        }

        assertFileSizeWithinLimit(
          imagePath,
          MAX_VIDEO_REFERENCE_IMAGE_BYTES,
          'Reference image for video generation'
        );

        const imageData = await fs.promises.readFile(imagePath);
        const mimeType = mimeTypeFromPath(imagePath, 'image/png');
        imageUrl = `data:${mimeType};base64,${imageData.toString('base64')}`;
      }

      try {
        const result = await queueVideoGeneration(prompt, {
          model: options.model,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
          imageUrl,
        });

        if (format === 'json') {
          console.log(formatJson(result));
        } else {
          console.log(formatSuccess('Video generation queued!'));
          console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(result.queue_id))}`);
          console.log(`${c.dim('Model:')} ${terminalSafe(result.model)}`);
          printQueuedDownloadUrl(result);
          console.log(`\n${c.dim('Check status with:')} ${shellCommand`venice video status ${apiId(result.queue_id)} -m ${apiId(result.model)}`}`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  video
    .command('quote [prompt...]')
    .description('Estimate the price of a video generation job')
    .requiredOption('-m, --model <model>', 'Model to quote')
    .option('-d, --duration <duration>', 'Video duration (e.g., 5s, 10s)', '5s')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio (16:9, 9:16, 1:1)')
    .option('-r, --resolution <resolution>', 'Resolution (e.g., 720p, 1080p)')
    .option('--factor <n>', 'Upscale factor for topaz-video-upscale (1, 2, or 4)')
    .option('--audio', 'Include audio in the quote')
    .option('--no-audio', 'Exclude audio from the quote')
    .option('--video-url <url>', 'Source video URL for upscale quotes')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      const prompt = promptParts.join(' ');

      try {
        const result = await quoteVideoGeneration({
          model: options.model,
          duration: options.duration,
          aspectRatio: options.aspectRatio,
          resolution: options.resolution,
          upscaleFactor: options.factor !== undefined ? parseUpscaleFactor(options.factor) : undefined,
          audio: options.audio,
          videoUrl: options.videoUrl,
        });

        if (format === 'json') {
          console.log(formatJson(result));
          return;
        }

        console.log(formatSuccess('Video quote'));
        console.log(`${c.dim('Model:')} ${options.model}`);
        console.log(`${c.dim('Duration:')} ${options.duration}`);
        if (options.aspectRatio) console.log(`${c.dim('Aspect ratio:')} ${options.aspectRatio}`);
        if (prompt) console.log(`${c.dim('Prompt:')} ${prompt}`);
        console.log(`${c.dim('Price:')} ${c.cyan(`$${terminalSafe(result.quote)}`)}`);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Check video status
  video
    .command('status <queueId>')
    .description('Check status of a video generation job')
    .requiredOption('-m, --model <model>', 'Model used for generation')
    .option('-w, --wait', 'Wait for completion (poll every 5s)')
    .option(
      '-t, --timeout <seconds>',
      'Maximum time to wait in seconds (at most 86400)',
      String(DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS)
    )
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const printStatus = (result: VideoStatusResult): void => {
        if (format === 'json') {
          console.log(formatJson(result));
          return;
        }

        const statusColors: Record<JobStatusPhase, (s: string) => string> = {
          processing: c.blue,
          completed: c.green,
          failed: c.red,
          other: c.yellow,
        };

        const colorFn = statusColors[classifyVideoStatus(result.status)];
        console.log(`${c.dim('Status:')} ${colorFn(terminalSafe(result.status))}`);

        if (result.average_execution_time) {
          const remainMs = Math.max(0, result.average_execution_time - (result.execution_duration || 0));
          console.log(`${c.dim('Estimated remaining:')} ~${Math.ceil(remainMs / 1000)}s`);
        }

        const videoUrl = videoUrlFromStatus(result);
        if (videoUrl) {
          console.log(`\n${c.dim('Video URL:')} ${c.cyan(terminalSafe(videoUrl))}`);
        }
        if (classifyVideoStatus(result.status) === 'completed') {
          console.log(`\n${c.dim('Download with:')} ${shellCommand`venice video retrieve ${queueId} -m ${options.model}`}`);
          if (!videoUrl) {
            console.log(c.dim('If the job was queued with a download URL, add --url <download_url>.'));
          }
        }

        if (result.error) {
          console.error(`\n${c.red('Error:')} ${terminalSafe(result.error, process.stderr)}`);
        }
      };

      try {
        if (options.wait) {
          const timeoutSeconds = parseDecimalOption(options.timeout, '--timeout', {
            min: 0,
            exclusiveMin: true,
            max: MAX_JOB_WAIT_TIMEOUT_SECONDS,
          });

          const status = await waitForVideoStatus(
            () => getVideoStatus(queueId, options.model),
            timeoutSeconds * 1000,
            jobPollIntervalMs(),
            format === 'json' ? undefined : currentStatus => {
              const elapsed = currentStatus.execution_duration
                ? `${Math.ceil(currentStatus.execution_duration / 1000)}s`
                : '';
              console.log(
                `Status: ${terminalSafe(currentStatus.status)}${elapsed ? ` (${elapsed} elapsed)` : ''} - waiting...`
              );
            }
          );
          const exitCode = classifyVideoStatus(status.status) === 'completed' ? 0 : 1;

          printStatus(status);
          if (exitCode !== 0 && format !== 'json' && !status.error) {
            console.error(formatError(`Video generation ended with status "${status.status}".`));
          }
          process.exitCode = exitCode;
        } else {
          printStatus(await getVideoStatus(queueId, options.model));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Retrieve/download video
  video
    .command('retrieve <queueId>')
    .alias('download')
    .description('Download a completed video')
    .requiredOption('-m, --model <model>', 'Model used for generation')
    .option('-o, --output <path>', 'Output file path', 'output.mp4')
    .option('--url <download_url>', 'Download from the download_url returned when the job was queued')
    .option('--complete', 'Delete media after a successful retrieval')
    .option('--delete', 'Alias for --complete')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const shouldComplete = Boolean(options.complete || options.delete);
        let saved: { bytes: number; content_type: string } | undefined;

        if (options.url !== undefined) {
          if (format !== 'json') {
            console.log(`${c.dim('Downloading video...')}`);
          }
          await downloadVideoFromUrl(options.url, options.output);
        } else {
          const result = await retrieveVideo(queueId, options.model, {
            outputPath: options.output,
            maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
          });

          if (result.kind === 'video') {
            saved = { bytes: result.bytesWritten, content_type: result.contentType };
          } else {
            const status = result.status;
            const downloadUrl = videoUrlFromStatus(status);

            if (!downloadUrl) {
              const phase = classifyVideoStatus(status.status);
              const exitCode = phase === 'processing' ? 2 : 1;

              if (format === 'json') {
                console.log(formatJson(status));
              } else if (phase === 'processing') {
                console.log(`${c.dim('Status:')} ${c.yellow(terminalSafe(status.status))} — video not ready yet.`);
                console.log(`${c.dim('Try again with:')} ${shellCommand`venice video retrieve ${queueId} -m ${options.model}`}`);
              } else if (phase === 'completed' && !status.error) {
                console.error(formatError(
                  `Venice reports the job as ${status.status} but returned no video. ` +
                  'Some models deliver the video only through the download_url returned when the job was queued. ' +
                  `Download it with: ${shellCommand`venice video retrieve ${queueId} -m ${options.model}`} --url <download_url>`
                ));
              } else {
                console.error(formatError(
                  `No video was returned (status: ${status.status})${status.error ? `: ${status.error}` : '.'}`
                ));
              }
              process.exitCode = exitCode;
              return;
            }

            if (format !== 'json') {
              console.log(`${c.dim('Downloading video...')}`);
            }
            await downloadVideoFromUrl(downloadUrl, options.output);
          }
        }

        let deleted = false;
        if (shouldComplete) {
          await completeSavedVideo(queueId, options.model, options.output);
          deleted = true;
        }

        if (format === 'json') {
          console.log(formatJson({
            status: 'completed',
            output: options.output,
            model: options.model,
            ...saved,
            ...(shouldComplete ? { deleted } : {}),
          }));
          return;
        }

        console.log(formatSuccess(`Video saved to ${options.output}`));
        console.log(`${c.dim('Model:')} ${options.model}`);
        if (deleted) {
          console.log(`${c.dim('Cleanup:')} media deleted after retrieval`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  video
    .command('complete <queueId>')
    .description('Delete a retrieved video from Venice storage')
    .requiredOption('-m, --model <model>', 'Model used for generation')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      try {
        const result = await completeVideo(queueId, options.model);
        const exitCode = result.success ? 0 : 1;

        if (format === 'json') {
          console.log(formatJson(result));
        } else if (result.success) {
          console.log(formatSuccess('Video cleaned up from storage.'));
        } else {
          console.error(formatError('Video cleanup did not succeed.'));
        }
        process.exitCode = exitCode;
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  video
    .command('transcribe <video>')
    .description("Transcribe a video's speech, from a local MP4 or WebM file or a public URL")
    .option('-m, --model <model>', 'Model: nvidia/parakeet-tdt-0.6b-v3, openai/whisper-large-v3', 'nvidia/parakeet-tdt-0.6b-v3')
    .option('-l, --language <lang>', 'Spoken language ISO code (e.g., en, es, fr)')
    .option('-t, --timestamps', 'Include word/segment timestamps in output')
    .option('--response-format <format>', 'Transcript format requested from the API (json|text)')
    .option('-f, --format <format>', 'Output format (pretty|json|raw)')
    .action(async (video: string, options) => {
      const format = detectOutputFormat(options.format);
      let source: TranscriptionSource | undefined;
      try {
        const transcribeOptions = parseTranscribeOptions(options);
        source = await transcriptionSource(video);
        await transcribeAndPrint(source.path, transcribeOptions, format);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        // Not process.exit, so the finally block still removes a downloaded copy.
        process.exitCode = 1;
      } finally {
        if (source?.kind === 'download') source.remove();
      }
    });

  video
    .command('upscale <source>')
    .description('Upscale a video with topaz-video-upscale')
    .option('-m, --model <model>', 'Upscale model', 'topaz-video-upscale')
    .option('--factor <n>', 'Upscale factor (1, 2, or 4)', '2')
    .option('-o, --output <path>', 'Output file path', 'upscaled.mp4')
    .option('--no-wait', 'Queue the job without waiting for the result')
    .option('--complete', 'Delete media after a successful download')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (source: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      try {
        const factor = parseUpscaleFactor(options.factor);
        let videoUrl: string;
        if (isPublicHttpUrl(source)) {
          videoUrl = source;
        } else {
          const filePath = path.resolve(source);
          if (!fs.existsSync(filePath)) {
            throw new Error(
              `Video file not found: ${source}. Provide a local MP4/MOV/WebM file or a public HTTP(S) URL.`
            );
          }
          videoUrl = await fileToDataUrl(
            filePath,
            MAX_VIDEO_UPSCALE_BYTES,
            'Video file for upscaling'
          );
        }

        const queued = await queueVideoUpscale(videoUrl, {
          model: options.model,
          upscaleFactor: factor,
        });
        if (options.wait === false) {
          if (format === 'json') {
            console.log(formatJson(queued));
          } else {
            console.log(formatSuccess('Video upscale queued!'));
            console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(queued.queue_id))}`);
            console.log(`${c.dim('Model:')} ${terminalSafe(queued.model)}`);
            printQueuedDownloadUrl(queued);
          }
          return;
        }

        const status = await waitForVideoStatus(
          () => getVideoStatus(queued.queue_id, queued.model),
          DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS * 1000,
          jobPollIntervalMs(),
          format === 'json' ? undefined : current => {
            console.log(`Status: ${terminalSafe(current.status)} - waiting...`);
          }
        );
        if (classifyVideoStatus(status.status) !== 'completed') {
          throw new Error(status.error || `Video upscale finished with status "${status.status}".`);
        }

        const result = await retrieveVideo(queued.queue_id, queued.model, {
          outputPath: options.output,
          maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
        });
        if (result.kind === 'status') {
          const downloadUrl = videoUrlFromStatus(result.status) ?? queued.download_url;
          if (!downloadUrl) {
            throw new Error(
              result.status.error || 'Video upscale completed but no video URL was returned.'
            );
          }
          await downloadVideoFromUrl(downloadUrl, options.output);
        }

        let deleted = false;
        if (options.complete) {
          await completeSavedVideo(queued.queue_id, queued.model, options.output);
          deleted = true;
        }

        if (format === 'json') {
          console.log(formatJson({
            ...queued,
            output: options.output,
            upscale_factor: factor,
            deleted,
          }));
        } else {
          console.log(formatSuccess(`Upscaled video saved to ${options.output}`));
          console.log(`${c.dim('Queue ID:')} ${terminalSafe(queued.queue_id)}`);
          console.log(`${c.dim('Model:')} ${terminalSafe(queued.model)}`);
          console.log(`${c.dim('Factor:')} ${factor}x`);
          if (deleted) {
            console.log(`${c.dim('Cleanup:')} media deleted after download`);
          }
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // List video models
  video
    .command('models')
    .description('List available video generation models')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      let models: Array<{ id: string; name?: string; type: string; description?: string }>;
      let usedFallback = false;

      try {
        const live = await listModels({ type: 'video', showSpinner: false });
        models = live.map((model: Model) => ({
          id: model.id,
          name: model.model_spec?.description,
          type: videoModelKind(model.id),
          description: model.model_spec?.description,
        }));
      } catch {
        usedFallback = true;
        models = FALLBACK_VIDEO_MODELS;
      }

      if (format === 'json') {
        console.log(formatJson({
          models,
          source: usedFallback ? 'fallback' : 'api',
        }));
        return;
      }

      console.log(c.bold('Available Video Models\n'));
      if (usedFallback) {
        console.log(c.yellow('Live catalog unavailable; showing fallback models.\n'));
      } else if (models.length === 0) {
        console.log('No video models were returned by the live API.');
        return;
      }
      const idWidth = Math.max(35, ...models.map((model) => model.id.length + 2));
      console.log(`${c.dim('ID'.padEnd(idWidth))} ${c.dim('Type')}`);
      console.log(c.dim('─'.repeat(idWidth + 20)));

      for (const model of models) {
        const typeColor = model.type === 'text-to-video'
          ? c.green
          : model.type === 'upscale'
            ? c.magenta
            : c.blue;
        console.log(`${c.cyan(terminalSafe(model.id).padEnd(idWidth))} ${typeColor(model.type)}`);
      }

      console.log(`\n${c.dim('T2V = Text-to-Video, I2V = Image-to-Video')}`);
      console.log(`${c.dim('Usage: venice video generate "a cat playing" --model wan-2.6-text-to-video')}`);
    });
}
