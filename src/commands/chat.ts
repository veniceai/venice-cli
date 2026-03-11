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
} from '../lib/tools.js';
import {
  formatUsage,
  formatError,
  getChalk,
  startSpinner,
  clearSpinner,
  detectOutputFormat,
  isPiped,
} from '../lib/output.js';
import {
  generateEphemeralKeyPair,
  encryptMessage,
  decryptChunk,
  isHexEncrypted,
  zeroFill,
} from '../lib/e2ee.js';
import {
  parseTdxQuote,
  isTdDebugMode,
  evaluateE2EEAttestationPolicy,
  type TeeVerificationResult,
} from '../lib/tee.js';
import type { Message, OutputFormat, ToolCall } from '../types/index.js';
import { isE2EEModel } from '../types/index.js';

interface E2EEContext {
  privateKey: Uint8Array;
  publicKeyHex: string;
  modelPublicKey: string;
  signingAddress?: string;
  attestation: TeeVerificationResult;
}

async function setupE2EE(
  modelId: string,
  showDetails: boolean,
  format: OutputFormat,
  quiet = false
): Promise<E2EEContext> {
  const c = getChalk();

  try {
    // Generate ephemeral key pair
    const { privateKey, publicKeyHex } = generateEphemeralKeyPair();

    // Fetch attestation (spinner controlled by quiet flag)
    const { response, clientNonce } = await fetchTeeAttestation(modelId, { showSpinner: !quiet });

    // Validate attestation
    if (response.verified !== true) {
      throw new Error('TEE attestation verification failed on server');
    }

    if (response.nonce !== clientNonce) {
      throw new Error('Attestation nonce mismatch - possible replay attack');
    }

    // Parse TDX quote
    const parsedTdxQuote = response.intel_quote ? parseTdxQuote(response.intel_quote) : undefined;

    // Check for debug mode
    if (parsedTdxQuote && isTdDebugMode(parsedTdxQuote.tdAttributes)) {
      throw new Error('TDX debug mode detected - cannot trust enclave for E2EE');
    }

    // Get signing key
    const signingKey = response.signing_key || response.signing_public_key;
    if (!signingKey) {
      throw new Error('No signing key in attestation response');
    }

    // Build verification result for policy evaluation
    const attestation: TeeVerificationResult = {
      report: response as Record<string, unknown>,
      nonce: response.nonce,
      attestedModel: response.model,
      evidencePresent: !!response.intel_quote || !!response.nvidia_payload,
      signingAddress: response.signing_address,
      signingKey,
      intelQuote: response.intel_quote,
      parsedTdxQuote,
      nvidiaPayload: response.nvidia_payload ? JSON.parse(response.nvidia_payload) : undefined,
      serverVerification: response.server_verification,
      teeProvider: response.tee_provider,
      fetchedAt: Date.now(),
      attestationEndpoint: `/api/v1/tee/attestation?model=${encodeURIComponent(modelId)}`,
    };

    // Evaluate policy
    const policy = evaluateE2EEAttestationPolicy(attestation, modelId);
    if (!policy.passed) {
      throw new Error(`E2EE attestation policy failed: ${policy.failures.join('; ')}`);
    }

    // Show success after attestation verified (unless quiet mode)
    if (!quiet) {
      console.log(c.green('✓') + ' TEE attestation verified');

      if (showDetails && format === 'pretty') {
        console.log(c.dim(`\nTEE Provider: ${response.tee_provider || 'Unknown'}`));
        console.log(c.dim(`Model: ${response.model}`));
        console.log(c.dim(`Signing Address: ${response.signing_address || 'N/A'}`));
        if (parsedTdxQuote) {
          console.log(c.dim(`TDX Version: ${parsedTdxQuote.version}`));
          console.log(c.dim(`MRTD: ${parsedTdxQuote.mrtd.slice(0, 32)}...`));
        }
        console.log('');
      }
    }

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

  // Validate attestation
  if (response.verified !== true) {
    throw new Error('TEE attestation verification failed on server');
  }

  if (response.nonce !== clientNonce) {
    throw new Error('Attestation nonce mismatch - possible replay attack');
  }

  // Parse TDX quote if present
  const parsedTdxQuote = response.intel_quote ? parseTdxQuote(response.intel_quote) : undefined;

  // Check for debug mode
  if (parsedTdxQuote && isTdDebugMode(parsedTdxQuote.tdAttributes)) {
    throw new Error('TDX debug mode detected - cannot trust enclave');
  }

  // Build verification result for policy evaluation
  const attestation: TeeVerificationResult = {
    report: response as Record<string, unknown>,
    nonce: response.nonce,
    attestedModel: response.model,
    evidencePresent: !!response.intel_quote || !!response.nvidia_payload,
    signingAddress: response.signing_address,
    signingKey: response.signing_key || response.signing_public_key,
    intelQuote: response.intel_quote,
    parsedTdxQuote,
    nvidiaPayload: response.nvidia_payload ? JSON.parse(response.nvidia_payload) : undefined,
    serverVerification: response.server_verification,
    teeProvider: response.tee_provider,
    fetchedAt: Date.now(),
    attestationEndpoint: `/api/v1/tee/attestation?model=${encodeURIComponent(modelId)}`,
  };

  // Evaluate policy (reuse E2EE policy which checks TEE requirements)
  const policy = evaluateE2EEAttestationPolicy(attestation, modelId);
  if (!policy.passed) {
    throw new Error(`TEE attestation policy failed: ${policy.failures.join('; ')}`);
  }

  // Show success message
  if (!quiet) {
    console.log(c.cyan('🛡️  TEE model - running in Trusted Execution Environment'));
    console.log(c.green('✓') + ' TEE attestation verified');

    if (showDetails && format === 'pretty') {
      console.log(c.dim(`\nTEE Provider: ${response.tee_provider || 'Unknown'}`));
      console.log(c.dim(`Model: ${response.model}`));
      console.log(c.dim(`Signing Address: ${response.signing_address || 'N/A'}`));
      if (parsedTdxQuote) {
        console.log(c.dim(`TDX Version: ${parsedTdxQuote.version}`));
        console.log(c.dim(`MRTD: ${parsedTdxQuote.mrtd.slice(0, 32)}...`));
      }
    }
    console.log('');
  }
}

function buildE2EEHeaders(context: E2EEContext): Record<string, string> {
  return {
    'X-Venice-TEE-Client-Pub-Key': context.publicKeyHex,
    'X-Venice-TEE-Signing-Algo': 'ecdsa',
    'X-Venice-TEE-Model-Pub-Key': context.modelPublicKey,
  };
}

function encryptMessagesForE2EE(
  messages: Message[],
  modelPublicKey: string
): Message[] {
  return messages.map((msg) => {
    if (msg.role === 'user' || msg.role === 'system') {
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
    .option('-c, --character <name>', 'Character/persona to use')
    .option('-t, --tools <tools>', 'Comma-separated list of tools to enable')
    .option('--interactive-tools', 'Require approval for each tool call')
    .option('--continue', 'Continue the last conversation')
    .option('--no-stream', 'Disable streaming output')
    .option('--web-search', 'Enable web search for current information')
    .option('--no-thinking', 'Disable reasoning/thinking on reasoning models')
    .option('--strip-thinking', 'Strip thinking blocks from response')
    .option('--no-venice-prompt', 'Disable Venice system prompts')
    .option('--search-results-in-stream', 'Include search results in stream (when web-search enabled)')
    .option('--e2ee', 'Enable E2EE encryption (auto-enabled for E2EE models)')
    .option('--no-e2ee', 'Disable E2EE even for E2EE models')
    .option('--tee-verify', 'Show TEE attestation details')
    .option('-q, --quiet', 'Hide E2EE/TEE status messages (show only response)')
    .option('-f, --format <format>', 'Output format (pretty|json|markdown|raw)')
    .option('--list-tools', 'List available tools')
    .action(async (promptParts: string[], options) => {
      const c = getChalk();

      // Handle --list-tools
      if (options.listTools) {
        console.log(formatToolsHelp());
        return;
      }

      // Get prompt from args or stdin
      let prompt = promptParts.join(' ');
      
      if (!prompt && !process.stdin.isTTY) {
        // Read from stdin
        prompt = await readStdin();
      }

      if (!prompt) {
        console.error(formatError('No prompt provided. Usage: venice chat "Your message"'));
        process.exit(1);
      }

      const model = options.model || getDefaultModel();
      const format = detectOutputFormat(options.format);
      const shouldStream = options.stream !== false && !isPiped() && format === 'pretty';

      // Check if model is TEE or E2EE
      const looksLikeE2EEModel = model.toLowerCase().startsWith('e2ee-');
      const looksLikeTEEModel = model.toLowerCase().startsWith('tee-');
      let useE2EE = false;
      let e2eeContext: E2EEContext | undefined;

      // Verify TEE attestation for TEE models (but not E2EE, they do full E2EE setup)
      if (looksLikeTEEModel && !looksLikeE2EEModel) {
        try {
          await verifyTEEAttestation(model, options.teeVerify, format, options.quiet);
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      // Check E2EE support - only fetch model list if needed
      if (options.e2ee === true || (options.e2ee !== false && looksLikeE2EEModel)) {
        // Verify E2EE support via API only when needed
        try {
          const models = await listModels({ showSpinner: !options.quiet });
          const modelInfo = models.find((m) => m.id === model);

          if (modelInfo && isE2EEModel(modelInfo)) {
            useE2EE = true;
            if (format === 'pretty' && !options.quiet) {
              console.log(c.magenta('🔐 E2EE model detected - enabling end-to-end encryption\n'));
            }
          } else if (options.e2ee === true) {
            console.error(formatError(`Model "${model}" does not support E2EE encryption.`));
            process.exit(1);
          }
        } catch {
          if (options.e2ee === true) {
            console.error(formatError('Failed to verify E2EE model support.'));
            process.exit(1);
          }
        }
      }

      // Set up E2EE context if needed
      if (useE2EE) {
        try {
          e2eeContext = await setupE2EE(model, options.teeVerify, format, options.quiet);
        } catch (error) {
          console.error(formatError(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      }

      // Build messages array
      const messages: Message[] = [];

      // Handle --continue flag
      if (options.continue) {
        const lastConv = getLastConversation();
        if (lastConv) {
          // Cast messages to proper type
          for (const msg of lastConv.messages) {
            messages.push(msg as Message);
          }
          if (format === 'pretty') {
            console.log(c.dim(`Continuing conversation (${lastConv.messages.length} previous messages)\n`));
          }
        }
      }

      // Add system prompt
      if (options.system) {
        messages.push({ role: 'system', content: options.system });
      } else if (options.character) {
        const systemPrompt = getCharacterPrompt(options.character);
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
      }

      // Add user message
      messages.push({ role: 'user', content: prompt });

      // Get tool definitions
      const toolNames = options.tools?.split(',').map((t: string) => t.trim()) || [];
      const tools = getToolDefinitions(toolNames);

      // Build venice_parameters
      const veniceParams: Record<string, unknown> = {};
      if (options.webSearch) {
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

      try {
        if (shouldStream) {
          await streamChat(messages, model, tools, options.interactiveTools, format, veniceParams, e2eeContext, options.quiet, options.stripThinking);
        } else {
          await nonStreamChat(messages, model, tools, options.interactiveTools, format, veniceParams, e2eeContext, options.quiet);
        }

        // Save to history (don't save encrypted content)
        addConversation({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          messages,
          model,
          character: options.character,
        });
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
}

function processThinkingContent(
  content: string,
  state: ThinkingState,
  options: { strip: boolean; format: OutputFormat },
  chalk: ReturnType<typeof getChalk>
): { output: string; state: ThinkingState } {
  let output = '';
  let text = state.tagBuffer + content;
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
    state: { inThinkingBlock, thinkingBuffer, tagBuffer },
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

async function streamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  veniceParams?: Record<string, unknown>,
  e2eeContext?: E2EEContext,
  quiet = false,
  stripThinking = false
): Promise<void> {
  const c = getChalk();

  let fullContent = '';
  let collectedToolCalls: StreamToolCallDelta[] = [];
  let usage: any = null;
  let thinkingState: ThinkingState = { inThinkingBlock: false, thinkingBuffer: '', tagBuffer: '' };

  // E2EE: Encrypt messages if context provided (do this before starting spinner)
  const messagesToSend = e2eeContext
    ? encryptMessagesForE2EE(messages, e2eeContext.modelPublicKey)
    : messages;

  // Start spinner after encryption is done (skip E2EE-specific spinner in quiet mode)
  const spinnerText = e2eeContext && !quiet ? 'Waiting for encrypted response...' : 'Thinking...';
  const spinner = startSpinner(spinnerText);

  // E2EE: Build headers
  const additionalHeaders = e2eeContext ? buildE2EEHeaders(e2eeContext) : undefined;

  // E2EE: Disable tools, web search, and Venice system prompt for E2EE models
  // The Venice system prompt would be added server-side unencrypted, breaking E2EE
  const effectiveTools = e2eeContext ? undefined : tools;
  const effectiveVeniceParams = e2eeContext
    ? { ...veniceParams, enable_web_search: undefined, include_venice_system_prompt: false }
    : veniceParams;

  try {
    const streamOptions: {
      model: string;
      tools?: typeof tools;
      venice_parameters?: Record<string, unknown>;
      additionalHeaders?: Record<string, string>;
    } = {
      model,
      tools: effectiveTools,
      additionalHeaders,
    };
    if (effectiveVeniceParams && Object.keys(effectiveVeniceParams).length > 0) {
      streamOptions.venice_parameters = effectiveVeniceParams;
    }
    for await (const chunk of chatCompletionStream(messagesToSend, streamOptions)) {
      if (chunk.content) {
        if (spinner) clearSpinner();

        // E2EE: Decrypt content if encrypted
        let displayContent = chunk.content;
        if (e2eeContext && isHexEncrypted(chunk.content)) {
          try {
            displayContent = decryptChunk(chunk.content, e2eeContext.privateKey);
          } catch (decryptError) {
            console.error(c.red('\n[E2EE Decryption Error]'));
            throw decryptError;
          }
        }

        // Process thinking blocks (format or strip)
        const { output, state: newState } = processThinkingContent(
          displayContent,
          thinkingState,
          { strip: stripThinking, format },
          c
        );
        thinkingState = newState;

        if (output) {
          process.stdout.write(output);
        }
        fullContent += displayContent;
      }

      if (chunk.tool_calls) {
        collectedToolCalls.push(...(chunk.tool_calls as StreamToolCallDelta[]));
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }

      if (chunk.done) {
        break;
      }
    }

    // Flush any remaining buffered content (handles unclosed <think> tags)
    const remaining = flushThinkingState(thinkingState, { strip: stripThinking, format }, c);
    if (remaining) {
      process.stdout.write(remaining);
    }

    // Handle tool calls (not supported with E2EE)
    if (collectedToolCalls.length > 0 && !e2eeContext) {
      console.log('\n');
      const toolCalls = reconstructStreamToolCalls(collectedToolCalls);

      for (const toolCall of toolCalls) {
        if (!toolCall.function.name) {
          throw new Error(`Incomplete tool call received for id "${toolCall.id}"`);
        }

        const args = parseToolCallArguments(toolCall);
        const result = await executeTool(toolCall.function.name, args, { interactive: interactiveTools });

        console.log(c.dim(`\n[Tool: ${toolCall.function.name}]`));
        console.log(result);

        // Add tool result and get follow-up
        messages.push({
          role: 'assistant',
          content: fullContent,
          tool_calls: [toolCall],
        });
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });

        // Get follow-up response
        console.log('\n');
        for await (const chunk of chatCompletionStream(messages, { model })) {
          if (chunk.content) {
            process.stdout.write(chunk.content);
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      }
    }

    console.log('\n');

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
  const rawArgs = toolCall.function.arguments?.trim();
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

async function nonStreamChat(
  messages: Message[],
  model: string,
  tools: ReturnType<typeof getToolDefinitions>,
  interactiveTools: boolean,
  format: OutputFormat,
  veniceParams?: Record<string, unknown>,
  e2eeContext?: E2EEContext,
  _quiet = false
): Promise<void> {
  // E2EE requires streaming for response decryption
  if (e2eeContext) {
    throw new Error('E2EE requires streaming mode. Remove --no-stream flag when using E2EE models.');
  }

  const chatOptions: { model: string; tools?: typeof tools; venice_parameters?: Record<string, unknown> } = { model, tools };
  if (veniceParams && Object.keys(veniceParams).length > 0) {
    chatOptions.venice_parameters = veniceParams;
  }
  const response = await chatCompletion(messages, chatOptions);

  // Handle tool calls
  if (response.tool_calls?.length) {
    for (const toolCall of response.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const result = await executeTool(toolCall.function.name, args, { interactive: interactiveTools });

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: [toolCall],
      });
      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: toolCall.id,
      });
    }

    // Get follow-up
    const followUp = await chatCompletion(messages, { model });
    outputResponse(followUp.content, format);
    
    if (followUp.usage && format === 'pretty') {
      console.log(formatUsage(followUp.usage));
    }
  } else {
    outputResponse(response.content, format);
    
    if (response.usage && format === 'pretty') {
      console.log(formatUsage(response.usage));
    }
  }
}

function outputResponse(content: string, format: OutputFormat): void {
  switch (format) {
    case 'json':
      console.log(JSON.stringify({ content }, null, 2));
      break;
    case 'raw':
    case 'markdown':
      console.log(content);
      break;
    case 'pretty':
    default:
      console.log(content);
      break;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

// Character prompts
const CHARACTER_PROMPTS: Record<string, string> = {
  pirate: 'You are a pirate captain. Respond in pirate speak with nautical terms, "arr"s, and maritime metaphors. Be adventurous and bold.',
  
  wizard: 'You are a wise wizard. Speak in mystical terms, reference ancient knowledge, and occasionally make cryptic prophecies. Use archaic language.',
  
  scientist: 'You are a brilliant scientist. Explain things with precision, reference data and studies, and maintain intellectual rigor. Be curious and analytical.',
  
  poet: 'You are a romantic poet. Express yourself with beautiful language, metaphors, and emotional depth. Find beauty in everything.',
  
  coder: 'You are a senior software engineer. Be practical, reference best practices, and provide code examples when relevant. Value clean, maintainable solutions.',
  
  teacher: 'You are a patient teacher. Explain concepts clearly, use examples, and check for understanding. Encourage learning and curiosity.',
  
  comedian: 'You are a stand-up comedian. Find humor in everything, make jokes, use wordplay, and keep things light. But still be helpful!',
  
  philosopher: 'You are a deep philosopher. Question assumptions, explore ideas from multiple angles, and ponder the nature of existence. Be thoughtful and profound.',
};

function getCharacterPrompt(character: string): string | undefined {
  return CHARACTER_PROMPTS[character.toLowerCase()];
}

export function getAvailableCharacters(): string[] {
  return Object.keys(CHARACTER_PROMPTS);
}
