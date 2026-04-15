/**
 * System Prompt Builder for Codex Mode
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CodingTool } from '../types/index.js';

export async function buildSystemPrompt(
  tools: CodingTool[],
  cwd: string,
  additionalPrompt?: string
): Promise<string> {
  const sections: string[] = [];

  sections.push(
    'You are an expert coding assistant with access to local development tools. ' +
    'You can read, write, and edit files, execute shell commands, search codebases, and fetch web content.\n'
  );

  // Tool descriptions
  sections.push('## Available Tools\n');
  for (const tool of tools) {
    const params = Object.entries(tool.parameters.properties)
      .map(([name, schema]) => {
        const s = schema as { type?: string; description?: string };
        const required = tool.parameters.required?.includes(name) ? ' (required)' : '';
        return `  - ${name}: ${s.description || s.type || 'unknown'}${required}`;
      })
      .join('\n');
    sections.push(`**${tool.name}**: ${tool.description}\n${params}\n`);
  }

  // Guidelines
  sections.push(
    '## Guidelines\n' +
    '- Always read a file before editing it to understand the current content\n' +
    '- Use glob and grep to explore the codebase before making changes\n' +
    '- For file_edit, provide enough surrounding context in old_string to ensure uniqueness\n' +
    '- Use file_write only for new files or complete rewrites\n' +
    '- Run tests after making changes to verify correctness\n' +
    '- Prefer the simplest approach that solves the problem\n' +
    '- When uncertain, explain your reasoning before acting\n'
  );

  // Working directory
  sections.push(`## Working Directory\n${cwd}\n`);

  // Project context
  const projectContext = await loadProjectContext(cwd);
  if (projectContext) {
    sections.push(`## Project Context\n${projectContext}\n`);
  }

  // Additional user prompt
  if (additionalPrompt) {
    sections.push(`## Additional Instructions\n${additionalPrompt}\n`);
  }

  return sections.join('\n');
}

async function loadProjectContext(cwd: string): Promise<string | null> {
  const root = await findProjectRoot(cwd);
  if (!root) return null;

  const contextPaths = [
    path.join(root, '.venice', 'context.md'),
    path.join(root, '.venice', 'INSTRUCTIONS.md'),
  ];

  for (const contextPath of contextPaths) {
    try {
      const content = await fs.readFile(contextPath, 'utf-8');
      if (content.trim()) return content.trim();
    } catch {
      // File does not exist
    }
  }

  return null;
}

export async function findProjectRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;

  while (current !== root) {
    for (const marker of ['.venice', '.git']) {
      try {
        const stat = await fs.stat(path.join(current, marker));
        if (stat.isDirectory()) return current;
      } catch {
        // Not found, continue
      }
    }
    current = path.dirname(current);
  }

  return null;
}
