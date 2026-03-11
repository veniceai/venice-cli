import { verifyKeyBinding, deriveSigningAddressFromKey } from './e2ee.js'

export const NRAS_ATTEST_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'

export type NvidiaEvidence = { certificate: string; evidence: string; arch: string }

export type NvidiaPayload = {
  nonce: string
  evidence_list: NvidiaEvidence[]
  arch: string
}

export type ServerVerificationTdx = {
  valid: boolean
  error?: string
  signatureValid?: boolean
  certificateChainValid?: boolean
  attestationKeyMatch?: boolean
}

export type ServerVerificationNvidia = {
  valid: boolean
  error?: string
}

export type SigningAddressBinding = {
  bound: boolean
  reportDataAddress?: string
  error?: string
}

export type NonceBinding = {
  bound: boolean
  method?: 'sha256' | 'raw'
  error?: string
}

export type ServerVerification = {
  tdx?: ServerVerificationTdx
  nvidia?: ServerVerificationNvidia
  signingAddressBinding?: SigningAddressBinding
  nonceBinding?: NonceBinding
  verifiedAt: string
  verificationDurationMs: number
}

export type ParsedTdxQuote = {
  version: number
  attestationKeyType: number
  teeType: number
  teeTcbSvn: string
  mrSeam: string
  mrSignerSeam: string
  seamAttributes: string
  tdAttributes: string
  xfam: string
  mrtd: string
  mrConfigId: string
  mrOwner: string
  mrOwnerConfig: string
  rtmr0: string
  rtmr1: string
  rtmr2: string
  rtmr3: string
  reportData: string
}

export type TeeVerificationResult = {
  report: Record<string, unknown>
  nonce: string
  attestedModel: string
  evidencePresent: boolean
  signingAddress?: string
  signingKey?: string
  intelQuote?: string
  parsedTdxQuote?: ParsedTdxQuote
  nvidiaPayload?: NvidiaPayload
  serverVerification?: ServerVerification
  teeProvider?: string
  fetchedAt: number
  attestationEndpoint: string
}

export type TeeE2EEPolicyEvaluation = {
  passed: boolean
  failures: string[]
}

export type TeePolicyEvaluation = {
  passed: boolean
  failures: string[]
}

const TDX_TEE_TYPE = 0x81
const TDX_BODY_OFFSET = 48
const TDX_MIN_QUOTE_BYTES = 632

/**
 * Check if TDX is in debug mode by examining tdAttributes.
 * Debug mode provides no confidentiality guarantees.
 */
export const isTdDebugMode = (tdAttributes: string): boolean => {
  if (tdAttributes.length < 2) return false
  const lsb = parseInt(tdAttributes.slice(0, 2), 16)
  return (lsb & 0x01) !== 0
}

/**
 * Parse Intel TDX quote structure from hex string.
 */
export const parseTdxQuote = (hexQuote: string): ParsedTdxQuote | undefined => {
  const hex = hexQuote.startsWith('0x') ? hexQuote.slice(2) : hexQuote
  if (hex.length < TDX_MIN_QUOTE_BYTES * 2) return undefined

  try {
    const readHex = (byteOffset: number, byteLength: number) => hex.slice(byteOffset * 2, (byteOffset + byteLength) * 2)
    const readUint16LE = (byteOffset: number) => {
      const h = readHex(byteOffset, 2)
      return parseInt(h.slice(2, 4) + h.slice(0, 2), 16)
    }
    const readUint32LE = (byteOffset: number) => {
      const h = readHex(byteOffset, 4)
      return parseInt(h.slice(6, 8) + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2), 16)
    }

    const b = TDX_BODY_OFFSET
    return {
      version: readUint16LE(0),
      attestationKeyType: readUint16LE(2),
      teeType: readUint32LE(4),
      teeTcbSvn: readHex(b, 16),
      mrSeam: readHex(b + 16, 48),
      mrSignerSeam: readHex(b + 64, 48),
      seamAttributes: readHex(b + 112, 8),
      tdAttributes: readHex(b + 120, 8),
      xfam: readHex(b + 128, 8),
      mrtd: readHex(b + 136, 48),
      mrConfigId: readHex(b + 184, 48),
      mrOwner: readHex(b + 232, 48),
      mrOwnerConfig: readHex(b + 280, 48),
      rtmr0: readHex(b + 328, 48),
      rtmr1: readHex(b + 376, 48),
      rtmr2: readHex(b + 424, 48),
      rtmr3: readHex(b + 472, 48),
      reportData: readHex(b + 520, 64),
    }
  } catch {
    return undefined
  }
}

/**
 * Evaluate the E2EE attestation policy against a verification result.
 * Returns whether the attestation passes all security checks.
 */
