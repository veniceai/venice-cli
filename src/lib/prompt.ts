/**
 * Interactive prompts
 *
 * Prompts need a terminal on stdin. A prompt left unanswered (end of input or
 * Ctrl-C) rejects, so the command exits non-zero instead of exiting 0 without
 * doing anything.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

export interface PromptStreams {
  input?: PromptInput;
  output?: NodeJS.WritableStream;
}

function terminalInput(streams: PromptStreams): PromptInput {
  const input = streams.input ?? process.stdin;
  if (!input.isTTY) {
    throw new Error('Cannot prompt for input: stdin is not a terminal.');
  }
  return input;
}

export function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('Input ended before the prompt was answered.'));
    const onInterrupt = () => {
      rl.off('close', onClose);
      rl.close();
      reject(new Error('Input cancelled'));
    };
    rl.once('close', onClose);
    rl.once('SIGINT', onInterrupt);
    rl.question(prompt, (answer) => {
      rl.off('close', onClose);
      rl.off('SIGINT', onInterrupt);
      resolve(answer);
    });
  });
}

/** Asks a yes/no question; only "y" or "yes" counts as yes. */
export async function confirm(prompt: string, streams: PromptStreams = {}): Promise<boolean> {
  const rl = readline.createInterface({
    input: terminalInput(streams),
    output: streams.output ?? process.stdout,
  });
  try {
    const answer = (await question(rl, prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Reads one line from the terminal without echoing it. */
export async function askHidden(prompt: string, streams: PromptStreams = {}): Promise<string> {
  const input = terminalInput(streams);
  const output = streams.output ?? process.stderr;
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({
    input,
    output: mutedOutput,
    terminal: true,
  });

  output.write(prompt);
  try {
    return await question(rl, '');
  } finally {
    rl.close();
    output.write('\n');
  }
}
