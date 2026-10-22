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
  onTurn: (
    prompt: string,
    signal: AbortSignal,
    askQuestion: (question: string) => Promise<string>
  ) => Promise<void>;
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
  let turnRunning = false;
  let ignoredLines = 0;
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
  const reportIgnoredLines = () => {
    if (ignoredLines === 0) return;
    options.output.write(
      `\n(Ignored ${ignoredLines} line${ignoredLines === 1 ? '' : 's'} entered while the response was running.)\n`
    );
    ignoredLines = 0;
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      rl.off('SIGINT', onSigint);
      rl.close();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    rl.on('SIGINT', onSigint);
    rl.on('close', () => {
      closed = true;
      abortActiveTurn();
      if (!turnRunning) settle();
    });

    // Lines entered while a turn runs are dropped, never queued: queued input
    // would be sent as an unseen chat turn (e.g. an approval typed too early).
    // Answers to askQuestion() never arrive here; readline hands a line to a
    // pending question() instead of emitting 'line'.
    rl.on('line', (answer) => {
      if (closed) return;
      if (turnRunning) {
        ignoredLines++;
        return;
      }
      const line = answer.trim();
      if (!line) {
        rl.prompt();
        return;
      }
      if (isReplExitCommand(line)) {
        rl.close();
        return;
      }
      if (isReplHelpCommand(line)) {
        options.output.write(`${REPL_HELP}\n`);
        rl.prompt();
        return;
      }

      turnRunning = true;
      activeTurn = new AbortController();
      const { signal } = activeTurn;
      const askQuestion = (question: string): Promise<string> =>
        new Promise((resolveAnswer, rejectAnswer) => {
          if (signal.aborted || closed) {
            rejectAnswer(new Error('Question cancelled'));
            return;
          }
          reportIgnoredLines();
          const onAbort = () => rejectAnswer(new Error('Question cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
          rl.question(question, { signal }, (reply) => {
            signal.removeEventListener('abort', onAbort);
            resolveAnswer(reply);
          });
        });

      options.onTurn(line, signal, askQuestion).then(
        () => {
          turnRunning = false;
          activeTurn = undefined;
          if (closed) {
            settle();
            return;
          }
          reportIgnoredLines();
          rl.prompt();
        },
        (error: unknown) => {
          turnRunning = false;
          activeTurn = undefined;
          settle(error);
        }
      );
    });

    rl.prompt();
  });
}
