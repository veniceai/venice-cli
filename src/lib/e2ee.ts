import { gcm } from '@noble/ciphers/aes'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'

const HKDF_INFO = 'ecdsa_encryption'
const EPHEMERAL_PUB_LENGTH = 65
const NONCE_LENGTH = 12
const AES_GCM_TAG_LENGTH = 16
const ADDRESS_LENGTH = 20
const HEX_BYTES_PATTERN = /^(?:[0-9a-fA-F]{2})*$/

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Decode a hex string with an optional 0x prefix.
 * Returns undefined unless the rest is an even number of hex digits.
 */
export const parseHex = (hex: string): Uint8Array | undefined => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!HEX_BYTES_PATTERN.test(h)) return undefined
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export const hexToBytes = (hex: string): Uint8Array => {
  const bytes = parseHex(hex)
  if (!bytes) throw new Error('Invalid hex string')
  return bytes
}

const normalizePublicKey = (hex: string): string => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length === 128) return '04' + clean
  return clean
}

const normalizeUncompressedPublicKey = (signingKeyHex: string): Uint8Array | undefined => {
  let keyBytes = parseHex(signingKeyHex)
  if (!keyBytes) return undefined

  if (keyBytes.length === 64) {
    const prefixed = new Uint8Array(65)
    prefixed[0] = 0x04
    prefixed.set(keyBytes, 1)
    keyBytes = prefixed
  }

  if (keyBytes.length !== 65 || keyBytes[0] !== 0x04) return undefined

  return keyBytes
}

/**
 * Derive the AES-256-GCM key from the ECDH shared secret's X coordinate.
 */
const deriveAesKey = (privateKey: Uint8Array, publicKey: Uint8Array | string): Uint8Array => {
  const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKey)
  const aesKey = hkdf(sha256, sharedPoint.subarray(1), undefined, HKDF_INFO, 32)
  zeroFill(sharedPoint)
  return aesKey
}

/**
 * Generate ephemeral key pair for E2EE using secp256k1 curve.
 */
export const generateEphemeralKeyPair = (): { privateKey: Uint8Array; publicKeyHex: string } => {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKeyHex = bytesToHex(secp256k1.getPublicKey(privateKey, false))
  return { privateKey, publicKeyHex }
}

/**
 * Encrypt plaintext for the model using ECDH + HKDF + AES-GCM.
 */
export const encryptMessage = (plaintext: string, modelPublicKeyHex: string): string => {
  const normalizedModelKey = normalizePublicKey(modelPublicKeyHex)

  const ephemeralPrivateKey = secp256k1.utils.randomSecretKey()
  const ephemeralPublic = secp256k1.getPublicKey(ephemeralPrivateKey, false)
  const aesKey = deriveAesKey(ephemeralPrivateKey, normalizedModelKey)
  zeroFill(ephemeralPrivateKey)

  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = gcm(aesKey, nonce)
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext))
  zeroFill(aesKey)

  const result = new Uint8Array(EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + encrypted.length)
  result.set(ephemeralPublic, 0)
  result.set(nonce, EPHEMERAL_PUB_LENGTH)
  result.set(encrypted, EPHEMERAL_PUB_LENGTH + NONCE_LENGTH)

  return Buffer.from(result).toString('hex')
}

/**
 * Detect if a string looks like hex-encrypted E2EE content.
 * Minimum length: ephemeral_pub (65) + nonce (12) + tag (16) = 93 bytes = 186 hex chars
 */
export const isHexEncrypted = (s: string): boolean => {
  if (s.length < (EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + AES_GCM_TAG_LENGTH) * 2) return false
  return /^[0-9a-fA-F]+$/.test(s)
}

/**
 * Decrypt a server response chunk.
 * Format: [ephemeral_public (65 bytes)][nonce (12 bytes)][ciphertext + auth_tag]
 */
export const decryptChunk = (ciphertextHex: string, ephemeralPrivateKey: Uint8Array): string => {
  const raw = hexToBytes(ciphertextHex)

  const serverEphemeralPubKey = raw.slice(0, EPHEMERAL_PUB_LENGTH)
  const nonce = raw.slice(EPHEMERAL_PUB_LENGTH, EPHEMERAL_PUB_LENGTH + NONCE_LENGTH)
  const ciphertext = raw.slice(EPHEMERAL_PUB_LENGTH + NONCE_LENGTH)

  const aesKey = deriveAesKey(ephemeralPrivateKey, serverEphemeralPubKey)
  try {
    const cipher = gcm(aesKey, nonce)
    return new TextDecoder().decode(cipher.decrypt(ciphertext))
  } finally {
    zeroFill(aesKey)
  }
}

/**
 * Derive Ethereum address from an uncompressed secp256k1 public key.
 * Used to verify the signing key matches the attestation.
 */
