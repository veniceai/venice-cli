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

/**
 * Decode an uncompressed secp256k1 public key from hex (optional 0x prefix, optional 04 prefix byte).
 * Returns the 65-byte encoding, or undefined unless the key is a valid point on the curve.
 */
export const parseSecp256k1PublicKey = (publicKeyHex: string): Uint8Array | undefined => {
  const keyBytes = parseHex(publicKeyHex)
  if (!keyBytes) return undefined

  const uncompressed = keyBytes.length === 64 ? Uint8Array.of(0x04, ...keyBytes) : keyBytes
  return secp256k1.utils.isValidPublicKey(uncompressed, false) ? uncompressed : undefined
}

/**
 * Derive the AES-256-GCM key from the ECDH shared secret's X coordinate.
 */
const deriveAesKey = (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
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
  const modelPublicKey = parseSecp256k1PublicKey(modelPublicKeyHex)
  if (!modelPublicKey) {
    throw new Error('Model public key is not a valid uncompressed secp256k1 key')
  }

  const ephemeralPrivateKey = secp256k1.utils.randomSecretKey()
  const ephemeralPublic = secp256k1.getPublicKey(ephemeralPrivateKey, false)
  const aesKey = deriveAesKey(ephemeralPrivateKey, modelPublicKey)
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
 * Returns undefined unless the key is a valid point on the curve.
 */
export const deriveSigningAddressFromKey = (signingKeyHex: string): string | undefined => {
  const keyBytes = parseSecp256k1PublicKey(signingKeyHex)
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
  /** The exact reply text, or the exact response the enclave hashed when expectedRequest is set. */
  expectedContent: string
  /** The exact request the enclave hashed. */
  expectedRequest?: string
}

export interface SignatureVerificationResult {
  verified: boolean
  error?: string
}

const sha256Hex = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)))

/**
 * Verify that the signature was created by the expected signing address over exactly one payload:
 * expectedContent itself or, when expectedRequest is set, the lower-case hex SHA-256 digests of
 * expectedRequest and expectedContent joined by a colon.
 */
export const verifySignature = (params: SignatureVerificationParams): SignatureVerificationResult => {
  const { signedText, signatureHex, expectedSigningAddress, expectedContent, expectedRequest } = params

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

  if (expectedRequest !== undefined) {
    if (signedText !== `${sha256Hex(expectedRequest)}:${sha256Hex(expectedContent)}`) {
      return { verified: false, error: 'Signed hashes do not match the expected request and response' }
    }
    return { verified: true }
  }

  if (signedText !== expectedContent) {
    return {
      verified: false,
      error: `Signed text does not match expected content (signed: ${signedText.length} chars, expected: ${expectedContent.length} chars)`,
    }
  }

  return { verified: true }
}
