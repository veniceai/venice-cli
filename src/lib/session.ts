/**
 * Persistent Session State
 *
 * Saves and restores full session state across invocations.
 * State is stored in .venice/session.json in the project directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Message } from '../types/index.js';

interface SessionState {
  id: string;
  model: string;
  messages: Message[];
  cwd: string;
  createdAt: string;
  updatedAt: string;
  totalTokensUsed: number;
  iterationCount: number;
}

const SESSION_FILENAME = 'session.json';

function getSessionDir(cwd: string): string {
  return path.join(cwd, '.venice');
}

function getSessionPath(cwd: string): string {
  return path.join(getSessionDir(cwd), SESSION_FILENAME);
}

export async function saveSession(
  cwd: string,
  state: {
    id: string;
    model: string;
    messages: Message[];
    totalTokensUsed?: number;
    iterationCount?: number;
  }
): Promise<void> {
  const sessionDir = getSessionDir(cwd);
  const sessionPath = getSessionPath(cwd);

  const existing = await loadSession(cwd);

  const session: SessionState = {
    id: state.id,
    model: state.model,
    messages: state.messages,
    cwd,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalTokensUsed: state.totalTokensUsed || 0,
    iterationCount: state.iterationCount || 0,
  };

  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
  } catch {
    // Silently fail -- session persistence is best-effort
  }
}

export async function loadSession(cwd: string): Promise<SessionState | null> {
  const sessionPath = getSessionPath(cwd);

  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

export async function clearSession(cwd: string): Promise<void> {
  try {
    await fs.unlink(getSessionPath(cwd));
  } catch {
    // Already gone
  }
}

export async function hasSession(cwd: string): Promise<boolean> {
  try {
    await fs.access(getSessionPath(cwd));
    return true;
  } catch {
    return false;
  }
}
