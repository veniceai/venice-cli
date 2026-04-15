import { webSearch } from '../lib/api.js';
import { getDefaultModel } from '../lib/config.js';
import type { CodingTool, ToolResult } from '../types/index.js';

export const webSearchTool: CodingTool = {
  name: 'web_search',
  description:
    'Search the web for current information. Returns AI-synthesized results with source citations.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  },
  isReadOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;

    try {
      const result = await webSearch(query, {
        model: getDefaultModel(),
        maxResults: 5,
        enableCitations: true,
      });

      let output = result.content || '';

      if (result.citations?.length) {
        output += '\n\nSources:';
        for (const cite of result.citations.slice(0, 5)) {
          output += `\n- ${cite.title}: ${cite.url}`;
        }
      }

      return { output };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Web search error: ${msg}`, error: true };
    }
  },
};