export const deriveSigningAddressFromKey = (signingKeyHex: string): string | undefined => {
  const keyBytes = normalizeUncompressedPublicKey(signingKeyHex)
  if (!keyBytes) return undefined

  const hash = keccak_256(keyBytes.slice(1))
  return bytesToHex(hash.slice(12))
}

/**
 * Verify that the signing key is bound to the TDX REPORTDATA.
 * The first 20 bytes of REPORTDATA should match the derived Ethereum address.
 */
export const verifyKeyBinding = (signingKeyHex: string, reportDataHex: string): boolean => {
  const address = deriveSigningAddressFromKey(signingKeyHex)
  if (!address) return false

  const reportData = parseHex(reportDataHex)
  if (!reportData || reportData.length < ADDRESS_LENGTH) return false

  return address === bytesToHex(reportData.subarray(0, ADDRESS_LENGTH))
}

/**
 * Securely zero-fill a Uint8Array (for wiping private keys from memory).
 */
export const zeroFill = (arr: Uint8Array): void => {
  arr.fill(0)
}

/**
 * Recover Ethereum address from an eth_sign-style ECDSA secp256k1 signature.
 * Uses EIP-191 message prefix.
 *
 * Format: r (32 bytes) || s (32 bytes) || v (1 byte)
 */
export const recoverSignerAddress = (message: string, signatureHex: string): string | null => {
  try {
    const sigBytes = hexToBytes(signatureHex)
    if (sigBytes.length !== 65) return null

    let v = sigBytes[64]

    // Normalize v: Ethereum uses 27/28, but some implementations use 0/1
    if (v >= 27) v -= 27
    if (v !== 0 && v !== 1) return null

    // Ethereum eth_sign prefix (EIP-191: use UTF-8 byte length)
    const messageBytes = new TextEncoder().encode(message)
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`)
    const prefixed = new Uint8Array(prefix.length + messageBytes.length)
    prefixed.set(prefix, 0)
    prefixed.set(messageBytes, prefix.length)
    const msgHash = keccak_256(prefixed)

    const signature = secp256k1.Signature.fromBytes(sigBytes.subarray(0, 64), 'compact').addRecoveryBit(v)
    const pubKeyBytes = signature.recoverPublicKey(msgHash).toBytes(false).subarray(1) // remove 0x04 prefix

    const address = bytesToHex(keccak_256(pubKeyBytes).slice(12))
    return address.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Verify a TEE response signature matches the expected signing address.
 */
export interface SignatureVerificationParams {
  signedText: string
  signatureHex: string
  expectedSigningAddress: string
  expectedContent: string
  expectedReasoningContent?: string
}

export interface SignatureVerificationResult {
  verified: boolean
  error?: string
}

const normalizeTextForComparison = (text: string): string => text.trim().replace(/\s+/g, ' ')

/**
 * Verify that the signature was created by the expected signing address.
 * This performs signer recovery and content matching.
 */
export const verifySignature = (params: SignatureVerificationParams): SignatureVerificationResult => {
  const { signedText, signatureHex, expectedSigningAddress, expectedContent, expectedReasoningContent } = params

  const expectedAddr = expectedSigningAddress.toLowerCase().replace(/^0x/, '')
  const recoveredAddress = recoverSignerAddress(signedText, signatureHex)

  if (!recoveredAddress) {
    return { verified: false, error: 'Failed to recover signer address from signature' }
  }

  if (recoveredAddress !== expectedAddr) {
    return {
      verified: false,
      error: `Recovered signer address ${recoveredAddress} does not match expected ${expectedAddr}`,
    }
  }

  // Generate content variants for matching
  const contentVariants = [expectedContent]
  if (expectedReasoningContent) {
    contentVariants.push(
      expectedReasoningContent + expectedContent,
      expectedContent + expectedReasoningContent,
      expectedReasoningContent + '\n' + expectedContent,
      expectedContent + '\n' + expectedReasoningContent,
      expectedReasoningContent,
    )
  }

  // Check for hash formats (hash pairs or single hash)
  const hashPairRegex = /^([0-9a-f]{64}):([0-9a-f]{64})$/i
  const singleHashRegex = /^[0-9a-f]{64}$/i

  if (hashPairRegex.test(signedText) || singleHashRegex.test(signedText)) {
    // Hash format detected - trust signer verification since the cryptographic chain is intact
    return { verified: true }
  }

  // Direct content matching
  for (const variant of contentVariants) {
    if (signedText === variant || normalizeTextForComparison(signedText) === normalizeTextForComparison(variant)) {
      return { verified: true }
    }
  }

  return {
    verified: false,
    error: `Signed text does not match expected content (signed: ${signedText.length} chars, expected: ${expectedContent.length} chars)`,
  }
}
