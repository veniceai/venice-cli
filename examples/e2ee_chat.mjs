#!/usr/bin/env node
/**
 * Venice AI E2EE Chat Example
 *
 * =============================================================================
 * PROTOCOL SKETCH, NOT A VERIFIED E2EE CLIENT
 *
 * This example shows the E2EE message flow and wire format. Before it encrypts
 * anything it checks the server's attestation report for consistency, but it
 * does not verify the Intel TDX quote signature, its certificate chain or the
 * enclave measurements (client-side verification is tracked publicly in issue
 * #43: https://github.com/veniceai/venice-cli/issues/43). It therefore does not
 * prove that the server cannot read your data.
 * =============================================================================
 *
 * Flow:
 *   1. Fetch an attestation for a fresh nonce and apply the checks the Venice
 *      CLI applies before it encrypts (see checkAttestation below).
 *   2. Encrypt the prompt to the attested signing key: ECDH on secp256k1,
 *      HKDF-SHA256, AES-256-GCM.
 *   3. Stream the reply and decrypt every chunk with this session's key.
 *
 * The example exits with status 1, without the success banner, if the
 * attestation fails a check, a content chunk is not ciphertext or does not
 * decrypt, or the stream ends without a finish_reason and `data: [DONE]`.
 *
 * Requirements (Node.js 18 or later):
 *     npm install @noble/curves@1 @noble/ciphers@1 @noble/hashes@1
 *
 * Usage:
 *     export VENICE_API_KEY="your-api-key"
 *     node e2ee_chat.mjs
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import crypto from 'crypto';
import readline from 'readline';

// Configuration
const API_KEY = process.env.VENICE_API_KEY;
// As in the Venice CLI, only test runs may send the API key to another server.
const BASE_URL =
  process.env.NODE_ENV === 'test' && process.env.VENICE_API_BASE_URL
    ? process.env.VENICE_API_BASE_URL
    : 'https://api.venice.ai/api/v1';
const MODEL = 'e2ee-qwen3-5-122b-a10b'; // E2EE-capable model
const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption');

// Encrypted message layout: ephemeral public key || nonce || ciphertext + tag
const EPHEMERAL_PUBLIC_KEY_BYTES = 65;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

// Intel TDX quote layout
const TDX_TEE_TYPE = 0x81;
const QUOTE_HEADER_BYTES = 48;
const TD_REPORT_10_BYTES = 584;
const TD_REPORT_15_BYTES = 648;
const TD_ATTRIBUTES_OFFSET = 120; // within the TD report
const REPORT_DATA_OFFSET = 520; // within the TD report

if (!API_KEY) {
  console.error('Error: VENICE_API_KEY environment variable not set');
  console.error('Usage: export VENICE_API_KEY="your-api-key"');
  process.exit(1);
}

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Convert an optionally 0x-prefixed hex string to bytes, rejecting anything
 * that is not an even number of hex digits.
 */
function hexToBytes(hex, label = 'value') {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) {
    throw new Error(`${label} is not valid hex`);
  }
  return Buffer.from(h, 'hex');
}

/**
 * Generate 32-byte client nonce (64 hex characters).
 * Required by all TEE providers.
 */
function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Parse an Intel TDX quote and check that its layout is complete: version 4
 * or 5, TEE type 0x81, a TD report body, and signature data that ends exactly
 * where the quote ends. Only fields are read; the signature is not verified.
 */
