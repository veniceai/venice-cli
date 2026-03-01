# Venice CLI

> Privacy-first AI from the command line. No browser. No tracking. Just you and the model.

[![npm version](https://badge.fury.io/js/venice-cli.svg)](https://www.npmjs.com/package/venice-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official command-line interface for [Venice AI](https://venice.ai). Chat with AI models, generate images, convert text to speech, transcribe audio, and more—all from your terminal.

## Installation

```bash
npm install -g venice-cli
```

Or use without installing:

```bash
npx venice-cli chat 'Hello, world!'
```

## Quick Start

1. **Get your API key** from [Venice AI Settings](https://venice.ai/settings/api)

2. **Configure the CLI**:
   ```bash
   venice config set api_key YOUR_API_KEY
   ```
   
   Or use an environment variable:
   ```bash
   export VENICE_API_KEY=YOUR_API_KEY
   ```

3. **Start chatting**:
   ```bash
   venice chat "What is the meaning of life?"
   ```

## Features

- 🤖 **Chat** with state-of-the-art AI models
- 🔍 **Web Search** with AI-powered synthesis
- 🖼️ **Image Generation** from text prompts
- 🔊 **Text-to-Speech** with 35+ voices across languages
- 🎤 **Speech-to-Text** transcription with timestamps
- 🎬 **Video Generation** (text-to-video, image-to-video)
- 📐 **Embeddings** generation
- 🔧 **Function Calling** with built-in tools
- 🎭 **Character Personas** for fun interactions
- 💾 **Conversation History** with continue mode
- 📊 **Usage Tracking** for token monitoring
- 🐚 **Shell Completions** for bash, zsh, fish

## Commands

### Chat

```bash
# Basic chat
venice chat "Explain quantum computing in simple terms"

# Use a specific model
venice chat -m deepseek-v3.2 "Solve this step by step: 15% of 340"

# With a system prompt
venice chat -s "You are a helpful coding assistant" "Write a fizzbuzz in Python"

# Use a character persona
venice chat -c pirate "Tell me about the weather"

# Continue the previous conversation
venice chat --continue "What about the next step?"

# With function calling
venice chat -t calculator,weather "What's 25 * 4.5?"

# JSON output for scripting
venice chat -f json "List 3 colors" | jq '.content'

# Disable streaming
venice chat --no-stream "Quick question"
```

**Options:**

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Model to use (default: kimi-k2-5) |
| `-s, --system <prompt>` | System prompt |
| `-c, --character <name>` | Character persona |
| `-t, --tools <tools>` | Comma-separated list of tools |
| `--interactive-tools` | Approve each tool call |
| `--continue` | Continue last conversation |
| `--no-stream` | Disable streaming output |
| `--web-search` | Enable web search for current information |
| `--no-thinking` | Disable reasoning on reasoning models |
| `--strip-thinking` | Strip thinking blocks from response |
| `--no-venice-prompt` | Disable Venice system prompts |
| `--search-results-in-stream` | Include search results in stream |
| `-f, --format <format>` | Output format (pretty\|json\|markdown\|raw) |

### Web Search

```bash
# Search with AI synthesis
venice search "Latest developments in fusion energy"

# Limit results
venice search -n 10 "Best practices for TypeScript"

# Include citations in response
venice search --citations "Latest AI news"

# Enable deep web scraping
venice search --scrape "Company research on Anthropic"
```

### Image Generation

```bash
# Generate an image
venice image "A serene mountain lake at sunset"

# Save to a file
venice image -o sunset.png "A serene mountain lake at sunset"

# Custom dimensions
venice image -w 1024 -h 768 "Landscape photograph"

# Use a specific model
venice image -m flux-1-dev "Artistic portrait"
```

### Image Upscaling

```bash
# Upscale an image
venice upscale photo.jpg -o photo_upscaled.jpg

# 4x upscale
venice upscale photo.jpg -s 4 -o photo_4x.jpg
```

### Text-to-Speech

```bash
# Generate speech
venice tts "Hello, world!"

# Custom voice and output
venice tts -v bf_emma -o greeting.mp3 "Good morning, everyone!"

# From stdin
echo "Text to speak" | venice tts -o output.mp3
```

### Transcription (Speech-to-Text)

```bash
# Transcribe audio
venice transcribe recording.mp3

# With word/segment timestamps
venice transcribe -t recording.mp3

# Use a specific model (Whisper or Parakeet)
venice transcribe -m openai/whisper-large-v3 interview.wav

# With language hint
venice transcribe -l es spanish_audio.mp3

# JSON output
venice transcribe -f json interview.wav
```

**Available STT Models:**
- `nvidia/parakeet-tdt-0.6b-v3` (default, fast)
- `openai/whisper-large-v3`

### Video Generation

Venice supports AI video generation using state-of-the-art models. Video generation is asynchronous (queue-based).

```bash
# Queue a text-to-video generation
venice video generate "A cat playing with a ball in slow motion"

# Use a specific model
venice video generate -m veo3-fast-text-to-video "Cinematic sunset over mountains"

# Image-to-video with reference image
venice video generate -m wan-2.6-image-to-video -i photo.jpg "The scene comes alive"

# Set duration and aspect ratio
venice video generate -d 10s -a 16:9 "A peaceful forest scene"

# Check status of a video job
venice video status <queue_id>

# Wait for completion (polls every 5s)
venice video status -w <queue_id>

# Download completed video
venice video retrieve <queue_id> -o my_video.mp4

# List available video models
venice video models
```

**Available Video Models:**
- **Wan 2.6**: `wan-2.6-text-to-video`, `wan-2.6-image-to-video`
- **Veo3**: `veo3-fast-text-to-video`, `veo3-fast-image-to-video`
- **Sora2**: `sora2-text-to-video`, `sora2-image-to-video`
- **Kling V3**: `kling-v3-pro-text-to-video`, `kling-v3-pro-image-to-video`
- **Grok Imagine**: `grok-imagine-text-to-video`, `grok-imagine-image-to-video`
- **LTX2**: `ltx2-fast-text-to-video`, `ltx2-fast-image-to-video`

### Models

```bash
# List all models
venice models

# Filter by type
venice models -t image
venice models -t audio

# Show only privacy-preserving models
venice models --privacy

# Search models
venice models -s llama
```

### Embeddings

```bash
# Generate embeddings
venice embeddings "Text to embed"

# Save to file
venice embeddings -o vectors.json "Text to embed"
```

### Configuration

```bash
# Interactive setup
venice config init

# Show current config
venice config show

# Set values
venice config set api_key YOUR_KEY
venice config set default_model kimi-k2-5
venice config set default_voice af_sky

# Get a value
venice config get default_model

# Remove a value
venice config unset default_model

# Show config file path
venice config path
```

**Available config keys:**

| Key | Description |
|-----|-------------|
| `api_key` | Your Venice API key |
| `default_model` | Default chat model |
| `default_image_model` | Default image generation model |
| `default_voice` | Default TTS voice |
| `output_format` | Default output format |
| `no_color` | Disable colored output |
| `show_usage` | Show token usage after requests |

### Conversation History

```bash
# List recent conversations
venice history list

# Show a specific conversation
venice history show

# Clear all history
venice history clear

# Export history
venice history export history.json
```

### Usage Statistics

```bash
# Show last 7 days
venice usage

# Show today only
venice usage --today

# Show this month
venice usage --month

# Custom range
venice usage -d 30
```

### Characters

```bash
# List available characters
venice characters

# Use a character
venice chat -c wizard "What is the nature of magic?"
```

Available characters: `pirate`, `wizard`, `scientist`, `poet`, `coder`, `teacher`, `comedian`, `philosopher`

### Voices

```bash
# List available TTS voices
venice voices
```

### Shell Completions

```bash
# Bash
venice completions bash >> ~/.bashrc

# Zsh
venice completions zsh >> ~/.zshrc

# Fish
venice completions fish > ~/.config/fish/completions/venice.fish
```

## Built-in Tools

The CLI includes several built-in tools for function calling:

| Tool | Description |
|------|-------------|
| `calculator` | Mathematical calculations |
| `weather` | Weather information (simulated) |
| `datetime` | Current date and time |
| `random` | Random number/choice generation |
| `base64` | Base64 encoding/decoding |
| `hash` | Hash generation (md5, sha256, etc.) |

```bash
# Use tools
venice chat -t calculator "What's the square root of 144?"
venice chat -t datetime "What day is it today?"

# Interactive tool approval
venice chat --interactive-tools -t calculator "Calculate 15% tip on $85"
```

## Output Formats

| Format | Description | Use Case |
|--------|-------------|----------|
| `pretty` | Colored, formatted (default) | Interactive use |
| `json` | Machine-readable JSON | Scripting, piping |
| `markdown` | Markdown formatted | Documentation |
| `raw` | Plain text, no decoration | Pipes, simple output |

The CLI automatically detects when output is being piped and switches to `raw` format.

```bash
# Explicit format
venice chat -f json "List items" | jq '.'

# Auto-detected raw format when piped
venice chat "Generate code" | pbcopy
```

## Privacy

Venice CLI is designed with privacy in mind:

- **No browser tracking**: Terminal interactions don't expose browser metadata
- **No telemetry**: The CLI doesn't collect or send usage data
- **Local configuration**: API key stored locally with restricted permissions
- **Transparent**: You can see exactly what's being sent to the API
- **Privacy-preserving models**: Use `venice models --privacy` to find models with no data retention

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VENICE_API_KEY` | API key (overrides config file) |
| `NO_COLOR` | Disable colored output |

## Requirements

- Node.js 18.0.0 or higher
- A Venice AI API key

## Development

```bash
# Clone the repo
git clone https://github.com/veniceai/venice-cli.git
cd venice-cli

# Install dependencies
npm install

# Build
npm run build

# Run locally
npm run dev -- chat "Hello"
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © Venice AI

---

Made with ❤️ for privacy-conscious developers.
