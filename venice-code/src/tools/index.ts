/**
 * Tool registry and index
 */

import type { Tool, ToolDefinition } from '../types/index.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { listFilesTool } from './list-files.js';
import { searchFilesTool } from './search-files.js';
import { applyPatchTool } from './apply-patch.js';
import { runShellTool } from './run-shell.js';
import { gitStatusTool } from './git-status.js';
import { gitDiffTool } from './git-diff.js';

/**
 * All available tools
 */
export const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  applyPatchTool,
  runShellTool,
  gitStatusTool,
  gitDiffTool,
];

/**
 * Convert Tool to Venice API ToolDefinition
 */
export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Get all tool definitions for API
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map(toolToDefinition);
}

/**
 * Get tool by name
 */
export function getTool(name: string): Tool | undefined {
  return ALL_TOOLS.find(tool => tool.name === name);
}

/**
 * Execute a tool by name
 */
export async function executeTool(name: string, args: any): Promise<string> {
  const tool = getTool(name);
  
  if (!tool) {
    return `Error: Unknown tool: ${name}`;
  }

  try {
    return await tool.execute(args);
  } catch (error) {
    return `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
