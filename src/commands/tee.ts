/**
 * TEE Command - TEE attestation and signature verification
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  fetchTeeAttestation,
  fetchTeeSignature,
} from '../lib/api.js';
import {
  formatError,
  formatJson,
  getChalk,
  detectOutputFormat,
  terminalSafe,
} from '../lib/output.js';
import {
  parseTdxQuote,
  isTdDebugMode,
  evaluateE2EEAttestationPolicy,
  buildGpuAttestationCurl,
  buildTeeVerificationResult,
  ATTESTATION_SCOPE_NOTE,
  type TeeE2EEPolicyEvaluation,
} from '../lib/tee.js';
import { deriveSigningAddressFromKey, recoverSignerAddress } from '../lib/e2ee.js';

const VERIFY_SCOPE_NOTE =
  `The attestation report is the server's own; the CLI checks it for internal consistency only. ${ATTESTATION_SCOPE_NOTE}`;

const SIGNED_HASH_PAIR = /^([0-9a-f]{64}):([0-9a-f]{64})$/i;
const SIGNED_HASH = /^[0-9a-f]{64}$/i;

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const normaliseAddress = (address: string) => address.toLowerCase().replace(/^0x/, '');

/**
 * The API signs "<request SHA-256>:<response SHA-256>", a bare response
 * SHA-256, or the response text itself.
 */
function signedResponseDigest(signedText: string): string {
  const pair = SIGNED_HASH_PAIR.exec(signedText);
  if (pair) return pair[2].toLowerCase();
  if (SIGNED_HASH.test(signedText)) return signedText.toLowerCase();
  return sha256Hex(signedText);
}

function readExpectedResponseSha256(options: { expectContent?: string; expectSha256?: string }): string | undefined {
  if (options.expectContent !== undefined && options.expectSha256 !== undefined) {
    throw new Error('Use either --expect-content or --expect-sha256, not both.');
  }
  if (options.expectContent !== undefined) {
    let content: Buffer;
    try {
      content = readFileSync(options.expectContent);
    } catch (error) {
      throw new Error(`Could not read --expect-content file: ${error instanceof Error ? error.message : String(error)}`);
    }
    return sha256Hex(content);
  }
  if (options.expectSha256 !== undefined) {
    const digest = options.expectSha256.toLowerCase().replace(/^0x/, '');
    if (!SIGNED_HASH.test(digest)) {
      throw new Error('--expect-sha256 must be a 64-character hex SHA-256 digest.');
    }
    return digest;
  }
  return undefined;
}

