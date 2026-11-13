/**
 * Video Commands - AI video generation
 */

import { Command, Option } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { collectOptionValue } from '../lib/chat-attachments.js';
import { parseSpendCap, quoteWithinCap } from '../lib/spend-cap.js';
import {
  TASK_TYPES,
  hasPerReferenceAudio,
  isPublicHttpUrl,
  mediaUrl,
  parseVideoInputs,
  referenceVideoSeconds,
  type TaskType,
  type VideoInputFlags,
  type VideoInputs,
} from '../lib/video-inputs.js';
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
  type QueuedJob,
  type VideoStatusResult,
} from '../lib/api.js';
import {
  downloadToFile,
  fileToDataUrl,
  formatBytes,
  MAX_VIDEO_DOWNLOAD_BYTES,
  MAX_VIDEO_UPSCALE_BYTES,
} from '../lib/media.js';
import { checkMp4Header, fileHasMp4Header, mp4DurationSeconds } from '../lib/mp4.js';
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
import { outputTarget, saveToTarget, type OutputTarget } from '../lib/safe-write.js';
import { apiId, shellCommand } from '../lib/shell-quote.js';
import type { Model, NonEmpty, OutputFormat } from '../types/index.js';

export { isPublicHttpUrl };

export const FALLBACK_VIDEO_MODELS: Array<{ id: string; name: string; type: string }> = [
  { id: 'wan-2.6-text-to-video', name: 'Wan 2.6 T2V', type: 'text-to-video' },
  { id: 'wan-2.6-image-to-video', name: 'Wan 2.6 I2V', type: 'image-to-video' },
  { id: 'veo3.1-fast-text-to-video', name: 'Veo 3.1 Fast T2V', type: 'text-to-video' },
  { id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro T2V', type: 'text-to-video' },
  { id: 'topaz-video-upscale', name: 'Topaz Video Upscale', type: 'upscale' },
];

const DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS = DEFAULT_JOB_WAIT_TIMEOUT_SECONDS;

export function requirePublicVideoUrl(value: string): string {
  if (isPublicHttpUrl(value)) return value;
  throw new Error(
    'Video transcription requires a public HTTP(S) URL. Local files are not supported by the API.'
  );
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

export type VideoConstraints = {
  aspectRatios?: NonEmpty<string>;
  durations?: NonEmpty<string>;
  resolutions?: NonEmpty<string>;
  audio?: { kind: 'fixed'; on: boolean } | { kind: 'configurable' };
  acceptsVideoInput?: boolean;
  acceptsAudioInput?: boolean;
  perReferenceAudio?: boolean;
};

const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

function listedValues(value: unknown): NonEmpty<string> | undefined {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) return undefined;
  const [first, ...rest] = value;
  return first === undefined ? undefined : [first, ...rest];
}

/** What the live catalog lists for a model, or undefined when the catalog can't be read or doesn't list it. */
export async function fetchVideoConstraints(model: string): Promise<VideoConstraints | undefined> {
  let models: Model[];
  try {
    models = await listModels({ type: 'video', showSpinner: false });
  } catch {
    return undefined;
  }
  const spec = models.find((entry) => entry.id === model)?.model_spec as { constraints?: unknown } | undefined;
  if (!spec?.constraints || typeof spec.constraints !== 'object') return undefined;
  const constraints = spec.constraints as Record<string, unknown>;
  const audioOn = flag(constraints.audio);
  return {
    aspectRatios: listedValues(constraints.aspect_ratios),
    durations: listedValues(constraints.durations),
    resolutions: listedValues(constraints.resolutions),
    audio: flag(constraints.audio_configurable)
      ? { kind: 'configurable' }
      : audioOn === undefined ? undefined : { kind: 'fixed', on: audioOn },
    acceptsVideoInput: flag(constraints.video_input),
    acceptsAudioInput: flag(constraints.audio_input),
    perReferenceAudio: flag(constraints.per_reference_audio),
  };
}

/** Rejects inputs the catalog says the model can't take, before anything is quoted or queued. */
export function checkVideoInputs(
  model: string,
  request: { audio?: boolean; inputs: VideoInputs },
  constraints: VideoConstraints | undefined
): void {
  if (!constraints) return;
  const { audio, acceptsVideoInput, acceptsAudioInput, perReferenceAudio } = constraints;
  if (request.audio !== undefined && audio?.kind === 'fixed' && audio.on !== request.audio) {
    throw new Error(`${model} always generates ${audio.on ? 'with' : 'without'} audio, so ${request.audio ? '--audio' : '--no-audio'} can't apply.`);
  }
  if (request.inputs.video && acceptsVideoInput === false) {
    throw new Error(`${model} doesn't take a source video (--video).`);
  }
  if (request.inputs.audio && acceptsAudioInput === false) {
    throw new Error(`${model} doesn't take an audio input (--audio-input).`);
  }
  if (perReferenceAudio === false && hasPerReferenceAudio(request.inputs)) {
    throw new Error(`${model} doesn't take a voice per reference (the "audio" field of --image-reference or --video-reference).`);
  }
}

/** Total seconds of local reference videos for `video quote`, which has no file to upload and so can't take URLs. */
function measureReferenceVideos(values: string[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => {
    if (isPublicHttpUrl(value)) throw new Error('--reference-video: video quote measures reference videos locally, so give a file, not a URL.');
    if (!fs.existsSync(value)) throw new Error(`--reference-video: file not found: ${value}`);
    const seconds = mp4DurationSeconds(value);
    if (seconds === undefined) throw new Error(`--reference-video: can't read the length of ${value}. Use an MP4 or MOV file.`);
    return total + seconds;
  }, 0);
}

/**
 * A model that lists auto or adaptive first fits the ratio to its inputs, so that stays the default.
 * Otherwise 16:9 is preferred over a first listed ratio such as 21:9.
 */
function defaultAspectRatio(listed: NonEmpty<string>): string {
  const [first] = listed;
  if (first === 'auto' || first === 'adaptive') return first;
  return listed.includes('16:9') ? '16:9' : first;
}

/**
 * Fills in a listed aspect ratio (see defaultAspectRatio) and the first listed duration when none is given,
 * and rejects values the model doesn't list, so a request the API would refuse fails before anything is
 * queued. Resolution is only checked, because the API has its own default.
 */
export function applyVideoConstraints(
  model: string,
  options: { aspectRatio?: string; duration?: string; resolution?: string },
  constraints: VideoConstraints | undefined
): { aspectRatio?: string; duration?: string; resolution?: string } {
  const pick = (
    flag: string,
    value: string | undefined,
    listed: NonEmpty<string> | undefined,
    byDefault?: (listed: NonEmpty<string>) => string
  ) => {
    if (!listed) return value;
    if (value === undefined) return byDefault?.(listed);
    if (listed.includes(value)) return value;
    throw new Error(`Invalid ${flag} "${value}" for ${model}. Use one of: ${listed.join(', ')}`);
  };
  return {
    aspectRatio: pick('--aspect-ratio', options.aspectRatio, constraints?.aspectRatios, defaultAspectRatio),
    duration: pick('--duration', options.duration, constraints?.durations, (listed) => listed[0]),
    resolution: pick('--resolution', options.resolution, constraints?.resolutions),
  };
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

/** Saves a completed job's video from /video/retrieve, or from the queue's download_url when retrieve has none. */
async function saveCompletedVideo(
  queued: QueuedJob,
  outputPath: string
): Promise<{ bytesWritten: number; contentType: string }> {
  const result = await retrieveVideo(queued.queue_id, queued.model, {
    outputPath,
    maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
  });
  if (result.kind === 'video') {
    return { bytesWritten: result.bytesWritten, contentType: result.contentType };
  }
  const downloadUrl = videoUrlFromStatus(result.status) ?? queued.download_url;
  if (!downloadUrl) {
    throw new Error(result.status.error || `Venice reports the job as ${result.status.status} but returned no video.`);
  }
  return downloadVideoFromUrl(downloadUrl, outputPath);
}

function retrieveCommand(queued: QueuedJob): string {
  const { queue_id: queueId, model, download_url: downloadUrl } = queued;
  return downloadUrl !== undefined && isPasteableHttpsUrl(downloadUrl)
    ? shellCommand`venice video retrieve ${apiId(queueId)} -m ${apiId(model)} --url ${downloadUrl}`
    : shellCommand`venice video retrieve ${apiId(queueId)} -m ${apiId(model)}`;
}

type VideoRequest = {
  model: string;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  negativePrompt?: string;
  taskType?: TaskType;
  inputs: VideoInputs;
};

type GenerateMode =
  | { kind: 'queue' }
  | { kind: 'wait'; output: OutputTarget; timeoutSeconds: number; afterSave: 'keep' | 'delete' };

type Cleanup = { kind: 'kept' } | { kind: 'deleted' } | { kind: 'failed'; error: string };

/** Reads the flags into one mode, so options that only mean something with --wait can't reach a queue-only run. */
function parseGenerateMode(options: { wait?: boolean; output?: string; timeout?: string; complete?: boolean }): GenerateMode {
  if (options.wait) {
    return {
      kind: 'wait',
      output: outputTarget(options.output, 'output.mp4'),
      timeoutSeconds: parseDecimalOption(
        options.timeout ?? String(DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS),
        '--timeout',
        { min: 0, exclusiveMin: true, max: MAX_JOB_WAIT_TIMEOUT_SECONDS }
      ),
      afterSave: options.complete ? 'delete' : 'keep',
    };
  }
  const waitOnly = Object.entries({
    '--output': options.output,
    '--timeout': options.timeout,
    '--complete': options.complete,
  }).filter(([, value]) => value !== undefined).map(([flag]) => flag);
  if (waitOnly.length > 0) {
    throw new Error(`${waitOnly.join(', ')} ${waitOnly.length === 1 ? 'needs' : 'need'} --wait.`);
  }
  return { kind: 'queue' };
}

function quoteVideoRequest(request: VideoRequest): Promise<{ quote: number }> {
  return quoteVideoGeneration({
    model: request.model,
    duration: request.duration,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    audio: request.audio,
    // Billing reads the start image only to size an auto aspect ratio, so the quote does the same.
    imageUrl: request.aspectRatio === 'auto' && request.inputs.start ? mediaUrl(request.inputs.start.image) : undefined,
    referenceVideoSeconds: referenceVideoSeconds(request.inputs),
  });
}

async function generateAndSaveVideo(
  prompt: string,
  request: VideoRequest,
  quote: number | undefined,
  mode: Extract<GenerateMode, { kind: 'wait' }>,
  format: OutputFormat
): Promise<void> {
  const c = getChalk();
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const queued = await queueVideoGeneration(prompt, request);
  if (format !== 'json') {
    console.log(formatSuccess('Video generation queued!'));
    console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(queued.queue_id))}`);
    console.log(`${c.dim('Model:')} ${terminalSafe(queued.model)}`);
    if (quote !== undefined) console.log(`${c.dim('Price:')} ${c.cyan(`$${quote}`)}`);
  }

  let status: VideoStatusResult;
  try {
    status = await waitForVideoStatus(
      () => getVideoStatus(queued.queue_id, queued.model),
      mode.timeoutSeconds * 1000,
      jobPollIntervalMs(),
      format === 'json' ? undefined : current => {
        console.log(`Status: ${terminalSafe(current.status)} - waiting...`);
      }
    );
  } catch (error) {
    throw new Error(
      `${message(error)}\nThe job is still on Venice. Keep waiting with: ` +
      shellCommand`venice video status ${apiId(queued.queue_id)} -m ${apiId(queued.model)} --wait`
    );
  }

  if (classifyVideoStatus(status.status) !== 'completed') {
    if (format === 'json') {
      console.log(formatJson({ ...status, queue_id: queued.queue_id, model: queued.model }));
    } else {
      console.error(formatError(status.error || `Video generation ended with status "${status.status}".`));
    }
    process.exitCode = 1;
    return;
  }

  let outputPath: string;
  let saved: { bytesWritten: number; contentType: string };
  try {
    ({ outputPath, saved } = await saveToTarget(mode.output, (filePath) => saveCompletedVideo(queued, filePath)));
  } catch (error) {
    throw new Error(`${message(error)}\nThe video is still on Venice. Download it with: ${retrieveCommand(queued)}`);
  }

  // The video is saved, so a failed cleanup is reported rather than raised as an error that invites a paid retry.
  const cleanup: Cleanup = mode.afterSave === 'keep'
    ? { kind: 'kept' }
    : await completeSavedVideo(queued.queue_id, queued.model, outputPath).then(
      (): Cleanup => ({ kind: 'deleted' }),
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
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      quote_usd: quote ?? null,
      ...(cleanup.kind === 'kept' ? {} : { deleted: cleanup.kind === 'deleted' }),
      ...(cleanup.kind === 'failed' ? { cleanup_error: cleanup.error } : {}),
    }));
    return;
  }

  console.log(formatSuccess(`Video saved to ${outputPath}`));
  console.log(`${c.dim('Size:')} ${formatBytes(saved.bytesWritten)}`);
  if (cleanup.kind === 'deleted') {
    console.log(`${c.dim('Cleanup:')} media deleted after download`);
  } else if (cleanup.kind === 'failed') {
    console.log(c.yellow(`Remote cleanup did not complete: ${terminalSafe(cleanup.error)}`));
    console.log(c.dim(`Retry with: ${shellCommand`venice video complete ${apiId(queued.queue_id)} -m ${apiId(queued.model)}`}`));
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
    .description('Queue a video generation job, or with --wait, wait for it and save the video')
    .option('-m, --model <model>', 'Model to use', 'wan-2.6-text-to-video')
    .option('-d, --duration <duration>', "Video duration (e.g., 5s, 10s; default: the model's first listed duration)")
    .option('-a, --aspect-ratio <ratio>', "Aspect ratio (e.g., 16:9; default: 16:9 where the model lists it, unless it lists auto or adaptive first)")
    .option('-r, --resolution <resolution>', 'Resolution (e.g., 720p), one the model lists')
    .option('--audio', 'Generate audio, for models where it can be turned on or off')
    .option('--no-audio', 'Generate without audio, for models where it can be turned on or off')
    .option('--negative-prompt <text>', 'What the video should avoid')
    .option('-i, --image <file|url>', 'Start frame for image-to-video models')
    .option('--end-image <file|url>', 'End frame, for models with end frames or transitions')
    .option('--video <file|url>', 'Source video for video-to-video, edit and motion-control models (MP4, MOV or WebM)')
    .option('--audio-input <file|url>', 'Audio input, for models that take one (WAV or MP3, at most 15 MB)')
    .option('--reference-image <file|url>', 'Reference image (repeatable, up to 30)', collectOptionValue, [])
    .option('--reference-video <file|url>', 'Reference video, MP4 or MOV up to 50 MB (repeatable, up to 10)', collectOptionValue, [])
    .option(
      '--reference-audio <file|url>',
      'Reference audio, WAV or MP3, used with a reference image or video (repeatable, up to 10)',
      collectOptionValue,
      []
    )
    .option(
      '--image-reference <json>',
      'Typed reference image as JSON or a JSON file: {"image", "type", "name", "audio"} (repeatable, up to 30)',
      collectOptionValue,
      []
    )
    .option(
      '--video-reference <json>',
      'Typed reference clip as JSON or a JSON file: {"video", "name", "audio"} (repeatable, up to 5)',
      collectOptionValue,
      []
    )
    .option(
      '--element <json>',
      'Element as JSON or a JSON file: {"frontal_image", "reference_images", "video"} (repeatable, up to 4)',
      collectOptionValue,
      []
    )
    .option('--scene-image <file|url>', 'Scene image for element models (repeatable, up to 4)', collectOptionValue, [])
    .option('--camera-trajectory <json>', 'Camera keyframes as a JSON array or a JSON file; needs -i')
    .addOption(new Option('--task-type <type>', 'Omni-reference task').choices(TASK_TYPES))
    .option('--max-usd <amount>', 'Quote the job first, and refuse it before anything is charged if it costs more than this many US dollars')
    .option('-w, --wait', 'Wait for the video and save it')
    .option('-o, --output <path>', 'With --wait, file to save the video to (default: output.mp4, or output-1.mp4 and so on if it exists)')
    .option(
      '-t, --timeout <seconds>',
      `With --wait, maximum time to wait in seconds (default: ${DEFAULT_VIDEO_STATUS_TIMEOUT_SECONDS}, at most 86400)`
    )
    .option('--complete', 'With --wait, delete the video from Venice after it is saved')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const prompt = promptParts.join(' ');
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const mode = parseGenerateMode(options);
        const cap = parseSpendCap(options.maxUsd as string | undefined);
        const inputs = await parseVideoInputs(options as VideoInputFlags);
        const constraints = await fetchVideoConstraints(options.model);
        const listed = applyVideoConstraints(
          options.model,
          { aspectRatio: options.aspectRatio, duration: options.duration, resolution: options.resolution },
          constraints
        );
        const request: VideoRequest = {
          model: options.model,
          ...listed,
          audio: options.audio as boolean | undefined,
          negativePrompt: options.negativePrompt as string | undefined,
          taskType: options.taskType as TaskType | undefined,
          inputs,
        };
        checkVideoInputs(options.model, request, constraints);
        const quote = await quoteWithinCap(() => quoteVideoRequest(request), cap, { wantPrice: mode.kind === 'wait' });

        if (mode.kind === 'wait') {
          await generateAndSaveVideo(prompt, request, quote, mode, format);
          return;
        }

        const result = await queueVideoGeneration(prompt, request);

        if (format === 'json') {
          console.log(formatJson(quote === undefined ? result : { ...result, quote_usd: quote }));
        } else {
          console.log(formatSuccess('Video generation queued!'));
          console.log(`\n${c.dim('Queue ID:')} ${c.cyan(terminalSafe(result.queue_id))}`);
          console.log(`${c.dim('Model:')} ${terminalSafe(result.model)}`);
          if (quote !== undefined) console.log(`${c.dim('Price:')} ${c.cyan(`$${quote}`)}`);
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
    .option('-d, --duration <duration>', "Video duration (e.g., 5s, 10s; default: the model's first listed duration)")
    .option('-a, --aspect-ratio <ratio>', "Aspect ratio (e.g., 16:9; default: 16:9 where the model lists it, unless it lists auto or adaptive first)")
    .option('-r, --resolution <resolution>', 'Resolution (e.g., 720p, 1080p)')
    .option('--factor <n>', 'Upscale factor for topaz-video-upscale (1, 2, or 4)')
    .option('--audio', 'Include audio in the quote')
    .option('--no-audio', 'Exclude audio from the quote')
    .option('--video-url <url>', 'Source video URL for upscale quotes')
    .option(
      '--reference-video <file>',
      'Local reference video (MP4 or MOV) whose length the quote should include (repeatable)',
      collectOptionValue,
      []
    )
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      const prompt = promptParts.join(' ');

      try {
        const upscaleFactor = options.factor !== undefined ? parseUpscaleFactor(options.factor) : undefined;
        const referenceSeconds = measureReferenceVideos(options.referenceVideo as string[]);
        const listed = applyVideoConstraints(
          options.model,
          { aspectRatio: options.aspectRatio, duration: options.duration, resolution: options.resolution },
          await fetchVideoConstraints(options.model)
        );
        const result = await quoteVideoGeneration({
          model: options.model,
          duration: listed.duration,
          aspectRatio: listed.aspectRatio,
          resolution: listed.resolution,
          upscaleFactor,
          audio: options.audio,
          videoUrl: options.videoUrl,
          referenceVideoSeconds: referenceSeconds,
        });

        if (format === 'json') {
          console.log(formatJson(result));
          return;
        }

        console.log(formatSuccess('Video quote'));
        console.log(`${c.dim('Model:')} ${options.model}`);
        if (listed.duration) console.log(`${c.dim('Duration:')} ${terminalSafe(listed.duration)}`);
        if (listed.aspectRatio) console.log(`${c.dim('Aspect ratio:')} ${terminalSafe(listed.aspectRatio)}`);
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
    .command('transcribe <url>')
    .description('Transcribe speech from a public video URL')
    .option('-f, --format <format>', 'Output format (pretty|json|raw)')
    .action(async (url: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();
      try {
        const result = await transcribeVideo(requirePublicVideoUrl(url));
        if (format === 'json') {
          console.log(formatJson(result));
        } else if (format === 'raw') {
          console.log(terminalSafe(result.transcript));
        } else {
          console.log(formatSuccess('Video transcribed'));
          if (result.lang) console.log(`${c.dim('Language:')} ${terminalSafe(result.lang)}`);
          console.log(`\n${terminalSafe(result.transcript)}`);
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
      let catalog:
        | { source: 'api'; models: Array<{ id: string; name?: string; type: string; description?: string; constraints?: unknown }> }
        | { source: 'fallback'; models: typeof FALLBACK_VIDEO_MODELS };
      try {
        const live = await listModels({ type: 'video', showSpinner: false });
        catalog = {
          source: 'api',
          models: live.map((model: Model) => ({
            id: model.id,
            name: model.model_spec?.description,
            type: videoModelKind(model.id),
            description: model.model_spec?.description,
            constraints: (model.model_spec as { constraints?: unknown } | undefined)?.constraints,
          })),
        };
      } catch {
        catalog = { source: 'fallback', models: FALLBACK_VIDEO_MODELS };
      }
      const { models } = catalog;

      if (format === 'json') {
        console.log(formatJson({ models, source: catalog.source }));
        return;
      }

      console.log(c.bold('Available Video Models\n'));
      if (catalog.source === 'fallback') {
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
