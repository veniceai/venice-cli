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

    local commands="chat search image tts transcribe models embeddings upscale history usage config characters voices video music completions"
    local config_cmds="show set get unset path init"
    local history_cmds="list show clear export"
    local video_cmds="generate status retrieve models"
    local music_cmds="generate quote status retrieve complete models"
    local formats="pretty json markdown raw"
    local models="kimi-k2-5 zai-org-glm-4.7 zai-org-glm-4.6 claude-opus-4-6 claude-opus-45 claude-sonnet-4-6 openai-gpt-53-codex minimax-m25"
    local image_models="flux-2-pro flux-2-max seedream-v5-lite recraft-v4 grok-imagine nano-banana-pro"
    local video_models="wan-2.6-text-to-video wan-2.6-image-to-video veo3-fast-text-to-video sora2-text-to-video kling-v3-pro-text-to-video"
    local music_models="elevenlabs-music elevenlabs-sound-effects-v2"
    local asr_models="nvidia/parakeet-tdt-0.6b-v3 openai/whisper-large-v3"
    local voices="af_sky af_bella af_nicole am_adam am_michael bf_emma bf_isabella bm_george bm_lewis"
    local characters="pirate wizard scientist poet coder teacher comedian philosopher"
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
        music)
            COMPREPLY=( \$(compgen -W "\${music_cmds}" -- "\${cur}") )
            return 0
            ;;
        -m|--model)
            COMPREPLY=( \$(compgen -W "\${models} \${image_models} \${video_models} \${music_models}" -- "\${cur}") )
            return 0
            ;;
        -v|--voice)
            COMPREPLY=( \$(compgen -W "\${voices}" -- "\${cur}") )
            return 0
            ;;
        -c|--character)
            COMPREPLY=( \$(compgen -W "\${characters}" -- "\${cur}") )
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
        completions)
            COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\${cur}") )
            return 0
            ;;
    esac

    case "\${words[1]}" in
        chat)
            COMPREPLY=( \$(compgen -W "-m --model -s --system -c --character -t --tools --interactive-tools --continue --no-stream -f --format --list-tools" -- "\${cur}") )
            return 0
            ;;
        search)
            COMPREPLY=( \$(compgen -W "-m --model -n --results -f --format" -- "\${cur}") )
            return 0
            ;;
        image)
            COMPREPLY=( \$(compgen -W "-m --model -o --output -w --width -h --height -n --count -f --format" -- "\${cur}") )
            return 0
            ;;
        tts|speak)
            COMPREPLY=( \$(compgen -W "-v --voice -m --model -o --output --format" -- "\${cur}") )
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
                status)
                    COMPREPLY=( \$(compgen -W "-w --wait -f --format" -- "\${cur}") )
                    ;;
                retrieve|download)
                    COMPREPLY=( \$(compgen -W "-o --output -f --format" -- "\${cur}") )
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
        'search:Web search with AI synthesis'
        'image:Generate an image'
        'upscale:Upscale an image'
        'tts:Convert text to speech'
        'transcribe:Transcribe audio to text'
        'video:AI video generation'
        'music:Generate music and sound effects'
        'models:List available models'
        'embeddings:Generate text embeddings'
        'history:View conversation history'
        'usage:Show usage statistics'
        'config:Manage configuration'
        'characters:List available characters'
        'voices:List available TTS voices'
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

    local -a characters=(
        'pirate:Swashbuckling sea captain'
        'wizard:Mystical sage'
        'scientist:Analytical mind'
        'poet:Romantic artist'
        'coder:Senior engineer'
        'teacher:Patient educator'
        'comedian:Humorous helper'
        'philosopher:Deep thinker'
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
                        '-c[Character to use]:character:((\$characters))' \\
                        '--character[Character to use]:character:((\$characters))' \\
                        '-t[Tools to enable]:tools:((\$tools))' \\
                        '--tools[Tools to enable]:tools:((\$tools))' \\
                        '--interactive-tools[Require tool approval]' \\
                        '--continue[Continue last conversation]' \\
                        '--no-stream[Disable streaming]' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '--format[Output format]:format:((\$formats))' \\
                        '--list-tools[List available tools]' \\
                        '*:prompt:'
                    ;;
                search)
                    _arguments \\
                        '-m[Model to use]:model:(\$models)' \\
                        '-n[Number of results]:number:' \\
                        '-f[Output format]:format:((\$formats))' \\
                        '*:query:'
                    ;;
                image)
                    _arguments \\
                        '-m[Model to use]:model:(\$image_models)' \\
                        '-o[Output file]:file:_files' \\
                        '-w[Width]:pixels:' \\
                        '-h[Height]:pixels:' \\
                        '-n[Number of images]:count:' \\
                        '-f[Output format]:format:((pretty json))' \\
                        '*:prompt:'
                    ;;
                tts|speak)
                    _arguments \\
                        '-v[Voice to use]:voice:((\$voices))' \\
                        '-m[Model to use]:model:(tts-kokoro)' \\
                        '-o[Output file]:file:_files' \\
                        '--format[Audio format]:format:(mp3 wav opus)' \\
                        '*:text:'
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
                        'status:Check generation status'
                        'retrieve:Download completed video'
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
set -l commands chat search image upscale tts transcribe video music models embeddings history usage config characters voices completions

