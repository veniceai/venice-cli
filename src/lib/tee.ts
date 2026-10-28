import { bytesToHex, parseHex, verifyKeyBinding, deriveSigningAddressFromKey } from './e2ee.js'

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
const TDX_QUOTE_HEADER_BYTES = 48
const TDX_V5_BODY_DESCRIPTOR_BYTES = 6
const TDX_SIGNATURE_LENGTH_BYTES = 4
const TD_REPORT_V10_BYTES = 584
// Quote v5 body types: 2 is a TDX 1.0 TD report, 3 is a TDX 1.5 TD report that extends the 1.0 layout.
const TDX_V5_BODY_BYTES = new Map([
  [2, TD_REPORT_V10_BYTES],
  [3, 648],
])
const TD_ATTRIBUTES_DEBUG = 0x01

/**
 * Check if TDX is in debug mode by examining tdAttributes.
 * Debug mode provides no confidentiality guarantees, so malformed attributes count as debug mode.
 */
export const isTdDebugMode = (tdAttributes: string): boolean => {
  if (!/^[0-9a-fA-F]{16}$/.test(tdAttributes)) return true
  return (parseInt(tdAttributes.slice(0, 2), 16) & TD_ATTRIBUTES_DEBUG) !== 0
}

/**
 * Parse an Intel TDX quote (version 4, or version 5 with a TDX 1.0 or 1.5 TD report) from a hex string.
 * Returns undefined unless the whole string is exactly one well-formed TDX quote.
 */
export const parseTdxQuote = (hexQuote: string): ParsedTdxQuote | undefined => {
  const quote = parseHex(hexQuote)
  if (!quote || quote.length < TDX_QUOTE_HEADER_BYTES) return undefined

  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength)
  const version = view.getUint16(0, true)
  const attestationKeyType = view.getUint16(2, true)
  const teeType = view.getUint32(4, true)
  if (teeType !== TDX_TEE_TYPE) return undefined

  let bodyOffset = TDX_QUOTE_HEADER_BYTES
  let bodyLength = TD_REPORT_V10_BYTES
  if (version === 5) {
    bodyOffset = TDX_QUOTE_HEADER_BYTES + TDX_V5_BODY_DESCRIPTOR_BYTES
    if (quote.length < bodyOffset) return undefined
    bodyLength = view.getUint32(TDX_QUOTE_HEADER_BYTES + 2, true)
    if (bodyLength !== TDX_V5_BODY_BYTES.get(view.getUint16(TDX_QUOTE_HEADER_BYTES, true))) return undefined
  } else if (version !== 4) {
    return undefined
  }

  const signatureLengthOffset = bodyOffset + bodyLength
  if (quote.length < signatureLengthOffset + TDX_SIGNATURE_LENGTH_BYTES) return undefined
  const signatureLength = view.getUint32(signatureLengthOffset, true)
  if (quote.length !== signatureLengthOffset + TDX_SIGNATURE_LENGTH_BYTES + signatureLength) return undefined

  const readHex = (offset: number, length: number) =>
    bytesToHex(quote.subarray(bodyOffset + offset, bodyOffset + offset + length))

  return {
    version,
    attestationKeyType,
    teeType,
    teeTcbSvn: readHex(0, 16),
    mrSeam: readHex(16, 48),
    mrSignerSeam: readHex(64, 48),
    seamAttributes: readHex(112, 8),
    tdAttributes: readHex(120, 8),
    xfam: readHex(128, 8),
    mrtd: readHex(136, 48),
    mrConfigId: readHex(184, 48),
    mrOwner: readHex(232, 48),
    mrOwnerConfig: readHex(280, 48),
    rtmr0: readHex(328, 48),
    rtmr1: readHex(376, 48),
    rtmr2: readHex(424, 48),
    rtmr3: readHex(472, 48),
    reportData: readHex(520, 64),
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
