/**
 * Responses Command - One-shot requests to the alpha Responses API
 */

import { Command } from 'commander';
import {
  createResponse,
  type ResponsesInputPart,
  type ResponsesRequest,
  type ResponsesResult,
} from '../lib/api.js';
import { getDefaultModel } from '../lib/config.js';
import {
  detectOutputFormat,
  reportError,
  formatJson,
  formatWarning,
  terminalSafe,
} from '../lib/output.js';
import { parseDecimalOption, parseIntegerOption } from '../lib/options.js';
import { assertResponsesResult } from '../lib/response-checks.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../lib/structured-output.js';
import {
  assertLocalAttachmentFiles,
  buildUserMessageContent,
  collectOptionValue,
  parseChatAttachments,
} from '../lib/chat-attachments.js';
import { modelIdRequiresE2EE } from './chat.js';

export const MAX_RESPONSES_STDIN_BYTES = 1024 * 1024;

export function registerResponsesCommand(program: Command): void {
  program
    .command('responses [input...]')
    .description('Send one stateless request to the Responses API (alpha; E2EE models are not supported)')
    .option('-m, --model <model>', 'Model to use')
    .option('--max-output-tokens <n>', 'Maximum number of tokens to generate')
    .option('--temperature <n>', 'Sampling temperature (0-2)')
    .option('--top-p <n>', 'Nucleus sampling (0-1)')
    .option('--reasoning-effort <level>', `Reasoning effort (${REASONING_EFFORTS.join('|')})`)
    .option('--image <path>', 'Attach an image file or URL (repeatable)', collectOptionValue, [])
    .option('-f, --format <format>', 'Output format (pretty|json|raw)')
    .action(async (inputParts: string[], options) => {
      try {
        const format = detectOutputFormat(options.format);
        const model = String(options.model || getDefaultModel());
        if (modelIdRequiresE2EE(model)) {
          throw new Error(
            `The Responses API does not support E2EE models such as "${model}". ` +
            'Use venice chat for end-to-end encrypted requests.'
          );
        }

        const settings: Omit<ResponsesRequest, 'model' | 'input'> = {
          max_output_tokens: parseIntegerOption(options.maxOutputTokens, '--max-output-tokens', { min: 1 }),
          temperature: parseDecimalOption(options.temperature, '--temperature', { min: 0, max: 2 }),
          top_p: parseDecimalOption(options.topP, '--top-p', { min: 0, max: 1 }),
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: parseReasoningEffort(options.reasoningEffort) } }),
        };

        const attachments = parseChatAttachments({ image: options.image });
        assertLocalAttachmentFiles(attachments);

        const prompt = inputParts.join(' ');
        const pipedInput = process.stdin.isTTY ? '' : await readStdin();
        const text = pipedInput && prompt ? `${pipedInput}\n\n${prompt}` : pipedInput || prompt;
        if (!text && attachments.images.length === 0) {
          throw new Error('No input provided. Usage: venice responses "Your message"');
        }

        const input: ResponsesRequest['input'] = attachments.images.length === 0
          ? text
          : [{ role: 'user', content: await buildInputParts(text, attachments) }];

        const response = await createResponse({ model, input, ...settings });
        assertResponsesResult(response);

        if (format === 'json') {
          console.log(formatJson(response));
          return;
        }

        if (response.status === 'failed') {
          throw new Error(`The response failed: ${response.error?.message ?? 'no reason given'}`);
        }
        const output = responseOutputText(response);
        if (output) {
          console.log(terminalSafe(output));
        }
        if (response.status === 'incomplete') {
          const reason = response.incomplete_details?.reason;
          console.error(formatWarning(`The response is incomplete${reason ? ` (${reason})` : ''}.`));
        } else if (!output) {
          console.error(formatWarning('The response contained no text output.'));
        }
      } catch (error) {
        reportError(error, options.format === 'json' ? 'json' : undefined);
        process.exit(1);
      }
    });
}

export function responseOutputText(response: ResponsesResult): string {
  if (typeof response.output_text === 'string') return response.output_text;
  return response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function parseReasoningEffort(value: string): ReasoningEffort {
  const level = String(value).toLowerCase();
  if (!REASONING_EFFORTS.includes(level as ReasoningEffort)) {
    throw new Error(`Invalid --reasoning-effort "${value}". Use one of: ${REASONING_EFFORTS.join(', ')}`);
  }
  return level as ReasoningEffort;
}

async function buildInputParts(
  text: string,
  attachments: ReturnType<typeof parseChatAttachments>
): Promise<ResponsesInputPart[]> {
  const content = await buildUserMessageContent(text, attachments);
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  return parts.map((part): ResponsesInputPart => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url };
    throw new Error(`Unsupported attachment type: ${part.type}`);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_RESPONSES_STDIN_BYTES) {
      throw new Error('Input from stdin exceeds the 1 MiB limit.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}
