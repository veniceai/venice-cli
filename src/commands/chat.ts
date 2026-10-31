/**
 * Chat Command - Interactive chat with AI models
 */

import { Command } from 'commander';
import { randomUUID } from 'crypto';
import {
  chatCompletion,
  chatCompletionStream,
  listModels,
  fetchTeeAttestation,
} from '../lib/api.js';
import {
  getDefaultModel,
  addConversation,
  getLastConversation,
} from '../lib/config.js';
import {
  getToolDefinitions,
  executeTool,
  formatToolsHelp,
  MAX_TOOL_ARGUMENTS_BYTES,
} from '../lib/tools.js';
import {
  formatUsage,
  formatError,
  formatJson,
  formatWarning,
  getChalk,
  startSpinner,
  clearSpinner,
  detectOutputFormat,
  isPiped,
  terminalFilter,
  terminalSafe,
} from '../lib/output.js';
import {
  generateEphemeralKeyPair,
  encryptMessage,
  decryptChunk,
  isHexEncrypted,
  zeroFill,
} from '../lib/e2ee.js';
import {
  ATTESTATION_SCOPE_NOTE,
  buildTeeVerificationResult,
  evaluateE2EEAttestationPolicy,
  evaluateTEEAttestationPolicy,
  type TeeVerificationResult,
} from '../lib/tee.js';
import type { Message, Model, OutputFormat, ToolCall } from '../types/index.js';
import {
  isE2EEModel,
  isTEEModel,
  supportsReasoningEffort,
  supportsResponseSchema,
  supportsXSearch,
} from '../types/index.js';
import {
  parseStructuredContent,
  normalizeResponseFormat,
  resolveResponseFormat,
  validateAgainstSchema,
  type PromptCacheRetention,
  type ReasoningEffort,
  type ResponseFormat,
  PROMPT_CACHE_RETENTIONS,
  REASONING_EFFORTS,
} from '../lib/structured-output.js';
import type { ChatCompletionRequestOptions } from '../lib/api.js';
import {
  assertAttachmentCapabilities,
  assertAttachmentsAllowedForPrivacy,
  assertLocalAttachmentFiles,
  buildUserMessageContent,
  collectOptionValue,
  hasChatAttachments,
  parseChatAttachments,
} from '../lib/chat-attachments.js';

interface E2EEContext {
  privateKey: Uint8Array;
  publicKeyHex: string;
  modelPublicKey: string;
  signingAddress?: string;
  attestation: TeeVerificationResult;
}

export const MAX_TOOL_ROUNDS = 10;
export const MAX_CHAT_STDIN_BYTES = 1024 * 1024;
export const MAX_CONTEXT_REPLY_CHARS = 1024 * 1024;
type ChatCompletionFn = typeof chatCompletion;
type ChatCompletionStreamFn = typeof chatCompletionStream;

async function setupE2EE(
  modelId: string,
  showDetails: boolean,
  format: OutputFormat,
  quiet = false
): Promise<E2EEContext> {
  const c = getChalk();

  try {
    // Fetch attestation (spinner controlled by quiet flag)
    const { response, clientNonce } = await fetchTeeAttestation(modelId, { showSpinner: !quiet });
    const attestation = buildTeeVerificationResult(response, clientNonce, modelId);
    const { parsedTdxQuote, signingKey } = attestation;

    // Evaluate policy
    const policy = evaluateE2EEAttestationPolicy(attestation, modelId);
    if (!policy.passed || !signingKey) {
      throw new Error(`E2EE attestation policy failed: ${policy.failures.join('; ')}`);
    }

    // Show success after attestation verified (unless quiet mode)
    if (!quiet) {
      // Raw output must carry only the decrypted reply.
      const status = format === 'pretty' ? console.log : console.error;
      status(c.green('✓') + " Server attestation report passed the CLI's consistency checks");
      status(c.dim(`  ${ATTESTATION_SCOPE_NOTE}`));

      if (showDetails && format === 'pretty') {
        console.log(c.dim(`\nTEE Provider: ${terminalSafe(response.tee_provider || 'Unknown')}`));
        console.log(c.dim(`Model: ${terminalSafe(response.model)}`));
        console.log(c.dim(`Signing Address: ${terminalSafe(response.signing_address || 'N/A')}`));
        if (parsedTdxQuote) {
          console.log(c.dim(`TDX Version: ${parsedTdxQuote.version}`));
          console.log(c.dim(`MRTD: ${parsedTdxQuote.mrtd.slice(0, 32)}...`));
        }
        console.log('');
      }
    }

    // Generate ephemeral key pair
    const { privateKey, publicKeyHex } = generateEphemeralKeyPair();

    return {
      privateKey,
      publicKeyHex,
      modelPublicKey: signingKey,
      signingAddress: response.signing_address,
      attestation,
    };
  } catch (error) {
    // apiRequest handles its own spinner cleanup on errors
    throw error;
  }
}

// Verify TEE attestation for TEE models (without E2EE encryption setup)
async function verifyTEEAttestation(
  modelId: string,
  showDetails: boolean,
  format: OutputFormat,
  quiet = false
): Promise<void> {
  const c = getChalk();

  // Fetch and verify attestation
  const { response, clientNonce } = await fetchTeeAttestation(modelId, { showSpinner: !quiet });
  const attestation = buildTeeVerificationResult(response, clientNonce, modelId);
  const { parsedTdxQuote } = attestation;

  const policy = evaluateTEEAttestationPolicy(attestation, modelId);
  if (!policy.passed) {
    throw new Error(`TEE attestation policy failed: ${policy.failures.join('; ')}`);
  }

  // Show success message
  if (!quiet) {
    // Raw output must carry only the reply.
    const status = format === 'pretty' ? console.log : console.error;
    status(c.cyan("🛡️  TEE mode: not end-to-end encrypted; Venice's proxy can read the prompt"));
    status("Server attestation report passed the CLI's consistency checks; it is not bound to this request");
    status(c.dim(`  ${ATTESTATION_SCOPE_NOTE}`));

    if (showDetails && format === 'pretty') {
      console.log(c.dim(`\nTEE Provider: ${terminalSafe(response.tee_provider || 'Unknown')}`));
      console.log(c.dim(`Model: ${terminalSafe(response.model)}`));
      console.log(c.dim(`Signing Address: ${terminalSafe(response.signing_address || 'N/A')}`));
      if (parsedTdxQuote) {
        console.log(c.dim(`TDX Version: ${parsedTdxQuote.version}`));
        console.log(c.dim(`MRTD: ${parsedTdxQuote.mrtd.slice(0, 32)}...`));
      }
    }
    status('');
  }
}

