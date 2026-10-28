/**
 * Status handling shared by asynchronous video and music jobs
 */

export type JobStatusPhase = 'processing' | 'completed' | 'failed' | 'other';

type StatusColors = Record<'blue' | 'green' | 'red' | 'yellow', (text: string) => string>;

export const DEFAULT_JOB_WAIT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export function classifyJobStatus(status: string): JobStatusPhase {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');

  if (['processing', 'pending', 'queued', 'in_progress'].includes(normalized)) {
    return 'processing';
  }
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(normalized)) {
    return 'completed';
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(normalized)) {
    return 'failed';
  }
  return 'other';
}

export function colorForJobStatus(status: string, c: StatusColors): (text: string) => string {
  const colors: Record<JobStatusPhase, (text: string) => string> = {
    processing: c.blue,
    completed: c.green,
    failed: c.red,
    other: c.yellow,
  };
  return colors[classifyJobStatus(status)];
}

export function jobPollIntervalMs(): number {
  const override = process.env.NODE_ENV === 'test'
    ? Number(process.env.VENICE_TEST_POLL_INTERVAL_MS)
    : Number.NaN;
  return override > 0 ? override : DEFAULT_POLL_INTERVAL_MS;
}

export async function waitForJobStatus<T extends { status: string }>(
  fetchStatus: () => Promise<T>,
  options: {
    label: string;
    timeoutMs: number;
    pollIntervalMs?: number;
    onPoll?: (status: T) => void;
  }
): Promise<T> {
  const { label, timeoutMs, pollIntervalMs = jobPollIntervalMs(), onPoll } = options;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () =>
    new Error(`Timed out waiting for ${label} after ${Math.ceil(timeoutMs / 1000)} seconds.`);

  const fetchBeforeDeadline = async (): Promise<T> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fetchStatus(),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(timeoutError()), remainingMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  let status = await fetchBeforeDeadline();
  while (classifyJobStatus(status.status) === 'processing') {
    onPoll?.(status);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw timeoutError();
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    status = await fetchBeforeDeadline();
  }

  return status;
}
