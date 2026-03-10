/**
 * Image Command - Generate and manipulate images
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { generateImage, upscaleImage } from '../lib/api.js';
import { downloadToFile, MAX_IMAGE_DOWNLOAD_BYTES } from '../lib/media.js';
import { getDefaultImageModel } from '../lib/config.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

export function registerImageCommand(program: Command): void {
  // Generate image
  program
    .command('image <prompt...>')
    .description('Generate an image from a text prompt')
    .option('-m, --model <model>', 'Model to use')
    .option('-o, --output <path>', 'Save image to file')
    .option('-w, --width <pixels>', 'Image width', '1024')
    .option('-h, --height <pixels>', 'Image height', '1024')
    .option('-n, --count <number>', 'Number of images to generate', '1')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (promptParts: string[], options) => {
      const prompt = promptParts.join(' ');
      const model = options.model || getDefaultImageModel();
      const format = detectOutputFormat(options.format);

      const width = parseInt(options.width, 10);
      const height = parseInt(options.height, 10);
      const count = parseInt(options.count, 10);

      if (isNaN(width) || width < 64 || width > 4096) {
        console.error(formatError('Width must be a number between 64 and 4096'));
        process.exit(1);
      }
      if (isNaN(height) || height < 64 || height > 4096) {
        console.error(formatError('Height must be a number between 64 and 4096'));
        process.exit(1);
      }
      if (isNaN(count) || count < 1 || count > 10) {
        console.error(formatError('Count must be a number between 1 and 10'));
        process.exit(1);
      }

      try {
        const images = await generateImage(prompt, {
          model,
          width,
          height,
          n: count,
        });

        if (format === 'json') {
          console.log(JSON.stringify({ images: images.map(b64 => ({ b64_json: b64 })) }, null, 2));
          return;
        }

        for (let i = 0; i < images.length; i++) {
          const imageData = Buffer.from(images[i], 'base64');

          let outputPath = options.output || `image_${Date.now()}.png`;
          if (images.length > 1) {
            const ext = path.extname(outputPath);
            const base = path.basename(outputPath, ext);
            const dir = path.dirname(outputPath);
            outputPath = path.join(dir, `${base}_${i + 1}${ext}`);
          }

          fs.writeFileSync(outputPath, imageData);
          console.log(formatSuccess(`Saved to ${outputPath}`));
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

      const scale = parseInt(options.scale, 10);
      if (isNaN(scale) || (scale !== 2 && scale !== 4)) {
        console.error(formatError('Scale must be either 2 or 4'));
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
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (options.output) {
          await downloadToFile(result.url, options.output, {
            maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
            expectedContentTypePrefixes: ['image/'],
          });
          console.log(formatSuccess(`Saved upscaled image to ${options.output}`));
        } else {
          console.log(`${c.cyan('🖼️  Upscaled URL:')} ${result.url}`);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