function parseTdxQuote(quoteHex) {
  const quote = hexToBytes(quoteHex, 'TDX quote');
  if (quote.length < QUOTE_HEADER_BYTES) throw new Error('TDX quote is shorter than its header');

  const version = quote.readUInt16LE(0);
  let bodyOffset;
  let bodyLength;
  if (version === 4) {
    bodyOffset = QUOTE_HEADER_BYTES;
    bodyLength = TD_REPORT_10_BYTES;
  } else if (version === 5) {
    // Version 5 adds a body descriptor: type (u16) and size (u32).
    if (quote.length < QUOTE_HEADER_BYTES + 6) throw new Error('TDX quote is truncated');
    const bodyType = quote.readUInt16LE(QUOTE_HEADER_BYTES);
    const declaredLength = quote.readUInt32LE(QUOTE_HEADER_BYTES + 2);
    bodyLength = { 2: TD_REPORT_10_BYTES, 3: TD_REPORT_15_BYTES }[bodyType];
    if (bodyLength === undefined || declaredLength !== bodyLength) {
      throw new Error(`TDX quote has an unexpected body (type ${bodyType}, ${declaredLength} bytes)`);
    }
    bodyOffset = QUOTE_HEADER_BYTES + 6;
  } else {
    throw new Error(`unsupported TDX quote version ${version}`);
  }

  const teeType = quote.readUInt32LE(4);
  if (teeType !== TDX_TEE_TYPE) {
    throw new Error(`unexpected TEE type 0x${teeType.toString(16)} in quote, expected 0x81`);
  }

  const signatureLengthOffset = bodyOffset + bodyLength;
  if (quote.length < signatureLengthOffset + 4) throw new Error('TDX quote is truncated');
  const signatureLength = quote.readUInt32LE(signatureLengthOffset);
  if (quote.length !== signatureLengthOffset + 4 + signatureLength) {
    throw new Error('TDX quote length does not match its signature data length');
  }

  const body = quote.subarray(bodyOffset, bodyOffset + bodyLength);
  return {
    tdAttributes: body.subarray(TD_ATTRIBUTES_OFFSET, TD_ATTRIBUTES_OFFSET + 8),
    reportData: body.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 64),
  };
}

/**
 * Return the model's signing key as 65 uncompressed bytes (04 || x || y).
 * Accepts the 64-byte form without the 04 prefix.
 */
function parseSigningKey(keyHex) {
  const clean = keyHex.startsWith('0x') ? keyHex.slice(2) : keyHex;
  // A 64-byte key can itself begin with 04, so normalise by length, not prefix.
  const uncompressed = clean.length === 128 ? '04' + clean : clean;
  if (uncompressed.length !== 130) {
    throw new Error('signing key is not a 64- or 65-byte uncompressed secp256k1 public key');
  }
  const keyBytes = hexToBytes(uncompressed, 'signing key');
  if (!secp256k1.utils.isValidPublicKey(keyBytes, false)) {
    throw new Error('signing key is not a valid uncompressed secp256k1 public key');
  }
  return keyBytes;
}

/**
 * Ethereum address of an uncompressed public key: the last 20 bytes of the
 * Keccak-256 hash of x || y.
 */
function ethereumAddress(publicKeyBytes) {
  return bytesToHex(keccak_256(publicKeyBytes.subarray(1)).subarray(12));
}

/**
 * Apply the checks the Venice CLI applies to an attestation before it
 * encrypts. They test the server's report for consistency; they do not verify
 * the TDX quote signature, its certificate chain or the enclave measurements.
 * Returns the model's signing key as 65 uncompressed bytes.
 */