# Disable file completions by default
complete -c venice -f

# Main commands
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a chat -d "Chat with an AI model"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a search -d "Web search with AI synthesis"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a image -d "Generate an image"
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
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a config -d "Manage config"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a characters -d "List characters"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a voices -d "List voices"
complete -c venice -n "not __fish_seen_subcommand_from $commands" -a completions -d "Shell completions"

# Models
set -l models kimi-k2-5 zai-org-glm-4.7 zai-org-glm-4.6 claude-opus-4-6 claude-opus-45 claude-sonnet-4-6 openai-gpt-53-codex minimax-m25
set -l image_models flux-2-pro flux-2-max seedream-v5-lite recraft-v4 grok-imagine nano-banana-pro
set -l video_models wan-2.6-text-to-video wan-2.6-image-to-video veo3-fast-text-to-video sora2-text-to-video kling-v3-pro-text-to-video
set -l music_models elevenlabs-music elevenlabs-sound-effects-v2
set -l asr_models nvidia/parakeet-tdt-0.6b-v3 openai/whisper-large-v3
set -l voices af_sky af_bella af_nicole am_adam am_michael bf_emma bm_george
set -l characters pirate wizard scientist poet coder teacher comedian philosopher
set -l tools calculator weather datetime random base64 hash
set -l formats pretty json markdown raw

# Chat options
complete -c venice -n "__fish_seen_subcommand_from chat" -s m -l model -d "Model" -xa "$models"
complete -c venice -n "__fish_seen_subcommand_from chat" -s s -l system -d "System prompt"
complete -c venice -n "__fish_seen_subcommand_from chat" -s c -l character -d "Character" -xa "$characters"
complete -c venice -n "__fish_seen_subcommand_from chat" -s t -l tools -d "Tools" -xa "$tools"
complete -c venice -n "__fish_seen_subcommand_from chat" -l interactive-tools -d "Approve tools"
complete -c venice -n "__fish_seen_subcommand_from chat" -l continue -d "Continue conversation"
complete -c venice -n "__fish_seen_subcommand_from chat" -l no-stream -d "Disable streaming"
complete -c venice -n "__fish_seen_subcommand_from chat" -s f -l format -d "Format" -xa "$formats"

# Image options
complete -c venice -n "__fish_seen_subcommand_from image" -s m -l model -d "Model" -xa "$image_models"
complete -c venice -n "__fish_seen_subcommand_from image" -s o -l output -d "Output file" -r
complete -c venice -n "__fish_seen_subcommand_from image" -s w -l width -d "Width"
complete -c venice -n "__fish_seen_subcommand_from image" -s h -l height -d "Height"

# TTS options
complete -c venice -n "__fish_seen_subcommand_from tts" -s v -l voice -d "Voice" -xa "$voices"
complete -c venice -n "__fish_seen_subcommand_from tts" -s o -l output -d "Output file" -r

# Transcribe options
complete -c venice -n "__fish_seen_subcommand_from transcribe" -s m -l model -d "Model" -xa "$asr_models"
complete -c venice -n "__fish_seen_subcommand_from transcribe" -s t -l timestamps -d "Include timestamps"
complete -c venice -n "__fish_seen_subcommand_from transcribe" -r

# Video subcommands
complete -c venice -n "__fish_seen_subcommand_from video" -a generate -d "Queue video generation"
complete -c venice -n "__fish_seen_subcommand_from video" -a status -d "Check status"
complete -c venice -n "__fish_seen_subcommand_from video" -a retrieve -d "Download video"
complete -c venice -n "__fish_seen_subcommand_from video" -a models -d "List video models"

# Video generate options
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s m -l model -d "Model" -xa "$video_models"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s d -l duration -d "Duration"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s a -l aspect-ratio -d "Aspect ratio" -xa "16:9 9:16 1:1"
complete -c venice -n "__fish_seen_subcommand_from video; and __fish_seen_subcommand_from generate" -s i -l image -d "Reference image" -r

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

# Completions
complete -c venice -n "__fish_seen_subcommand_from completions" -a "bash zsh fish" -d "Shell"`;
}
