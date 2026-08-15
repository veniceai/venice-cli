# Venice CLI

> Privacy-first AI from the command line. No browser. No tracking. Just you and the model.

[![npm version](https://badge.fury.io/js/veniceai-cli.svg)](https://www.npmjs.com/package/veniceai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The official command-line interface for [Venice AI](https://venice.ai). Chat with AI models, generate images, convert text to speech, transcribe audio, and more—all from your terminal.

## Installation

```bash
npm install -g veniceai-cli
```

Or use without installing:

```bash
npx veniceai-cli chat 'Hello, world!'
```

## Quick Start

1. **Get your API key** from [Venice AI Settings](https://venice.ai/settings/api)

2. **Configure the CLI**:
   ```bash
   venice config set api_key
   ```

   The CLI prompts for the key without displaying it. For non-interactive use,
   pipe the key over standard input with `venice config set api_key --stdin`.
   
   Or use an environment variable:
   ```bash
   export VENICE_API_KEY=YOUR_API_KEY
   ```

   Environment variables are convenient for CI and headless use, but can be
   inherited by child processes or captured in diagnostic output. Scope them
   to the process that needs them.

3. **Start chatting**:
   ```bash
   venice chat "What is the meaning of life?"
   ```

## Features

- 🤖 **Chat** with state-of-the-art AI models
- 🔐 **End-to-End Encryption (E2EE)** for maximum privacy
- 🛡️ **TEE Attestation** verification for trusted execution
- 🔍 **Web Search** with AI-powered synthesis
- 📄 **Document Parsing** without model inference
- 🌐 **Standalone Web Search & Scraping** for structured retrieval
- 🖼️ **Image Generation** from text prompts
- 🔊 **Text-to-Speech** with 35+ voices across languages
- 🎤 **Speech-to-Text** transcription with timestamps
- 🎵 **Music & Sound Effects Generation** with asynchronous job handling
- 🎬 **Video Generation** (text/image-to-video, quotes, transcription, upscaling, live models)
- 📐 **Embeddings** generation
- 🔧 **Function Calling** with built-in tools
- 🎭 **Character Personas** for fun interactions
- 💾 **Conversation History** with continue mode
- 📊 **Usage Tracking** for token monitoring
- ⛓️ **Crypto RPC** for Ethereum, Base, Solana, and more
- 🐚 **Shell Completions** for bash, zsh, fish

## Commands

### Chat

```bash
# Basic chat
venice chat "Explain quantum computing in simple terms"

# Interactive REPL (TTY, no prompt). Type exit, quit, or Ctrl-C to leave.
venice chat

# Use a specific model
venice chat -m deepseek-v3.2 "Solve this step by step: 15% of 340"

# With a system prompt
venice chat -s "You are a helpful coding assistant" "Write a fizzbuzz in Python"

# Use a character from the Venice API catalog
venice chat -c alan-watts "What is the nature of reality?"

# Continue the previous conversation
venice chat --continue "What about the next step?"

# With function calling
venice chat -t calculator,weather "What's 25 * 4.5?"

# JSON output for scripting
venice chat -f json "List 3 colors" | jq '.content'

# Request JSON object output (no schema)
venice chat --json "extract the fields as JSON"

# Structured JSON matching a schema file
venice chat --json-schema schema.json "extract the fields"

# Control reasoning effort on models that advertise it
venice chat --reasoning-effort high "solve this"

# xAI native search (web + X/Twitter) on supported Grok models
venice chat --x-search "what is trending about venice ai"

# Improve prompt-cache affinity across related requests
venice chat --prompt-cache-key session-123 "continue with cached prefix"

# Attach images, files, audio, or video (repeatable; local path or URL)
venice chat --image photo.jpg "what is in this picture?"
venice chat --file report.pdf "summarize the findings"
venice chat --audio clip.wav "transcribe and answer"
venice chat --video https://example.com/clip.mp4 "describe this clip"

# Use piped context plus an instruction
cat error.log | venice chat "find the root cause"

# Disable streaming
venice chat --no-stream "Quick question"

# E2EE encrypted chat (auto-enabled based on model capabilities)
venice chat -m e2ee-qwen3-5-122b-a10b "This message is end-to-end encrypted"

# TEE-only mode (attestation verified, no encryption)
venice chat -m e2ee-qwen3-5-122b-a10b --no-e2ee "Verified but not encrypted"

# Show TEE attestation details
venice chat -m e2ee-qwen3-5-122b-a10b --tee-verify "Verify the secure enclave"

# Quiet mode - E2EE without status messages (looks like normal chat)
venice chat -m e2ee-qwen3-5-122b-a10b -q "This is encrypted but looks like normal chat"
```

**Options:**

| Option | Description |
|--------|-------------|
| `-m, --model <model>` | Model to use (default: kimi-k2-5) |
| `-s, --system <prompt>` | System prompt |
| `-c, --character <slug>` | Character slug from the Venice API catalog |
| `-t, --tools <tools>` | Comma-separated list of tools |
| `--interactive-tools` | Approve each tool call |
| `--continue` | Continue last conversation (local history only; not covered by TEE/E2EE guarantees) |
| `--no-stream` | Disable streaming output |
| `--web-search` | Enable web search for current information |
| `--x-search` | Enable xAI native search (web + X/Twitter) on supported Grok models |
| `--json` | Request JSON object output without a schema |
| `--json-schema <file>` | Request structured JSON matching a schema file |
| `--reasoning-effort <level>` | Reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `--prompt-cache-key <key>` | Route requests for better prompt-cache affinity |
| `--prompt-cache-retention <mode>` | Prompt cache retention (`default`, `extended`, `24h`) |
| `--image <path>` | Attach an image file or URL (repeatable) |
| `--file <path>` | Attach a document or source file (repeatable) |
| `--audio <path>` | Attach an audio file or URL (repeatable) |
| `--video <path>` | Attach a video file or URL (repeatable) |
| `--no-thinking` | Disable reasoning on reasoning models |
| `--strip-thinking` | Strip thinking blocks from response |
| `--no-venice-prompt` | Disable Venice system prompts |
| `--search-results-in-stream` | Include search results in stream |
| `--e2ee` | Enable E2EE encryption (auto-enabled for models with E2EE capability) |
| `--no-e2ee` | Disable E2EE, use TEE-only mode (verifies attestation without encryption) |
| `--tee-verify` | Show TEE attestation details |
| `-q, --quiet` | Hide E2EE/TEE status messages (show only response) |
| `-f, --format <format>` | Output format (pretty\|json\|markdown\|raw) |

Schema files are limited to 1 MiB and are compiled locally with strict JSON
Schema validation before a completion request is sent. Draft 7, 2019-09, and
2020-12 schemas are supported, including local `$ref` references and standard
formats. Invalid schemas and unsupported keywords are rejected.

Structured output, reasoning effort, and X search are fail-closed features:
the selected model must be present in the model catalog and explicitly
advertise the corresponding capability. They are unavailable when the catalog
cannot be fetched. E2EE does not support structured output, reasoning effort,
or prompt-cache key/retention options.

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

# Return structured results directly (no model inference)
venice search --raw --provider brave -f json "Latest Venice API models"
```

### Document Parsing

Extract text from PDF, DOCX, PPTX, XLSX, and plain text files (up to 25 MB):

```bash
# Print extracted text
venice parse report.pdf

# Save extracted text
venice parse report.pdf -o report.txt

# Include the extracted text and token count as JSON
venice parse report.pdf -f json
```

Parsing runs in memory on Venice infrastructure with zero data retention and does not invoke a model.

### Web Scraping

```bash
# Convert a public page to Markdown
venice scrape https://docs.venice.ai/llms.txt

# Save the Markdown or return the full structured response
venice scrape https://example.com/article -o article.md
venice scrape https://example.com/article -f json
```

### Image Generation

```bash
# Generate an image
venice image "A serene mountain lake at sunset"

# Save to a file
venice image -o sunset.png "A serene mountain lake at sunset"

# Custom dimensions
venice image -w 1024 -h 768 "Landscape photograph"

# Aspect ratio and resolution-tier sizing
venice image -m nano-banana-pro -a 16:9 --resolution 2K --quality medium "Canal at sunset"

# Prompt and style controls
venice image --negative "clouds, rain" --seed 123 --style "3D Model" "A sunny city square"

# Guide the style with one or more references (optional strength: 0.1-1)
venice image --style-reference "https://example.com/style.png::0.75" "A woodland cabin"

# Use a specific model
venice image -m flux-1-dev "Artistic portrait"

# Apply a style preset
venice image --style Cinematic "A gondola at sunset"
```

### Image Editing

```bash
# Edit a local image
venice image-edit photo.jpg "Remove the cars in the background" -o edited.png

# Enhance the prompt using the input image
venice image-edit portrait.jpg "Turn this into an illustration" \
  --enhance-prompt -o illustrated.png

# Edit with up to three layered images
venice image-multi-edit base.jpg overlay.png \
  --prompt "Blend the overlay into the scene" -o composited.png

# Remove a background and save a transparent PNG
venice image-bg-remove product.jpg -o cutout.png

# List available style presets
venice image-styles
venice image-styles --format json
```

Image sizing is model-specific. Use `--width` and `--height` together for
pixel-based models, `--aspect-ratio` for ratio-based models, and add
`--resolution` for models with `1K`, `2K`, or `4K` tiers. These sizing modes
cannot be mixed.

Run `venice image --help` for all generation controls, including CFG scale,
steps, LoRA strength, watermark, safe-mode, and EXIF metadata flags.

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

# Adjust generation and request sentence-by-sentence streaming
venice tts --speed 1.2 --temperature 0.8 --streaming "Hello, world!"

# Browse live, model-specific voice catalogs
venice voices
venice voices --model tts-chatterbox-hd

# Clone a voice, then synthesize with its temporary handle
venice voice clone reference.wav -m tts-chatterbox-hd
venice tts -m tts-chatterbox-hd -v vv_... "Hello from a cloned voice"

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
venice video status <queue_id> -m wan-2.6-text-to-video

# Wait for completion (polls every 5s, times out after 10 minutes)
venice video status -w <queue_id> -m <model>

# Set a custom wait timeout in seconds
venice video status -w <queue_id> -m <model> --timeout 900

# Download completed video
venice video retrieve <queue_id> -m wan-2.6-text-to-video -o my_video.mp4

# Delete media after download, or clean it up later
venice video retrieve <queue_id> -m wan-2.6-text-to-video --complete
venice video complete <queue_id> -m wan-2.6-text-to-video

# Estimate price before queueing
venice video quote -m veo3-fast-text-to-video -d 5s -a 16:9 "sunset"

# Transcribe speech from a public video URL
venice video transcribe https://example.com/clip.mp4

# Upscale a local file or public URL (2x or 4x)
venice video upscale clip.mp4 --factor 2 -o clip_2x.mp4
venice video upscale https://example.com/clip.mp4 --factor 4 --no-wait

# List current video models from the API
venice video models
```

`venice video models` loads the live catalog from `GET /models?type=video`. If that request fails, the CLI prints a short fallback list and says so.

Video transcription accepts a public HTTP(S) URL only. Local MP4, MOV, and WebM files can be upscaled as data URLs within the existing size limit.

### Music & Sound Effects

Generate songs, instrumental tracks, and sound effects with Venice's asynchronous audio pipeline.

```bash
# List current models and their capabilities
venice music models

# Get a price quote
venice music quote -m elevenlabs-music -d 60

# Queue instrumental music
venice music generate -m elevenlabs-music -d 60 --instrumental \
  "Lofi beat on a rainy night"

# Generate a song using lyrics from a file
venice music generate -m elevenlabs-music --lyrics lyrics.txt \
  "A folk song about the sea"

# Check once, or poll until complete
venice music status <queue_id> -m elevenlabs-music
venice music status <queue_id> -m elevenlabs-music --wait

# Download the finished audio
venice music retrieve <queue_id> -m elevenlabs-music -o song.mp3
```

`retrieve` removes the remote media after a successful local write. Pass `--keep`
to retain it, or use `venice music complete <queue_id> -m <model>` to clean it
up later. Optional generation fields are model-specific; inspect
`venice music models --format json` before using lyrics, duration, or
instrumental mode.

### TEE Attestation

Venice supports Trusted Execution Environment (TEE) attestation for models running in secure enclaves. This provides cryptographic proof that your data is processed in a trusted environment.

```bash
# Fetch and display TEE attestation for a model
venice tee attestation tee-qwen3-5-122b-a10b

# With verbose TDX quote details
venice tee attestation --verbose tee-qwen3-5-122b-a10b

# Run TEE attestation policy verification
venice tee verify tee-qwen3-5-122b-a10b

# Verify a response signature (requires completion ID from a previous request)
venice tee signature e2ee-qwen3-5-122b-a10b <completion-id>

# Verify signature matches expected signer address
venice tee signature e2ee-qwen3-5-122b-a10b <completion-id> --verify-signer 0x123...
```

**TEE Commands:**

| Command | Description |
|---------|-------------|
| `attestation <model>` | Fetch and display TEE attestation report |
| `verify <model>` | Run TEE attestation policy verification |
| `signature <model> <id>` | Fetch and verify TEE response signature |

### Models

```bash
# List all models
venice models

# Filter by type
venice models -t image
venice models -t music

# Show only privacy-preserving models
venice models --privacy

# Show TEE-attestable models
venice models --tee

# Show E2EE-capable models
venice models --e2ee

# Search models
venice models -s llama
```

### Embeddings

```bash
# Generate embeddings
venice embeddings "Text to embed"

# Save to file
venice embeddings -o vectors.json "Text to embed"

# From stdin
echo "Text to embed" | venice embeddings
```

### Crypto RPC

Venice proxies JSON-RPC to supported blockchain nodes with the same API key. Listing networks is public and does not require a key.

```bash
# List supported network slugs (no API key required)
venice rpc networks

# Call a JSON-RPC method
venice rpc ethereum-mainnet eth_blockNumber
venice rpc base-mainnet eth_getBalance 0xYourAddress latest

# JSON object/array/number params are parsed; everything else stays a string
venice rpc ethereum-mainnet eth_call '{"to":"0x...","data":"0x..."}' latest

# Batch up to 100 JSON-RPC objects from a file
venice rpc ethereum-mainnet --batch reqs.json

# Machine-readable output
venice rpc ethereum-mainnet eth_chainId -f json
```

Pretty mode prints the JSON-RPC result and, when present, `X-Venice-RPC-Credits` / cost headers. JSON-RPC `error` responses exit non-zero.

**Options:**

| Option | Description |
|--------|-------------|
| `--batch <file>` | JSON array of JSON-RPC 2.0 objects (max 100) |
| `-f, --format <format>` | Output format (pretty\|json) |

### Configuration

```bash
# Interactive setup
venice config init

# Show current config
venice config show

# Set the API key using a hidden prompt
venice config set api_key

# Or read the API key from standard input
printf '%s' "$VENICE_API_KEY" | venice config set api_key --stdin

# Set non-secret values
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

On POSIX systems, the CLI restricts the config directory to `0700` and the
config file to `0600`. Windows does not implement equivalent POSIX permission
bits, so protection there depends on the user profile's inherited ACLs.

### Conversation History

Remote attachments are downloaded by the CLI before the request rather than fetched by the API server. Local files, data URLs, and downloads are MIME-checked, must be non-empty, use per-type size limits and download timeouts, and share a 100 MiB combined attachment limit.

`--continue` replays **local** history from `~/.venice/history.json`. Attachment bytes and source URLs are not retained there; history stores only the message text and generic attachment markers (including a safe filename summary for files). It is not covered by TEE or E2EE enclave guarantees. E2EE and TEE transcripts are not written to history, and `--continue` refuses to mix encrypted and plaintext sessions.

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

### Billing and Account Usage

These commands query Venice account-wide billing data, including usage from
other clients:

```bash
# Current USD and DIEM balances
venice billing balance

# Billed usage from the replacement usage-history endpoint
venice billing usage --days 7

# Aggregated usage by date, model, and API key
venice billing analytics --lookback 30d
```

### API Keys

Key management requires an admin API key. New keys default to the narrower
`INFERENCE` type; the secret returned by `create` is only available once.

```bash
# List key metadata (never includes key secrets)
venice keys list

# Create a bounded inference key
venice keys create --name ci --usd-limit 25 --limit-period month --output ./ci.key

# Show limits for the current key
venice keys rate-limits

# Delete by key ID (interactive confirmation)
venice keys delete <key-id>
```

Use `--force` for intentional non-interactive deletion. `keys create` never
prints the secret in pretty or JSON output. It requires `--output` and creates
that file with mode `0600` without following symlinks or overwriting a file.

### Local Usage Statistics

The legacy `venice usage` command reports only token logs recorded locally by
this CLI. Use `venice billing usage` for billed account-wide usage.

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
# List characters from the Venice API catalog
venice characters

# Search the catalog
venice characters --search philosophy

# Show details (and reviews when available)
venice characters show alan-watts

# Chat as a catalog character — sends character_slug, not a local system prompt
venice chat -c alan-watts "What is the nature of reality?"
```

`-c` / `--character` takes an API slug from `venice characters` (for example `alan-watts`), not a locally hardcoded persona.

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

Only tools named by `--tools` are permitted to execute. The model may make
sequential tool calls for up to 10 rounds; the command stops with an error if
that limit is exceeded.

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

- **End-to-End Encryption (E2EE)**: Messages encrypted client-side, decrypted only in the TEE—Venice cannot read your data
- **TEE Attestation**: Cryptographically verify that models run in secure enclaves before sending data
- **No browser tracking**: Terminal interactions don't expose browser metadata
- **No telemetry**: The CLI doesn't collect or send usage data
- **Local configuration**: API key stored locally with restricted permissions
- **Transparent**: You can see exactly what's being sent to the API
- **Privacy-preserving models**: Use `venice models --privacy` to find models with no data retention

### E2EE Models

E2EE models provide the highest level of privacy. The CLI automatically detects E2EE support via model capabilities (not model names). When using an E2EE-capable model:

1. The CLI fetches and verifies TEE attestation
2. An ephemeral key pair is generated for the session
3. All messages are encrypted client-side using ECDH + AES-GCM
4. Only the TEE enclave can decrypt and process your data
5. Responses are encrypted and decrypted client-side

```bash
# List E2EE-capable models
venice models --e2ee

# Chat with E2EE (auto-enabled based on model capabilities)
venice chat -m <e2ee-capable-model> "Your private message here"

# TEE-only mode: verify attestation without encryption
venice chat -m <e2ee-capable-model> --no-e2ee "TEE verified, not encrypted"
```

**Note:** E2EE mode disables tools and web search to maintain end-to-end encryption. Multimodal attachments (`--image`, `--file`, `--audio`, `--video`) are not supported with E2EE or TEE models.

### TEE Models

TEE (Trusted Execution Environment) models run in secure enclaves with cryptographic attestation. The CLI automatically verifies attestation for models with TEE support.

```bash
# List TEE-capable models
venice models --tee

# Chat with TEE attestation verification
venice chat -m <tee-capable-model> "Verified secure execution"
```

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
