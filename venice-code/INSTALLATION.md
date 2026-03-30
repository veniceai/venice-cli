# Installation Instructions for Venice Code

## System Requirements

- **Operating System**: Ubuntu 20.04+ (or any Linux distribution)
- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 7.0.0 or higher
- **Venice AI API Key**: Get from https://venice.ai/settings/api

## Installation Steps

### 1. Navigate to Project Directory

```bash
# After cloning or downloading the repository
cd venice-code
```

### 2. Install Dependencies

```bash
npm install
```

This will install all required packages:
- chalk (colored terminal output)
- commander (CLI framework)
- ora (loading spinners)
- micromatch (glob pattern matching)
- TypeScript and dev dependencies

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript source files to JavaScript in the `dist/` directory.

### 4. Link Globally

```bash
npm link
```

This makes the `venice-code` command available globally on your system.

### 5. Verify Installation

```bash
venice-code --version
```

You should see: `1.0.0`

```bash
venice-code --help
```

You should see the list of available commands.

## Initial Setup

### 1. Initialize Configuration

```bash
venice-code init
```

This will:
- Create configuration directory at `~/.config/venice-code/`
- Prompt you for your Venice AI API key
- Set up default configuration

### 2. Get Your API Key

If you don't have a Venice AI API key:

1. Visit https://venice.ai/settings/api
2. Create an account or log in
3. Generate a new API key
4. Copy the key

### 3. Enter Your API Key

When prompted by `venice-code init`, paste your API key.

Alternatively, you can set it as an environment variable:

```bash
export VENICE_API_KEY="your-api-key-here"
```

Add this to your `~/.bashrc` or `~/.zshrc` to make it permanent:

```bash
echo 'export VENICE_API_KEY="your-api-key-here"' >> ~/.bashrc
source ~/.bashrc
```

## First Use

### 1. Index a Project

Navigate to any code project and index it:

```bash
cd ~/your-project
venice-code index
```

This will:
- Scan all code files
- Generate embeddings
- Create a vector store at `~/.config/venice-code/index.json`

### 2. Start Using

Try these commands:

```bash
# Chat about your project
venice-code chat "explain what this project does"

# Explain a file
venice-code explain src/main.ts

# Search semantically
venice-code search "authentication logic"

# Interactive chat
venice-code chat
```

## Configuration

Configuration file location: `~/.config/venice-code/config.json`

Default configuration:

```json
{
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
    "coverage"
  ],
  "verbose": false
}
```

## Troubleshooting

### Command not found

If `venice-code` command is not found after `npm link`:

1. Check npm global bin directory:
   ```bash
   npm config get prefix
   ```

2. Add it to PATH if needed:
   ```bash
   export PATH="$PATH:$(npm config get prefix)/bin"
   ```

### Permission errors

If you get permission errors during `npm link`:

```bash
sudo npm link
```

Or configure npm to use a directory you own:

```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### API key issues

If you get "No API key found" errors:

1. Run `venice-code init` again
2. Or set environment variable:
   ```bash
   export VENICE_API_KEY="your-key"
   ```

### Build errors

If you get build errors:

1. Make sure you have Node.js 18+:
   ```bash
   node --version
   ```

2. Clean and rebuild:
   ```bash
   npm run clean
   npm run build
   ```

## Uninstallation

To uninstall venice-code:

```bash
npm unlink -g venice-code
cd /home/xmrfk/venice-code
npm unlink
```

To remove configuration:

```bash
rm -rf ~/.config/venice-code
```

## Development

To run in development mode without building:

```bash
npm run dev -- chat "hello"
```

To rebuild after making changes:

```bash
npm run build
```

## Directory Structure

After installation, you'll have:

```
venice-code/
├── src/              # TypeScript source files
├── dist/             # Compiled JavaScript (after build)
├── bin/              # Executable script
├── node_modules/     # Dependencies
├── package.json      # Package configuration
├── tsconfig.json     # TypeScript configuration
├── README.md         # Main documentation
└── LICENSE           # MIT License

~/.config/venice-code/
├── config.json       # Your configuration
├── index.json        # Vector store (after indexing)
└── backups/          # File backups (when editing)
```

## Next Steps

1. **Read the README**: Check `/home/xmrfk/venice-code/README.md` for full documentation
2. **Index a project**: Try `venice-code index` in any codebase
3. **Experiment**: Use different commands to explore capabilities
4. **Customize**: Edit `~/.config/venice-code/config.json` to your preferences

## Support

For issues or questions:
- Check the README.md
- Review command help: `venice-code <command> --help`
- Check configuration: `~/.config/venice-code/config.json`

## Complete Feature List

✅ All commands implemented and working
✅ All tools functional
✅ Embeddings and vector search
✅ Patch generation and application
✅ Agent loop with tool calling
✅ Git integration
✅ Shell command execution
✅ Backup system
✅ Configuration management

---

**Ready to code with AI assistance!** 🚀
