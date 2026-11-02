/**
 * Image Command - Generate and manipulate images
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  editImage,
  generateImage,
  listImageStyles,
  looksLikeImageBytes,
  multiEditImage,
  removeImageBackground,
  upscaleImage,
} from '../lib/api.js';
import { formatBytes, writeBufferToFile, MAX_IMAGE_DOWNLOAD_BYTES } from '../lib/media.js';
import { parseDecimalOption, parseIntegerOption } from '../lib/options.js';
import { getDefaultImageModel } from '../lib/config.js';
import type {
  ImageGenerationOptions,
  ImageStyleReference,
  OutputFormat,
} from '../types/index.js';
import {
  formatSuccess,
  formatError,
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';

interface ImageCommandOptions {
  model?: string;
  output?: string;
  width?: string;
  height?: string;
  count: string;
  format?: OutputFormat;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  style?: string;
  styleReference?: string[];
  negative?: string;
  seed?: string;
  cfgScale?: string;
  steps?: string;
  loraStrength?: string;
  hideWatermark?: boolean;
  safeMode?: boolean;
  embedExifMetadata?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function parseStyleReference(value: string): ImageStyleReference {
  const strengthSuffix = value.match(/^(.*)::(\d*\.?\d+)$/);
  if (!strengthSuffix) {
    return { image: value };
  }

  const image = strengthSuffix[1];
  const strength = parseDecimalOption(strengthSuffix[2], '--style-reference strength', { min: 0.1, max: 1 });
  if (!image) {
    throw new Error('Style reference must use IMAGE or IMAGE::STRENGTH');
  }
  return { image, strength };
}

export function parseImageGenerationOptions(
  options: ImageCommandOptions
): Omit<ImageGenerationOptions, 'output' | 'format'> {
  const width = parseIntegerOption(options.width, '--width', { min: 1, max: 1280 });
  const height = parseIntegerOption(options.height, '--height', { min: 1, max: 1280 });
  const count = parseIntegerOption(options.count, '--count', { min: 1, max: 4 });

  if ((width === undefined) !== (height === undefined)) {
    throw new Error('Width and height must be provided together');
  }

  const aspectRatio = options.aspectRatio?.trim();
  if (options.aspectRatio !== undefined && !aspectRatio) {
    throw new Error('Aspect ratio must not be blank');
  }
  if (aspectRatio && !/^[1-9]\d*:[1-9]\d*$/.test(aspectRatio)) {
    throw new Error('Aspect ratio must use WIDTH:HEIGHT format, for example 16:9');
  }
  if (aspectRatio && width !== undefined) {
    throw new Error('Choose either width/height or aspect ratio; these sizing modes cannot be combined');
  }

  const resolution = options.resolution?.trim().toUpperCase();
  if (options.resolution !== undefined && !resolution) {
    throw new Error('Resolution must not be blank');
  }
  if (resolution && !['1K', '2K', '4K'].includes(resolution)) {
    throw new Error('Resolution must be one of: 1K, 2K, 4K');
  }
  if (resolution && !aspectRatio) {
    throw new Error('Resolution requires --aspect-ratio; do not combine it with width/height');
  }

  const quality = options.quality?.trim().toLowerCase();
  if (options.quality !== undefined && !quality) {
    throw new Error('Quality must not be blank');
  }
  if (quality && !['low', 'medium', 'high'].includes(quality)) {
    throw new Error('Quality must be one of: low, medium, high');
  }

  if (options.negative && options.negative.length > 7500) {
    throw new Error('Negative prompt must not exceed 7500 characters');
  }

  return {
    model: options.model || getDefaultImageModel(),
    width,
    height,
    count,
    aspectRatio,
    resolution: resolution as ImageGenerationOptions['resolution'],
    quality: quality as ImageGenerationOptions['quality'],
    stylePreset: options.style,
    styleReferences: options.styleReference?.length
      ? options.styleReference.map(parseStyleReference)
      : undefined,
    negativePrompt: options.negative,
    seed: parseIntegerOption(options.seed, '--seed', { min: -999999999, max: 999999999 }),
    cfgScale: parseDecimalOption(options.cfgScale, '--cfg-scale', { min: 0, max: 20, exclusiveMin: true }),
    steps: parseIntegerOption(options.steps, '--steps', { min: 1 }),
    loraStrength: parseIntegerOption(options.loraStrength, '--lora-strength', { min: 0, max: 100 }),
    hideWatermark: options.hideWatermark,
    safeMode: options.safeMode,
    embedExifMetadata: options.embedExifMetadata,
  };
}

export function registerImageCommand(program: Command): void {
  // Generate image
  program
    .command('image <prompt...>')
    .description('Generate an image from a text prompt')
    .option('-m, --model <model>', 'Model to use')
    .option('-o, --output <path>', 'Save image to file')
    .option('-w, --width <pixels>', 'Image width (pixel-based models)')
    .option('-h, --height <pixels>', 'Image height (pixel-based models)')
    .option('-a, --aspect-ratio <ratio>', 'Aspect ratio, for example 16:9')
    .option('--resolution <tier>', 'Resolution tier (1K|2K|4K)')
    .option('--quality <quality>', 'Output quality (low|medium|high)')
    .option('--style <preset>', 'Style preset')
    .option(
      '--style-reference <image>',
      'Style reference URL/base64, optionally IMAGE::STRENGTH (repeatable)',
      collect,
      []
    )
    .option('--negative <prompt>', 'Negative prompt')
    .option('--seed <integer>', 'Random seed')
    .option('--cfg-scale <number>', 'CFG scale (greater than 0, up to 20)')
    .option('--steps <integer>', 'Number of inference steps')
    .option('--lora-strength <integer>', 'LoRA strength (0-100)')
    .option('--hide-watermark', 'Request an image without the Venice watermark')
    .option('--no-hide-watermark', 'Request the Venice watermark')
    .option('--safe-mode', 'Blur images classified as adult content')
    .option('--no-safe-mode', 'Disable adult-content blurring')
    .option('--embed-exif-metadata', 'Embed generation details in EXIF metadata')
    .option('--no-embed-exif-metadata', 'Do not embed generation details in EXIF metadata')
    .option('-n, --count <number>', 'Number of images to generate', '1')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options: ImageCommandOptions) => {
      const prompt = promptParts.join(' ');
      const format = detectOutputFormat(options.format);

      try {
        const generationOptions = parseImageGenerationOptions(options);
        const images = await generateImage(prompt, generationOptions);

        if (format === 'json') {
          console.log(formatJson({ images: images.map(b64 => ({ b64_json: b64 })) }));
          return;
        }

        for (let i = 0; i < images.length; i++) {
          const imageData = decodeGeneratedImage(images[i]);

          let outputPath = options.output || `image_${Date.now()}.png`;
          if (images.length > 1) {
            const ext = path.extname(outputPath);
            const base = path.basename(outputPath, ext);
            const dir = path.dirname(outputPath);
            outputPath = path.join(dir, `${base}_${i + 1}${ext}`);
          }

          writeBufferToFile(imageData, outputPath, {
            maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
            label: 'Generated image',
          });
          console.log(formatSuccess(`Saved to ${outputPath}`));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program
    .command('image-edit <image> <prompt...>')
    .description('Edit a local image using a text prompt')
    .option('-m, --model <model>', 'Edit model to use')
    .option('-o, --output <path>', 'Save result to file')
    .option('-a, --aspect-ratio <ratio>', 'Output aspect ratio (for example, 16:9 or auto)')
    .option('--enhance-prompt', 'Enhance the prompt using the input image')
    .option('--no-safe-mode', 'Disable adult-content blurring')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      try {
        const result = await editImage(path.resolve(imagePath), promptParts.join(' '), {
          model: options.model,
          aspectRatio: options.aspectRatio,
          enhancePrompt: options.enhancePrompt,
          safeMode: options.safeMode,
        });
        writeImageResult(result, options.output || `edited_${Date.now()}.png`, format, 'edited image');
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program
    .command('image-multi-edit <images...>')
    .description('Edit using one to three local image layers')
    .requiredOption('-p, --prompt <prompt>', 'Edit instructions')
    .option('-m, --model <model>', 'Edit model to use')
    .option('-o, --output <path>', 'Save result to file')
    .option('-a, --aspect-ratio <ratio>', 'Output aspect ratio (for example, 16:9 or auto)')
    .option('--enhance-prompt', 'Enhance the prompt using the input images')
    .option('--no-safe-mode', 'Disable adult-content blurring')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePaths: string[], options) => {
      const format = detectOutputFormat(options.format);
      try {
        const result = await multiEditImage(
          imagePaths.map(imagePath => path.resolve(imagePath)),
          options.prompt,
          {
            model: options.model,
            aspectRatio: options.aspectRatio,
            enhancePrompt: options.enhancePrompt,
            safeMode: options.safeMode,
          }
        );
        writeImageResult(result, options.output || `multi_edited_${Date.now()}.png`, format, 'edited image');
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program
    .command('image-bg-remove <image>')
    .description('Remove the background from a local image')
    .option('-o, --output <path>', 'Save result to file')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, options) => {
      const format = detectOutputFormat(options.format);
      try {
        const result = await removeImageBackground(path.resolve(imagePath));
        writeImageResult(result, options.output || `cutout_${Date.now()}.png`, format, 'cutout');
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  program
    .command('image-styles')
    .description('List available image style presets')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      try {
        const styles = await listImageStyles();
        if (format === 'json') {
          console.log(formatJson({ data: styles, object: 'list' }));
        } else {
          console.log(terminalSafe(styles.join('\n')));
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Upscale image
  program
    .command('upscale <image>')
    .description('Upscale an image')
    .option('-m, --model <model>', 'Model to use')
    .option('-s, --scale <factor>', 'Scale factor (2 or 4)', '2')
    .option('-o, --output <path>', 'Save result to file')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      let scale: number;
      try {
        scale = parseIntegerOption(options.scale, '--scale', { allowed: [2, 4] });
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }

      const resolvedPath = path.resolve(imagePath);
      
      if (!fs.existsSync(resolvedPath)) {
        console.error(formatError(`File not found: ${imagePath}`));
        process.exit(1);
      }

      try {
        const result = await upscaleImage(resolvedPath, {
          model: options.model,
          scale,
        });

        if (format === 'json') {
          console.log(formatJson({
            images: [{
              b64_json: result.bytes.toString('base64'),
              content_type: result.contentType,
              bytes: result.bytes.length,
            }],
          }));
          return;
        }

        const outputPath = options.output || `upscaled_${Date.now()}.png`;
        writeBufferToFile(result.bytes, outputPath, {
          maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
          label: 'Upscaled image',
        });

        console.log(formatSuccess(`Saved upscaled image to ${outputPath}`));
        if (!options.output) {
          console.log(`${c.dim('Tip: pass -o to choose the output path')}`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

export function decodeGeneratedImage(base64: string): Buffer {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor((base64.length * 3) / 4) - padding;
  if (decodedBytes > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new Error(
      `Generated image is too large (${formatBytes(decodedBytes)}). ` +
      `Maximum allowed size is ${formatBytes(MAX_IMAGE_DOWNLOAD_BYTES)}.`
    );
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new Error('Generated image response was empty.');
  }
  if (!looksLikeImageBytes(bytes)) {
    throw new Error('Generated image did not contain a supported PNG, JPEG, or WebP image.');
  }
  return bytes;
}

function writeImageResult(
  result: ArrayBuffer,
  outputPath: string,
  format: string,
  label: string
): void {
  const imageData = Buffer.from(result);
  if (format === 'json') {
    console.log(formatJson({ image: { b64_json: imageData.toString('base64') } }));
    return;
  }

  writeBufferToFile(imageData, outputPath, {
    maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
    label,
  });
  console.log(formatSuccess(`Saved ${label} to ${outputPath}`));
}
