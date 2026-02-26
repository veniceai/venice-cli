# RFC: Venice CLI — Official Command Line Interface for Venice AI

**Status:** Proposal  
**Author:** Venice AI Team  
**Date:** February 2026  
**Version:** 2.0.0

---

## Executive Summary

We propose the creation and release of an official Venice CLI—a comprehensive, production-ready command-line interface for Venice AI. This tool enables developers, researchers, and power users to interact with all Venice AI capabilities directly from their terminal, embodying Venice's core value of privacy-first AI without browser tracking.

### Why Venice Needs an Official CLI

1. **Developer Adoption**: CLIs are the native interface for developers. An official CLI lowers the barrier to integration and experimentation.

2. **Privacy Differentiator**: "No browser, no tracking"—a CLI reinforces Venice's privacy-first positioning. Terminal interactions leave no browser fingerprints, cookies, or tracking pixels.

3. **Workflow Integration**: Enables piping, scripting, and automation. Users can integrate Venice AI into shell scripts, CI/CD pipelines, and local toolchains.

4. **Power User Demand**: Community feedback indicates strong demand for CLI access, especially among the privacy-conscious developer demographic.

5. **Competitive Parity**: OpenAI, Anthropic, and other providers have robust CLI offerings. An official Venice CLI is table stakes.

---

## Competitive Analysis

### OpenAI CLI
- Mature, well-documented
- Supports chat, embeddings, images, audio
- JSON output mode
- Missing: privacy focus, function calling from CLI

### Anthropic Claude CLI
- Focus on chat and Claude models
- Clean, minimal interface
- Missing: image generation, TTS, shell completions

### Community Venice Tools
- Scattered, inconsistent quality
- No official endorsement
- Missing: completeness, support, updates

### Venice CLI Advantages
- **Complete API coverage**: chat, search, images, TTS, transcription, embeddings, upscale
- **Privacy-first messaging**: Built into the help text and documentation
- **Function calling**: Built-in tools (calculator, weather, datetime, etc.)
- **Character personas**: Fun, engaging character modes
- **Configuration management**: Persistent config file, environment variable support
- **Usage tracking**: Local tracking of token usage
- **Shell completions**: bash, zsh, fish support

---

## Feature Specification

### Core Commands

| Command | Description |
|---------|-------------|
| `venice chat <prompt>` | Chat with AI models |
| `venice search <query>` | Web search with AI synthesis |
| `venice image <prompt>` | Generate images |
| `venice upscale <file>` | Upscale images |
| `venice tts <text>` | Text-to-speech |
| `venice transcribe <audio>` | Speech-to-text |
| `venice embeddings <text>` | Generate embeddings |
| `venice models` | List available models |

### Utility Commands

| Command | Description |
|---------|-------------|
| `venice config` | Manage configuration |
| `venice history` | View conversation history |
| `venice usage` | Show API usage statistics |
| `venice characters` | List chat personas |
| `venice voices` | List TTS voices |
| `venice completions` | Generate shell completions |

### Chat Options

```
-m, --model <model>       Model to use
-s, --system <prompt>     System prompt
-c, --character <name>    Character persona
-t, --tools <tools>       Enable function calling
--interactive-tools       Approve tool calls manually
--continue                Continue last conversation
--no-stream               Disable streaming
-f, --format <format>     Output format (pretty|json|markdown|raw)
```

### Output Formats

- **pretty** (default): Colored, formatted for terminal
- **json**: Machine-readable JSON output
- **markdown**: Markdown formatted
- **raw**: Plain text, pipe-friendly

### Configuration

Configuration stored in `~/.venice/config.json`:

```json
{
  "api_key": "vn-...",
  "default_model": "kimi-k2-5",
  "default_image_model": "fluently-xl",
  "default_voice": "af_sky",
  "output_format": "pretty",
  "show_usage": true
}
```

---

## Architecture

### Technology Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript with strict mode
- **CLI Framework**: Commander.js
- **Styling**: Chalk for colors, Ora for spinners
- **Module System**: ESM (ECMAScript modules)

### File Structure

```
venice-cli/
├── src/
│   ├── index.ts           # Entry point
│   ├── commands/          # Command implementations
│   │   ├── chat.ts
│   │   ├── search.ts
│   │   ├── image.ts
│   │   ├── audio.ts
│   │   ├── models.ts
│   │   ├── config.ts
│   │   └── ...
│   ├── lib/               # Shared utilities
│   │   ├── api.ts         # API client
│   │   ├── config.ts      # Config management
│   │   ├── output.ts      # Output formatting
│   │   └── tools.ts       # Function calling
│   └── types/             # TypeScript types
├── dist/                  # Compiled output
├── package.json
├── tsconfig.json
└── README.md
```

