/**
 * Completions Command - Generate shell completion scripts
 */

import { Command } from 'commander';
import { getChalk } from '../lib/output.js';

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions <shell>')
    .description('Generate shell completion script (bash|zsh|fish)')
    .action((shell: string) => {
      const c = getChalk();

      switch (shell.toLowerCase()) {
        case 'bash':
          console.log(generateBashCompletion());
          console.error(c.dim('\n# Add to ~/.bashrc:'));
          console.error(c.dim('# eval "$(venice completions bash)"'));
          break;

        case 'zsh':
          console.log(generateZshCompletion());
          console.error(c.dim('\n# Add to ~/.zshrc:'));
          console.error(c.dim('# eval "$(venice completions zsh)"'));
          break;

        case 'fish':
          console.log(generateFishCompletion());
          console.error(c.dim('\n# Save to ~/.config/fish/completions/venice.fish'));
          break;

        default:
          console.error(`Unknown shell: ${shell}`);
          console.error('Supported shells: bash, zsh, fish');
          process.exit(1);
      }
    });
}

function generateBashCompletion(): string {
  return `# Venice CLI bash completion
_venice_completion() {
    local cur prev words cword
    _init_completion || return

    local commands="chat search scrape parse image image-edit image-multi-edit image-bg-remove image-styles tts transcribe models embeddings upscale history usage billing keys config characters voices voice video music rpc completions"
    local config_cmds="show set get unset path init"
    local history_cmds="list show clear export"
    local video_cmds="generate quote status retrieve complete transcribe upscale models"
    local voice_cmds="clone"
    local music_cmds="generate quote status retrieve complete models"
    local billing_cmds="balance usage analytics"
    local keys_cmds="list create delete rate-limits"
    local formats="pretty json markdown raw"
    local models="kimi-k2-5 zai-org-glm-4.7 zai-org-glm-4.6 claude-opus-4-6 claude-opus-45 claude-sonnet-4-6 openai-gpt-53-codex minimax-m25"
    local image_models="flux-2-pro flux-2-max seedream-v5-lite recraft-v4 grok-imagine nano-banana-pro"
    local edit_models="qwen-edit firered-image-edit qwen-edit-uncensored grok-imagine-edit grok-imagine-quality-edit qwen-image-2-edit qwen-image-2-pro-edit wan-2-7-pro-edit flux-2-max-edit gpt-image-2-edit gpt-image-1-5-edit nano-banana-2-edit nano-banana-pro-edit seedream-v5-lite-edit seedream-v5-pro-edit seedream-v4-edit qwen-image-3-edit qwen-image-3-pro-edit"
    local video_models="wan-2.6-text-to-video wan-2.6-image-to-video veo3-fast-text-to-video sora2-text-to-video kling-v3-pro-text-to-video"
    local music_models="elevenlabs-music elevenlabs-sound-effects-v2"
    local asr_models="nvidia/parakeet-tdt-0.6b-v3 openai/whisper-large-v3"
    local voices="af_sky af_bella af_nicole am_adam am_michael bf_emma bf_isabella bm_george bm_lewis"
    local tools="calculator weather datetime random base64 hash"

    case "\${prev}" in
        venice)
            COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
            return 0
            ;;
        config)
            COMPREPLY=( \$(compgen -W "\${config_cmds}" -- "\${cur}") )
            return 0
            ;;
        history)
            COMPREPLY=( \$(compgen -W "\${history_cmds}" -- "\${cur}") )
            return 0
            ;;
        video)
            COMPREPLY=( \$(compgen -W "\${video_cmds}" -- "\${cur}") )
            return 0
            ;;
        rpc)
            COMPREPLY=( \$(compgen -W "networks" -- "\${cur}") )
            return 0
            ;;
        billing)
            COMPREPLY=( \$(compgen -W "\${billing_cmds}" -- "\${cur}") )
            return 0
            ;;
        keys)
            COMPREPLY=( \$(compgen -W "\${keys_cmds}" -- "\${cur}") )
            return 0
            ;;
        voice)
            COMPREPLY=( \$(compgen -W "\${voice_cmds}" -- "\${cur}") )
            return 0
            ;;
        music)
            COMPREPLY=( \$(compgen -W "\${music_cmds}" -- "\${cur}") )
            return 0
            ;;
        -m|--model)
            if [[ "\${words[1]}" == "image-edit" || "\${words[1]}" == "image-multi-edit" ]]; then
                COMPREPLY=( \$(compgen -W "\${edit_models}" -- "\${cur}") )
            else
                COMPREPLY=( \$(compgen -W "\${models} \${image_models} \${video_models} \${music_models}" -- "\${cur}") )
            fi
            return 0
            ;;
        -v|--voice)
            COMPREPLY=( \$(compgen -W "\${voices}" -- "\${cur}") )
            return 0
            ;;
        -c|--character)
            return 0
            ;;
        -t|--tools)
            COMPREPLY=( \$(compgen -W "\${tools}" -- "\${cur}") )
            return 0
            ;;
        -f|--format)
            COMPREPLY=( \$(compgen -W "\${formats}" -- "\${cur}") )
            return 0
            ;;
        --resolution)
            COMPREPLY=( \$(compgen -W "1K 2K 4K" -- "\${cur}") )
            return 0
            ;;
        --quality)
            COMPREPLY=( \$(compgen -W "low medium high" -- "\${cur}") )
            return 0
            ;;
        completions)
            COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\${cur}") )
            return 0
            ;;
    esac

    case "\${words[1]}" in
        chat)
            COMPREPLY=( \$(compgen -W "-m --model -s --system -c --character -t --tools --interactive-tools --continue --no-stream --web-search --x-search --json --json-schema --reasoning-effort --prompt-cache-key --prompt-cache-retention --image --file --audio --video -f --format --list-tools" -- "\${cur}") )
            return 0
            ;;
        search)
            COMPREPLY=( \$(compgen -W "-m --model -n --results --citations --scrape --raw --provider -f --format" -- "\${cur}") )
            return 0
            ;;
        scrape|parse)
            COMPREPLY=( \$(compgen -W "-o --output -f --format" -- "\${cur}") )
            return 0
            ;;
        image)
            COMPREPLY=( \$(compgen -W "-m --model -o --output -w --width -h --height -a --aspect-ratio --resolution --quality --style --style-reference --negative --seed --cfg-scale --steps --lora-strength --hide-watermark --no-hide-watermark --safe-mode --no-safe-mode --embed-exif-metadata --no-embed-exif-metadata -n --count -f --format" -- "\${cur}") )
            return 0
            ;;
        image-edit)
            COMPREPLY=( \$(compgen -W "-m --model -o --output -a --aspect-ratio --enhance-prompt --no-safe-mode -f --format" -- "\${cur}") )
            return 0
            ;;
        image-multi-edit)
            COMPREPLY=( \$(compgen -W "-p --prompt -m --model -o --output -a --aspect-ratio --enhance-prompt --no-safe-mode -f --format" -- "\${cur}") )
            return 0
            ;;
        image-bg-remove)
            COMPREPLY=( \$(compgen -W "-o --output -f --format" -- "\${cur}") )
            return 0
            ;;
        image-styles)
            COMPREPLY=( \$(compgen -W "-f --format" -- "\${cur}") )
            return 0
            ;;
        tts|speak)
            COMPREPLY=( \$(compgen -W "-v --voice -m --model -o --output --format -s --speed --temperature --streaming" -- "\${cur}") )
            return 0
            ;;
        voice)
            COMPREPLY=( \$(compgen -W "clone" -- "\${cur}") )
            return 0
            ;;
        transcribe)
            COMPREPLY=( \$(compgen -W "-m --model -l --language -t --timestamps -f --format" -- "\${cur}") )
            return 0
            ;;
        video)
            case "\${words[2]}" in
                generate|gen)
                    COMPREPLY=( \$(compgen -W "-m --model -d --duration -a --aspect-ratio -i --image -f --format" -- "\${cur}") )
                    ;;
                quote)
                    COMPREPLY=( \$(compgen -W "-m --model -d --duration -a --aspect-ratio -r --resolution --factor --audio --no-audio --video-url -f --format" -- "\${cur}") )
                    ;;
                status)
                    COMPREPLY=( \$(compgen -W "-m --model -w --wait -t --timeout -f --format" -- "\${cur}") )
                    ;;
                retrieve|download)
                    COMPREPLY=( \$(compgen -W "-m --model -o --output --complete --delete -f --format" -- "\${cur}") )
                    ;;
                complete)
                    COMPREPLY=( \$(compgen -W "-m --model -f --format" -- "\${cur}") )
                    ;;
                transcribe)
                    COMPREPLY=( \$(compgen -W "-f --format" -- "\${cur}") )
                    ;;
                upscale)
                    COMPREPLY=( \$(compgen -W "-m --model --factor -o --output --no-wait --complete -f --format" -- "\${cur}") )
                    ;;
                *)
                    COMPREPLY=( \$(compgen -W "\${video_cmds}" -- "\${cur}") )
                    ;;
            esac
            return 0
            ;;
        music)
            case "\${words[2]}" in
                generate|gen)
                    COMPREPLY=( \$(compgen -W "-m --model -l --lyrics -d --duration -i --instrumental -f --format" -- "\${cur}") )
                    ;;
                quote)
                    COMPREPLY=( \$(compgen -W "-m --model -d --duration --character-count -f --format" -- "\${cur}") )
                    ;;
                status)
                    COMPREPLY=( \$(compgen -W "-m --model -w --wait -f --format" -- "\${cur}") )
                    ;;
                retrieve|download)
                    COMPREPLY=( \$(compgen -W "-m --model -o --output --keep -f --format" -- "\${cur}") )
                    ;;
                complete)
                    COMPREPLY=( \$(compgen -W "-m --model -f --format" -- "\${cur}") )
                    ;;
                *)
                    COMPREPLY=( \$(compgen -W "\${music_cmds}" -- "\${cur}") )
                    ;;
            esac
            return 0
            ;;
        models)
            COMPREPLY=( \$(compgen -W "-t --type -s --search --privacy --tee --e2ee -f --format" -- "\${cur}") )
            return 0
            ;;
        characters)
            COMPREPLY=( \$(compgen -W "show -s --search --limit --offset -f --format" -- "\${cur}") )
            return 0
            ;;
        embeddings|embed)
            COMPREPLY=( \$(compgen -W "-m --model -o --output -f --format --file" -- "\${cur}") )
            return 0
            ;;
        upscale)
            COMPREPLY=( \$(compgen -W "-m --model -s --scale -o --output -f --format" -- "\${cur}") )
            return 0
            ;;
        usage)
            COMPREPLY=( \$(compgen -W "-d --days --today --month -f --format" -- "\${cur}") )
            return 0
            ;;
        rpc)
            COMPREPLY=( \$(compgen -W "networks --batch -f --format" -- "\${cur}") )
            return 0
            ;;
        billing)
            COMPREPLY=( \$(compgen -W "\${billing_cmds} -d --days -c --currency -l --lookback -f --format" -- "\${cur}") )
            return 0
            ;;
        keys)
            COMPREPLY=( \$(compgen -W "\${keys_cmds} -n --name -o --output -t --type --expires --usd-limit --diem-limit --limit-period --force -f --format" -- "\${cur}") )
            return 0
            ;;
    esac

    COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
}

complete -F _venice_completion venice`;
}

