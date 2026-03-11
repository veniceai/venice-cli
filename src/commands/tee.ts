/**
 * TEE Command - TEE attestation and signature verification
 */

import { Command } from 'commander';
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
  type TeeVerificationResult,
} from '../lib/tee.js';
import { deriveSigningAddressFromKey, recoverSignerAddress } from '../lib/e2ee.js';

export function registerTeeCommand(program: Command): void {
  const teeCommand = program
    .command('tee')
    .description('TEE attestation and verification commands');

  // venice tee attestation <model>
  teeCommand
    .command('attestation <model>')
    .description('Fetch and display TEE attestation for a model')
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

        console.log(c.bold('\n🛡️ TEE Attestation Report\n'));

        // Basic info
        console.log(`${c.dim('Model:')} ${response.model}`);
        console.log(`${c.dim('TEE Provider:')} ${response.tee_provider || 'Unknown'}`);
        console.log(`${c.dim('Verified:')} ${response.verified ? c.green('✓ Yes') : c.red('✗ No')}`);
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

        console.log('');
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // venice tee verify <model>
  teeCommand
    .command('verify <model>')
    .description('Run full E2EE attestation policy verification')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .action(async (modelId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const { response, clientNonce } = await fetchTeeAttestation(modelId);

        // Parse TDX quote
        const parsedTdxQuote = response.intel_quote ? parseTdxQuote(response.intel_quote) : undefined;

        // Build verification result
        const signingKey = response.signing_key || response.signing_public_key;
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

        // Run policy evaluation
        const policy = evaluateE2EEAttestationPolicy(attestation, modelId);

        if (format === 'json') {
          console.log(
            JSON.stringify(
              {
                model: modelId,
                passed: policy.passed,
                failures: policy.failures,
                attestation: {
                  verified: response.verified,
                  nonceMatch: response.nonce === clientNonce,
                  signingKey: signingKey?.slice(0, 32) + '...',
                  signingAddress: response.signing_address,
                  teeProvider: response.tee_provider,
                  hasIntelQuote: !!response.intel_quote,
                  hasNvidiaPayload: !!response.nvidia_payload,
                },
              },
              null,
              2
            )
          );
          return;
        }

        console.log(c.bold('\n🔐 E2EE Attestation Policy Verification\n'));
        console.log(`${c.dim('Model:')} ${modelId}`);

        if (policy.passed) {
          console.log(`${c.bold(c.green('✓ PASSED'))} - Model attestation is valid for E2EE\n`);
          console.log(`${c.dim('Signing Address:')} ${response.signing_address || 'N/A'}`);
          console.log(`${c.dim('TEE Provider:')} ${response.tee_provider || 'Unknown'}`);
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
    .description('Fetch TEE response signature for a completed request')
    .option('-f, --format <format>', 'Output format (pretty|json)')
    .option('--verify-signer <address>', 'Verify recovered signer matches this address')
    .action(async (modelId: string, completionId: string, options) => {
      const format = detectOutputFormat(options.format);
      const c = getChalk();

      try {
        const response = await fetchTeeSignature(modelId, completionId);

        if (format === 'json') {
          console.log(JSON.stringify(response, null, 2));
          return;
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

        const signatureHex = typeof response.signature === 'string' ? response.signature : response.signature?.value;
        if (signatureHex) {
          console.log(`${c.dim('Signature:')} ${signatureHex.slice(0, 32)}...`);

          // Try to recover signer from signature
          if (response.text) {
            const recoveredAddress = recoverSignerAddress(response.text, signatureHex);
            if (recoveredAddress) {
              console.log(`${c.dim('Recovered Signer:')} ${recoveredAddress}`);

              if (options.verifySigner) {
                const expected = options.verifySigner.toLowerCase().replace(/^0x/, '');
                const matches = recoveredAddress === expected;
                console.log(
                  `${c.dim('Signer Verified:')} ${matches ? c.green('✓ Yes') : c.red('✗ No (expected ' + expected + ')')}`
                );
              }
            }
          }
        }

        if (response.text) {
          console.log(`\n${c.dim('Signed Text:')}`);
          const truncated = response.text.length > 200 ? response.text.slice(0, 200) + '...' : response.text;
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
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
