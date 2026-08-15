import readline from 'node:readline';

export const REPL_PROMPT = 'you> ';
export const REPL_HELP = 'Commands: /help, exit, quit, Ctrl-C, or Ctrl-D';

export function shouldEnterRepl(prompt: string, stdinIsTTY: boolean | undefined): boolean {
  return prompt.trim() === '' && stdinIsTTY === true;
}

export function isReplExitCommand(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return normalized === 'exit' || normalized === 'quit';
}

export function isReplHelpCommand(line: string): boolean {
  return line.trim().toLowerCase() === '/help';
}

export async function runChatRepl(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onTurn: (prompt: string, signal: AbortSignal) => Promise<void>;
  prompt?: string;
}): Promise<void> {
  const promptLabel = options.prompt ?? REPL_PROMPT;
  const input = options.input as NodeJS.ReadStream;
  const rl = readline.createInterface({
    input: options.input,
    output: options.output,
    terminal: Boolean(input.isTTY),
  });
  rl.setPrompt(promptLabel);

  let closed = false;
  let activeTurn: AbortController | undefined;
  const abortActiveTurn = () => {
    const controller = activeTurn;
    activeTurn = undefined;
    controller?.abort();
  };
  const onSigint = () => {
    options.output.write('\n');
    closed = true;
    abortActiveTurn();
    rl.close();
  };
  rl.on('SIGINT', onSigint);
  rl.on('close', () => {
    closed = true;
    abortActiveTurn();
  });
  rl.prompt();

  try {
    for await (const answer of rl) {
      const line = answer.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (isReplExitCommand(line)) {
        break;
      }
      if (isReplHelpCommand(line)) {
        options.output.write(`${REPL_HELP}\n`);
        rl.prompt();
        continue;
      }
      activeTurn = new AbortController();
      try {
        await options.onTurn(line, activeTurn.signal);
      } finally {
        activeTurn = undefined;
      }
      if (closed) {
        break;
      }
      rl.prompt();
    }
  } finally {
    rl.off('SIGINT', onSigint);
    rl.close();
  }
}