function generateZshCompletion(): string {
  return `#compdef venice

# Venice CLI zsh completion
_venice() {
    local -a commands
    commands=(
        'chat:Chat with an AI model'
        'search:Web search with optional AI synthesis'
        'scrape:Scrape a public page to Markdown'
        'parse:Extract text from a document'
        'image:Generate an image'
        'image-edit:Edit a local image'
        'image-multi-edit:Edit layered local images'
        'image-bg-remove:Remove an image background'
        'image-styles:List image style presets'
        'upscale:Upscale an image'
        'tts:Convert text to speech'
        'transcribe:Transcribe audio to text'
        'video:AI video generation'
        'music:Generate music and sound effects'
        'models:List available models'
        'embeddings:Generate text embeddings'
        'history:View conversation history'
        'usage:Show usage statistics'
        'billing:Show account billing and billed usage'
        'keys:Manage API keys'
        'config:Manage configuration'
        'characters:List characters from the Venice API catalog'
        'voices:List available TTS voices'
        'rpc:Proxy JSON-RPC requests to blockchain nodes'
        'voice:Create and manage cloned voices'
        'completions:Generate shell completions'
    )

    local -a models=(
        'kimi-k2-5' 'zai-org-glm-4.7' 'zai-org-glm-4.6' 'claude-opus-4-6' 'claude-opus-45' 'claude-sonnet-4-6' 'openai-gpt-53-codex' 'minimax-m25'
        'llama-3.2-3b'
        'mistral-31-24b'
        'qwen-2.5-coder'
        'nous-hermes-3'
        'deepseek-v3.2'
        'dolphin-2.9.2'
    )

    local -a image_models=(
        'flux-2-pro' 'flux-2-max' 'seedream-v5-lite' 'recraft-v4' 'grok-imagine' 'nano-banana-pro'
        'flux-1-dev'
        'flux-1-schnell'
        'akash-sdxl'
    )

    local -a edit_models=(
        'qwen-edit' 'firered-image-edit' 'qwen-edit-uncensored'
        'grok-imagine-edit' 'grok-imagine-quality-edit'
        'qwen-image-2-edit' 'qwen-image-2-pro-edit' 'wan-2-7-pro-edit'
        'flux-2-max-edit' 'gpt-image-2-edit' 'gpt-image-1-5-edit'
        'nano-banana-2-edit' 'nano-banana-pro-edit'
        'seedream-v5-lite-edit' 'seedream-v5-pro-edit' 'seedream-v4-edit'
        'qwen-image-3-edit' 'qwen-image-3-pro-edit'
    )

    local -a video_models=(
        'wan-2.6-text-to-video' 'wan-2.6-image-to-video' 'wan-2.6-flash-image-to-video'
        'veo3-fast-text-to-video' 'veo3-fast-image-to-video' 'veo3.1-fast-text-to-video'
        'sora2-text-to-video' 'sora2-image-to-video'
        'kling-v3-pro-text-to-video' 'kling-v3-pro-image-to-video'
        'grok-imagine-text-to-video' 'grok-imagine-image-to-video'
        'ltx2-fast-text-to-video' 'ltx2-fast-image-to-video'
    )

    local -a asr_models=(
        'nvidia/parakeet-tdt-0.6b-v3:Parakeet ASR (fast, default)'
        'openai/whisper-large-v3:Whisper Large V3'
    )

    local -a voices=(
        'af_sky:Sky (American Female)'
        'af_bella:Bella (American Female)'
        'am_adam:Adam (American Male)'
        'bf_emma:Emma (British Female)'
        'bm_george:George (British Male)'
    )

    local -a tools=(
        'calculator:Math operations'
        'weather:Weather info (simulated)'
        'datetime:Current date/time'
        'random:Random values'
        'base64:Base64 encode/decode'
        'hash:Generate hashes'
    )

    local -a formats=(
        'pretty:Formatted output'
        'json:JSON output'
        'markdown:Markdown output'
        'raw:Raw output'
    )

    _arguments -C \\
        '1: :->command' \\
        '*:: :->args'

    case \$state in
        command)
            _describe -t commands 'venice commands' commands
            ;;
        args)
            case \$words[1] in
                chat)
                    _arguments \\
                        '-m[Model to use]:model:(\$models)' \\
                        '--model[Model to use]:model:(\$models)' \\
                        '-s[System prompt]:prompt:' \\
                        '--system[System prompt]:prompt:' \\
                        '-c[Character slug from the Venice API catalog]:slug:' \\
                        '--character[Character slug from the Venice API catalog]:slug:' \\
                        '-t[Tools to enable]:tools:((\$tools))' \\
                        '--tools[Tools to enable]:tools:((\$tools))' \\
                        '--interactive-tools[Require tool approval]' \\
                        '--continue[Continue last conversation]' \\
                        '--no-stream[Disable streaming]' \\
                        '--web-search[Enable Venice web search]' \\
                        '--x-search[Enable xAI native search]' \\
                        '--json[Request JSON object output]' \\
                        '--json-schema[JSON schema file]:file:_files' \\
                        '--reasoning-effort[Reasoning effort]:level:(none minimal low medium high xhigh max)' \\
                        '--prompt-cache-key[Prompt cache key]:key:' \\
                        '--prompt-cache-retention[Prompt cache retention]:mode:(default extended 24h)' \\
                        '--image[Attach an image file or URL]:file:_files' \\
                        '--file[Attach a document or source file]:file:_files' \\
                        '--audio[Attach an audio file or URL]:file:_files' \\
                        '--video[Attach a video file or URL]:file:_files' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '--format[Output format]:format:((\$formats))' \\
                        '--list-tools[List available tools]' \\
                        '*:prompt:'
                    ;;
                search)
                    _arguments \\
                        '-m[Model to use]:model:(\$models)' \\
                        '-n[Number of results]:number:' \\
                        '--citations[Include citations in synthesized output]' \\
                        '--scrape[Scrape pages for synthesized output]' \\
                        '--raw[Use dedicated search without AI synthesis]' \\
                        '--provider[Raw search provider]:provider:((brave google))' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '*:query:'
                    ;;
                scrape)
                    _arguments \\
                        '-o[Output file]:file:_files' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '1:url:'
                    ;;
                parse)
                    _arguments \\
                        '-o[Output file]:file:_files' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '1:document:_files'
                    ;;
                image)
                    _arguments \\
                        '-m[Model to use]:model:(\$image_models)' \\
                        '-o[Output file]:file:_files' \\
                        '-w[Width]:pixels:' \\
                        '-h[Height]:pixels:' \\
                        '-a[Aspect ratio]:ratio:(1:1 3:2 2:3 4:3 3:4 16:9 9:16 21:9)' \\
                        '--resolution[Resolution tier]:tier:(1K 2K 4K)' \\
                        '--quality[Output quality]:quality:(low medium high)' \\
                        '--style[Style preset]:style:' \\
                        '*--style-reference[Style reference URL/base64]:reference:' \\
                        '--negative[Negative prompt]:prompt:' \\
                        '--seed[Random seed]:integer:' \\
                        '--cfg-scale[CFG scale]:number:' \\
                        '--steps[Inference steps]:integer:' \\
                        '--lora-strength[LoRA strength]:integer:' \\
                        '--hide-watermark[Hide Venice watermark]' \\
                        '--no-hide-watermark[Keep Venice watermark]' \\
                        '--safe-mode[Enable adult-content blurring]' \\
                        '--no-safe-mode[Disable adult-content blurring]' \\
                        '--embed-exif-metadata[Embed generation metadata]' \\
                        '--no-embed-exif-metadata[Do not embed generation metadata]' \\
                        '-n[Number of images]:count:' \\
                        '--style[Image style preset]:preset:' \\
                        '-f[Output format]:format:((pretty json))' \\
                        '*:prompt:'
                    ;;
                image-edit)
                    _arguments \\
                        '-m[Edit model]:model:(\$edit_models)' \\
                        '-o[Output file]:file:_files' \\
                        '-a[Output aspect ratio]:ratio:' \\
                        '--enhance-prompt[Enhance edit prompt]' \\
                        '--no-safe-mode[Disable safe mode]' \\
                        '-f[Output format]:format:((pretty json))' \\
                        '1:input image:_files' \\
                        '*:prompt:'
                    ;;
                image-multi-edit)
                    _arguments \\
                        '-p[Edit instructions]:prompt:' \\
                        '-m[Edit model]:model:(\$edit_models)' \\
                        '-o[Output file]:file:_files' \\
                        '-a[Output aspect ratio]:ratio:' \\
                        '--enhance-prompt[Enhance edit prompt]' \\
                        '--no-safe-mode[Disable safe mode]' \\
                        '-f[Output format]:format:((pretty json))' \\
                        '*:input images:_files'
                    ;;
                image-bg-remove)
                    _arguments \\
                        '-o[Output file]:file:_files' \\
                        '-f[Output format]:format:((pretty json))' \\
                        '1:input image:_files'
                    ;;
                image-styles)
                    _arguments '-f[Output format]:format:((pretty json))'
                    ;;
                tts|speak)
                    _arguments \\
                        '-v[Voice to use]:voice:((\$voices))' \\
                        '-m[Model to use]:model:(tts-kokoro)' \\
                        '-o[Output file]:file:_files' \\
                        '--format[Audio format]:format:(mp3 wav opus aac flac pcm)' \\
                        '-s[Speech speed]:speed:' \\
                        '--speed[Speech speed]:speed:' \\
                        '--temperature[Sampling temperature]:temperature:' \\
                        '--streaming[Request sentence streaming]' \\
                        '*:text:'
                    ;;
                voice)
                    _arguments \\
                        '1:action:(clone)' \\
                        '2:audio file:_files' \\
                        '-m[Voice cloning model]:model:' \\
                        '-f[Output format]:format:(pretty json)'
                    ;;
                transcribe)
                    _arguments \\
                        '-m[Model to use]:model:((\$asr_models))' \\
                        '-l[Language]:lang:' \\
                        '-t[Include timestamps]' \\
                        '--timestamps[Include timestamps]' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '1:audio file:_files'
                    ;;
                video)
                    local -a video_cmds=(
                        'generate:Queue video generation'
                        'quote:Estimate video generation price'
                        'status:Check generation status'
                        'retrieve:Download completed video'
                        'complete:Delete retrieved video from storage'
                        'transcribe:Transcribe speech from a video URL'
                        'upscale:Upscale a video'
                        'models:List video models'
                    )
                    _describe -t video_cmds 'video commands' video_cmds
                    ;;
                music)
                    local -a music_cmds=(
                        'generate:Queue audio generation'
                        'quote:Estimate generation cost'
                        'status:Check generation status'
                        'retrieve:Download completed audio'
                        'complete:Clean up stored audio'
                        'models:List music models'
                    )
                    _describe -t music_cmds 'music commands' music_cmds
                    ;;
                models)
                    _arguments \\
                        '-t[Filter by type]:type:(all text image tts asr music embedding video upscale inpaint)' \\
                        '-s[Search query]:query:' \\
                        '--privacy[Privacy models only]' \\
                        '--tee[TEE-attestable models only]' \\
                        '--e2ee[E2EE-capable models only]' \\
                        '-f[Output format]:format:((pretty json))'
                    ;;
                characters)
                    local -a character_cmds=(
                        'show:Show character details'
                    )
                    _describe -t character_cmds 'character commands' character_cmds
                    ;;
                config)
                    local -a config_cmds=(
                        'show:Show configuration'
                        'set:Set a value'
                        'get:Get a value'
                        'unset:Remove a value'
                        'path:Show config path'
                        'init:Initialize config'
                    )
                    _describe -t config_cmds 'config commands' config_cmds
                    ;;
                history)
                    local -a history_cmds=(
                        'list:List conversations'
                        'show:Show a conversation'
                        'clear:Clear history'
                        'export:Export history'
                    )
                    _describe -t history_cmds 'history commands' history_cmds
                    ;;
                rpc)
                    _arguments \\
                        '--batch[JSON array of JSON-RPC requests]:file:_files' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '--format[Output format]:format:((\$formats))' \\
                        '1:network:(networks ethereum-mainnet base-mainnet solana-mainnet)' \\
                        '2:method:' \\
                        '*:params:'
                    ;;
                billing)
                    local -a billing_cmds=(
                        'balance:Show current account balances'
                        'usage:Show account-wide billed usage'
                        'analytics:Show aggregated usage analytics'
                    )
                    _describe -t billing_cmds 'billing commands' billing_cmds
                    ;;
                keys)
                    local -a keys_cmds=(
                        'list:List API key metadata'
                        'create:Create an API key'
                        'delete:Permanently delete an API key'
                        'rate-limits:Show current key limits'
                    )
                    _describe -t keys_cmds 'API key commands' keys_cmds
                    ;;
                completions)
                    _arguments '1:shell:(bash zsh fish)'
                    ;;
            esac
            ;;
    esac
}

_venice`;
}

