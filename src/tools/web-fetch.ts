import type { CodingTool, ToolResult } from '../types/index.js';

const MAX_CONTENT = 32 * 1024; // 32KB

export const webFetchTool: CodingTool = {
  name: 'web_fetch',
  description:
    'Fetch content from a URL. HTML is converted to plain text. ' +
    'Useful for reading documentation, API references, or web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
    },
    required: ['url'],
  },
  isReadOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const url = args.url as string;

    try {
      new URL(url); // validate
    } catch {
      return { output: `Invalid URL: ${url}`, error: true };
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Venice-CLI/2.0',
          'Accept': 'text/html,application/json,text/plain,*/*',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        return { output: `HTTP ${response.status} ${response.statusText}`, error: true };
      }

      const contentType = response.headers.get('content-type') || '';
      const raw = await response.text();

      let content: string;
      if (contentType.includes('html')) {
        content = stripHtml(raw);
      } else {
        content = raw;
      }

      if (content.length > MAX_CONTENT) {
        content = content.slice(0, MAX_CONTENT) +
          `\n\n[Content truncated at ${MAX_CONTENT} characters. Total: ${raw.length}]`;
      }

      return { output: content || '(empty response)' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Fetch error: ${msg}`, error: true };
    }
  },
};

function stripHtml(html: string): string {
  return html
    // Remove script and style blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Convert block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
