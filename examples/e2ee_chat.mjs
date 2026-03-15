#!/usr/bin/env node
/**
 * Venice AI E2EE Chat Example
 *
 * Complete example of end-to-end encrypted communication with Venice AI API.
 * Your messages are encrypted client-side before transmission, and responses
 * are encrypted by the TEE before being sent back—Venice never sees plaintext.
 *
 * Requirements:
 *     npm install elliptic @noble/ciphers @noble/hashes
 *
 * Usage:
 *     export VENICE_API_KEY="your-api-key"
 *     node e2ee_chat.mjs
 */

import elliptic from 'elliptic';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import crypto from 'crypto';
import readline from 'readline';

const EC = elliptic.ec;

// Configuration
const API_KEY = process.env.VENICE_API_KEY;
const BASE_URL = process.env.VENICE_API_BASE_URL || 'https://api.venice.ai/api/v1';
const MODEL = 'e2ee-qwen3-30b-a3b'; // E2EE-capable model
const HKDF_INFO = 'ecdsa_encryption';

if (!API_KEY) {
  console.error('Error: VENICE_API_KEY environment variable not set');
  console.error('Usage: export VENICE_API_KEY="your-api-key"');
  process.exit(1);
}

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex string to bytes.
 */
function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Generate ephemeral secp256k1 key pair for E2EE session.
 */
function generateKeyPair() {
  const ec = new EC('secp256k1');
  const keyPair = ec.genKeyPair();
  const privateKey = new Uint8Array(keyPair.getPrivate().toArray('be', 32));
  const publicKeyHex = keyPair.getPublic('hex'); // Uncompressed: 04 + x + y = 130 hex chars
  return { privateKey, publicKeyHex, keyPair };
}

/**
 * Generate 32-byte client nonce (64 hex characters).
 * Required by all TEE providers.
 */
function generateNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Fetch and verify TEE attestation for a model.
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

  // Verify attestation
  if (attestation.verified !== true) {
    throw new Error(`TEE attestation verification failed: ${JSON.stringify(attestation)}`);
  }

  if (attestation.nonce !== clientNonce) {
    throw new Error('Attestation nonce mismatch - possible replay attack');
  }

  // Get model's public key
  const modelPublicKey = attestation.signing_key || attestation.signing_public_key;
  if (!modelPublicKey) {
    throw new Error('No signing key in attestation response');
  }

  return {
    modelPublicKey,
    signingAddress: attestation.signing_address,
    teeProvider: attestation.tee_provider,
    attestation,
  };
}

/**
 * Normalize public key to uncompressed format with 04 prefix.
 */
function normalizePublicKey(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 128) return '04' + clean;
  return clean;
}

/**
 * Encrypt a message using ECDH + HKDF + AES-256-GCM.
 */
function encryptMessage(plaintext, modelPublicKeyHex) {
  const ec = new EC('secp256k1');

  // Normalize and parse model's public key
  const normalizedKey = normalizePublicKey(modelPublicKeyHex);
  const modelPublicKey = ec.keyFromPublic(normalizedKey, 'hex');

  // Generate ephemeral key pair for this message
  const ephemeralKeyPair = ec.genKeyPair();

  // ECDH: compute shared secret
  const sharedSecret = ephemeralKeyPair.derive(modelPublicKey.getPublic());
  const sharedSecretBytes = new Uint8Array(sharedSecret.toArray('be', 32));

  // Derive AES key using HKDF-SHA256
  const aesKey = hkdf(sha256, sharedSecretBytes, undefined, HKDF_INFO, 32);

  // Generate random 12-byte nonce
  const nonce = randomBytes(12);

  // Encrypt with AES-256-GCM
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext));

  // Get ephemeral public key (uncompressed: 65 bytes)
  const ephemeralPublic = new Uint8Array(ephemeralKeyPair.getPublic(false, 'array'));

  // Format: ephemeral_public (65 bytes) + nonce (12 bytes) + ciphertext
  const result = new Uint8Array(65 + 12 + encrypted.length);
  result.set(ephemeralPublic, 0);
  result.set(nonce, 65);
  result.set(encrypted, 77);

  return Buffer.from(result).toString('hex');
}

/**
 * Decrypt an E2EE response chunk.
 */
function decryptChunk(ciphertextHex, clientKeyPair) {
  const raw = hexToBytes(ciphertextHex);

  // Parse components (65 + 12 + ciphertext)
  const serverEphemeralPubKey = raw.slice(0, 65);
  const nonce = raw.slice(65, 77);
  const ciphertext = raw.slice(77);

  const ec = new EC('secp256k1');
  const serverKey = ec.keyFromPublic(Buffer.from(serverEphemeralPubKey));

  // ECDH: compute shared secret
  const sharedSecret = clientKeyPair.derive(serverKey.getPublic());
  const sharedSecretBytes = new Uint8Array(sharedSecret.toArray('be', 32));

  // Derive AES key
  const aesKey = hkdf(sha256, sharedSecretBytes, undefined, HKDF_INFO, 32);

  // Decrypt
  const cipher = gcm(aesKey, nonce);
  const plaintext = cipher.decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}

/**
 * Check if string looks like hex-encrypted content.
 */
function isHexEncrypted(s) {
  // Minimum: ephemeral_pub (65) + nonce (12) + tag (16) = 93 bytes = 186 hex
  if (s.length < 186) return false;
  return /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Send an E2EE-encrypted chat message and decrypt the response.
 */
async function chatE2EE(prompt) {
  console.log('🔑 Generating ephemeral key pair...');
  const { publicKeyHex, keyPair } = generateKeyPair();

  console.log('🔍 Fetching TEE attestation...');
  const { modelPublicKey, teeProvider } = await fetchAttestation(MODEL);
  console.log(`✅ TEE attestation verified (provider: ${teeProvider || 'unknown'})`);

  console.log('🔐 Encrypting message...');
  const encryptedContent = encryptMessage(prompt, modelPublicKey);

  const messages = [{ role: 'user', content: encryptedContent }];

  console.log('📤 Sending encrypted request...');
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-Venice-TEE-Client-Pub-Key': publicKeyHex,
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

  console.log('📥 Decrypting response...\n');
  console.log('-'.repeat(50));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;

        if (!content) continue;

        // Decrypt if encrypted
        if (isHexEncrypted(content)) {
          const decrypted = decryptChunk(content, keyPair);
          fullContent += decrypted;
          process.stdout.write(decrypted);
        } else {
          fullContent += content;
          process.stdout.write(content);
        }
      } catch (e) {
        if (!(e instanceof SyntaxError)) {
          console.error(`\n[Decryption error: ${e.message}]`);
        }
      }
    }
  }

  console.log('\n' + '-'.repeat(50));
  console.log('\n🔐 Response decrypted end-to-end');

  return fullContent;
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
  console.log('Venice AI E2EE Chat Example');
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
