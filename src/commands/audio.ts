/**
 * Audio Commands - Text-to-speech and transcription
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import {
  cloneVoice,
  listTtsModels,
  textToSpeech,
  transcribe,
} from '../lib/api.js';
import { getDefaultVoice } from '../lib/config.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import { MAX_AUDIO_DOWNLOAD_BYTES, writeBufferToFile, writeBufferToNewFile } from '../lib/media.js';

export function registerAudioCommands(program: Command): void {
  // Text to speech
  program
    .command('tts [text...]')
    .alias('speak')
    .description('Convert text to speech')
    .option('-v, --voice <voice>', 'Voice to use (default: af_sky)')
    .option('-m, --model <model>', 'Model to use', 'tts-kokoro')
    .option('-o, --output <path>', 'Output file path')
    .option('--format <fmt>', 'Audio format (mp3|wav|opus|aac|flac|pcm)')
    .option('-s, --speed <speed>', 'Speech speed (0.25-4.0)', '1.0')
    .option('--temperature <temperature>', 'Sampling temperature (0-2)')
    .option('--streaming', 'Request sentence-by-sentence audio streaming')
    .action(async (textParts: string[], options) => {
      let text = textParts.join(' ');
      
      // Read from stdin if no text provided
      if (!text && !process.stdin.isTTY) {
        text = await readStdin();
      }

      if (!text) {
        console.error(formatError('No text provided. Usage: venice tts "Your text"'));
        process.exit(1);
      }

      const voice = options.voice || getDefaultVoice();

      try {
        const speed = parseNumberOption(options.speed, 'speed', 0.25, 4);
        const temperature = options.temperature === undefined
          ? undefined
          : parseNumberOption(options.temperature, 'temperature', 0, 2);
        const requestedFormat = options.format || formatFromOutputPath(options.output);
        const result = await textToSpeech(text, {
          model: options.model,
          voice,
          format: requestedFormat,
          speed,
          temperature,
          streaming: options.streaming,
        });

        // Determine output path
        const audioFormat = requestedFormat || formatFromContentType(result.contentType) || 'mp3';
        const audio = Buffer.from(result.audio);
        const limits = { maxBytes: MAX_AUDIO_DOWNLOAD_BYTES, label: 'Text-to-speech audio' };
        let outputPath: string;
        if (options.output) {
          outputPath = ensureAudioExtension(options.output, audioFormat);
          writeBufferToFile(audio, outputPath, limits);
        } else {
          outputPath = writeBufferToNewFile(audio, defaultSpeechFileName(audioFormat), limits).outputPath;
        }
        console.log(formatSuccess(`Saved audio to ${outputPath}`));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Voice cloning
  program
    .command('voice')
    .description('Create and manage cloned voices')
    .command('clone <audio>')
    .description('Clone a voice from a reference audio sample')
    .option('-m, --model <model>', 'Voice cloning model', 'tts-chatterbox-hd')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (audioPath: string, options) => {
      const format = detectOutputFormat(options.format);
      const resolvedPath = path.resolve(audioPath);

      try {
        const result = await cloneVoice(resolvedPath, { model: options.model });
        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(formatSuccess(`Cloned voice: ${result.id}`));
        console.log(`Model: ${result.model}`);
        console.log(`Use: venice tts -m ${result.model} -v ${result.id} "Hello"`);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Transcription
  program
    .command('transcribe <audio>')
    .description('Transcribe audio to text (STT)')
    .option('-m, --model <model>', 'Model: nvidia/parakeet-tdt-0.6b-v3, openai/whisper-large-v3', 'nvidia/parakeet-tdt-0.6b-v3')
    .option('-l, --language <lang>', 'Audio language ISO code (e.g., en, es, fr)')
    .option('-t, --timestamps', 'Include word/segment timestamps in output')
    .option('-f, --format <format>', 'Output format (pretty|json|raw)')
    .action(async (audioPath: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      // Resolve path
      const resolvedPath = path.resolve(audioPath);
      
      if (!fs.existsSync(resolvedPath)) {
        console.error(formatError(`File not found: ${audioPath}`));
        process.exit(1);
      }

      try {
        const result = await transcribe(resolvedPath, {
          model: options.model,
          language: options.language,
          timestamps: options.timestamps,
        });

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (format === 'raw') {
          console.log(result.text);
        } else {
          console.log(result.text);
          if (options.timestamps && result.timestamps) {
            console.log(`\n${c.dim('─'.repeat(50))}`);
            if (result.timestamps.segment) {
              console.log(c.bold('\nSegments:'));
              for (const seg of result.timestamps.segment) {
                console.log(`${c.dim(`[${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s]`)} ${seg.text}`);
              }
            }
          }
          if (result.duration) {
            console.log(`\n${c.dim(`Duration: ${result.duration.toFixed(2)}s`)}`);
          }
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // List available voices
  program
    .command('voices')
    .description('List available TTS voices')
    .option('-m, --model <model>', 'Only list voices for this model')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        let models = await listTtsModels();
        if (options.model) {
          models = models.filter((model) => model.id === options.model);
        }
        models.sort((a, b) => a.id.localeCompare(b.id));

        const voices = models.flatMap((model) =>
          (model.model_spec?.voices || []).map((voice) => ({
            id: voice,
            model: model.id,
            default: voice === model.model_spec?.default_voice,
          }))
        );

        if (format === 'json') {
          console.log(JSON.stringify(voices, null, 2));
          return;
        }

        if (models.length === 0) {
          console.log(c.yellow('No TTS models found matching your criteria.'));
          return;
        }

        console.log(c.bold(`Available TTS Voices (${voices.length})`));
        for (const model of models) {
          const modelVoices = model.model_spec?.voices || [];
          const cloneLabel = model.model_spec?.voice_cloning
            ? c.dim(` · cloning (${model.model_spec.voice_cloning.retention_days}-day handles)`)
            : '';
          console.log(`\n${c.bold(model.id)}${cloneLabel}`);
          if (modelVoices.length === 0) {
            console.log(c.dim('  No preset voices advertised.'));
            continue;
          }
          console.log(modelVoices.map((voice) =>
            voice === model.model_spec?.default_voice ? `${c.cyan(voice)} ${c.dim('(default)')}` : c.cyan(voice)
          ).join(', '));
        }

        console.log(`\n${c.dim('Usage: venice tts -m <model> -v <voice> "Hello world"')}`);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function parseNumberOption(
  value: string,
  name: string,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function formatFromContentType(contentType?: string): string | undefined {
  const formats: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/opus': 'opus',
    'audio/ogg': 'opus',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/pcm': 'pcm',
    'application/octet-stream': 'pcm',
  };
  return contentType ? formats[contentType.toLowerCase()] : undefined;
}

function formatFromOutputPath(outputPath?: string): string | undefined {
  if (!outputPath) return undefined;

  const extension = path.extname(outputPath).slice(1).toLowerCase();
  const formats = new Set(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']);
  return formats.has(extension) ? extension : undefined;
}

function ensureAudioExtension(outputPath: string, format: string): string {
  const extension = path.extname(outputPath);
  if (extension.toLowerCase() === `.${format}`) return outputPath;
  if (!extension) return `${outputPath}.${format}`;
  return `${outputPath.slice(0, -extension.length)}.${format}`;
}

function defaultSpeechFileName(format: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `speech-${date}-${time}.${format}`;
}