export function registerTeeCommand(program: Command): void {
  const teeCommand = program
    .command('tee')
    .description('TEE attestation and verification commands');

  // venice tee attestation <model>
  teeCommand
    .command('attestation <model>')
    .description("Fetch and display the server's TEE attestation report for a model")
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .option('--verbose', 'Show detailed TDX quote information')
    .action(async (modelId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const { response, clientNonce } = await fetchTeeAttestation(modelId);

        if (format === 'json') {
          console.log(formatJson(response));
          return;
        }

        console.log(c.bold('\n🔐 TEE Attestation Report\n'));

        // Basic info
        console.log(`${c.dim('Model:')} ${terminalSafe(response.model)}`);
        console.log(`${c.dim('TEE Provider:')} ${terminalSafe(response.tee_provider || 'Unknown')}`);
        console.log(`${c.dim('Server Verified:')} ${response.verified ? c.green('✓ Yes') : c.red('✗ No')}`);
        console.log(`${c.dim('Nonce Match:')} ${response.nonce === clientNonce ? c.green('✓ Yes') : c.red('✗ No')}`);

        // Signing key info
        const signingKey = response.signing_key || response.signing_public_key;
        if (signingKey) {
          const derivedAddress = deriveSigningAddressFromKey(signingKey);
          console.log(`${c.dim('Signing Key:')} ${terminalSafe(signingKey).slice(0, 32)}...`);
          console.log(`${c.dim('Signing Address:')} ${terminalSafe(response.signing_address || derivedAddress || 'N/A')}`);
        }

        // TDX Quote info
        if (response.intel_quote) {
          console.log(`\n${c.bold('Intel TDX Quote:')}`);
          const parsed = parseTdxQuote(response.intel_quote);
          if (parsed) {
            const debugMode = isTdDebugMode(parsed.tdAttributes);
            console.log(`  ${c.dim('Version:')} ${parsed.version}`);
            console.log(`  ${c.dim('TEE Type:')} 0x${parsed.teeType.toString(16)}`);
            console.log(`  ${c.dim('Debug Mode:')} ${debugMode ? c.red('⚠️ YES (INSECURE)') : c.green('No')}`);

            if (options.verbose) {
              console.log(`  ${c.dim('MRTD:')} ${parsed.mrtd}`);
              console.log(`  ${c.dim('MR Config ID:')} ${parsed.mrConfigId}`);
              console.log(`  ${c.dim('MR Owner:')} ${parsed.mrOwner}`);
              console.log(`  ${c.dim('Report Data:')} ${parsed.reportData.slice(0, 40)}...`);
              console.log(`  ${c.dim('RTMR0:')} ${parsed.rtmr0}`);
              console.log(`  ${c.dim('RTMR1:')} ${parsed.rtmr1}`);
              console.log(`  ${c.dim('RTMR2:')} ${parsed.rtmr2}`);
              console.log(`  ${c.dim('RTMR3:')} ${parsed.rtmr3}`);
            }
          } else {
            console.log(c.yellow('  Unable to parse TDX quote'));
          }
        }

        // NVIDIA GPU attestation
        if (response.nvidia_payload) {
          console.log(`\n${c.bold('NVIDIA GPU Attestation:')}`);
          try {
            const payload = JSON.parse(response.nvidia_payload);
            console.log(`  ${c.dim('Architecture:')} ${terminalSafe(payload.arch || 'Unknown')}`);
            console.log(`  ${c.dim('Evidence Count:')} ${terminalSafe(payload.evidence_list?.length || 0)}`);

            if (options.verbose && payload.evidence_list?.length > 0) {
              console.log(`\n${c.dim('GPU attestation verification curl:')}`);
              console.log(buildGpuAttestationCurl(payload));
            }
          } catch {
            console.log(c.yellow('  Unable to parse NVIDIA payload'));
          }
        }

        // Server verification
        if (response.server_verification) {
          const sv = response.server_verification;
          console.log(`\n${c.bold('Server Verification:')}`);

          if (sv.tdx) {
            console.log(`  ${c.dim('TDX Valid:')} ${sv.tdx.valid ? c.green('✓ Yes') : c.red('✗ No')}`);
            if (sv.tdx.error) console.log(`    ${c.red(terminalSafe(sv.tdx.error))}`);
          }

          if (sv.nvidia) {
            console.log(`  ${c.dim('NVIDIA Valid:')} ${sv.nvidia.valid ? c.green('✓ Yes') : c.red('✗ No')}`);
            if (sv.nvidia.error) console.log(`    ${c.red(terminalSafe(sv.nvidia.error))}`);
          }

          if (sv.nonceBinding) {
            console.log(
              `  ${c.dim('Nonce Binding:')} ${sv.nonceBinding.bound ? c.green('✓ Bound') : c.red('✗ Not Bound')}`
            );
          }

          if (sv.signingAddressBinding) {
            console.log(
              `  ${c.dim('Address Binding:')} ${sv.signingAddressBinding.bound ? c.green('✓ Bound') : c.red('✗ Not Bound')}`
            );
          }

          console.log(`  ${c.dim('Verified At:')} ${terminalSafe(sv.verifiedAt)}`);
          console.log(`  ${c.dim('Duration:')} ${terminalSafe(sv.verificationDurationMs)}ms`);
        }

        console.log(c.dim(`\n${ATTESTATION_SCOPE_NOTE}`));
        console.log('');
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // venice tee verify <model>
  teeCommand
    .command('verify <model>')
    .description("Check the server's attestation report against the E2EE policy")
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (modelId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const { response, clientNonce } = await fetchTeeAttestation(modelId);
        const attestation = buildTeeVerificationResult(response, clientNonce, modelId);
        const policy = evaluateE2EEAttestationPolicy(attestation, modelId);
        const { signingKey } = attestation;

        if (format === 'json') {
          console.log(
            formatJson({
              model: modelId,
              passed: policy.passed,
              failures: policy.failures,
              attestation: {
                verified: response.verified,
                nonceMatch: attestation.nonce === attestation.clientNonce,
                signingKey: signingKey ? signingKey.slice(0, 32) + '...' : null,
                signingAddress: response.signing_address,
                teeProvider: response.tee_provider,
                hasIntelQuote: !!response.intel_quote,
                hasNvidiaPayload: !!response.nvidia_payload,
              },
              note: VERIFY_SCOPE_NOTE,
            })
          );
          process.exit(policy.passed ? 0 : 1);
        }

        console.log(c.bold('\n🛡️ E2EE Attestation Policy Verification\n'));
        console.log(`${c.dim('Model:')} ${modelId}`);

        if (policy.passed) {
          console.log(`${c.bold(c.green('✓ PASSED'))} - The server's attestation report passed the E2EE policy checks\n`);
          console.log(`${c.dim('Signing Address:')} ${terminalSafe(response.signing_address || 'N/A')}`);
          console.log(`${c.dim('TEE Provider:')} ${terminalSafe(response.tee_provider || 'Unknown')}`);
          console.log(c.dim(`\n${VERIFY_SCOPE_NOTE}`));
        } else {
          console.log(`${c.bold(c.red('✗ FAILED'))} - Attestation policy check failed\n`);
          console.log(c.red('Failures:'));
          for (const failure of policy.failures) {
            console.log(`  ${c.red('•')} ${terminalSafe(failure)}`);
          }
        }

        console.log('');
        process.exit(policy.passed ? 0 : 1);
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // venice tee signature <model> <completion-id>
  teeCommand
    .command('signature <model> <completionId>')
    .description('Fetch the TEE response signature for a completed request and check it')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .option('--verify-signer <address>', 'Expected signer address (default with --expect-*: the attested signing address)')
    .option('--expect-content <file>', 'File with the exact reply text the signature must cover')
    .option('--expect-sha256 <hex>', 'SHA-256 of the exact reply text the signature must cover')
    .action(async (modelId: string, completionId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const expectedResponseSha256 = readExpectedResponseSha256(options);
        const checking = options.verifySigner !== undefined || expectedResponseSha256 !== undefined;
        const response = await fetchTeeSignature(modelId, completionId);

        if (response.request_id !== completionId && (checking || response.request_id !== undefined)) {
          throw new Error(
            response.request_id === undefined
              ? `The signature response has no request ID, so it cannot be matched to ${completionId}.`
              : `The signature response is for request ${response.request_id}, not ${completionId}.`
          );
        }

        let expectedSigner: string | undefined;
        let attestationPolicy: TeeE2EEPolicyEvaluation | undefined;
        if (options.verifySigner !== undefined) {
          expectedSigner = normaliseAddress(options.verifySigner);
        } else if (expectedResponseSha256 !== undefined) {
          const { response: report, clientNonce } = await fetchTeeAttestation(modelId);
          const attestation = buildTeeVerificationResult(report, clientNonce, modelId);
          attestationPolicy = evaluateE2EEAttestationPolicy(attestation, modelId);
          if (attestationPolicy.passed && attestation.signingKey) {
            expectedSigner = deriveSigningAddressFromKey(attestation.signingKey);
          }
        }

        const signatureValue = typeof response.signature === 'string' ? response.signature : response.signature?.value;
        const signatureHex = typeof signatureValue === 'string' ? signatureValue : undefined;
        const signedText = typeof response.text === 'string' ? response.text : undefined;
        const recoveredSigner =
          signedText && signatureHex ? recoverSignerAddress(signedText, signatureHex) : null;
        const signerMatch =
          expectedSigner !== undefined && recoveredSigner !== null && normaliseAddress(recoveredSigner) === expectedSigner;
        const signedResponseSha256 = signedText !== undefined ? signedResponseDigest(signedText) : null;
        const responseMatch = expectedResponseSha256 !== undefined && signedResponseSha256 === expectedResponseSha256;
        const verified = signerMatch && (expectedResponseSha256 === undefined || responseMatch);

        if (format === 'json') {
          if (!checking) {
            console.log(formatJson(response));
            return;
          }
          const verification: Record<string, unknown> = { expectedSigner: expectedSigner ?? null, recoveredSigner };
          if (attestationPolicy) {
            verification.attestation = { passed: attestationPolicy.passed, failures: attestationPolicy.failures };
          }
          if (expectedResponseSha256 !== undefined) {
            verification.expectedResponseSha256 = expectedResponseSha256;
            verification.signedResponseSha256 = signedResponseSha256;
            verification.responseMatch = responseMatch;
          }
          verification.verified = verified;
          console.log(formatJson({ ...response, verification }));
          process.exit(verified ? 0 : 1);
        }

        console.log(c.bold('\n📝 TEE Response Signature\n'));

        console.log(`${c.dim('Model:')} ${terminalSafe(response.model || modelId)}`);
        console.log(`${c.dim('Request ID:')} ${terminalSafe(response.request_id || 'N/A')}`);
        console.log(`${c.dim('Requested ID:')} ${terminalSafe(response.requested_request_id || 'N/A')}`);
        console.log(`${c.dim('TEE Provider:')} ${terminalSafe(response.tee_provider || 'Unknown')}`);
        console.log(`${c.dim('TEE Hardware:')} ${terminalSafe(response.tee_hardware || 'Unknown')}`);

        if (response.signing_address) {
          console.log(`${c.dim('Signing Address:')} ${terminalSafe(response.signing_address)}`);
        }

        if (signatureHex) {
          console.log(`${c.dim('Signature:')} ${terminalSafe(signatureHex).slice(0, 32)}...`);
        }
        if (recoveredSigner) {
          console.log(`${c.dim('Recovered Signer:')} ${recoveredSigner}`);
        }

        if (!checking) {
          console.log(c.dim('Not verified: pass --expect-content or --expect-sha256 to check this signature against your reply.'));
        } else {
          console.log('');
          if (expectedSigner !== undefined) {
            const source = options.verifySigner !== undefined ? '--verify-signer' : 'a fresh attestation';
            console.log(`${c.dim('Expected Signer:')} ${expectedSigner} (from ${source})`);
          } else {
            console.log(`${c.dim('Expected Signer:')} ${c.red('unavailable: the attestation did not pass the E2EE policy')}`);
            for (const failure of attestationPolicy?.failures ?? []) {
              console.log(`  ${c.red('•')} ${terminalSafe(failure)}`);
            }
          }

          const signerStatus = signerMatch
            ? c.green('Yes')
            : recoveredSigner === null
              ? c.red('No (could not recover signer)')
              : c.red(`No (expected ${expectedSigner ?? 'an attested signer'})`);
          console.log(`${c.dim('Signer Match:')} ${signerStatus}`);

          const responseStatus = expectedResponseSha256 === undefined
            ? c.yellow('not checked (use --expect-content or --expect-sha256)')
            : responseMatch
              ? c.green('Yes')
              : c.red(`No (signed response SHA-256 ${signedResponseSha256 ?? 'unavailable'}, expected ${expectedResponseSha256})`);
          console.log(`${c.dim('Response Match:')} ${responseStatus}`);

          const verdict = !verified
            ? c.red('✗ No')
            : expectedResponseSha256 === undefined
              ? c.green('✓ Yes') + c.dim(' (signer only; the signed text was not compared with a reply)')
              : c.green('✓ Yes');
          console.log(`${c.dim('Verified:')} ${verdict}`);
        }

        if (signedText) {
          console.log(`\n${c.dim('Signed Text:')}`);
          const shownText = terminalSafe(signedText);
          const truncated = shownText.length > 200 ? shownText.slice(0, 200) + '...' : shownText;
          console.log(`  ${truncated}`);
        }

        if (response.payload) {
          console.log(`\n${c.dim('Payload:')}`);
          if (response.payload.request_hash) {
            console.log(`  ${c.dim('Request Hash:')} ${terminalSafe(response.payload.request_hash)}`);
          }
          if (response.payload.response_hash) {
            console.log(`  ${c.dim('Response Hash:')} ${terminalSafe(response.payload.response_hash)}`);
          }
          if (response.payload.timestamp) {
            console.log(`  ${c.dim('Timestamp:')} ${terminalSafe(response.payload.timestamp)}`);
          }
        }

        console.log('');
        if (checking && !verified) {
          process.exit(1);
        }
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
