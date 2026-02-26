/**
 * Audio Commands - Text-to-speech and transcription
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { textToSpeech, transcribe } from '../lib/api.js';
import { getDefaultVoice } from '../lib/config.js';
import {
  formatSuccess,
  formatError,
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';

export function registerAudioCommands(program: Command): void {
  // Text to speech
  program
    .command('tts <text...>')
    .alias('speak')
    .description('Convert text to speech')
    .option('-v, --voice <voice>', 'Voice to use (default: af_sky)')
    .option('-m, --model <model>', 'Model to use', 'tts-kokoro')
    .option('-o, --output <path>', 'Output file path', 'output.mp3')
    .option('--format <fmt>', 'Audio format (mp3|wav|opus|aac|flac)', 'mp3')
    .option('-s, --speed <speed>', 'Speech speed (0.25-4.0)', '1.0')
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
        const audioBuffer = await textToSpeech(text, {
          model: options.model,
          voice,
          format: options.format,
        });

        // Determine output path
        let outputPath = options.output;
        if (!outputPath.endsWith(`.${options.format}`)) {
          outputPath = outputPath.replace(/\.[^.]+$/, `.${options.format}`);
        }

        fs.writeFileSync(outputPath, Buffer.from(audioBuffer));
        console.log(formatSuccess(`Saved audio to ${outputPath}`));
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
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action((options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      const voices = [
        // American English - Female
        { id: 'af_sky', name: 'Sky', language: 'en-US', gender: 'Female' },
        { id: 'af_alloy', name: 'Alloy', language: 'en-US', gender: 'Female' },
        { id: 'af_bella', name: 'Bella', language: 'en-US', gender: 'Female' },
        { id: 'af_heart', name: 'Heart', language: 'en-US', gender: 'Female' },
        { id: 'af_jessica', name: 'Jessica', language: 'en-US', gender: 'Female' },
        { id: 'af_nicole', name: 'Nicole', language: 'en-US', gender: 'Female' },
        { id: 'af_nova', name: 'Nova', language: 'en-US', gender: 'Female' },
        { id: 'af_river', name: 'River', language: 'en-US', gender: 'Female' },
        { id: 'af_sarah', name: 'Sarah', language: 'en-US', gender: 'Female' },
        // American English - Male
        { id: 'am_adam', name: 'Adam', language: 'en-US', gender: 'Male' },
        { id: 'am_echo', name: 'Echo', language: 'en-US', gender: 'Male' },
        { id: 'am_eric', name: 'Eric', language: 'en-US', gender: 'Male' },
        { id: 'am_liam', name: 'Liam', language: 'en-US', gender: 'Male' },
        { id: 'am_michael', name: 'Michael', language: 'en-US', gender: 'Male' },
        { id: 'am_onyx', name: 'Onyx', language: 'en-US', gender: 'Male' },
        // British English - Female
        { id: 'bf_alice', name: 'Alice', language: 'en-GB', gender: 'Female' },
        { id: 'bf_emma', name: 'Emma', language: 'en-GB', gender: 'Female' },
        { id: 'bf_lily', name: 'Lily', language: 'en-GB', gender: 'Female' },
        // British English - Male
        { id: 'bm_daniel', name: 'Daniel', language: 'en-GB', gender: 'Male' },
        { id: 'bm_george', name: 'George', language: 'en-GB', gender: 'Male' },
        { id: 'bm_lewis', name: 'Lewis', language: 'en-GB', gender: 'Male' },
        // Other Languages
        { id: 'ff_siwis', name: 'Siwis', language: 'fr-FR', gender: 'Female' },
        { id: 'if_sara', name: 'Sara', language: 'it-IT', gender: 'Female' },
        { id: 'im_nicola', name: 'Nicola', language: 'it-IT', gender: 'Male' },
        { id: 'ef_dora', name: 'Dora', language: 'es-ES', gender: 'Female' },
        { id: 'em_alex', name: 'Alex', language: 'es-ES', gender: 'Male' },
        { id: 'pf_dora', name: 'Dora', language: 'pt-BR', gender: 'Female' },
        { id: 'pm_alex', name: 'Alex', language: 'pt-BR', gender: 'Male' },
        { id: 'jf_nezumi', name: 'Nezumi', language: 'ja-JP', gender: 'Female' },
        { id: 'jm_kumo', name: 'Kumo', language: 'ja-JP', gender: 'Male' },
        { id: 'zf_xiaoxiao', name: 'Xiaoxiao', language: 'zh-CN', gender: 'Female' },
        { id: 'zm_yunxi', name: 'Yunxi', language: 'zh-CN', gender: 'Male' },
      ];

      if (format === 'json') {
        console.log(JSON.stringify(voices, null, 2));
        return;
      }

      console.log(c.bold('Available TTS Voices\n'));
      console.log(`${c.dim('ID'.padEnd(14))} ${c.dim('Name'.padEnd(12))} ${c.dim('Language'.padEnd(8))} ${c.dim('Gender')}`);
      console.log(c.dim('─'.repeat(50)));

      for (const voice of voices) {
        console.log(`${c.cyan(voice.id.padEnd(14))} ${voice.name.padEnd(12)} ${voice.language.padEnd(8)} ${voice.gender}`);
      }

      console.log(`\n${c.dim('Default: af_sky')}`);
      console.log(`${c.dim('Usage: venice tts "Hello world" --voice bf_emma')}`);
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}
