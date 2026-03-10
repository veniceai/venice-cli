/**
 * Video Commands - AI video generation
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { queueVideoGeneration, getVideoStatus, retrieveVideo } from '../lib/api.js';
import {
  downloadToFile,
  assertFileSizeWithinLimit,
  mimeTypeFromPath,
  MAX_VIDEO_DOWNLOAD_BYTES,
  MAX_VIDEO_REFERENCE_IMAGE_BYTES,
} from '../lib/media.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

const VIDEO_MODELS = [
  // Wan models
  { id: 'wan-2.6-image-to-video', name: 'Wan 2.6 I2V', type: 'image-to-video' },
  { id: 'wan-2.6-flash-image-to-video', name: 'Wan 2.6 Flash I2V', type: 'image-to-video' },
  { id: 'wan-2.6-text-to-video', name: 'Wan 2.6 T2V', type: 'text-to-video' },
  // Veo3 models
  { id: 'veo3-fast-text-to-video', name: 'Veo3 Fast T2V', type: 'text-to-video' },
  { id: 'veo3-fast-image-to-video', name: 'Veo3 Fast I2V', type: 'image-to-video' },
  { id: 'veo3.1-fast-text-to-video', name: 'Veo3.1 Fast T2V', type: 'text-to-video' },
  // Sora2 models
  { id: 'sora2-text-to-video', name: 'Sora2 T2V', type: 'text-to-video' },
  { id: 'sora2-image-to-video', name: 'Sora2 I2V', type: 'image-to-video' },
  // Kling models
  { id: 'kling-v3-pro-text-to-video', name: 'Kling V3 Pro T2V', type: 'text-to-video' },
  { id: 'kling-v3-pro-image-to-video', name: 'Kling V3 Pro I2V', type: 'image-to-video' },
  // Grok Imagine
  { id: 'grok-imagine-text-to-video', name: 'Grok Imagine T2V', type: 'text-to-video' },
  { id: 'grok-imagine-image-to-video', name: 'Grok Imagine I2V', type: 'image-to-video' },
  // LTX models
  { id: 'ltx2-fast-text-to-video', name: 'LTX2 Fast T2V', type: 'text-to-video' },
  { id: 'ltx2-fast-image-to-video', name: 'LTX2 Fast I2V', type: 'image-to-video' },
];

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

  // Check video status
  video
    .command('status <queueId>')
    .description('Check status of a video generation job')
    .requiredOption('-m, --model <model>', 'Model used for generation')
    .option('-w, --wait', 'Wait for completion (poll every 5s)')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const checkStatus = async (): Promise<void> => {
        const result = await getVideoStatus(queueId, options.model);

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const statusLabel = result.status.toLowerCase();
        const statusColors: Record<string, (s: string) => string> = {
          processing: c.blue,
          completed: c.green,
          failed: c.red,
        };

        const colorFn = statusColors[statusLabel] || c.yellow;
        console.log(`${c.dim('Status:')} ${colorFn(result.status)}`);

        if (result.average_execution_time) {
          const remainMs = Math.max(0, result.average_execution_time - (result.execution_duration || 0));
          console.log(`${c.dim('Estimated remaining:')} ~${Math.ceil(remainMs / 1000)}s`);
        }

        if (result.video_url) {
          console.log(`\n${c.dim('Video URL:')} ${c.cyan(result.video_url)}`);
          console.log(`\n${c.dim('Download with:')} venice video retrieve ${queueId} -m ${options.model}`);
        }

        if (result.error) {
          console.error(`\n${c.red('Error:')} ${result.error}`);
        }
      };

      try {
        if (options.wait) {
          let status = await getVideoStatus(queueId, options.model);
          while (status.status === 'PROCESSING') {
            const elapsed = status.execution_duration ? `${Math.ceil(status.execution_duration / 1000)}s` : '';
            console.log(`Status: ${status.status}${elapsed ? ` (${elapsed} elapsed)` : ''} - waiting...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            status = await getVideoStatus(queueId, options.model);
          }
          if (format === 'json') {
            console.log(JSON.stringify(status, null, 2));
          } else {
            await checkStatus();
          }
        } else {
          await checkStatus();
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
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (queueId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const result = await retrieveVideo(queueId, options.model);

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (!result.video_url) {
          if (result.status) {
            console.log(`${c.dim('Status:')} ${c.yellow(result.status)} — video not ready yet.`);
            console.log(`${c.dim('Try again with:')} venice video retrieve ${queueId} -m ${options.model}`);
          } else {
            console.error(formatError('No video URL returned. The video may still be processing.'));
          }
          return;
        }

        // Download the video
        console.log(`${c.dim('Downloading video...')}`);
        await downloadToFile(result.video_url, options.output, {
          maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
          expectedContentTypePrefixes: ['video/'],
        });

        console.log(formatSuccess(`Video saved to ${options.output}`));
        console.log(`${c.dim('Model:')} ${result.model}`);
        if (result.duration) {
          console.log(`${c.dim('Duration:')} ${result.duration}s`);
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
    .action((options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      if (format === 'json') {
        console.log(JSON.stringify(VIDEO_MODELS, null, 2));
        return;
      }

      console.log(c.bold('Available Video Models\n'));
      console.log(`${c.dim('ID'.padEnd(35))} ${c.dim('Name'.padEnd(20))} ${c.dim('Type')}`);
      console.log(c.dim('─'.repeat(70)));

      for (const model of VIDEO_MODELS) {
        const typeColor = model.type === 'text-to-video' ? c.green : c.blue;
        console.log(`${c.cyan(model.id.padEnd(35))} ${model.name.padEnd(20)} ${typeColor(model.type)}`);
      }

      console.log(`\n${c.dim('T2V = Text-to-Video, I2V = Image-to-Video')}`);
      console.log(`${c.dim('Usage: venice video generate "a cat playing" --model wan-2.6-text-to-video')}`);
    });
}