export function generateFishCompletion(): string {
  return `# Venice CLI fish completion

# Test whether the first non-option token is the requested top-level command.
function __venice_using_command
    set -l tokens (commandline -xpc)
    set -a tokens (commandline -ct)

    for token in $tokens[2..-1]
        if string match -q -- '-*' "$token"
            continue
        end

        test "$token" = "$argv[1]"
        return
    end

    return 1
end

# Main commands
set -l commands chat search scrape parse image image-edit image-multi-edit image-bg-remove image-styles upscale tts transcribe video music models embeddings history usage billing keys config characters voices voice rpc completions

# Disable file completions by default
complete -c venice -f

# Main commands
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a chat -d "Chat with an AI model"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a search -d "Web search with optional AI synthesis"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a scrape -d "Scrape a public page to Markdown"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a parse -d "Extract text from a document"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image -d "Generate an image"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image-edit -d "Edit a local image"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image-multi-edit -d "Edit layered local images"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image-bg-remove -d "Remove an image background"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image-styles -d "List image style presets"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a upscale -d "Upscale an image"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a tts -d "Convert text to speech"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a transcribe -d "Transcribe audio"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a video -d "AI video generation"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a music -d "Generate music and sound effects"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a models -d "List models"
complete -c venice -n "__venice_using_command models" -l privacy -d "Privacy-preserving models only"
complete -c venice -n "__venice_using_command models" -l tee -d "TEE-attestable models only"
complete -c venice -n "__venice_using_command models" -l e2ee -d "E2EE-capable models only"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a embeddings -d "Generate embeddings"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a history -d "View history"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a usage -d "Show usage stats"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a billing -d "Show account billing"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a keys -d "Manage API keys"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a config -d "Manage config"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a characters -d "List API characters"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a voices -d "List voices"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a voice -d "Create and manage cloned voices"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a completions -d "Shell completions"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a rpc -d "Crypto JSON-RPC"

# Models
set -l models kimi-k2-5 zai-org-glm-4.7 zai-org-glm-4.6 claude-opus-4-6 claude-opus-45 claude-sonnet-4-6 openai-gpt-53-codex minimax-m25
set -l image_models flux-2-pro flux-2-max seedream-v5-lite recraft-v4 grok-imagine nano-banana-pro
set -l edit_models qwen-edit firered-image-edit qwen-edit-uncensored grok-imagine-edit grok-imagine-quality-edit qwen-image-2-edit qwen-image-2-pro-edit wan-2-7-pro-edit flux-2-max-edit gpt-image-2-edit gpt-image-1-5-edit nano-banana-2-edit nano-banana-pro-edit seedream-v5-lite-edit seedream-v5-pro-edit seedream-v4-edit qwen-image-3-edit qwen-image-3-pro-edit
set -l video_models wan-2.6-text-to-video wan-2.6-image-to-video veo3-fast-text-to-video sora2-text-to-video kling-v3-pro-text-to-video
set -l music_models elevenlabs-music elevenlabs-sound-effects-v2
set -l asr_models nvidia/parakeet-tdt-0.6b-v3 openai/whisper-large-v3
set -l voices af_sky af_bella af_nicole am_adam am_michael bf_emma bm_george
set -l tools calculator weather datetime random base64 hash
set -l formats pretty json markdown raw

# Chat options
complete -c venice -n "__fish_seen_subcommand_from chat" -s m -l model -d "Model" -xa "$models"
complete -c venice -n "__fish_seen_subcommand_from chat" -s s -l system -d "System prompt"
complete -c venice -n "__fish_seen_subcommand_from chat" -s c -l character -d "Character slug from the API catalog"
complete -c venice -n "__fish_seen_subcommand_from chat" -s t -l tools -d "Tools" -xa "$tools"
complete -c venice -n "__fish_seen_subcommand_from chat" -l interactive-tools -d "Approve tools"
complete -c venice -n "__fish_seen_subcommand_from chat" -l continue -d "Continue conversation"
complete -c venice -n "__fish_seen_subcommand_from chat" -l no-stream -d "Disable streaming"
complete -c venice -n "__fish_seen_subcommand_from chat" -l web-search -d "Enable Venice web search"
complete -c venice -n "__fish_seen_subcommand_from chat" -l x-search -d "Enable xAI native search"
complete -c venice -n "__fish_seen_subcommand_from chat" -l json -d "Request JSON object output"
complete -c venice -n "__fish_seen_subcommand_from chat" -l json-schema -d "JSON schema file" -r
complete -c venice -n "__fish_seen_subcommand_from chat" -l reasoning-effort -d "Reasoning effort" -xa "none minimal low medium high xhigh max"
complete -c venice -n "__fish_seen_subcommand_from chat" -l prompt-cache-key -d "Prompt cache key"
complete -c venice -n "__fish_seen_subcommand_from chat" -l prompt-cache-retention -d "Prompt cache retention" -xa "default extended 24h"
complete -c venice -n "__fish_seen_subcommand_from chat" -l image -d "Attach an image file or URL" -r
complete -c venice -n "__fish_seen_subcommand_from chat" -l file -d "Attach a document or source file" -r
complete -c venice -n "__fish_seen_subcommand_from chat" -l audio -d "Attach an audio file or URL" -r
complete -c venice -n "__fish_seen_subcommand_from chat" -l video -d "Attach a video file or URL" -r
complete -c venice -n "__fish_seen_subcommand_from chat" -s f -l format -d "Format" -xa "$formats"

# Search options
complete -c venice -n "__fish_seen_subcommand_from search" -s m -l model -d "Model" -xa "$models"
complete -c venice -n "__fish_seen_subcommand_from search" -s n -l results -d "Number of results"
complete -c venice -n "__fish_seen_subcommand_from search" -l citations -d "Include citations"
complete -c venice -n "__fish_seen_subcommand_from search" -l scrape -d "Scrape synthesized sources"
complete -c venice -n "__fish_seen_subcommand_from search" -l raw -d "Search without AI synthesis"
complete -c venice -n "__fish_seen_subcommand_from search" -l provider -d "Search provider" -xa "brave google"
complete -c venice -n "__fish_seen_subcommand_from search" -s f -l format -d "Format" -xa "$formats"

# Parse and scrape options
complete -c venice -n "__fish_seen_subcommand_from parse scrape" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from parse scrape" -s f -l format -d "Format" -xa "$formats"

# Image options
complete -c venice -n "__fish_seen_subcommand_from image" -s m -l model -d "Model" -xa "$image_models"
complete -c venice -n "__fish_seen_subcommand_from image" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from image" -s w -l width -d "Width"
complete -c venice -n "__fish_seen_subcommand_from image" -s h -l height -d "Height"
complete -c venice -n "__fish_seen_subcommand_from image" -s a -l aspect-ratio -d "Aspect ratio" -xa "1:1 3:2 2:3 4:3 3:4 16:9 9:16 21:9"
complete -c venice -n "__fish_seen_subcommand_from image" -l resolution -d "Resolution tier" -xa "1K 2K 4K"
complete -c venice -n "__fish_seen_subcommand_from image" -l quality -d "Output quality" -xa "low medium high"
complete -c venice -n "__fish_seen_subcommand_from image" -l style -d "Style preset"
complete -c venice -n "__fish_seen_subcommand_from image" -l style-reference -d "Style reference URL/base64"
complete -c venice -n "__fish_seen_subcommand_from image" -l negative -d "Negative prompt"
complete -c venice -n "__fish_seen_subcommand_from image" -l seed -d "Random seed"
complete -c venice -n "__fish_seen_subcommand_from image" -l cfg-scale -d "CFG scale"
complete -c venice -n "__fish_seen_subcommand_from image" -l steps -d "Inference steps"
complete -c venice -n "__fish_seen_subcommand_from image" -l lora-strength -d "LoRA strength"
complete -c venice -n "__fish_seen_subcommand_from image" -l hide-watermark -d "Hide Venice watermark"
complete -c venice -n "__fish_seen_subcommand_from image" -l no-hide-watermark -d "Keep Venice watermark"
complete -c venice -n "__fish_seen_subcommand_from image" -l safe-mode -d "Enable adult-content blurring"
complete -c venice -n "__fish_seen_subcommand_from image" -l no-safe-mode -d "Disable adult-content blurring"
complete -c venice -n "__fish_seen_subcommand_from image" -l embed-exif-metadata -d "Embed generation metadata"
complete -c venice -n "__fish_seen_subcommand_from image" -l no-embed-exif-metadata -d "Do not embed generation metadata"
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit" -s m -l model -d "Edit model" -xa "$edit_models"
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit image-bg-remove" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit image-bg-remove image-styles" -s f -l format -d "Output format" -xa "pretty json"
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit" -s a -l aspect-ratio -d "Output aspect ratio"
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit" -l enhance-prompt -d "Enhance edit prompt"
complete -c venice -n "__fish_seen_subcommand_from image-edit image-multi-edit" -l no-safe-mode -d "Disable safe mode"
complete -c venice -n "__fish_seen_subcommand_from image-multi-edit" -s p -l prompt -d "Edit instructions"

# TTS options
complete -c venice -n "__fish_seen_subcommand_from tts" -s v -l voice -d "Voice" -xa "$voices"
complete -c venice -n "__fish_seen_subcommand_from tts" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from tts" -s s -l speed -d "Speech speed"
complete -c venice -n "__fish_seen_subcommand_from tts" -l temperature -d "Sampling temperature"
complete -c venice -n "__fish_seen_subcommand_from tts" -l streaming -d "Request sentence streaming"

# Voice cloning
complete -c venice -n "__fish_seen_subcommand_from voice; and not __fish_seen_subcommand_from clone" -a clone -d "Clone a reference voice"
complete -c venice -n "__fish_seen_subcommand_from voice; and __fish_seen_subcommand_from clone" -s m -l model -d "Voice cloning model"
complete -c venice -n "__fish_seen_subcommand_from voice; and __fish_seen_subcommand_from clone" -s f -l format -d "Output format" -xa "pretty json"
complete -c venice -n "__fish_seen_subcommand_from voice; and __fish_seen_subcommand_from clone" -r

# Transcribe options
complete -c venice -n "__fish_seen_subcommand_from transcribe" -s m -l model -d "Model" -xa "$asr_models"
complete -c venice -n "__fish_seen_subcommand_from transcribe" -s t -l timestamps -d "Include timestamps"
complete -c venice -n "__fish_seen_subcommand_from transcribe" -r

# Video subcommands
complete -c venice -n "__fish_seen_subcommand_from video" -a generate -d "Queue video generation"
complete -c venice -n "__fish_seen_subcommand_from video" -a quote -d "Estimate video price"
complete -c venice -n "__fish_seen_subcommand_from video" -a status -d "Check status"
complete -c venice -n "__fish_seen_subcommand_from video" -a retrieve -d "Download video"
complete -c venice -n "__fish_seen_subcommand_from video" -a complete -d "Delete retrieved video"
complete -c venice -n "__fish_seen_subcommand_from video" -a transcribe -d "Transcribe a video URL"
complete -c venice -n "__fish_seen_subcommand_from video" -a upscale -d "Upscale a video"
complete -c venice -n "__fish_seen_subcommand_from video" -a models -d "List video models"

# Video generate options
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s m -l model -d "Model" -xa "$video_models"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s d -l duration -d "Duration"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s a -l aspect-ratio -d "Aspect ratio" -xa "16:9 9:16 1:1"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s i -l image -d "Reference image" -r
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from quote" -s r -l resolution -d "Resolution"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from status" -s w -l wait -d "Wait for completion"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from status" -s t -l timeout -d "Wait timeout in seconds"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from retrieve upscale" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from retrieve upscale" -l complete -d "Delete media after download"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from upscale quote" -l factor -d "Upscale factor" -xa "1 2 4"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from upscale" -l no-wait -d "Queue without waiting"

# Characters
complete -c venice -n "__fish_seen_subcommand_from characters" -a show -d "Show character details"
complete -c venice -n "__fish_seen_subcommand_from characters" -s s -l search -d "Search characters"
complete -c venice -n "__fish_seen_subcommand_from characters" -l limit -d "Number of characters to return"
complete -c venice -n "__fish_seen_subcommand_from characters" -l offset -d "Number of characters to skip"
complete -c venice -n "__fish_seen_subcommand_from characters" -s f -l format -d "Format" -xa "$formats"

# Music subcommands
complete -c venice -n "__fish_seen_subcommand_from music" -a generate -d "Queue audio generation"
complete -c venice -n "__fish_seen_subcommand_from music" -a quote -d "Estimate generation cost"
complete -c venice -n "__fish_seen_subcommand_from music" -a status -d "Check status"
complete -c venice -n "__fish_seen_subcommand_from music" -a retrieve -d "Download audio"
complete -c venice -n "__fish_seen_subcommand_from music" -a complete -d "Clean up stored audio"
complete -c venice -n "__fish_seen_subcommand_from music" -a models -d "List music models"

# Music options
complete -c venice -n "__fish_seen_subcommand_from music" -s m -l model -d "Model" -xa "$music_models"
complete -c venice -n "__fish_seen_subcommand_from music; and __fish_seen_subcommand_from generate" -s l -l lyrics -d "Lyrics file" -r
complete -c venice -n "__fish_seen_subcommand_from music; and __fish_seen_subcommand_from generate quote" -s d -l duration -d "Duration in seconds"
complete -c venice -n "__fish_seen_subcommand_from music; and __fish_seen_subcommand_from status" -s w -l wait -d "Wait for completion"
complete -c venice -n "__fish_seen_subcommand_from music; and __fish_seen_subcommand_from retrieve" -s o -l output -d "Output file" -r

# Config subcommands
complete -c venice -n "__fish_seen_subcommand_from config" -a show -d "Show config"
complete -c venice -n "__fish_seen_subcommand_from config" -a set -d "Set value"
complete -c venice -n "__fish_seen_subcommand_from config" -a get -d "Get value"
complete -c venice -n "__fish_seen_subcommand_from config" -a unset -d "Remove value"
complete -c venice -n "__fish_seen_subcommand_from config" -a path -d "Config path"
complete -c venice -n "__fish_seen_subcommand_from config" -a init -d "Initialize"

# History subcommands
complete -c venice -n "__fish_seen_subcommand_from history" -a list -d "List history"
complete -c venice -n "__fish_seen_subcommand_from history" -a show -d "Show conversation"
complete -c venice -n "__fish_seen_subcommand_from history" -a clear -d "Clear history"
complete -c venice -n "__fish_seen_subcommand_from history" -a export -d "Export history"

# Billing subcommands
complete -c venice -n "__fish_seen_subcommand_from billing" -a balance -d "Show balances"
complete -c venice -n "__fish_seen_subcommand_from billing" -a usage -d "Show billed usage"
complete -c venice -n "__fish_seen_subcommand_from billing" -a analytics -d "Show usage analytics"

# API key subcommands
complete -c venice -n "__fish_seen_subcommand_from keys" -a list -d "List API keys"
complete -c venice -n "__fish_seen_subcommand_from keys" -a create -d "Create API key"
complete -c venice -n "__fish_seen_subcommand_from keys" -a delete -d "Delete API key"
complete -c venice -n "__fish_seen_subcommand_from keys" -a rate-limits -d "Show rate limits"
complete -c venice -n "__fish_seen_subcommand_from keys; and __fish_seen_subcommand_from create" -s o -l output -d "Restrictive API key secret file" -r

# Completions
complete -c venice -n "__fish_seen_subcommand_from completions" -a "bash zsh fish" -d "Shell"

# RPC
complete -c venice -n "__fish_seen_subcommand_from rpc" -a networks -d "List supported networks"
complete -c venice -n "__fish_seen_subcommand_from rpc" -l batch -d "JSON-RPC batch file" -r
complete -c venice -n "__fish_seen_subcommand_from rpc" -s f -l format -d "Format" -xa "$formats"`;
}