function checkAttestation(attestation, modelId, clientNonce) {
  if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error('Attestation response is not a JSON object');
  }

  const failures = [];

  if (attestation.verified !== true) failures.push('the server did not report verified: true');
  if (attestation.nonce !== clientNonce) failures.push('the attestation does not echo our nonce');
  if (attestation.model !== modelId) {
    failures.push(`the attested model ${JSON.stringify(attestation.model)} is not ${modelId}`);
  }

  let quote;
  if (typeof attestation.intel_quote !== 'string' || !attestation.intel_quote) {
    failures.push('no Intel TDX quote was returned');
  } else {
    try {
      quote = parseTdxQuote(attestation.intel_quote);
      if (quote.tdAttributes[0] & 0x01) failures.push('the TDX quote has the TD debug bit set');
    } catch (error) {
      failures.push(error.message);
    }
  }

  const verification = attestation.server_verification;
  if (verification?.tdx?.valid !== true) failures.push('server_verification.tdx.valid is not true');
  if (verification?.nonceBinding?.bound !== true) failures.push('server_verification.nonceBinding.bound is not true');
  if (attestation.nvidia_payload && verification?.nvidia?.valid !== true) {
    failures.push('server_verification.nvidia.valid is not true');
  }

  let signingKey;
  const signingKeyHex = attestation.signing_key || attestation.signing_public_key;
  if (typeof signingKeyHex !== 'string' || !signingKeyHex) {
    failures.push('no signing key was returned');
  } else {
    try {
      signingKey = parseSigningKey(signingKeyHex);
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (signingKey) {
    const address = ethereumAddress(signingKey);
    if (quote && bytesToHex(quote.reportData.subarray(0, 20)) !== address) {
      failures.push('the signing key does not match the address in the TDX REPORTDATA');
    }
    if (attestation.signing_address) {
      const reported = String(attestation.signing_address).toLowerCase().replace(/^0x/, '');
      if (reported !== address) failures.push('signing_address does not match the signing key');
    }
  }

  if (failures.length > 0) {
    throw new Error(`Attestation rejected: ${failures.join('; ')}`);
  }
  return signingKey;
}

/**
 * Fetch an attestation for a fresh nonce and check it.
 */
async function fetchAttestation(modelId) {
  const clientNonce = generateNonce();

  const response = await fetch(
    `${BASE_URL}/tee/attestation?model=${encodeURIComponent(modelId)}&nonce=${clientNonce}`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Attestation request failed: ${response.status} ${error}`);
  }

  const attestation = await response.json();
  const signingKey = checkAttestation(attestation, modelId, clientNonce);

  return {
    modelPublicKey: attestation.signing_key || attestation.signing_public_key,
    signingKey,
    teeProvider: attestation.tee_provider,
  };
}

/**
 * Derive the AES-256-GCM key for one message from an ECDH shared secret.
 */
function deriveAesKey(secretKey, publicKey) {
  // The HKDF input is the 32-byte X coordinate, without the point's prefix byte.
  const sharedX = secp256k1.getSharedSecret(secretKey, publicKey, true).subarray(1);
  return hkdf(sha256, sharedX, undefined, HKDF_INFO, 32);
}

/**
 * Encrypt a message to the model's signing key using ECDH + HKDF + AES-256-GCM.
 */
function encryptMessage(plaintext, modelPublicKey) {
  // Generate ephemeral key pair for this message
  const ephemeralSecretKey = secp256k1.utils.randomSecretKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralSecretKey, false);

  const aesKey = deriveAesKey(ephemeralSecretKey, modelPublicKey);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const encrypted = gcm(aesKey, nonce).encrypt(new TextEncoder().encode(plaintext));

  return bytesToHex(Buffer.concat([ephemeralPublicKey, nonce, encrypted]));
}

/**
 * Check that a content chunk has the shape of an encrypted message.
 */
function isHexCiphertext(s) {
  const minLength = (EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES + GCM_TAG_BYTES) * 2;
  return s.length >= minLength && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Decrypt an E2EE response chunk; throws if it was not encrypted to our key.
 */
function decryptChunk(ciphertextHex, clientSecretKey) {
  const raw = hexToBytes(ciphertextHex);
  const serverEphemeralPublicKey = raw.subarray(0, EPHEMERAL_PUBLIC_KEY_BYTES);
  const nonce = raw.subarray(EPHEMERAL_PUBLIC_KEY_BYTES, EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES);
  const ciphertext = raw.subarray(EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES);

  const aesKey = deriveAesKey(clientSecretKey, serverEphemeralPublicKey);
  return gcm(aesKey, nonce).decrypt(ciphertext);
}

/**
 * Read the event stream and print each decrypted chunk as it arrives.
 * Throws if a content chunk is not ciphertext or does not decrypt, or if the
 * stream ends without a finish_reason and a `data: [DONE]` line.
 */
async function readEncryptedReply(response, clientSecretKey) {
  if (!response.body) throw new Error('Chat response has no body');

  const reader = response.body.getReader();
  const streamDecoder = new TextDecoder();
  // One decoder for the whole reply, because a character may span two chunks.
  const replyDecoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let chunks = 0;
  let finishReason;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += streamDecoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        // Skip blank lines, comments and SSE fields other than data.
        if (!line.startsWith('data:')) continue;
        const data = line.slice(line.startsWith('data: ') ? 6 : 5);

        if (data === '[DONE]') {
          if (!finishReason) throw new Error('Stream ended without a finish_reason');
          reply += replyDecoder.decode();
          return { reply, chunks, finishReason };
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error('Received a stream event that is not valid JSON');
        }
        if (event === null || typeof event !== 'object') {
          throw new Error('Received a stream event that is not a JSON object');
        }
        if (event.error) {
          throw new Error(`Server reported an error mid-stream: ${JSON.stringify(event.error)}`);
        }

        const choice = event.choices?.[0];
        const content = choice?.delta?.content;
        if (content !== undefined && content !== null && content !== '') {
          if (typeof content !== 'string' || !isHexCiphertext(content)) {
            throw new Error('Received a content chunk that is not E2EE ciphertext');
          }
          let plaintext;
          try {
            plaintext = decryptChunk(content, clientSecretKey);
          } catch (error) {
            throw new Error(`Could not decrypt a content chunk (${error.message})`);
          }
          const text = replyDecoder.decode(plaintext, { stream: true });
          reply += text;
          chunks += 1;
          process.stdout.write(text);
        }

        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  throw new Error('Stream ended before data: [DONE]');
}

/**
 * Send an E2EE-encrypted chat message and decrypt the response.
 */
async function chatE2EE(prompt) {
  console.log('🔑 Generating ephemeral key pair...');
  const clientSecretKey = secp256k1.utils.randomSecretKey();
  // Uncompressed: 04 + x + y = 130 hex chars
  const clientPublicKeyHex = bytesToHex(secp256k1.getPublicKey(clientSecretKey, false));

  console.log('🔍 Fetching TEE attestation...');
  const { modelPublicKey, signingKey, teeProvider } = await fetchAttestation(MODEL);
  console.log(`✅ Attestation report passed the client-side checks (provider: ${teeProvider || 'unknown'})`);
  console.log('   The TDX quote signature, certificate chain and measurements were not verified.');

  console.log('🔐 Encrypting message...');
  const encryptedContent = encryptMessage(prompt, signingKey);

  const messages = [{ role: 'user', content: encryptedContent }];

  console.log('📤 Sending encrypted request...');
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-Venice-TEE-Client-Pub-Key': clientPublicKeyHex,
      'X-Venice-TEE-Model-Pub-Key': modelPublicKey,
      'X-Venice-TEE-Signing-Algo': 'ecdsa',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Chat request failed: ${response.status} ${error}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
    throw new Error(`Expected an event stream, got content type ${JSON.stringify(contentType)}`);
  }

  console.log('📥 Decrypting response...\n');
  console.log('-'.repeat(50));

  const { reply, chunks, finishReason } = await readEncryptedReply(response, clientSecretKey);

  console.log('\n' + '-'.repeat(50));
  console.log(`\n🔐 Response decrypted (${chunks} encrypted chunks, finish_reason: ${JSON.stringify(finishReason)})`);

  return reply;
}

/**
 * Prompt user for input.
 */
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

/**
 * Main entry point.
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Venice AI E2EE Chat Example (protocol sketch)');
  console.log('='.repeat(60));
  console.log(`Model: ${MODEL}`);
  console.log(`API: ${BASE_URL}`);
  console.log();

  let prompt = await askQuestion('Enter your message (or press Enter for default): ');
  prompt = prompt.trim();
  if (!prompt) {
    prompt = 'What is end-to-end encryption and why is it important for privacy?';
  }

  console.log();

  try {
    await chatE2EE(prompt);
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
