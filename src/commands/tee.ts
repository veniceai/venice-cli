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
  getChalk,
  detectOutputFormat,
} from '../lib/output.js';
import {
  parseTdxQuote,
  isTdDebugMode,
  evaluateE2EEAttestationPolicy,
  buildGpuAttestationCurl,
  buildTeeVerificationResult,
  ATTESTATION_SCOPE_NOTE,
} from '../lib/tee.js';
import { deriveSigningAddressFromKey, recoverSignerAddress } from '../lib/e2ee.js';

const VERIFY_SCOPE_NOTE =
  `The attestation report is the server's own; the CLI checks it for internal consistency only. ${ATTESTATION_SCOPE_NOTE}`;

const SIGNED_HASH_PAIR = /^([0-9a-f]{64}):([0-9a-f]{64})$/i;
const SIGNED_HASH = /^[0-9a-f]{64}$/i;
const SIGNER_ADDRESS = /^(0x)?[0-9a-f]{40}$/i;

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const normaliseAddress = (address: string) => address.toLowerCase().replace(/^0x/, '');

/**
 * The API signs "<request SHA-256>:<response SHA-256>", a bare response
 * SHA-256, or the response text itself. Only the hash pair covers a request.
 */
function signedDigests(signedText: string): { request: string | null; response: string } {
  const pair = SIGNED_HASH_PAIR.exec(signedText);
  if (pair) return { request: pair[1].toLowerCase(), response: pair[2].toLowerCase() };
  if (SIGNED_HASH.test(signedText)) return { request: null, response: signedText.toLowerCase() };
  return { request: null, response: sha256Hex(signedText) };
}

function readExpectedSha256(
  fileFlag: string,
  file: string | undefined,
  digestFlag: string,
  digest: string | undefined
): string | undefined {
  if (file !== undefined && digest !== undefined) {
    throw new Error(`Use either ${fileFlag} or ${digestFlag}, not both.`);
  }
  if (file !== undefined) {
    let content: Buffer;
    try {
      content = readFileSync(file);
    } catch (error) {
      throw new Error(`Could not read ${fileFlag} file: ${error instanceof Error ? error.message : String(error)}`);
    }
    return sha256Hex(content);
  }
  if (digest !== undefined) {
    const normalised = digest.toLowerCase().replace(/^0x/, '');
    if (!SIGNED_HASH.test(normalised)) {
      throw new Error(`${digestFlag} must be a 64-character hex SHA-256 digest.`);
    }
    return normalised;
  }
  return undefined;
}

function describeRequestMatch(
  c: ReturnType<typeof getChalk>,
  signedText: string | undefined,
  signedRequestSha256: string | null,
  expectedRequestSha256: string | undefined
): string {
  if (signedText === undefined) {
    return c.red('No (the response has no signed text)');
  }
  if (signedRequestSha256 === null) {
    return expectedRequestSha256 === undefined
      ? c.yellow('not covered (the signature covers the reply only)')
      : c.red('No (the signature covers the reply only, not a request)');
  }
  if (expectedRequestSha256 === undefined) {
    return c.red(
      `No (the signature covers request SHA-256 ${signedRequestSha256}; pass --expect-request or --expect-request-sha256)`
    );
  }
  return signedRequestSha256 === expectedRequestSha256
    ? c.green('Yes')
    : c.red(`No (signed request SHA-256 ${signedRequestSha256}, expected ${expectedRequestSha256})`);
}