export const evaluateE2EEAttestationPolicy = (
  attestation: TeeVerificationResult,
  expectedModelId: string,
): TeeE2EEPolicyEvaluation => {
  const failures: string[] = []
  const { parsedTdxQuote, serverVerification, signingKey } = attestation
  const derivedSigningAddress = signingKey ? deriveSigningAddressFromKey(signingKey) : undefined

  if (!attestation.evidencePresent) {
    failures.push('No attestation evidence was returned for this model.')
  }

  if (attestation.attestedModel !== expectedModelId) {
    failures.push(`Attested model ${attestation.attestedModel} does not match requested model ${expectedModelId}.`)
  }

  if (!signingKey) {
    failures.push('Attestation did not include a signing public key.')
  } else if (!derivedSigningAddress) {
    failures.push('Attestation signing public key is not a valid uncompressed secp256k1 key.')
  }

  if (!attestation.intelQuote) {
    failures.push('Attestation did not include an Intel TDX quote.')
  }

  if (!parsedTdxQuote) {
    failures.push('Intel TDX quote could not be parsed client-side.')
  } else {
    if (parsedTdxQuote.teeType !== TDX_TEE_TYPE) {
      failures.push(
        `Unexpected TEE type in attestation quote: expected 0x${TDX_TEE_TYPE.toString(16)}, got 0x${parsedTdxQuote.teeType.toString(16)}.`,
      )
    }

    if (isTdDebugMode(parsedTdxQuote.tdAttributes)) {
      failures.push('TDX attestation indicates debug mode, which provides no confidentiality guarantees.')
    }
  }

  if (!serverVerification) {
    failures.push('Server verification details were not returned with the attestation evidence.')
  } else {
    if (serverVerification.nonceBinding?.bound !== true) {
      failures.push(serverVerification.nonceBinding?.error ?? 'Client nonce was not bound to the attestation evidence.')
    }

    if (attestation.intelQuote && serverVerification.tdx?.valid !== true) {
      failures.push(serverVerification.tdx?.error ?? 'Intel TDX attestation verification did not pass.')
    }

    if (attestation.nvidiaPayload && serverVerification.nvidia?.valid !== true) {
      failures.push(serverVerification.nvidia?.error ?? 'NVIDIA GPU attestation verification did not pass.')
    }

    if (!serverVerification.tdx && !serverVerification.nvidia) {
      failures.push('No hardware attestation verification results were returned by the server.')
    }
  }

  if (signingKey && derivedSigningAddress) {
    if (!parsedTdxQuote?.reportData) {
      failures.push('TDX REPORTDATA was not available for local signing-key binding verification.')
    } else if (!verifyKeyBinding(signingKey, parsedTdxQuote.reportData)) {
      failures.push('Signing public key does not match the TDX REPORTDATA binding in the attestation quote.')
    }
  }

  if (attestation.signingAddress && derivedSigningAddress) {
    const reportedSigningAddress = attestation.signingAddress.toLowerCase().replace(/^0x/, '')
    if (reportedSigningAddress !== derivedSigningAddress) {
      failures.push(
        'Reported signing address does not match the address derived from the attested signing public key.',
      )
    }
  }

  return {
    failures,
    passed: failures.length === 0,
  }
}

export const evaluateTEEAttestationPolicy = (
  attestation: TeeVerificationResult,
  expectedModelId: string,
): TeePolicyEvaluation => {
  const failures: string[] = []
  const { parsedTdxQuote, serverVerification } = attestation

  if (!attestation.evidencePresent) {
    failures.push('No attestation evidence was returned for this model.')
  }

  if (attestation.attestedModel !== expectedModelId) {
    failures.push(`Attested model ${attestation.attestedModel} does not match requested model ${expectedModelId}.`)
  }

  if (!attestation.intelQuote) {
    failures.push('Attestation did not include an Intel TDX quote.')
  }

  if (!parsedTdxQuote) {
    failures.push('Intel TDX quote could not be parsed client-side.')
  } else {
    if (parsedTdxQuote.teeType !== TDX_TEE_TYPE) {
      failures.push(
        `Unexpected TEE type in attestation quote: expected 0x${TDX_TEE_TYPE.toString(16)}, got 0x${parsedTdxQuote.teeType.toString(16)}.`,
      )
    }

    if (isTdDebugMode(parsedTdxQuote.tdAttributes)) {
      failures.push('TDX attestation indicates debug mode, which provides no confidentiality guarantees.')
    }
  }

  if (!serverVerification) {
    failures.push('Server verification details were not returned with the attestation evidence.')
  } else {
    if (serverVerification.nonceBinding?.bound !== true) {
      failures.push(serverVerification.nonceBinding?.error ?? 'Client nonce was not bound to the attestation evidence.')
    }

    if (attestation.intelQuote && serverVerification.tdx?.valid !== true) {
      failures.push(serverVerification.tdx?.error ?? 'Intel TDX attestation verification did not pass.')
    }

    if (attestation.nvidiaPayload && serverVerification.nvidia?.valid !== true) {
      failures.push(serverVerification.nvidia?.error ?? 'NVIDIA GPU attestation verification did not pass.')
    }

    if (!serverVerification.tdx && !serverVerification.nvidia) {
      failures.push('No hardware attestation verification results were returned by the server.')
    }
  }

  return {
    failures,
    passed: failures.length === 0,
  }
}

/**
 * Assert that the attestation passes E2EE policy, throwing an error if not.
 */
export const assertE2EEAttestationPolicy = (attestation: TeeVerificationResult, expectedModelId: string): void => {
  const evaluation = evaluateE2EEAttestationPolicy(attestation, expectedModelId)
  if (!evaluation.passed) {
    throw new Error(`E2EE attestation policy rejected the enclave key: ${evaluation.failures.join(' ')}`)
  }
}

/**
 * Generate a curl command for manual NVIDIA GPU attestation verification.
 */
export const buildGpuAttestationCurl = (payload: NvidiaPayload): string =>
  `curl --request POST \\\n  --url ${NRAS_ATTEST_URL} \\\n  --header 'accept: application/json' \\\n  --header 'content-type: application/json' \\\n  --data '${JSON.stringify({ nonce: payload.nonce, evidence_list: payload.evidence_list, arch: payload.arch })}'`
