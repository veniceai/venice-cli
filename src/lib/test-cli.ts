import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: RecordedRequest[];
}

class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}

export function reply(status: number, body: unknown): Reply {
  return new Reply(status, body);
}

/** Answers a request with a 200 JSON body, a reply(), or undefined for a 404. */
export type FakeApi = (request: RecordedRequest) => unknown;

/**
 * Runs the built CLI with its API base URL pointed at a local server whose
 * paths are relative to /api/v1. Unanswered requests get a 404.
 */
export async function runCli(
  args: string[],
  api: FakeApi,
  options: { stdin?: string; cwd?: string } = {}
): Promise<CliRun> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded = {
        method: request.method ?? '',
        path: (request.url ?? '').replace(/^\/api\/v1/, ''),
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
      };
      requests.push(recorded);
      const answer = api(recorded);
      const { status, body } = answer instanceof Reply
        ? answer
        : { status: answer === undefined ? 404 : 200, body: answer };
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body ?? { error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const homeDir = mkdtempSync(join(tmpdir(), 'venice-cli-run-'));

  try {
    const result = await new Promise<Omit<CliRun, 'requests'>>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: options.cwd ?? homeDir,
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          NODE_ENV: 'test',
          NO_COLOR: '1',
          VENICE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          VENICE_API_KEY: 'test-key',
        },
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stdout, stderr }));
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    });
    return { ...result, requests };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(homeDir, { recursive: true, force: true });
  }
}