function readExpectedSigner(verifySigner: string | undefined, checkingContent: boolean): string | undefined {
  if (verifySigner === undefined) {
    if (checkingContent) {
      throw new Error(
        '--expect-content and --expect-sha256 need --verify-signer <address>, an enclave signing address you trust. ' +
          "The CLI does not take the signer from the server's attestation, because it does not verify the Intel TDX quote signature or enclave measurements."
      );
    }
    return undefined;
  }
  if (!SIGNER_ADDRESS.test(verifySigner)) {
    throw new Error('--verify-signer must be a 40-character hex address.');
  }
  return normaliseAddress(verifySigner);
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
          console.log(JSON.stringify(response, null, 2));
          return;
        }

        console.log(c.bold('\n🔐 TEE Attestation Report\n'));

        // Basic info
        console.log(`${c.dim('Model:')} ${response.model}`);
        console.log(`${c.dim('TEE Provider:')} ${response.tee_provider || 'Unknown'}`);
        console.log(`${c.dim('Server Verified:')} ${response.verified ? c.green('✓ Yes') : c.red('✗ No')}`);
        console.log(`${c.dim('Nonce Match:')} ${response.nonce === clientNonce ? c.green('✓ Yes') : c.red('✗ No')}`);

        // Signing key info
        const signingKey = response.signing_key || response.signing_public_key;
        if (signingKey) {
          const derivedAddress = deriveSigningAddressFromKey(signingKey);
          console.log(`${c.dim('Signing Key:')} ${signingKey.slice(0, 32)}...`);
          console.log(`${c.dim('Signing Address:')} ${response.signing_address || derivedAddress || 'N/A'}`);
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
            console.log(`  ${c.dim('Architecture:')} ${payload.arch || 'Unknown'}`);
            console.log(`  ${c.dim('Evidence Count:')} ${payload.evidence_list?.length || 0}`);

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
            if (sv.tdx.error) console.log(`    ${c.red(sv.tdx.error)}`);
          }

          if (sv.nvidia) {
            console.log(`  ${c.dim('NVIDIA Valid:')} ${sv.nvidia.valid ? c.green('✓ Yes') : c.red('✗ No')}`);
            if (sv.nvidia.error) console.log(`    ${c.red(sv.nvidia.error)}`);
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

          console.log(`  ${c.dim('Verified At:')} ${sv.verifiedAt}`);
          console.log(`  ${c.dim('Duration:')} ${sv.verificationDurationMs}ms`);
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
            JSON.stringify(
              {
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
              },
              null,
              2
            )
          );
          process.exit(policy.passed ? 0 : 1);
        }

        console.log(c.bold('\n🛡️ E2EE Attestation Policy Verification\n'));
        console.log(`${c.dim('Model:')} ${modelId}`);

        if (policy.passed) {
          console.log(`${c.bold(c.green('✓ PASSED'))} - The server's attestation report passed the E2EE policy checks\n`);
          console.log(`${c.dim('Signing Address:')} ${response.signing_address || 'N/A'}`);
          console.log(`${c.dim('TEE Provider:')} ${response.tee_provider || 'Unknown'}`);
          console.log(c.dim(`\n${VERIFY_SCOPE_NOTE}`));
        } else {
          console.log(`${c.bold(c.red('✗ FAILED'))} - Attestation policy check failed\n`);
          console.log(c.red('Failures:'));
          for (const failure of policy.failures) {
            console.log(`  ${c.red('•')} ${failure}`);
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
    .option('--verify-signer <address>', 'Enclave signing address you trust (required with --expect-content and --expect-sha256)')
    .option('--expect-content <file>', 'File with the exact reply text the signature must cover')
    .option('--expect-sha256 <hex>', 'SHA-256 of the exact reply text the signature must cover')
    .option('--expect-request <file>', 'File with the exact request the signature must cover')
    .option('--expect-request-sha256 <hex>', 'SHA-256 of the exact request the signature must cover')
    .action(async (modelId: string, completionId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const expectedResponseSha256 = readExpectedSha256(
          '--expect-content',
          options.expectContent,
          '--expect-sha256',
          options.expectSha256
        );
        const expectedRequestSha256 = readExpectedSha256(
          '--expect-request',
          options.expectRequest,
          '--expect-request-sha256',
          options.expectRequestSha256
        );
        if (expectedRequestSha256 !== undefined && expectedResponseSha256 === undefined) {
          throw new Error('Use --expect-request or --expect-request-sha256 together with --expect-content or --expect-sha256.');
        }
        const expectedSigner = readExpectedSigner(options.verifySigner, expectedResponseSha256 !== undefined);
        const checking = expectedSigner !== undefined;
        const response = await fetchTeeSignature(modelId, completionId);

        if (response.request_id !== completionId && (checking || response.request_id !== undefined)) {
          throw new Error(
            response.request_id === undefined
              ? `The signature response has no request ID, so it cannot be matched to ${completionId}.`
              : `The signature response is for request ${response.request_id}, not ${completionId}.`
          );
        }

        const signatureValue = typeof response.signature === 'string' ? response.signature : response.signature?.value;
        const signatureHex = typeof signatureValue === 'string' ? signatureValue : undefined;
        const signedText = typeof response.text === 'string' ? response.text : undefined;
        const recoveredSigner =
          signedText && signatureHex ? recoverSignerAddress(signedText, signatureHex) : null;
        const signerMatch =
          expectedSigner !== undefined && recoveredSigner !== null && normaliseAddress(recoveredSigner) === expectedSigner;
        const signed = signedText !== undefined ? signedDigests(signedText) : null;
        const signedResponseSha256 = signed?.response ?? null;
        const signedRequestSha256 = signed?.request ?? null;
        const responseMatch = expectedResponseSha256 !== undefined && signedResponseSha256 === expectedResponseSha256;
        const requestMatch =
          signedRequestSha256 === null && expectedRequestSha256 === undefined
            ? null
            : signedRequestSha256 === expectedRequestSha256;
        const verified =
          signerMatch && (expectedResponseSha256 === undefined || (responseMatch && requestMatch !== false));

        if (format === 'json') {
          if (!checking) {
            console.log(JSON.stringify(response, null, 2));
            return;
          }
          const verification: Record<string, unknown> = { expectedSigner: expectedSigner ?? null, recoveredSigner };
          if (expectedResponseSha256 !== undefined) {
            verification.expectedResponseSha256 = expectedResponseSha256;
            verification.signedResponseSha256 = signedResponseSha256;
            verification.responseMatch = responseMatch;
            verification.expectedRequestSha256 = expectedRequestSha256 ?? null;
            verification.signedRequestSha256 = signedRequestSha256;
            verification.requestMatch = requestMatch;
          }
          verification.verified = verified;
          console.log(JSON.stringify({ ...response, verification }, null, 2));
          process.exit(verified ? 0 : 1);
        }

        console.log(c.bold('\n📝 TEE Response Signature\n'));

        console.log(`${c.dim('Model:')} ${response.model || modelId}`);
        console.log(`${c.dim('Request ID:')} ${response.request_id || 'N/A'}`);
        console.log(`${c.dim('Requested ID:')} ${response.requested_request_id || 'N/A'}`);
        console.log(`${c.dim('TEE Provider:')} ${response.tee_provider || 'Unknown'}`);
        console.log(`${c.dim('TEE Hardware:')} ${response.tee_hardware || 'Unknown'}`);

        if (response.signing_address) {
          console.log(`${c.dim('Signing Address:')} ${response.signing_address}`);
        }

        if (signatureHex) {
          console.log(`${c.dim('Signature:')} ${signatureHex.slice(0, 32)}...`);
        }
        if (recoveredSigner) {
          console.log(`${c.dim('Recovered Signer:')} ${recoveredSigner}`);
        }

        if (!checking) {
          console.log(
            c.dim('Not verified: pass --verify-signer <address> with --expect-content or --expect-sha256 to check this signature against your reply.')
          );
        } else {
          console.log('');
          console.log(`${c.dim('Expected Signer:')} ${expectedSigner} (from --verify-signer)`);

          const signerStatus = signerMatch
            ? c.green('Yes')
            : recoveredSigner === null
              ? c.red('No (could not recover signer)')
              : c.red(`No (expected ${expectedSigner})`);
          console.log(`${c.dim('Signer Match:')} ${signerStatus}`);

          const responseStatus = expectedResponseSha256 === undefined
            ? c.yellow('not checked (use --expect-content or --expect-sha256)')
            : responseMatch
              ? c.green('Yes')
              : c.red(`No (signed response SHA-256 ${signedResponseSha256 ?? 'unavailable'}, expected ${expectedResponseSha256})`);
          console.log(`${c.dim('Response Match:')} ${responseStatus}`);
          if (expectedResponseSha256 !== undefined) {
            const requestStatus = describeRequestMatch(c, signedText, signedRequestSha256, expectedRequestSha256);
            console.log(`${c.dim('Request Match:')} ${requestStatus}`);
          }

          const verdict = !verified
            ? c.red('✗ No')
            : expectedResponseSha256 === undefined
              ? c.green('✓ Yes') + c.dim(' (signer only; the signed text was not compared with a reply)')
              : requestMatch === null
                ? c.green('✓ Yes') + c.dim(' (reply only; the signature does not cover a request)')
                : c.green('✓ Yes');
          console.log(`${c.dim('Verified:')} ${verdict}`);
        }

        if (signedText) {
          console.log(`\n${c.dim('Signed Text:')}`);
          const truncated = signedText.length > 200 ? signedText.slice(0, 200) + '...' : signedText;
          console.log(`  ${truncated}`);
        }

        if (response.payload) {
          console.log(`\n${c.dim('Payload:')}`);
          if (response.payload.request_hash) {
            console.log(`  ${c.dim('Request Hash:')} ${response.payload.request_hash}`);
          }
          if (response.payload.response_hash) {
            console.log(`  ${c.dim('Response Hash:')} ${response.payload.response_hash}`);
          }
          if (response.payload.timestamp) {
            console.log(`  ${c.dim('Timestamp:')} ${response.payload.timestamp}`);
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
