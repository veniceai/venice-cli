import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyJobStatus, colorForJobStatus, waitForJobStatus } from './job-status.js';

function statusSequence(statuses: string[]): { fetch: () => Promise<{ status: string }>; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)];
      calls++;
      return { status };
    },
    calls: () => calls,
  };
}

test('classifyJobStatus treats every pending alias as still processing', () => {
  for (const status of ['PROCESSING', 'processing', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'in-progress', 'In Progress']) {
    assert.equal(classifyJobStatus(status), 'processing', status);
  }
  assert.equal(classifyJobStatus('COMPLETED'), 'completed');
  assert.equal(classifyJobStatus('succeeded'), 'completed');
  assert.equal(classifyJobStatus('FAILED'), 'failed');
  assert.equal(classifyJobStatus('canceled'), 'failed');
  assert.equal(classifyJobStatus('MYSTERY'), 'other');
});

test('colorForJobStatus shows unrecognised statuses as warnings', () => {
  const c = {
    blue: (text: string) => `blue:${text}`,
    green: (text: string) => `green:${text}`,
    red: (text: string) => `red:${text}`,
    yellow: (text: string) => `yellow:${text}`,
  };

  assert.equal(colorForJobStatus('MYSTERY', c)('MYSTERY'), 'yellow:MYSTERY');
  assert.equal(colorForJobStatus('PENDING', c)('PENDING'), 'blue:PENDING');
  assert.equal(colorForJobStatus('COMPLETED', c)('COMPLETED'), 'green:COMPLETED');
  assert.equal(colorForJobStatus('FAILED', c)('FAILED'), 'red:FAILED');
});

test('waitForJobStatus keeps polling until the job leaves the processing phase', async () => {
  const sequence = statusSequence(['PENDING', 'IN_PROGRESS', 'processing', 'COMPLETED']);
  const polled: string[] = [];

  const result = await waitForJobStatus(sequence.fetch, {
    label: 'test job',
    timeoutMs: 5000,
    pollIntervalMs: 1,
    onPoll: (status) => polled.push(status.status),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(sequence.calls(), 4);
  assert.deepEqual(polled, ['PENDING', 'IN_PROGRESS', 'processing']);
});

test('waitForJobStatus returns failed and unrecognised statuses without polling again', async () => {
  for (const status of ['FAILED', 'MYSTERY']) {
    const sequence = statusSequence([status, 'COMPLETED']);
    const result = await waitForJobStatus(sequence.fetch, {
      label: 'test job',
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    assert.equal(result.status, status);
    assert.equal(sequence.calls(), 1);
  }
});

test('waitForJobStatus names the job when it times out', { timeout: 5_000 }, async () => {
  const sequence = statusSequence(['PROCESSING']);
  await assert.rejects(
    waitForJobStatus(sequence.fetch, { label: 'audio generation', timeoutMs: 30, pollIntervalMs: 5 }),
    /Timed out waiting for audio generation after 1 seconds\./
  );
  assert.ok(sequence.calls() >= 2);
});

test('waitForJobStatus times out when a status request never settles', { timeout: 5_000 }, async () => {
  await assert.rejects(
    waitForJobStatus(() => new Promise<{ status: string }>(() => undefined), {
      label: 'audio generation',
      timeoutMs: 20,
    }),
    /Timed out waiting for audio generation/
  );
});
