import assert from 'node:assert/strict';
import test from 'node:test';
import { canShowSpinner, clearSpinner, startSpinner } from './output.js';

type FakeStream = NodeJS.WritableStream & { isTTY?: boolean; columns?: number; writes: string[] };

function fakeStream(props: { isTTY?: boolean; columns?: number }): FakeStream {
  const writes: string[] = [];
  return {
    ...props,
    writes,
    write(chunk: string | Uint8Array) {
      writes.push(chunk.toString());
      return true;
    },
  } as unknown as FakeStream;
}

function withProperties(
  target: object,
  values: Record<string, unknown>,
  run: () => void
): void {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(target, key, { value, configurable: true, writable: true });
    }
    run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        delete (target as Record<string, unknown>)[key];
      }
    }
  }
}

test('canShowSpinner requires a terminal that reports a usable width', () => {
  assert.equal(canShowSpinner({ isTTY: true, columns: 80 }), true);
  assert.equal(canShowSpinner({ isTTY: true, columns: 0 }), false);
  assert.equal(canShowSpinner({ isTTY: true }), false);
  assert.equal(canShowSpinner({ isTTY: false, columns: 80 }), false);
  assert.equal(canShowSpinner({ columns: 80 }), false);
});

test('startSpinner does not start on a zero-width or non-terminal spinner stream', () => {
  withProperties(process.stdout, { isTTY: true }, () => {
    for (const stream of [
      fakeStream({ isTTY: true, columns: 0 }),
      fakeStream({ isTTY: true }),
      fakeStream({ isTTY: false, columns: 80 }),
    ]) {
      assert.equal(startSpinner('Working...', stream), null);
      assert.deepEqual(stream.writes, []);
      clearSpinner();
    }
  });
});

test('startSpinner checks stderr, the stream the spinner writes to, by default', () => {
  withProperties(process.stdout, { isTTY: true, columns: 80 }, () => {
    withProperties(process.stderr, { isTTY: true, columns: 0 }, () => {
      assert.equal(startSpinner('Working...'), null);
      clearSpinner();
    });
  });
});
