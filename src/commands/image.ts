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
import {
  assertFileSizeWithinLimit,
  formatBytes,
  writeBufferToFile,
  MAX_IMAGE_DOWNLOAD_BYTES,
} from '../lib/media.js';
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
  reportError,
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
  enhancePrompt?: boolean;
  webSearch?: boolean;
  promptThinking?: boolean;
  imageFormat?: string;
}

export const MAX_STYLE_REFERENCE_BYTES = 8 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const IMAGE_FILE_FORMATS = ['png', 'jpeg', 'webp'] as const;
export type ImageFileFormat = typeof IMAGE_FILE_FORMATS[number];
const IMAGE_FILE_EXTENSIONS: Record<ImageFileFormat, readonly string[]> = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  webp: ['.webp'],
};

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function resolveStyleReferenceImage(image: string): string {
  if (/^(?:https?:|data:)/i.test(image)) {
    return image;
  }
  if (fs.existsSync(image)) {
    assertFileSizeWithinLimit(image, MAX_STYLE_REFERENCE_BYTES, 'Style reference image');
    return fs.readFileSync(image).toString('base64');
  }
  if (BASE64_PATTERN.test(image)) {
    return image;
  }
  throw new Error(`Style reference file not found: ${image}`);
}

function parseStyleReference(value: string): ImageStyleReference {
  const strengthSuffix = value.match(/^(.*)::(\d*\.?\d+)$/);
  if (!strengthSuffix) {
    return { image: resolveStyleReferenceImage(value) };
  }

  const image = strengthSuffix[1];
  const strength = parseDecimalOption(strengthSuffix[2], '--style-reference strength', { min: 0.1, max: 1 });
  if (!image) {
    throw new Error('Style reference must use IMAGE or IMAGE::STRENGTH');
  }
  return { image: resolveStyleReferenceImage(image), strength };
}

export function parseImageResolution(value: string | undefined): ImageGenerationOptions['resolution'] {
  const resolution = value?.trim().toUpperCase();
  if (value !== undefined && !resolution) {
    throw new Error('Resolution must not be blank');
  }
  if (resolution && !/^\d+(\.\d+)?K$/.test(resolution)) {
    throw new Error('Resolution must be a tier such as 1K, 1.5K, 2K or 4K');
  }
  return resolution;
}

export function parseImageQuality(value: string | undefined): ImageGenerationOptions['quality'] {
  const quality = value?.trim().toLowerCase();
  if (value !== undefined && !quality) {
    throw new Error('Quality must not be blank');
  }
  if (quality && !['low', 'medium', 'high'].includes(quality)) {
    throw new Error('Quality must be one of: low, medium, high');
  }
  return quality as ImageGenerationOptions['quality'];
}

export function parseImageFileFormat(value: string | undefined): ImageFileFormat | undefined {
  if (value === undefined) return undefined;
  const format = value.trim().toLowerCase();
  const normalized = format === 'jpg' ? 'jpeg' : format;
  if (!(IMAGE_FILE_FORMATS as readonly string[]).includes(normalized)) {
    throw new Error('Image format must be one of: png, jpeg, webp');
  }
  return normalized as ImageFileFormat;
}

type ImageOutputMode = { kind: 'file'; path: string | undefined } | { kind: 'base64' };

function parseImageOutputMode(options: { output?: string; base64?: boolean }): ImageOutputMode {
  if (options.base64 && options.output !== undefined) {
    throw new Error("--base64 prints the image instead of saving it, so it can't be used with -o.");
  }
  return options.base64 ? { kind: 'base64' } : { kind: 'file', path: options.output };
}

const IMAGE_MIME_TYPES: Record<ImageFileFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export function imageFileFormatOf(bytes: Buffer): ImageFileFormat | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

type SavedImage = { output: string; size_bytes: number; content_type: string };

/**
 * Writes an image under the requested format's extension or, when none was requested, the extension of the
 * format Venice returned, so a default name never claims PNG for a WebP or JPEG.
 */
function saveImage(
  bytes: Buffer,
  outputPath: string | undefined,
  defaultStem: string,
  requested: ImageFileFormat | undefined,
  label: string,
  number?: number
): SavedImage {
  const actual = imageFileFormatOf(bytes);
  let output = imageOutputPath(outputPath, defaultStem, requested ?? actual);
  if (number !== undefined) {
    const extension = path.extname(output);
    output = path.join(path.dirname(output), `${path.basename(output, extension)}_${number}${extension}`);
  }
  writeBufferToFile(bytes, output, { maxBytes: MAX_IMAGE_DOWNLOAD_BYTES, label });
  return { output, size_bytes: bytes.length, content_type: IMAGE_MIME_TYPES[actual ?? requested ?? 'png'] };
}