### API Integration

The CLI uses the Venice AI REST API:

- Base URL: `https://api.venice.ai/api/v1`
- Authentication: Bearer token
- Streaming: SSE for chat completions
- Retry logic: Exponential backoff on 5xx and rate limits

### Error Handling

- **Network errors**: Detect offline state, suggest checking connection
- **Auth errors**: Clear message pointing to API key setup
- **Rate limits**: Automatic retry with backoff
- **Validation**: Helpful messages for invalid inputs

---

## Privacy Angle

### Marketing Position

> **"AI from your terminal. No browser. No tracking. Just you and the model."**

### Privacy Benefits

1. **No browser fingerprinting**: Terminal interactions don't expose browser metadata
2. **No cookies or localStorage**: No persistent tracking mechanisms
3. **Local configuration**: API key stored locally with restricted permissions (0600)
4. **No telemetry**: CLI doesn't phone home (except to Venice API)
5. **Transparent requests**: Users can see exactly what's being sent
6. **Pipe-friendly**: Output can be processed without leaving traces

### Documentation Emphasis

Every README, help text, and marketing material should reinforce:
- Venice's privacy-preserving infrastructure
- No data retention on privacy models
- CLI as the most private way to use AI

---

## Effort Estimate

### Development Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Core CLI | 2 weeks | Basic commands, API integration |
| Advanced Features | 2 weeks | Tools, history, config |
| Polish | 1 week | Shell completions, error handling |
| Documentation | 1 week | README, help text, examples |
| Testing | 1 week | E2E tests, edge cases |
| **Total** | **7 weeks** | |

### Resources Required

- **Engineering**: 1 full-time developer
- **Design**: Help text and output format review
- **Documentation**: README, website integration
- **DevOps**: npm publishing, GitHub releases

### Maintenance

- Ongoing: Bug fixes, API compatibility
- Quarterly: Feature additions based on API updates
- Version bumps when Venice API changes

---

## Success Metrics

### Adoption

| Metric | Target (6 months) |
|--------|-------------------|
| npm downloads | 10,000 |
| GitHub stars | 500 |
| Active weekly users | 1,000 |

### Quality

| Metric | Target |
|--------|--------|
| CLI crash rate | < 0.1% |
| Average response time | < 2s for non-streaming |
| Help text coverage | 100% of commands |

### Community

| Metric | Target |
|--------|--------|
| GitHub issues resolved | > 80% within 1 week |
| Documentation completeness | All features documented |
| Shell completion coverage | bash, zsh, fish |

### Business Impact

- Increased API usage from CLI users
- Developer mindshare and advocacy
- Reduced support burden (self-service tool)

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| API changes break CLI | Semantic versioning, graceful degradation |
| Security vulnerabilities | Dependency audits, no credential logging |
| Low adoption | Developer marketing, integration guides |
| Maintenance burden | Clean code, comprehensive tests |

---

## Appendix: Command Reference

### venice chat

```bash
# Basic chat
venice chat "Explain quantum computing"

# With model selection
venice chat -m deepseek-r1 "Solve this math problem"

# With character persona
venice chat -c pirate "Tell me about the weather"

# With function calling
venice chat -t calculator,weather "What's 15% of 250?"

# Continue previous conversation
venice chat --continue "And what about the next step?"

# JSON output for scripting
venice chat -f json "List 3 colors" | jq '.content'
```

### venice image

```bash
# Generate and display URL
venice image "A sunset over mountains"

# Save to file
venice image -o sunset.png "A sunset over mountains"

# Custom dimensions
venice image -w 1024 -h 768 "Landscape photo"

# Specific model
venice image -m flux-1-dev "Artistic portrait"
```

### venice tts

```bash
# Basic text to speech
venice tts "Hello, world"

# Custom voice and output
venice tts -v bf_emma -o greeting.mp3 "Good morning"

# From stdin
echo "Text from pipe" | venice tts -o output.mp3
```

### venice config

```bash
# Initialize interactively
venice config init

# Set API key
venice config set api_key vn-xxxxxxxx

# Set default model
venice config set default_model kimi-k2-5

# View config
venice config show
```

---

## Conclusion

The Venice CLI fills a critical gap in Venice AI's tooling ecosystem. It provides:

1. **Complete API coverage** in a single, well-designed tool
2. **Privacy-first positioning** reinforced through every interaction
3. **Developer experience** that matches or exceeds competitors
4. **Foundation for ecosystem** growth and community tools

We recommend immediate development and release, followed by active promotion in developer communities.

---

*This proposal is open for feedback and revision.*
