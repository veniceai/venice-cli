/**
 * Video Commands - AI video generation
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  queueVideoGeneration,
  getVideoStatus,
  retrieveVideo,
  quoteVideoGeneration,
  completeVideo,
  transcribeVideo,
  queueVideoUpscale,
  listModels,
  videoUrlFromStatus,
  type VideoStatusResult,
} from '../lib/api.js';
import {
  downloadToFile,
  assertFileSizeWithinLimit,
  fileToDataUrl,
  mimeTypeFromPath,
  MAX_VIDEO_DOWNLOAD_BYTES,
  MAX_VIDEO_REFERENCE_IMAGE_BYTES,
  MAX_VIDEO_UPSCALE_BYTES,
} from '../lib/media.js';
import { checkMp4Header, fileHasMp4Header } from '../lib/mp4.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import type { Model } from '../types/index.js';

export const FALLBACK_VIDEO_MODELS: Array<{ id: string; name: string; type: string }> = [
  { id: 'wan-2.6-text-to-video', name: 'Wan 2.6 T2V', type: 'text-to-video' },
  { id: 'wan-2.6-image-to-video', name: 'Wan 2.6 I2V', type: 'image-to-video' },
  { id: 'veo3-fast-text-to-video', name: 'Veo3 Fast T2V', type: 'text-to-video' },
  { id: 'sora2-text-to-video', name: 'Sora2 T2V', type: 'text-to-video' },
  { id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro T2V', type: 'text-to-video' },
  { id: 'topaz-video-upscale', name: 'Topaz Video Upscale', type: 'upscale' },
];

const DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS = 600;
const VIDEO_STATUS_POLL_INTERVAL_MS = 5000;

type VideoStatusPhase = 'processing' | 'completed' | 'failed' | 'other';

export function isPublicHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function requirePublicVideoUrl(value: string): string {
  if (isPublicHttpUrl(value)) return value;
  throw new Error(
    'Video transcription requires a public HTTP(S) URL. Local files are not supported by the API.'
  );
}

export function parseUpscaleFactor(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '2'), 10);
  if (![1, 2, 4].includes(parsed)) {
    throw new Error('Upscale factor must be 1, 2, or 4.');
  }
  return parsed;
}

export function videoModelKind(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized.includes('upscale')) return 'upscale';
  if (normalized.includes('image-to-video') || normalized.includes('i2v')) return 'image-to-video';
  if (normalized.includes('text-to-video') || normalized.includes('t2v')) return 'text-to-video';
  return 'video';
}

export function classifyVideoStatus(status: string): VideoStatusPhase {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (['processing', 'pending', 'queued', 'in_progress'].includes(normalized)) {
    return 'processing';
  }
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(normalized)) {
    return 'completed';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(normalized)) {
    return 'failed';
  }
  return 'other';
}

export async function waitForVideoStatus(
  fetchStatus: () => Promise<VideoStatusResult>,
  timeoutMs: number,
  pollIntervalMs = VIDEO_STATUS_POLL_INTERVAL_MS,
  onPoll?: (status: VideoStatusResult) => void
): Promise<VideoStatusResult> {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () =>
    new Error(`Timed out waiting for video generation after ${Math.ceil(timeoutMs / 1000)} seconds.`);

  const fetchBeforeDeadline = async (): Promise<VideoStatusResult> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fetchStatus(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(timeoutError()), remainingMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  let status = await fetchBeforeDeadline();
  while (classifyVideoStatus(status.status) === 'processing') {
    onPoll?.(status);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    status = await fetchBeforeDeadline();
  }

  return status;
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
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatSuccess('Video generation queued!'));
          console.log(`\n${c.dim('Queue ID:')} ${c.cyan(result.queue_id)}`);
          console.log(`${c.dim('Model:')} ${result.model}`);
          console.log(`\n${c.dim('Check status with:')} venice video status ${result.queue_id} -m ${result.model}`);
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
          upscaleFactor: options.factor ? parseUpscaleFactor(options.factor) : undefined,
          audio: options.audio,
          videoUrl: options.videoUrl,
        });

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatSuccess('Video quote'));
        console.log(`${c.dim('Model:')} ${options.model}`);
        console.log(`${c.dim('Duration:')} ${options.duration}`);
        if (options.aspectRatio) console.log(`${c.dim('Aspect ratio:')} ${options.aspectRatio}`);
        if (prompt) console.log(`${c.dim('Prompt:')} ${prompt}`);
        console.log(`${c.dim('Price:')} ${c.cyan(`$${result.quote}`)}`);
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
      'Maximum time to wait in seconds',
      String(DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS)
    )
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const printStatus = (result: VideoStatusResult): void => {
        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const statusColors: Record<VideoStatusPhase, (s: string) => string> = {
          processing: c.blue,
          completed: c.green,
          failed: c.red,
          other: c.yellow,
        };

        const colorFn = statusColors[classifyVideoStatus(result.status)];
        console.log(`${c.dim('Status:')} ${colorFn(result.status)}`);

        if (result.average_execution_time) {
          const remainMs = Math.max(0, result.average_execution_time - (result.execution_duration || 0));
          console.log(`${c.dim('Estimated remaining:')} ~${Math.ceil(remainMs / 1000)}s`);
        }

        const videoUrl = videoUrlFromStatus(result);
        if (videoUrl) {
          console.log(`\n${c.dim('Video URL:')} ${c.cyan(videoUrl)}`);
        }
        if (classifyVideoStatus(result.status) === 'completed') {
          console.log(`\n${c.dim('Download with:')} venice video retrieve ${queueId} -m ${options.model}`);
        }

        if (result.error) {
          console.error(`\n${c.red('Error:')} ${result.error}`);
        }
      };

      try {
        if (options.wait) {
          const timeoutSeconds = Number(options.timeout);
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
            throw new Error('--timeout must be a positive number of seconds.');
          }

          const status = await waitForVideoStatus(
            () => getVideoStatus(queueId, options.model),
            timeoutSeconds * 1000,
            VIDEO_STATUS_POLL_INTERVAL_MS,
            format === 'json' ? undefined : currentStatus => {
              const elapsed = currentStatus.execution_duration
                ? `${Math.ceil(currentStatus.execution_duration / 1000)}s`
                : '';
              console.log(
                `Status: ${currentStatus.status}${elapsed ? ` (${elapsed} elapsed)` : ''} - waiting...`
              );
            }
          );
          printStatus(status);
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
    .option('--complete', 'Delete media after a successful retrieval')
    .option('--delete', 'Alias for --complete')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const shouldComplete = Boolean(options.complete || options.delete);
        const result = await retrieveVideo(queueId, options.model, {
          outputPath: options.output,
          maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
        });

        if (result.kind === 'status') {
          const status = result.status;
          const downloadUrl = videoUrlFromStatus(status);

          if (!downloadUrl) {
            if (format === 'json') {
              console.log(JSON.stringify(status, null, 2));
            } else if (status.status) {
              console.log(`${c.dim('Status:')} ${c.yellow(status.status)} — video not ready yet.`);
              console.log(`${c.dim('Try again with:')} venice video retrieve ${queueId} -m ${options.model}`);
            } else {
              console.error(formatError('No video returned. The video may still be processing.'));
            }
            return;
          }

          if (format !== 'json') {
            console.log(`${c.dim('Downloading video...')}`);
          }
          await downloadVideoFromUrl(downloadUrl, options.output);
        }

        let deleted = false;
        if (shouldComplete) {
          await completeSavedVideo(queueId, options.model, options.output);
          deleted = true;
        }

        if (format === 'json') {
          console.log(JSON.stringify({
            status: 'completed',
            output: options.output,
            model: options.model,
            ...(result.kind === 'video'
              ? { bytes: result.bytesWritten, content_type: result.contentType }
              : {}),
            ...(shouldComplete ? { deleted } : {}),
          }, null, 2));
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
        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(formatSuccess('Video cleaned up from storage.'));
        } else {
          throw new Error('Video cleanup did not succeed.');
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  video
    .command('transcribe <url>')
    .description('Transcribe speech from a public video URL')
    .option('-f, --format <format>', 'Output format (pretty|json|raw)')
    .action(async (url: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      try {
        const result = await transcribeVideo(requirePublicVideoUrl(url));
        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (format === 'raw') {
          console.log(result.transcript);
        } else {
          console.log(formatSuccess('Video transcribed'));
          if (result.lang) console.log(`${c.dim('Language:')} ${result.lang}`);
          console.log(`\n${result.transcript}`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
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
            console.log(JSON.stringify(queued, null, 2));
          } else {
            console.log(formatSuccess('Video upscale queued!'));
            console.log(`\n${c.dim('Queue ID:')} ${c.cyan(queued.queue_id)}`);
            console.log(`${c.dim('Model:')} ${queued.model}`);
          }
          return;
        }

        const status = await waitForVideoStatus(
          () => getVideoStatus(queued.queue_id, queued.model),
          DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS * 1000,
          VIDEO_STATUS_POLL_INTERVAL_MS,
          format === 'json' ? undefined : current => {
            console.log(`Status: ${current.status} - waiting...`);
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
          const downloadUrl = videoUrlFromStatus(result.status);
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
          console.log(JSON.stringify({
            ...queued,
            output: options.output,
            upscale_factor: factor,
            deleted,
          }, null, 2));
        } else {
          console.log(formatSuccess(`Upscaled video saved to ${options.output}`));
          console.log(`${c.dim('Queue ID:')} ${queued.queue_id}`);
          console.log(`${c.dim('Model:')} ${queued.model}`);
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
        console.log(JSON.stringify({
          models,
          source: usedFallback ? 'fallback' : 'api',
        }, null, 2));
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
        console.log(`${c.cyan(model.id.padEnd(idWidth))} ${typeColor(model.type)}`);
      }

      console.log(`\n${c.dim('T2V = Text-to-Video, I2V = Image-to-Video')}`);
      console.log(`${c.dim('Usage: venice video generate "a cat playing" --model wan-2.6-text-to-video')}`);
    });
}
