# Changelog

All notable changes to Venice CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Node.js 22 or later is required.**
- With `-f json`, `image`, `image-edit`, `image-multi-edit`, `image-bg-remove` and `upscale` save the image and print its path, size and type instead of base64. Pass `--base64` for the previous output.
- With `-f json`, errors are one line of JSON on stderr instead of text.
- `video generate` and `video quote` fill in a ratio and duration the model lists when none is given, instead of no ratio and a fixed `5s`: `16:9` where listed, unless the model lists `auto` or `adaptive` first, and the first listed duration. They reject values the model doesn't list.
- `music generate` refuses `--lyrics` for a model that doesn't take lyrics, and refuses a model that needs lyrics without them.
- The background update notifier is replaced by `venice update --check`, which runs only when asked.
- Requests to the Venice API send `User-Agent: veniceai-cli/<version>`.

### Added

- **One command per media job**: `video generate --wait` and `music generate --wait` quote, queue, wait for and save the result without replacing an earlier file unless `-o` names it, and with `-f json` print one object with the file path, size, model, queue ID and quoted price. `--complete` (video) and `--keep` (music) choose what happens to the remote copy.
- `--max-usd` on `video generate` and `music generate` refuses a job before anything is charged when its quote is higher or can't be fetched.
- Every `/video/queue` media input on `video generate`, from local files or URLs: `--end-image`, `--video`, `--audio-input`, `--reference-image`, `--reference-video`, `--reference-audio`, `--image-reference`, `--video-reference`, `--element`, `--scene-image`, `--camera-trajectory`, `--task-type`, `--resolution`, `--audio`/`--no-audio` and `--negative-prompt`. Quotes include the length of local reference videos.
- `music generate --lyrics-optimizer`, `--loop`, `--voice` and `--speed`, checked against the model's catalog entry.
- `tts --json`, and `--base64` on the image commands.
- `VENICE_SKILL` or `--skill <name>` adds `skill/<name>` to the User-Agent.
- JSON errors carry the API's status and code, plus `credits_refunded`, `suggested_prompt` or `recommended_model` when Venice sends them.
- Deprecation warnings from Venice, with the replacement model, in a `warnings` field of media results or on stderr.
- `video generate` and `video upscale` follow a `download_url` returned when the job was queued, and `video retrieve --url` downloads from one.
- `models show`, `models traits`, `models compat`, `keys show`, `keys rate-limit-logs` and `responses`, plus chat sampling, image, billing, characters, embeddings, scrape, parse and transcribe options.
- `venice update --check`, the `exa` search provider, `venice video models -f json` constraints, and a "Use with coding agents" section in the README.
- Releases are published from version tags with npm trusted publishing.

### Fixed

- Image outputs up to 80 MB are kept, so a large 4096x4096 PNG is no longer discarded after a paid request, and default file names use the format Venice returned.
- `venice video transcribe` no longer calls a retired endpoint: it sends the video to the audio transcription endpoint.
- Paid requests are no longer re-sent after ambiguous failures, API responses are read within size and time limits, and redirects from the API are refused.
- Video and music jobs exit non-zero when they fail or are not ready, reject responses of the wrong shape, and save video only with a valid MP4 header.
- Chat streams follow the SSE spec and fail on errors, truncation and stalls; E2EE output stops at the first bad chunk and requires a finish reason.
- Every numeric option is parsed by one strict parser, and malformed options are rejected before any request is sent.

### Security

- Text from the Venice API, models and saved history is printed without terminal control sequences, and prompts are asked on stderr.
- Output files are written through an exclusive temporary file, and server-named download URLs must be public https hosts.
- E2EE and TEE chat check the attestation report and fail closed; `tee signature` checks the request ID, signer and reply.

## [2.1.0] - 2026-03-18

### Added

- End-to-end encrypted (E2EE) and TEE chat, with attestation checks.
- An update notifier and an automated publish workflow.
- More video generation options and the current video endpoints.

### Changed

- The default chat model is `deepseek-v3.2`, and the package is published as `veniceai-cli`.
- Media uploads and downloads are streamed within size limits.

### Fixed

- The API key is masked in `config` JSON output.
- Streamed tool call arguments are reassembled correctly.
- `tts` accepts its text as an optional argument, so it can read stdin.

## [2.0.0] - 2026-02-25

### Added

- **Configuration Management**
  - Persistent config file at `~/.venice/config.json`
  - `venice config` command with init, show, set, get, unset subcommands
  - Support for default model, voice, and output format preferences
  
- **Improved Streaming**
  - Proper TTY detection
  - Spinner animation while waiting for response
  - Automatic format detection for piped output
  
- **Function Calling / Tools**
  - `--tools` flag for enabling built-in tools
  - Built-in tools: calculator, weather, datetime, random, base64, hash
  - `--interactive-tools` flag for manual tool approval
  - `--list-tools` to see available tools
  
- **Character Personas**
  - `--character` flag for chat command
  - Built-in characters: pirate, wizard, scientist, poet, coder, teacher, comedian, philosopher
  - `venice characters` command to list available personas
  
- **Conversation History**
  - `--continue` flag to continue previous conversation
  - `venice history` command with list, show, clear, export subcommands
  - Local history storage with automatic cleanup
  
- **Output Formats**
  - `--format` flag supporting pretty, json, markdown, raw
  - Automatic pipe detection for raw output
  - `--no-color` global flag
  
- **Usage Tracking**
  - Token usage displayed after each request
  - `venice usage` command for statistics
  - Daily, weekly, monthly views
  
- **New Commands**
  - `venice embeddings` - Generate text embeddings
  - `venice upscale` - Upscale images
  - `venice voices` - List available TTS voices
  - `venice characters` - List available personas
  - `venice usage` - Show usage statistics
  
- **Shell Completions**
  - `venice completions bash|zsh|fish`
  - Full command and option completion
  
- **Better Error Handling**
  - Helpful error messages with suggestions
  - Retry logic for transient failures
  - Offline detection
  - Graceful handling of missing API key

### Changed

- Complete rewrite in TypeScript with strict mode
- Modular architecture with separate command files
- Uses chalk for colored output
- Uses ora for spinners
- ESM module system

### Fixed

- Streaming output now properly handles line breaks
- API key validation before requests
- Proper exit codes on errors

## [1.0.0] - 2026-02-08

### Added

- Initial release
- Basic commands: chat, search, image, tts, transcribe, models
- Environment variable configuration
- Streaming chat output
- JSON output option

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 2.0.0 | 2026-02-25 | Complete rewrite, tools, personas, history |
| 1.0.0 | 2026-02-08 | Initial release |
