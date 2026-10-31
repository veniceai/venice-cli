/**
 * Cleanups to run when SIGINT or SIGTERM interrupts the CLI
 */

type Cleanup = () => void;

const cleanups = new Set<Cleanup>();

// The signal handler exits as soon as these return, so they must be synchronous.
export function onInterrupt(cleanup: Cleanup): () => void {
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

export function runInterruptCleanups(): void {
  for (const cleanup of [...cleanups].reverse()) {
    cleanups.delete(cleanup);
    try {
      cleanup();
    } catch {
      // Keep going so one failure does not leave the other files behind.
    }
  }
}
