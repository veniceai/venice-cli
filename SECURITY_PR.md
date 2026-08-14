# Security fix: enforce E2EE/TEE conversation-integrity client-side

## Summary

The E2EE/"TEE-attested" guarantee was not cryptographically enforced on the
client. A malicious or compromised server (the exact party the feature claims
to protect against) could:

1. Have the client display attacker-authored content under the
   `🔐 Response decrypted end-to-end` banner, because the streamed response
   was **never verified against the attested enclave signing key**, and
2. Skip encryption entirely: the `isHexEncrypted()` gate meant a **plaintext**
   chunk was printed verbatim while the CLI still asserted it was decrypted
   end-to-end, and
3. Pass the broken `verifySignature()` helper for **any** content, because a
   64-hex `signedText` short-circuited to `verified: true` without checking
   the hash committed to the response.

## Root causes

| # | File | Issue |
|---|------|-------|
| 1 | `src/lib/e2ee.ts` `verifySignature` | Hash-format `signedText` returned `verified: true` without comparing the hash to `sha256(expectedContent)`. |
| 2 | `src/commands/chat.ts` `streamChat` | E2EE responses were displayed/trusted without ever fetching/verifying the enclave signature; `fetchTeeSignature`/`verifySignature` were dead code. |
| 3 | `src/commands/chat.ts` `streamChat` | `isHexEncrypted()` gate let a plaintext chunk through; the "decrypted end-to-end" banner printed unconditionally. |

## Fix

**`src/lib/e2ee.ts`** — replace the blanket hash short-circuit with real
verification: compute `sha256` of each expected-content variant and
constant-time-compare it to the signed single-hash / response-half of a
`request:response` hash pair. Mismatch ⇒ `verified: false`.
*(File was UTF-16 — opaque to `git diff`/SAST; re-encoded to UTF-8 so this
security change is reviewable. This is intentional; it is why `e2ee.ts` shows
as a binary→text change.)*

**`src/commands/chat.ts`** — in E2EE mode:
- reject any non-ciphertext chunk (`E2EE protocol violation`),
- **buffer** decrypted content instead of streaming it (do not show
  unverified bytes),
- after the stream, `assertTeeResponseSignature()` fetches the TEE signature
  and verifies it (via the now-fixed `verifySignature`) against the attested
  signing address over the full response; failure aborts and nothing is
  shown,
- the `🔐 Response decrypted end-to-end` banner is now reachable only after
  successful verification.

Nils Putnins / OffSeq Cybersecurity
npu@offseq.com / https://offseq.com / https://radar.offseq.com