# Venice Code

> AI-powered coding assistant CLI built on Venice AI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A complete, production-ready coding assistant CLI that extends Venice AI with autonomous coding capabilities including file operations, multi-file refactoring, patch generation, semantic search, and intelligent agent workflows.

## Features

🤖 **Autonomous Coding Agent**
- Multi-step problem solving with tool calling
- Automatic file reading and writing
- Intelligent context selection
- Iterative refinement

📁 **File Operations**
- Read and write files safely
- Automatic backups
- Pattern-based file searching
- Git integration

🔧 **Patch Engine**
- Generate unified diffs
- Safe patch application with validation
- Multi-file patch support
- Rollback capability

🔍 **Semantic Search**
- Project-wide embeddings indexing
- Vector-based similarity search
- Intelligent context retrieval
- Incremental updates

💬 **Coding Commands**
- `explain` - Understand code
- `fix` - Debug and fix issues
- `refactor` - Improve code quality
- `testgen` - Generate tests
- `edit` - Make specific changes
- `chat` - Project-aware conversation
- `search` - Semantic code search

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- A Venice AI API key ([Get one here](https://venice.ai/settings/api))

### Install from Source

```bash
# Clone or navigate to the venice-code directory
cd venice-code

# Install dependencies
npm install

# Build the project
npm run build

# Link globally
npm link
```

### Verify Installation

```bash
venice-code --version
```

## Quick Start

### 1. Initialize Configuration

```bash
venice-code init
```

This will prompt you for your Venice API key and set up the configuration.

### 2. Index Your Project

```bash
venice-code index
```

This creates embeddings for semantic search across your codebase.

### 3. Start Coding!

```bash
# Chat about your codebase
venice-code chat "explain the authentication flow"

# Fix an issue
venice-code fix src/auth.ts --issue "login not working"

# Refactor code
venice-code refactor src/utils --pattern "extract common functions"

# Generate tests
venice-code testgen src/parser.ts

# Make specific edits
venice-code edit "add error handling to API calls" -f src/api.ts

# Explain code
venice-code explain src/complex-algorithm.ts

# Search semantically
venice-code search "where is database connection configured"
```

## Commands

### `venice-code init`

Initialize configuration and set up API key.

```bash
venice-code init
```

### `venice-code index`

Index project files for semantic search.

```bash
venice-code index [options]

Options:
  -d, --directory <path>      Directory to index (default: current directory)
  -p, --patterns <patterns>   Comma-separated file patterns to include
```

### `venice-code chat [message]`

Interactive or single-shot chat with project awareness.

```bash
venice-code chat [message] [options]

Options:
  -m, --model <model>    Model to use
  --no-context          Disable automatic context from embeddings
  -v, --verbose         Verbose output
```

**Interactive mode:** Run without a message to start a conversation.

```bash
venice-code chat
```

### `venice-code explain <target>`

Explain code in a file or directory.

```bash
venice-code explain <target> [options]

Options:
  -m, --model <model>    Model to use
  -v, --verbose         Verbose output

Examples:
  venice-code explain src/auth.ts
  venice-code explain src/utils
```

### `venice-code fix <target>`

Find and fix issues in code.

```bash
venice-code fix <target> [options]

Options:
  -m, --model <model>           Model to use
  --issue <description>         Describe the specific issue
  --dry-run                     Preview fixes without applying
  -v, --verbose                Verbose output

Examples:
  venice-code fix src/api.ts --issue "memory leak in connection pool"
  venice-code fix . --dry-run
```

### `venice-code edit <instruction>`

Make specific code changes based on instructions.

```bash
venice-code edit <instruction> [options]

Options:
  -f, --files <files>    Comma-separated list of files to edit
  -m, --model <model>    Model to use
  --dry-run             Preview changes without applying
  -v, --verbose         Verbose output

Examples:
  venice-code edit "add TypeScript types to all functions"
  venice-code edit "rename variable userId to accountId" -f src/auth.ts
```

### `venice-code refactor <target>`

Refactor code for better quality.

```bash
venice-code refactor <target> [options]

Options:
  -m, --model <model>         Model to use
  -p, --pattern <pattern>     Specific refactoring pattern
  --dry-run                  Preview refactoring without applying
  -v, --verbose              Verbose output

Examples:
  venice-code refactor src/legacy.js
  venice-code refactor src --pattern "extract reusable components"
```

### `venice-code testgen <target>`

Generate tests for code.

```bash
venice-code testgen <target> [options]

Options:
  -m, --model <model>      Model to use
  -o, --output <file>      Output test file path
  -v, --verbose           Verbose output

Examples:
  venice-code testgen src/parser.ts
  venice-code testgen src/utils.ts -o tests/utils.test.ts
```

### `venice-code search <query>`

Semantic search in indexed codebase.

```bash
venice-code search <query> [options]

Options:
  -k, --top <number>           Number of results (default: 5)
  -s, --similarity <threshold> Minimum similarity 0-1 (default: 0.7)

Examples:
  venice-code search "authentication logic"
  venice-code search "database queries" -k 10
```

## Configuration

Configuration is stored in `~/.config/venice-code/config.json`.

### Default Configuration

```json
{
  "api_key": "your-api-key",
  "default_model": "qwen-3-235b-a10b",
  "embeddings_model": "text-embedding-3-large",
  "auto_approve": false,
  "backup_enabled": true,
  "index_path": "~/.config/venice-code/index.json",
  "max_file_size": 1048576,
  "ignore_patterns": [
    "node_modules",
    ".git",
    "dist",
    "build",
    "*.log"
  ],
  "verbose": false
}
```

### Environment Variables

- `VENICE_API_KEY` - Override configured API key
- `VENICE_API_BASE_URL` - Custom API endpoint (for development)

## Architecture

Venice Code is built with a modular architecture:

- **CLI Layer** - Commander.js-based command interface
- **Agent System** - Tool-calling loop with autonomous workflows
- **Tools** - File operations, shell commands, git integration
- **Patch Engine** - Unified diff generation and safe application
- **Embeddings** - Project indexing with vector similarity search
- **API Client** - Venice API integration for chat and embeddings

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- chat "hello"

# Build
npm run build

# Clean build artifacts
npm run clean
```

## Safety Features

- **Automatic Backups** - Files are backed up before modification
- **Dry Run Mode** - Preview changes before applying
- **Validation** - Patches are validated before application
- **Rollback** - Failed patches don't corrupt files
- **Size Limits** - Large files are skipped to prevent issues
- **Ignore Patterns** - Respects .gitignore-style patterns

## Examples

### Example 1: Debug an Issue

```bash
$ venice-code fix src/api.ts --issue "API calls timing out"

Fixing issues in: src/api.ts

🤖 Analyzing the code...
✓ Read src/api.ts
✓ Identified issue: Missing timeout configuration in fetch calls
✓ Generated patch

Applying fix:
--- src/api.ts
+++ src/api.ts
@@ -15,10 +15,17 @@
+  const controller = new AbortController();
+  const timeoutId = setTimeout(() => controller.abort(), 30000);
+
   const response = await fetch(url, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(data),
+    signal: controller.signal
   });
+
+  clearTimeout(timeoutId);

✓ Applied patch successfully
✓ Created backup: ~/.config/venice-code/backups/src_api.ts.2026-03-30T19-00-00.backup
```

### Example 2: Semantic Search

```bash
$ venice-code search "where are authentication tokens validated"

Searching codebase...
✓ Found 3 results:

1. src/middleware/auth.ts (lines 45-67)
   Similarity: 92.3%
   
   export function validateToken(token: string): boolean {
     try {
       const decoded = jwt.verify(token, SECRET_KEY);
       return decoded.exp > Date.now() / 1000;
     } catch {
       return false;
     }
   }

2. src/api/client.ts (lines 120-135)
   Similarity: 85.1%
   ...
```

## Troubleshooting

### "No API key found"

Run `venice-code init` to configure your API key, or set the `VENICE_API_KEY` environment variable.

### "No index found"

Run `venice-code index` to create the embeddings index for your project.

### "Failed to apply patch"

The model may have generated an invalid patch. Try adding `--dry-run` to preview changes, or use the `edit` command with more specific instructions.

## License

MIT © Venice AI

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

---

Built with ❤️ using [Venice AI](https://venice.ai) - Privacy-first AI for developers.