function buildE2EEHeaders(context: E2EEContext): Record<string, string> {
  return {
    'X-Venice-TEE-Client-Pub-Key': context.publicKeyHex,
    'X-Venice-TEE-Signing-Algo': 'ecdsa',
    'X-Venice-TEE-Model-Pub-Key': context.modelPublicKey,
  };
}

function rejectE2EEStream(reason: string, format: OutputFormat): never {
  if (format === 'pretty') {
    process.stdout.write('\n');
  }
  throw new Error(`E2EE response rejected: ${reason}`);
}

function decryptE2EEContent(content: string, privateKey: Uint8Array, format: OutputFormat): string {
  if (!isHexEncrypted(content) || content.length % 2 !== 0) {
    rejectE2EEStream('a response chunk was not encrypted. Output stopped at that chunk.', format);
  }
  try {
    return decryptChunk(content, privateKey);
  } catch {
    rejectE2EEStream('a response chunk could not be decrypted. Output stopped at that chunk.', format);
  }
}

function encryptMessagesForE2EE(
  messages: Message[],
  modelPublicKey: string
): Message[] {
  return messages.map((msg) => {
    if (msg.role === 'user' || msg.role === 'system') {
      if (typeof msg.content !== 'string') {
        throw new Error(
          'E2EE does not support multimodal attachments. Use a text-only prompt, or omit --image/--file/--audio/--video.'
        );
      }
      return {
        ...msg,
        content: encryptMessage(msg.content, modelPublicKey),
      };
    }
    return msg;
  });
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat [prompt...]')
    .description('Chat with an AI model')
    .option('-m, --model <model>', 'Model to use')
    .option('-s, --system <prompt>', 'System prompt')
    .option('-c, --character <slug>', 'Character slug from the Venice API catalog (e.g. alan-watts)')
    .option('-t, --tools <tools>', 'Comma-separated list of tools to enable')
    .option('--interactive-tools', 'Require approval for each tool call')
    .option('--continue', 'Continue the last conversation')
    .option('--no-stream', 'Disable streaming output')
    .option('--web-search', 'Enable web search for current information')
    .option('--x-search', 'Enable xAI native search (web + X/Twitter) on supported Grok models')
    .option('--json', 'Request JSON object output without a schema (disables streaming)')
    .option('--json-schema <file>', 'Request structured JSON matching a schema file (disables streaming)')
    .option('--reasoning-effort <level>', `Reasoning effort (${REASONING_EFFORTS.join('|')})`)
    .option('--prompt-cache-key <key>', 'Route requests for better prompt-cache affinity')
    .option('--prompt-cache-retention <mode>', `Prompt cache retention (${PROMPT_CACHE_RETENTIONS.join('|')})`)
    .option('--no-thinking', 'Disable reasoning/thinking on reasoning models')
    .option('--strip-thinking', 'Strip thinking blocks from response')
    .option('--no-venice-prompt', 'Disable Venice system prompts')
    .option('--search-results-in-stream', 'Include search results in stream (when web-search enabled)')
    .option('--e2ee', 'Require E2EE encryption (implied by model ids containing "e2ee")')
    .option('--no-e2ee', "Disable E2EE; E2EE models fall back to TEE mode, where Venice's proxy can read the prompt")
    .option('--tee-verify', 'Show TEE attestation details')
    .option('-q, --quiet', 'Hide E2EE/TEE status messages (show only response)')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .option('--list-tools', 'List available tools')
    .option('--image <path>', 'Attach an image file or URL (repeatable)', collectOptionValue, [])
    .option('--file <path>', 'Attach a document or source file (repeatable)', collectOptionValue, [])
    .option('--audio <path>', 'Attach an audio file or URL (repeatable)', collectOptionValue, [])
    .option('--video <path>', 'Attach a video file or URL (repeatable)', collectOptionValue, [])
    .action(async (promptParts: string[], options) => {
      const c = getChalk();

      // Handle --list-tools
      if (options.listTools) {
        console.log(formatToolsHelp());
        return;
      }

      let responseFormat: ResponseFormat | undefined;
      try {
        responseFormat = resolveResponseFormat({
          json: options.json === true,
          jsonSchema: options.jsonSchema,
        });
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }

      let reasoningEffort: ReasoningEffort | undefined;
      if (options.reasoningEffort) {
        const level = String(options.reasoningEffort).toLowerCase();
        if (!REASONING_EFFORTS.includes(level as ReasoningEffort)) {
          console.error(formatError(
            `Invalid --reasoning-effort "${options.reasoningEffort}". Use one of: ${REASONING_EFFORTS.join(', ')}`
          ));
          process.exit(1);
        }
        reasoningEffort = level as ReasoningEffort;
      }

      if (options.thinking === false && reasoningEffort && reasoningEffort !== 'none') {
        console.error(formatError('Cannot combine --no-thinking with --reasoning-effort (except "none").'));
        process.exit(1);
      }

      let promptCacheRetention: PromptCacheRetention | undefined;
      if (options.promptCacheRetention) {
        const retention = String(options.promptCacheRetention).toLowerCase();
        if (!PROMPT_CACHE_RETENTIONS.includes(retention as PromptCacheRetention)) {
          console.error(formatError(
            `Invalid --prompt-cache-retention "${options.promptCacheRetention}". Use one of: ${PROMPT_CACHE_RETENTIONS.join(', ')}`
          ));
          process.exit(1);
        }
        promptCacheRetention = retention as PromptCacheRetention;
      }

      // Get prompt from args and optionally stdin
      let prompt = promptParts.join(' ');
      const attachments = parseChatAttachments(options);

      try {
        assertLocalAttachmentFiles(attachments);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
      if (options.interactiveTools && !process.stdin.isTTY) {
        console.error(formatError(
          '--interactive-tools asks for approval on the terminal, but stdin is not a terminal. ' +
          'Run the command in a terminal without piped input, or omit --interactive-tools.'
        ));
        process.exit(1);
      }
      let pipedInput = '';

      if (!process.stdin.isTTY) {
        try {
          pipedInput = await readStdin();
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      const userMessage = buildChatUserMessage(prompt, pipedInput);
      if (!userMessage && !hasChatAttachments(attachments)) {
        console.error(formatError('No prompt provided. Usage: venice chat "Your message"'));
        process.exit(1);
      }

      const model = options.model || getDefaultModel();
      const format = detectOutputFormat(options.format);
      const quietStatus = options.quiet || Boolean(responseFormat) || format === 'json';

      if (
        hasChatAttachments(attachments) &&
        (
          options.e2ee === true ||
          (options.e2ee !== false && modelIdImpliesPrivateMode(model))
        )
      ) {
        console.error(formatError(
          'Multimodal attachments are not supported with E2EE or TEE. ' +
          'No attachment data was read or sent.'
        ));
        process.exit(1);
      }

      let useE2EE = false;
      let useTEE = false;
      let e2eeContext: E2EEContext | undefined;
      let modelInfo: Model | undefined;
      let catalogFailed = false;
      let catalog: Model[] = [];

      // Fetch model capabilities from API
      try {
        catalog = await listModels({ showSpinner: !quietStatus });
        modelInfo = catalog.find((m) => m.id === model);
      } catch {
        catalogFailed = true;
      }

      const privacyDecision = resolveChatPrivacyMode({
        modelId: model,
        modelInfo,
        catalogFailed,
        e2eeFlag: options.e2ee,
      });

      if (privacyDecision.error) {
        console.error(formatError(privacyDecision.error));
        process.exit(1);
      }
      if (privacyDecision.notice) {
        console.error(formatWarning(privacyDecision.notice));
      }

      useE2EE = privacyDecision.useE2EE;
      useTEE = privacyDecision.useTEE;

      const capabilityError = requestedCapabilityError({
        model,
        modelInfo,
        catalogFailed,
        responseFormatRequested: Boolean(responseFormat),
        reasoningEffortRequested: reasoningEffort !== undefined,
        xSearchRequested: options.xSearch === true,
      });
      if (capabilityError) {
        console.error(formatError(capabilityError));
        process.exit(1);
      }

      if (hasChatAttachments(attachments)) {
        try {
          assertAttachmentsAllowedForPrivacy(useE2EE, useTEE);
          if (catalogFailed || !modelInfo) {
            throw new Error(
              'Could not verify attachment capabilities for the selected model; refusing to send attachments.'
            );
          }
          assertAttachmentCapabilities(modelInfo, attachments);
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      const lastConv = options.continue ? getLastConversation() : undefined;
      if (lastConv) {
        const currentPrivacy = useE2EE ? 'e2ee' : useTEE ? 'tee' : 'plain';
        const continueError = continueConversationError(lastConv, {
          model,
          privacy: currentPrivacy,
          lastModel: catalog.find((m) => m.id === lastConv.model),
          catalogAvailable: catalog.length > 0,
        });
        if (continueError) {
          console.error(formatError(continueError));
          process.exit(1);
        }
      }

      // Send -c/--character to the API as a catalog slug, including names that
      // used to be local personas (poet, pirate, …). Continue only skips those
      // names when history still contains the old injected persona prompt.
      const historyCharacter = options.character
        ? String(options.character)
        : restoreCharacterSlug(lastConv);
      const continuedCharacter = useE2EE ? undefined : historyCharacter;
      if (options.character && useE2EE) {
        console.error(formatError(
          'Characters are applied server-side and cannot be used with E2EE. ' +
          'Omit -c/--character or use --no-e2ee.'
        ));
        process.exit(1);
      }
      if (useE2EE && historyCharacter && !options.character && format === 'pretty' && !options.quiet) {
        console.log(formatWarning(
          `Saved character "${historyCharacter}" will not be applied; E2EE cannot use server-side personas.`,
          process.stdout
        ));
      }

      // TEE-only mode: verify attestation without encryption
      if (useTEE && !useE2EE) {
        try {
          await verifyTEEAttestation(model, options.teeVerify, format, quietStatus);
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      if (useE2EE && responseFormat) {
        console.error(formatError('Structured output (--json / --json-schema) is not supported with E2EE. E2EE requires streaming.'));
        process.exit(1);
      }
      if (useE2EE && options.stream === false) {
        console.error(formatError(
          '--no-stream is not supported with E2EE: responses can only be decrypted while streaming. ' +
          'Remove --no-stream, or use --no-e2ee.'
        ));
        process.exit(1);
      }
      if (
        useE2EE &&
        (
          options.promptCacheKey !== undefined ||
          promptCacheRetention !== undefined ||
          reasoningEffort !== undefined
        )
      ) {
        console.error(formatError(
          'Prompt caching (--prompt-cache-key / --prompt-cache-retention) and --reasoning-effort are not supported with E2EE.'
        ));
        process.exit(1);
      }

      // E2EE mode: full attestation + encryption setup
      if (useE2EE) {
        if (format === 'pretty' && !options.quiet) {
          console.log(c.magenta('🔐 E2EE model detected - enabling end-to-end encryption\n'));
        }
        try {
          e2eeContext = await setupE2EE(model, options.teeVerify, format, quietStatus);
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      // Build messages array
      const messages: Message[] = [];

      // Handle --continue flag
      if (lastConv) {
        for (const msg of lastConv.messages) {
          messages.push(msg as Message);
        }
        if (format === 'pretty' && !responseFormat) {
          console.log(c.dim(`Continuing conversation (${lastConv.messages.length} previous messages)\n`));
          console.log(c.dim('Note: --continue replays local history and is not covered by TEE/E2EE enclave guarantees.\n'));
        }
      }

      // Add system prompt (can be combined with --character)
      if (options.system) {
        messages.push({ role: 'system', content: options.system });
      }

      // Add user message
      let userContent: Message['content'];
      try {
        const textContent =
          userMessage && typeof userMessage.content === 'string'
            ? userMessage.content
            : '';
        userContent = await buildUserMessageContent(textContent, attachments);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
      messages.push({ role: 'user', content: userContent });

      // Get tool definitions
      const toolNames = options.tools?.split(',').map((t: string) => t.trim()) || [];
      const tools = getToolDefinitions(toolNames);

      // Build venice_parameters
      const veniceParams: Record<string, unknown> = {};
      if (continuedCharacter) {
        veniceParams.character_slug = continuedCharacter;
      }
      if (options.xSearch) {
        veniceParams.enable_x_search = true;
        if (options.webSearch && format === 'pretty' && !responseFormat) {
          console.log(c.yellow('⚠ --x-search replaces Venice web search; --web-search will be ignored.\n'));
        }
      } else if (options.webSearch) {
        veniceParams.enable_web_search = 'on';
      }
      if (options.thinking === false) {
        veniceParams.disable_thinking = true;
      }
      if (options.stripThinking) {
        veniceParams.strip_thinking_response = true;
      }
      if (options.venicePrompt === false) {
        veniceParams.include_venice_system_prompt = false;
      }
      if (options.searchResultsInStream) {
        veniceParams.include_search_results_in_stream = true;
      }
      if (useE2EE) {
        veniceParams.enable_e2ee = true;
      } else if (options.e2ee === false) {
        veniceParams.enable_e2ee = false;
      }

      const chatExtras: ChatRunExtras = {
        veniceParams,
        e2eeContext,
        quiet: quietStatus,
        stripThinking: options.stripThinking,
        responseFormat,
        reasoningEffort,
        promptCacheKey: options.promptCacheKey,
        promptCacheRetention,
        recordUsage: !useE2EE && !useTEE,
      };

      // E2EE responses can only be decrypted on the streaming path, so piped
      // and non-pretty output must not fall back to nonStreamChat.
      const shouldStream =
        options.stream !== false &&
        (useE2EE || (!isPiped() && format === 'pretty' && !responseFormat));

      try {
        if (shouldStream) {
          await streamChat(messages, model, tools, options.interactiveTools, format, chatExtras);
        } else {
          await nonStreamChat(messages, model, tools, options.interactiveTools, format, chatExtras);
        }

        if (!useE2EE && !useTEE) {
          addConversation({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            messages,
            model,
            character: historyCharacter,
            privacy: 'plain',
          });
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      } finally {
        // Securely clear E2EE private key from memory
        if (e2eeContext?.privateKey) {
          zeroFill(e2eeContext.privateKey);
        }
      }
    });
}

// State machine for processing thinking blocks in streaming content
interface ThinkingState {
  inThinkingBlock: boolean;
  thinkingBuffer: string; // Buffer content inside <think> until we see </think>
  tagBuffer: string; // Buffer for partial tags
  display: (text: string) => string; // Makes streamed model text safe for stdout
}

function processThinkingContent(
  content: string,
  state: ThinkingState,
  options: { strip: boolean; format: OutputFormat },
  chalk: ReturnType<typeof getChalk>
): { output: string; state: ThinkingState } {
  let output = '';
  let text = state.tagBuffer + state.display(content);
  let { inThinkingBlock, thinkingBuffer } = state;
  let tagBuffer = '';

  while (text.length > 0) {
    if (!inThinkingBlock) {
      // Look for opening <think> tag
      const openIdx = text.indexOf('<think>');
      if (openIdx === -1) {
        // Check for partial <think tag at end
        const partialIdx = text.lastIndexOf('<');
        if (partialIdx !== -1 && partialIdx > text.length - 7) {
          output += text.slice(0, partialIdx);
          tagBuffer = text.slice(partialIdx);
          text = '';
        } else {
          output += text;
          text = '';
        }
      } else {
        // Found opening tag
        output += text.slice(0, openIdx);
        text = text.slice(openIdx + 7); // Skip <think>
        inThinkingBlock = true;
        thinkingBuffer = '';
      }
    } else {
      // Inside thinking block - look for closing </think> tag
      const closeIdx = text.indexOf('</think>');
      if (closeIdx === -1) {
        // No closing tag yet - buffer the content
        // Check for partial </think tag at end
        const partialIdx = text.lastIndexOf('<');
        if (partialIdx !== -1 && partialIdx > text.length - 8) {
          thinkingBuffer += text.slice(0, partialIdx);
          tagBuffer = text.slice(partialIdx);
          text = '';
        } else {
          thinkingBuffer += text;
          text = '';
        }
      } else {
        // Found closing tag - we have a complete thinking block
        thinkingBuffer += text.slice(0, closeIdx);
        text = text.slice(closeIdx + 8); // Skip </think>
        inThinkingBlock = false;
        
        // Output thinking content (formatted or stripped)
        if (!options.strip && thinkingBuffer.trim()) {
          if (options.format === 'pretty') {
            output += chalk.dim('💭 ' + thinkingBuffer.trim()) + '\n';
          } else {
            output += thinkingBuffer;
          }
        }
        thinkingBuffer = '';
      }
    }
  }

  return {
    output,
    state: { inThinkingBlock, thinkingBuffer, tagBuffer, display: state.display },
  };
}

// Flush any remaining thinking buffer at end of stream
// If <think> was opened but never closed, just output the content normally
function flushThinkingState(
  state: ThinkingState,
  _options: { strip: boolean; format: OutputFormat },
  _chalk: ReturnType<typeof getChalk>
): string {
  let output = '';
  
  // If we're still in a thinking block without closing tag, output content normally
  if (state.inThinkingBlock && state.thinkingBuffer) {
    output += state.thinkingBuffer;
  }
  
  // Output any buffered partial tags
  if (state.tagBuffer) {
    output += state.tagBuffer;
  }
  
  return output;
}

export interface ChatRunExtras {
  veniceParams?: Record<string, unknown>;
  e2eeContext?: E2EEContext;
  quiet?: boolean;
  stripThinking?: boolean;
  responseFormat?: ResponseFormat;
  reasoningEffort?: ReasoningEffort;
  promptCacheKey?: string;
  promptCacheRetention?: PromptCacheRetention;
  recordUsage?: boolean;
  completion?: ChatCompletionFn;
  completionStream?: ChatCompletionStreamFn;
}

function buildRequestOptions(
  model: string,
  tools: ReturnType<typeof getToolDefinitions> | undefined,
  extras: ChatRunExtras,
  additionalHeaders?: Record<string, string>
): ChatCompletionRequestOptions {
  const request: ChatCompletionRequestOptions = { model };

  if (tools?.length) {
    request.tools = tools;
  }
  if (extras.veniceParams && Object.keys(extras.veniceParams).length > 0) {
    request.venice_parameters = extras.veniceParams;
  }
  if (additionalHeaders) {
    request.additionalHeaders = additionalHeaders;
  }
  if (extras.responseFormat) {
    request.response_format = normalizeResponseFormat(extras.responseFormat, 'response format');
  }
  if (extras.reasoningEffort) {
    request.reasoning_effort = extras.reasoningEffort;
  }
  if (extras.promptCacheKey) {
    request.prompt_cache_key = extras.promptCacheKey;
  }
  if (extras.promptCacheRetention) {
    request.prompt_cache_retention = extras.promptCacheRetention;
  }
  if (extras.recordUsage === false) {
    request.recordUsage = false;
  }

  return request;
}

function outputStructuredResponse(
  content: string,
  responseFormat: ResponseFormat,
  format: OutputFormat
): void {
  const parsed = parseStructuredContent(content);
  if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
    const errors = validateAgainstSchema(parsed, responseFormat.json_schema.schema);
    if (errors.length > 0) {
      throw new Error(`Structured output did not match the schema:\n${errors.map((error) => `  - ${error}`).join('\n')}`);
    }
  }

  if (format === 'raw') {
    console.log(formatJson(parsed, 0));
    return;
  }
  console.log(formatJson(parsed));
}

export async function streamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  extras: ChatRunExtras = {}
): Promise<void> {
  const c = getChalk();
  const e2eeContext = extras.e2eeContext;
  const quiet = extras.quiet ?? false;
  const stripThinking = extras.stripThinking ?? false;
  const completionStream = extras.completionStream ?? chatCompletionStream;

  let usage: any = null;

  // E2EE: Build headers
  const additionalHeaders = e2eeContext ? buildE2EEHeaders(e2eeContext) : undefined;

  // E2EE: Disable tools, web search, X search, and Venice system prompt for E2EE models
  // The Venice system prompt would be added server-side unencrypted, breaking E2EE
  const effectiveTools = e2eeContext ? undefined : tools;
  const effectiveExtras: ChatRunExtras = e2eeContext
    ? {
        ...extras,
        veniceParams: {
          ...extras.veniceParams,
          enable_web_search: undefined,
          enable_x_search: undefined,
          include_venice_system_prompt: false,
          include_search_results_in_stream: undefined,
          character_slug: undefined,
        },
        reasoningEffort: undefined,
        promptCacheKey: undefined,
        promptCacheRetention: undefined,
      }
    : extras;
  const allowedTools = new Set((effectiveTools || []).map((tool) => tool.function.name));

  try {
    const streamOptions = buildRequestOptions(model, effectiveTools, effectiveExtras, additionalHeaders);
    let toolRounds = 0;

    while (true) {
      let roundContent = '';
      let finishReason: string | undefined;
      const collectedToolCalls: StreamToolCallDelta[] = [];
      let thinkingState: ThinkingState = {
        inThinkingBlock: false,
        thinkingBuffer: '',
        tagBuffer: '',
        display: terminalFilter(),
      };
      const messagesToSend = e2eeContext
        ? encryptMessagesForE2EE(messages, e2eeContext.modelPublicKey)
        : messages;
      const spinnerText = e2eeContext && !quiet ? 'Waiting for encrypted response...' : 'Thinking...';
      const spinner = startSpinner(spinnerText);

      for await (const chunk of completionStream(messagesToSend, streamOptions)) {
        if (chunk.reasoning_content && !stripThinking && !e2eeContext && format !== 'json') {
          if (spinner) clearSpinner();
          const reasoning = thinkingState.display(chunk.reasoning_content);
          process.stdout.write(format === 'pretty' ? c.dim(reasoning) : reasoning);
        }
        if (chunk.content) {
          if (spinner) clearSpinner();

          // E2EE: every content chunk must decrypt
          const displayContent = e2eeContext
            ? decryptE2EEContent(chunk.content, e2eeContext.privateKey, format)
            : chunk.content;

          const { output, state: newState } = processThinkingContent(
            displayContent,
            thinkingState,
            { strip: stripThinking, format },
            c
          );
          thinkingState = newState;

          if (output && format !== 'json') {
            process.stdout.write(output);
          }
          roundContent += displayContent;
        }

        if (chunk.tool_calls) {
          collectedToolCalls.push(...(chunk.tool_calls as StreamToolCallDelta[]));
        }
        if (chunk.finish_reason) {
          finishReason = chunk.finish_reason;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
        if (chunk.done) {
          break;
        }
      }
      clearSpinner();
      if (e2eeContext && !finishReason) {
        rejectE2EEStream('the stream ended without a finish reason, so the reply may be incomplete.', format);
      }

      const remaining = flushThinkingState(thinkingState, { strip: stripThinking, format }, c);
      if (remaining && format !== 'json') {
        process.stdout.write(remaining);
      }

      const hasToolCalls = collectedToolCalls.length > 0;
      const requestsToolExecution =
        finishReason === 'tool_calls' || hasToolCalls;
      if (!requestsToolExecution || e2eeContext) {
        appendAssistantReply(messages, roundContent);
        if (format === 'json') {
          const content = stripThinking ? stripThinkingForContext(roundContent) : roundContent;
          console.log(formatJson({ content }));
        }
        break;
      }
      if (!hasToolCalls) {
        throw new Error('Tool-call response did not include any tool calls');
      }
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        throw new Error(`Tool calling exceeded the limit of ${MAX_TOOL_ROUNDS} rounds`);
      }
      toolRounds++;

      const toolCalls = reconstructStreamToolCalls(collectedToolCalls);
      messages.push({
        role: 'assistant',
        content: stripThinkingForContext(roundContent),
        tool_calls: toolCalls,
      });

      console.log('\n');
      for (const toolCall of toolCalls) {
        if (!toolCall.function.name) {
          throw new Error(`Incomplete tool call received for id "${toolCall.id}"`);
        }

        const result = await executeChatTool(
          toolCall,
          allowedTools,
          interactiveTools
        );
        if (allowedTools.has(toolCall.function.name)) {
          console.log(c.dim(`\n[Tool: ${toolCall.function.name}]`));
          console.log(terminalSafe(result));
        }
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });
      }
      console.log('\n');
    }

    if (format === 'pretty') {
      console.log('\n');
    } else if (format !== 'json') {
      process.stdout.write('\n');
    }

    // Show usage
    if (usage && format === 'pretty') {
      console.log(formatUsage(usage));
    }

    // E2EE indicator (skip in quiet mode)
    if (e2eeContext && format === 'pretty' && !quiet) {
      console.log(c.magenta('🔐 Response decrypted end-to-end'));
    }
  } catch (error) {
    clearSpinner();
    throw error;
  }
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface AccumulatedStreamToolCall {
  order: number;
  index?: number;
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

function reconstructStreamToolCalls(toolCallDeltas: StreamToolCallDelta[]): ToolCall[] {
  const callsByIndex = new Map<number, AccumulatedStreamToolCall>();
  const callsById = new Map<string, AccumulatedStreamToolCall>();
  const orderedCalls: AccumulatedStreamToolCall[] = [];

  for (const [position, delta] of toolCallDeltas.entries()) {
    const index = typeof delta.index === 'number' ? delta.index : undefined;
    const id = typeof delta.id === 'string' && delta.id.length > 0 ? delta.id : undefined;

    let accumulated: AccumulatedStreamToolCall | undefined;
    if (index !== undefined) {
      accumulated = callsByIndex.get(index);
    }
    if (!accumulated && id) {
      accumulated = callsById.get(id);
    }
    if (!accumulated && index !== undefined && orderedCalls[index] && orderedCalls[index].index === undefined) {
      accumulated = orderedCalls[index];
    }

    if (!accumulated) {
      accumulated = {
        order: position,
        index,
        id,
        function: {
          name: '',
          arguments: '',
        },
      };
      orderedCalls.push(accumulated);
    }

    if (index !== undefined) {
      accumulated.index = index;
      callsByIndex.set(index, accumulated);
    }

    if (id) {
      accumulated.id = id;
      callsById.set(id, accumulated);
    }

    if (delta.function?.name) {
      accumulated.function.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      accumulated.function.arguments += delta.function.arguments;
    }
  }

  return orderedCalls
    .sort((a, b) => {
      if (a.index !== undefined && b.index !== undefined) {
        return a.index - b.index;
      }
      if (a.index !== undefined) return -1;
      if (b.index !== undefined) return 1;
      return a.order - b.order;
    })
    .map((toolCall, position): ToolCall => ({
      id: toolCall.id || `stream_tool_call_${toolCall.index ?? position}`,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }));
}

function parseToolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  const raw: unknown = toolCall.function.arguments;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new Error(
      `Invalid arguments for tool "${toolCall.function.name}" (id: ${toolCall.id}): expected a JSON string`
    );
  }
  if (raw && Buffer.byteLength(raw, 'utf8') > MAX_TOOL_ARGUMENTS_BYTES) {
    throw new Error(
      `Arguments for tool "${toolCall.function.name}" (id: ${toolCall.id}) exceed the ` +
      `${MAX_TOOL_ARGUMENTS_BYTES}-byte limit`
    );
  }
  const rawArgs = raw?.trim();
  if (!rawArgs) {
    return {};
  }

  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON arguments for tool "${toolCall.function.name}" (id: ${toolCall.id}): ${reason}`
    );
  }
}

async function executeChatTool(
  toolCall: ToolCall,
  allowedTools: ReadonlySet<string>,
  interactive: boolean
): Promise<string> {
  if (!allowedTools.has(toolCall.function.name)) {
    return `Tool not enabled: ${toolCall.function.name}`;
  }

  const args = parseToolCallArguments(toolCall);
  return executeTool(toolCall.function.name, args, {
    interactive,
    allowedTools,
  });
}

export async function nonStreamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  extras: ChatRunExtras = {}
): Promise<void> {
  // E2EE requires streaming for response decryption
  if (extras.e2eeContext) {
    throw new Error('E2EE responses can only be decrypted in streaming mode.');
  }

  const chatOptions = buildRequestOptions(model, tools, extras);
  const allowedTools = new Set(tools.map((tool) => tool.function.name));
  const completion = extras.completion ?? chatCompletion;

  let toolRounds = 0;
  while (true) {
    const response = await completion(messages, chatOptions);
    const hasToolCalls = Boolean(response.tool_calls?.length);

    if (response.finish_reason !== 'tool_calls' && !hasToolCalls) {
      if (extras.responseFormat) {
        outputStructuredResponse(response.content, extras.responseFormat, format);
      } else {
        outputChatText(response.content, response.reasoning_content, format, extras);
      }
      appendAssistantReply(messages, response.content);
      if (response.usage && format === 'pretty') {
        console.log(formatUsage(response.usage));
      }
      return;
    }
    if (!hasToolCalls || !response.tool_calls) {
      throw new Error('Tool-call response did not include any tool calls');
    }
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      throw new Error(`Tool calling exceeded the limit of ${MAX_TOOL_ROUNDS} rounds`);
    }
    toolRounds++;

    messages.push({
      role: 'assistant',
      content: stripThinkingForContext(response.content),
      tool_calls: response.tool_calls,
    });

    for (const toolCall of response.tool_calls) {
      const result = await executeChatTool(
        toolCall,
        allowedTools,
        interactiveTools
      );
      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: toolCall.id,
      });
    }
  }
}

/**
 * Reasoning is shown to the user but never kept in the conversation, so
 * `--continue` does not resend it. An unclosed block (a reply cut off
 * mid-thought) is dropped too.
 */
export function stripThinkingForContext(content: string): string {
  const open = '<think>';
  const close = '</think>';
  let kept = '';
  let index = 0;
  while (index < content.length) {
    const start = content.indexOf(open, index);
    if (start === -1) {
      return kept + content.slice(index);
    }
    kept += content.slice(index, start);
    const end = content.indexOf(close, start + open.length);
    if (end === -1) {
      return kept;
    }
    index = end + close.length;
  }
  return kept;
}

function appendAssistantReply(messages: Message[], content: string): void {
  let reply = stripThinkingForContext(content).trim();
  if (reply.length > MAX_CONTEXT_REPLY_CHARS) {
    reply = `${reply.slice(0, MAX_CONTEXT_REPLY_CHARS)}\n[reply truncated]`;
  }
  if (reply) {
    messages.push({ role: 'assistant', content: reply });
  }
}

function outputChatText(
  content: string,
  reasoningContent: string | undefined,
  format: OutputFormat,
  extras: ChatRunExtras
): void {
  if (reasoningContent && !extras.stripThinking && format === 'pretty') {
    const c = getChalk();
    console.log(c.dim('💭 ' + terminalSafe(reasoningContent.trim())));
  }
  outputResponse(content, format);
}

function outputResponse(content: string, format: OutputFormat): void {
  switch (format) {
    case 'json':
      console.log(formatJson({ content }));
      break;
    case 'raw':
    case 'markdown':
      console.log(terminalSafe(content));
      break;
    case 'pretty':
    default:
      console.log(terminalSafe(content));
      break;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_CHAT_STDIN_BYTES) {
      throw new Error('Chat input from stdin exceeds the 1 MiB limit.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function buildChatUserMessage(prompt: string, pipedInput?: string): Message | null {
  if (pipedInput && prompt) {
    return { role: 'user', content: `${pipedInput}\n\n${prompt}` };
  }
  if (pipedInput) {
    return { role: 'user', content: pipedInput };
  }
  if (prompt) {
    return { role: 'user', content: prompt };
  }

  return null;
}

const LEGACY_LOCAL_CHARACTER_PROMPTS: Record<string, string> = {
  pirate: 'You are a pirate captain. Respond in pirate speak with nautical terms, "arr"s, and maritime metaphors. Be adventurous and bold.',
  wizard: 'You are a wise wizard. Speak in mystical terms, reference ancient knowledge, and occasionally make cryptic prophecies. Use archaic language.',
  scientist: 'You are a brilliant scientist. Explain things with precision, reference data and studies, and maintain intellectual rigor. Be curious and analytical.',
  poet: 'You are a romantic poet. Express yourself with beautiful language, metaphors, and emotional depth. Find beauty in everything.',
  coder: 'You are a senior software engineer. Be practical, reference best practices, and provide code examples when relevant. Value clean, maintainable solutions.',
  teacher: 'You are a patient teacher. Explain concepts clearly, use examples, and check for understanding. Encourage learning and curiosity.',
  comedian: 'You are a stand-up comedian. Find humor in everything, make jokes, use wordplay, and keep things light. But still be helpful!',
  philosopher: 'You are a deep philosopher. Question assumptions, explore ideas from multiple angles, and ponder the nature of existence. Be thoughtful and profound.',
};

export function isLegacyLocalCharacter(character?: string): boolean {
  return Boolean(character && character.toLowerCase() in LEGACY_LOCAL_CHARACTER_PROMPTS);
}

function hasLegacyLocalPersonaPrompt(
  character: string,
  messages?: Array<{ role: string; content?: Message['content'] }>
): boolean {
  const prompt = LEGACY_LOCAL_CHARACTER_PROMPTS[character.toLowerCase()];
  if (!prompt) return false;
  return Boolean(messages?.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content === prompt
  ));
}

export function restoreCharacterSlug(lastConv?: {
  character?: string;
  messages?: Array<{ role: string; content?: Message['content'] }>;
}): string | undefined {
  if (!lastConv?.character) return undefined;
  // Old local personas stored the name plus an injected system prompt. Skip
  // those so we do not send a leftover slug. A catalog character combined with
  // --system still restores, because that system text is not the old prompt.
  if (hasLegacyLocalPersonaPrompt(lastConv.character, lastConv.messages)) {
    return undefined;
  }
  return lastConv.character;
}

export function modelIdImpliesPrivateMode(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return modelIdRequiresE2EE(id) || id.startsWith('tee-') || id.includes('-tee');
}

export function modelIdRequiresE2EE(modelId: string): boolean {
  return modelId.toLowerCase().includes('e2ee');
}

export function modelImpliesPrivateHistory(modelId: string): boolean {
  return modelIdImpliesPrivateMode(modelId);
}

export function requestedCapabilityError(input: {
  model: string;
  modelInfo?: Model;
  catalogFailed: boolean;
  responseFormatRequested: boolean;
  reasoningEffortRequested: boolean;
  xSearchRequested: boolean;
}): string | undefined {
  const requested = input.responseFormatRequested ||
    input.reasoningEffortRequested ||
    input.xSearchRequested;
  if (!requested) return undefined;

  if (input.catalogFailed) {
    return (
      'Could not fetch the model catalog, so the requested capability cannot be verified. ' +
      'Structured output, --reasoning-effort, and --x-search require an explicitly advertised model capability.'
    );
  }
  if (!input.modelInfo) {
    return (
      `Model "${input.model}" is absent from the model catalog. ` +
      'Refusing to use structured output, --reasoning-effort, or --x-search without an explicitly advertised capability.'
    );
  }
  if (input.responseFormatRequested && !supportsResponseSchema(input.modelInfo)) {
    return `Model "${input.model}" does not support structured output (supportsResponseSchema).`;
  }
  if (input.reasoningEffortRequested && !supportsReasoningEffort(input.modelInfo)) {
    return `Model "${input.model}" does not support --reasoning-effort (supportsReasoningEffort).`;
  }
  if (input.xSearchRequested && !supportsXSearch(input.modelInfo)) {
    return (
      `Model "${input.model}" does not support --x-search (supportsXSearch). ` +
      'Use a model that explicitly advertises X search.'
    );
  }
  return undefined;
}

export function resolveChatPrivacyMode(input: {
  modelId: string;
  modelInfo?: Model;
  catalogFailed: boolean;
  e2eeFlag?: boolean;
}): { useE2EE: boolean; useTEE: boolean; error?: string; notice?: string } {
  if (input.catalogFailed) {
    if (input.e2eeFlag === true || modelIdImpliesPrivateMode(input.modelId)) {
      return {
        useE2EE: false,
        useTEE: false,
        error:
          'Could not fetch model capabilities; refusing to send this request in the clear. ' +
          'Retry when /models is reachable, or use a non-E2EE/TEE model.',
      };
    }
    return { useE2EE: false, useTEE: false };
  }

  if (!input.modelInfo) {
    if (input.e2eeFlag === true || modelIdImpliesPrivateMode(input.modelId)) {
      return {
        useE2EE: false,
        useTEE: false,
        error:
          `Could not confirm capabilities for "${input.modelId}"; refusing to send this request in the clear.`,
      };
    }
    return { useE2EE: false, useTEE: false };
  }

  const supportsE2EE = isE2EEModel(input.modelInfo);
  const supportsTEE = isTEEModel(input.modelInfo);

  if (
    input.e2eeFlag === true ||
    (input.e2eeFlag !== false && modelIdRequiresE2EE(input.modelId))
  ) {
    if (!supportsE2EE) {
      return {
        useE2EE: false,
        useTEE: false,
        error:
          `Model "${input.modelId}" does not support E2EE encryption (the model catalog does not ` +
          'advertise supportsE2EE for it); refusing to send this request in the clear.',
      };
    }
    return { useE2EE: true, useTEE: false };
  }

  if (
    modelIdImpliesPrivateMode(input.modelId) &&
    !supportsE2EE &&
    !supportsTEE
  ) {
    return {
      useE2EE: false,
      useTEE: false,
      error:
        `Could not confirm private-mode capabilities for "${input.modelId}"; ` +
        'refusing to send this request in the clear.',
    };
  }

  if (input.e2eeFlag === false) {
    const useTEE = supportsTEE || supportsE2EE;
    if (useTEE && (supportsE2EE || modelIdRequiresE2EE(input.modelId))) {
      return {
        useE2EE: false,
        useTEE,
        notice:
          '--no-e2ee: end-to-end encryption is off for this E2EE model. ' +
          "The request uses TEE mode, so Venice's proxy can read the prompt.",
      };
    }
    return { useE2EE: false, useTEE };
  }

  if (supportsE2EE) {
    return { useE2EE: true, useTEE: false };
  }
  if (supportsTEE) {
    return { useE2EE: false, useTEE: true };
  }
  return { useE2EE: false, useTEE: false };
}

export function continueConversationError(
  lastConv: { model: string; privacy?: string },
  current: {
    model: string;
    privacy: 'plain' | 'e2ee' | 'tee';
    lastModel?: Model;
    catalogAvailable?: boolean;
  }
): string | undefined {
  const lastPrivate = lastConv.privacy !== undefined
    ? lastConv.privacy === 'e2ee' || lastConv.privacy === 'tee'
    : modelImpliesPrivateHistory(lastConv.model) ||
      (current.lastModel ? isE2EEModel(current.lastModel) || isTEEModel(current.lastModel) : false);
  const currentPrivate =
    current.privacy === 'e2ee' ||
    current.privacy === 'tee';

  if (
    lastConv.privacy === undefined &&
    !modelImpliesPrivateHistory(lastConv.model) &&
    (current.catalogAvailable === false || !current.lastModel)
  ) {
    return (
      'Cannot continue this conversation because model capabilities could not be confirmed. ' +
      'Retry when /models is reachable, or start a new chat.'
    );
  }

  if (lastPrivate !== currentPrivate) {
    return (
      'Cannot continue a conversation across plaintext and E2EE/TEE sessions. ' +
      'Start a new chat or match the previous privacy mode.'
    );
  }

  if (lastPrivate && lastConv.model !== current.model) {
    return (
      `Cannot continue a private conversation with a different model ` +
      `(was ${lastConv.model}, now ${current.model}).`
    );
  }

  if (
    (lastConv.privacy === 'e2ee' || lastConv.privacy === 'tee') &&
    (current.privacy === 'e2ee' || current.privacy === 'tee') &&
    lastConv.privacy !== current.privacy
  ) {
    return (
      `Cannot continue a ${lastConv.privacy} conversation with a ${current.privacy} session. ` +
      'Start a new chat or match the previous privacy mode.'
    );
  }

  return undefined;
}
