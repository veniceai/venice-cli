import { toolToDefinition } from '../lib/tools.js';
import type { CodingTool, ToolDefinition } from '../types/index.js';

import { fileReadTool } from './file-read.js';
import { fileWriteTool } from './file-write.js';
import { fileEditTool } from './file-edit.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webSearchTool } from './web-search.js';
import { webFetchTool } from './web-fetch.js';
import { gitTool } from './git.js';
import { undoTool } from './undo.js';
import { applyTool } from './apply.js';
import { testRunnerTool } from './test-runner.js';
import { githubTool } from './github.js';

export const CODING_TOOLS: CodingTool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  globTool,
  grepTool,
  gitTool,
  undoTool,
  applyTool,
  testRunnerTool,
  githubTool,
  webSearchTool,
  webFetchTool,
];

const TOOL_MAP = new Map<string, CodingTool>(
  CODING_TOOLS.map((t) => [t.name, t])
);

export function getCodingTool(name: string): CodingTool | undefined {
  return TOOL_MAP.get(name);
}

export function codingToolDefinitions(): ToolDefinition[] {
  return CODING_TOOLS.map(toolToDefinition);
}

export {
  fileReadTool, fileWriteTool, fileEditTool, bashTool,
  globTool, grepTool, gitTool, undoTool, applyTool,
  testRunnerTool, githubTool, webSearchTool, webFetchTool,
};