export function imageOutputPath(
  output: string | undefined,
  defaultStem: string,
  format: ImageFileFormat | undefined
): string {
  const extension = IMAGE_FILE_EXTENSIONS[format ?? 'png'][0];
  if (!output) return `${defaultStem}_${Date.now()}${extension}`;
  if (!format) return output;

  const current = path.extname(output);
  if (IMAGE_FILE_EXTENSIONS[format].includes(current.toLowerCase())) return output;
  return current ? `${output.slice(0, -current.length)}${extension}` : `${output}${extension}`;
}

export function parseImageGenerationOptions(
  options: ImageCommandOptions
): Omit<ImageGenerationOptions, 'output'> {
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

  const resolution = parseImageResolution(options.resolution);
  if (resolution && !aspectRatio) {
    throw new Error('Resolution requires --aspect-ratio; do not combine it with width/height');
  }

  const quality = parseImageQuality(options.quality);

  if (options.negative && options.negative.length > 7500) {
    throw new Error('Negative prompt must not exceed 7500 characters');
  }

  return {
    model: options.model || getDefaultImageModel(),
    width,
    height,
    count,
    format: parseImageFileFormat(options.imageFormat),
    aspectRatio,
    resolution,
    quality,
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
    enhancePrompt: options.enhancePrompt,
    enableWebSearch: options.webSearch,
    disablePromptOptimizationThinking: options.promptThinking === false ? true : undefined,
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
    .option('--resolution <tier>', 'Resolution tier, e.g. 1K, 1.5K, 2K or 4K (supported tiers vary by model)')
    .option('--quality <quality>', 'Output quality (low|medium|high)')
    .option('--style <preset>', 'Style preset')
    .option(
      '--style-reference <image>',
      'Style reference file, URL or base64, optionally IMAGE::STRENGTH (repeatable)',
      collect,
      []
    )
    .option('--enhance-prompt', 'Rewrite the prompt before generation (may add time and cost)')
    .option('--no-enhance-prompt', 'Do not rewrite the prompt before generation')
    .option('--web-search', 'Let supported models use web search (additional credits may apply)')
    .option('--no-prompt-thinking', 'Skip prompt-optimization thinking on supported models')
    .option('--image-format <format>', 'Image file format (png|jpeg|webp)')
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
    .option('--base64', 'Print the images as base64 JSON instead of saving them')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options: ImageCommandOptions & { base64?: boolean }) => {
      const prompt = promptParts.join(' ');
      const format = detectOutputFormat(options.format);

      try {
        const generationOptions = parseImageGenerationOptions(options);
        const outputMode = parseImageOutputMode(options);
        const images = await generateImage(prompt, generationOptions);

        if (outputMode.kind === 'base64') {
          console.log(formatJson({ images: images.map(b64 => ({ b64_json: b64 })) }));
          return;
        }

        const saved = images.map((image, index) => saveImage(
          decodeGeneratedImage(image),
          outputMode.path,
          'image',
          generationOptions.format,
          'Generated image',
          images.length > 1 ? index + 1 : undefined
        ));
        if (format === 'json') {
          console.log(formatJson({ images: saved }));
          return;
        }
        for (const image of saved) {
          console.log(formatSuccess(`Saved to ${image.output}`));
        }
      } catch (error) {
        reportError(error, format);
        process.exit(1);
      }
    });

  program
    .command('image-edit <image> <prompt...>')
    .description('Edit a local image using a text prompt')
    .option('-m, --model <model>', 'Edit model to use')
    .option('-o, --output <path>', 'Save result to file')
    .option('-a, --aspect-ratio <ratio>', 'Output aspect ratio (for example, 16:9 or auto)')
    .option('--resolution <tier>', 'Resolution tier, e.g. 1K, 1.5K, 2K or 4K (supported tiers vary by model)')
    .option('--image-format <format>', 'Image file format (png|jpeg|webp)')
    .option('--enhance-prompt', 'Enhance the prompt using the input image')
    .option('--no-safe-mode', 'Disable adult-content blurring')
    .option('--base64', 'Print the image as base64 JSON instead of saving it')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, promptParts: string[], options) => {
      const format = detectOutputFormat(options.format);
      try {
        const outputMode = parseImageOutputMode(options);
        const resolution = parseImageResolution(options.resolution);
        const imageFormat = parseImageFileFormat(options.imageFormat);
        const result = await editImage(path.resolve(imagePath), promptParts.join(' '), {
          model: options.model,
          aspectRatio: options.aspectRatio,
          resolution,
          outputFormat: imageFormat,
          enhancePrompt: options.enhancePrompt,
          safeMode: options.safeMode,
        });
        writeImageResult(result, outputMode, 'edited', imageFormat, format, 'edited image');
      } catch (error) {
        reportError(error, format);
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
    .option('--resolution <tier>', 'Resolution tier, e.g. 1K, 1.5K, 2K or 4K (supported tiers vary by model)')
    .option('--quality <quality>', 'Output quality (low|medium|high)')
    .option('--image-format <format>', 'Image file format (png|jpeg|webp)')
    .option('--enhance-prompt', 'Enhance the prompt using the input images')
    .option('--no-safe-mode', 'Disable adult-content blurring')
    .option('--base64', 'Print the image as base64 JSON instead of saving it')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePaths: string[], options) => {
      const format = detectOutputFormat(options.format);
      try {
        const outputMode = parseImageOutputMode(options);
        const resolution = parseImageResolution(options.resolution);
        const quality = parseImageQuality(options.quality);
        const imageFormat = parseImageFileFormat(options.imageFormat);
        const result = await multiEditImage(
          imagePaths.map(imagePath => path.resolve(imagePath)),
          options.prompt,
          {
            model: options.model,
            aspectRatio: options.aspectRatio,
            resolution,
            quality,
            outputFormat: imageFormat,
            enhancePrompt: options.enhancePrompt,
            safeMode: options.safeMode,
          }
        );
        writeImageResult(result, outputMode, 'multi_edited', imageFormat, format, 'edited image');
      } catch (error) {
        reportError(error, format);
        process.exit(1);
      }
    });

  program
    .command('image-bg-remove <image>')
    .description('Remove the background from a local image')
    .option('-o, --output <path>', 'Save result to file')
    .option('--base64', 'Print the image as base64 JSON instead of saving it')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, options) => {
      const format = detectOutputFormat(options.format);
      try {
        const outputMode = parseImageOutputMode(options);
        const result = await removeImageBackground(path.resolve(imagePath));
        writeImageResult(result, outputMode, 'cutout', undefined, format, 'cutout');
      } catch (error) {
        reportError(error, format);
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
        reportError(error, format);
        process.exit(1);
      }
    });

  // Upscale image
  program
    .command('upscale <image>')
    .description('Upscale an image')
    .option('-m, --model <model>', 'Model to use')
    .option('-s, --scale <factor>', 'Scale factor (2 or 4)', '2')
    .option('--creativity <number>', 'How much detail the upscaler invents (0-0.02)')
    .option('-o, --output <path>', 'Save result to file')
    .option('--base64', 'Print the image as base64 JSON instead of saving it')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (imagePath: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      let scale: number;
      let creativity: number | undefined;
      let outputMode: ImageOutputMode;
      try {
        outputMode = parseImageOutputMode(options);
        scale = parseIntegerOption(options.scale, '--scale', { allowed: [2, 4] });
        creativity = parseDecimalOption(options.creativity, '--creativity', { min: 0, max: 0.02 });
      } catch (error) {
        reportError(error, format);
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
          creativity,
        });

        if (outputMode.kind === 'base64') {
          console.log(formatJson({
            images: [{
              b64_json: result.bytes.toString('base64'),
              content_type: result.contentType,
              bytes: result.bytes.length,
            }],
          }));
          return;
        }

        const saved = saveImage(result.bytes, outputMode.path, 'upscaled', undefined, 'Upscaled image');
        if (format === 'json') {
          console.log(formatJson({ images: [saved] }));
          return;
        }

        console.log(formatSuccess(`Saved upscaled image to ${saved.output}`));
        if (!options.output) {
          console.log(`${c.dim('Tip: pass -o to choose the output path')}`);
        }
      } catch (error) {
        reportError(error, format);
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
  mode: ImageOutputMode,
  defaultStem: string,
  requested: ImageFileFormat | undefined,
  format: string,
  label: string
): void {
  const imageData = Buffer.from(result);
  if (mode.kind === 'base64') {
    console.log(formatJson({ image: { b64_json: imageData.toString('base64') } }));
    return;
  }

  const saved = saveImage(imageData, mode.path, defaultStem, requested, label);
  if (format === 'json') {
    console.log(formatJson({ image: saved }));
    return;
  }
  console.log(formatSuccess(`Saved ${label} to ${saved.output}`));
}
