# Contributing to Venice CLI

Thank you for your interest in contributing to Venice CLI! This document provides guidelines and information for contributors.

## Code of Conduct

Please be respectful and constructive in all interactions. We want Venice CLI to have a welcoming community.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher (or Bun 1.3.0+)
- npm, yarn, or Bun
- A Venice AI API key for testing

### Development Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/venice-cli.git
   cd venice-cli
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

   Or:
   ```bash
   bun install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

   Or:
   ```bash
   bun run build
   ```

4. Test your changes:
   ```bash
   npm run dev -- chat "Test message"
   ```

   Or:
   ```bash
   bun run dev:bun -- chat "Test message"
   ```

## Project Structure

```
venice-cli/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── commands/          # Command implementations
│   │   ├── chat.ts        # Chat command
│   │   ├── search.ts      # Search command
│   │   ├── image.ts       # Image generation
│   │   ├── audio.ts       # TTS and transcription
│   │   ├── models.ts      # Model listing
│   │   ├── config.ts      # Configuration
│   │   ├── history.ts     # Conversation history
│   │   ├── usage.ts       # Usage statistics
│   │   ├── embeddings.ts  # Embeddings generation
│   │   ├── characters.ts  # Character personas
│   │   └── completions.ts # Shell completions
│   ├── lib/               # Shared utilities
│   │   ├── api.ts         # Venice API client
│   │   ├── config.ts      # Config file management
│   │   ├── output.ts      # Output formatting
│   │   └── tools.ts       # Function calling tools
│   └── types/             # TypeScript type definitions
├── dist/                  # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Development Guidelines

### TypeScript

- Use strict TypeScript (`strict: true` in tsconfig.json)
- Avoid `any` types where possible
- Add JSDoc comments for public functions
- Use proper error types

### Code Style

- Use 2-space indentation
- Use single quotes for strings
- Add trailing commas in multi-line structures
- Keep functions focused and small

### Naming Conventions

- Commands: lowercase, hyphenated (`--output-format`)
- Variables: camelCase
- Types/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE

### Error Handling

- Always provide helpful error messages
- Include suggestions for how to fix the error
- Handle network failures gracefully
- Never expose sensitive information in errors

### Testing

- Test new features manually before submitting
- Test with and without API key configured
- Test with `--no-color` flag
- Test piped output (`venice chat "test" | cat`)

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Commit Messages

Use conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Examples:
```
feat(chat): add --character flag for persona support
fix(config): handle missing config directory on first run
docs(readme): add shell completion instructions
```

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes with clear commits
3. Update documentation if needed
4. Test your changes thoroughly
5. Submit a PR with a clear description

#### PR Description Template

```markdown
## Description
Brief description of the changes.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Refactoring
- [ ] Other (please describe)

## Testing
Describe how you tested the changes.

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-reviewed my own code
- [ ] Added comments for complex logic
- [ ] Updated documentation if needed
- [ ] No new warnings
```

## Adding New Commands

1. Create a new file in `src/commands/`
2. Export a `register*Command(program: Command)` function
3. Import and call it in `src/index.ts`
4. Add documentation to README.md
5. Update shell completions in `src/commands/completions.ts`

Example command structure:

```typescript
import { Command } from 'commander';
import { formatError, getChalk } from '../lib/output.js';

export function registerExampleCommand(program: Command): void {
  program
    .command('example <arg>')
    .description('Example command description')
    .option('-o, --option <value>', 'Option description')
    .action(async (arg: string, options) => {
      const c = getChalk();
      
      try {
        // Command implementation
        console.log(c.green(`Success: ${arg}`));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
```

## Adding New Tools (Function Calling)

1. Add the tool definition to `BUILTIN_TOOLS` in `src/lib/tools.ts`
2. Add the executor function to `toolExecutors`
3. Update the shell completions
4. Document in README.md

## Security Considerations

- Never log API keys or tokens
- Use restrictive file permissions for sensitive files
- Validate all user input
- Don't execute arbitrary code from API responses

## Questions?

Open an issue with the `question` label or reach out to the maintainers.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
