# Venice AI E2EE Examples

Examples of end-to-end encrypted communication with Venice AI API.

> **Protocol sketches, not verified E2EE clients.** These examples show the E2EE
> message flow and wire format. Before they encrypt anything they check the
> server's attestation report for consistency, but they do not verify the Intel
> TDX quote signature, its certificate chain or the enclave measurements
> (client-side verification is tracked publicly in
> [issue #43](https://github.com/veniceai/venice-cli/issues/43)). They therefore
> do not prove that the server cannot read your data.

## What is E2EE?

End-to-end encryption is designed so that your messages are:
1. **Encrypted client-side** before leaving your machine
2. **Processed inside a TEE** (Trusted Execution Environment) - a secure enclave
3. **Encrypted by the TEE** before responses are sent back to you

That protection rests on the key you encrypt to belonging to a genuine enclave,
which only full verification of the attestation can establish. These examples
stop short of that verification (see the note above).

## How it Works

```
┌─────────────┐              ┌─────────────────────────────────────┐
│   Client    │              │          Venice AI Server           │
│             │              │  ┌─────────────────────────────┐   │
│  1. Generate│              │  │   TEE (Secure Enclave)      │   │
│     key pair│              │  │                             │   │
│             │              │  │  4. Decrypt message         │   │
│  2. Get TEE │──attestation─▶│  5. Process with LLM         │   │
│     attestation            │  │  6. Encrypt response        │   │
│             │              │  │                             │   │
│  3. Encrypt │──encrypted───▶│  └─────────────────────────────┘   │
│     message │   request    │                                     │
│             │              │                                     │
│  7. Decrypt │◀──encrypted──│                                     │
│     response│   response   │                                     │
└─────────────┘              └─────────────────────────────────────┘
```

## Setup

### Python

```bash
pip install cryptography requests
```

### JavaScript (Node.js 18 or later)

```bash
npm install @noble/curves@1 @noble/ciphers@1 @noble/hashes@1
```

In a clone of this repository, `npm install` at the root installs these.

## Usage

### Set your API key

```bash
export VENICE_API_KEY="your-api-key-here"
```

### Run Python example

```bash
python e2ee_chat.py
```

### Run JavaScript example

```bash
node e2ee_chat.mjs
```

Both examples send your API key only to `https://api.venice.ai/api/v1`. As in
the Venice CLI, `VENICE_API_BASE_URL` is ignored unless `NODE_ENV=test`.

## What the Examples Check

Before encrypting, both examples apply the attestation checks the Venice CLI
applies:

- The server reports `verified: true`
- The response echoes the fresh 32-byte nonce the client sent
- The attested model is the requested model
- An Intel TDX quote is present and parses strictly: version 4 or 5, TEE type
  `0x81`, a TD report body, and signature data that ends exactly where the
  quote ends
- The TD debug bit in the quote is clear
- `server_verification.tdx.valid` and `server_verification.nonceBinding.bound`
  are `true`, as is `server_verification.nvidia.valid` when an NVIDIA payload
  is present
- The signing key is a valid uncompressed secp256k1 public key whose Ethereum
  address (the last 20 bytes of the Keccak-256 hash of the 64-byte key) equals
  the first 20 bytes of the quote's REPORTDATA, and it matches
  `signing_address` when one is reported

While streaming, they stop with exit status 1, without the success banner,
when:

- A content chunk is not E2EE ciphertext, or does not decrypt with the
  session key
- The server sends an error event, or an event that is not JSON
- The stream ends without a `finish_reason` and a `data: [DONE]` line

### What They Do Not Check

- The quote's signature and its certificate chain back to Intel
- The enclave measurements, so they cannot tell which code the enclave runs
- The `server_verification` results themselves: the server reports them about
  its own attestation, and the examples only check that they are positive
- Response signatures

## Key Technical Details

### Cryptographic Primitives

| Component | Algorithm |
|-----------|-----------|
| Key Exchange | ECDH (secp256k1) |
| Key Derivation | HKDF-SHA256 (no salt, info `ecdsa_encryption`) |
| Encryption | AES-256-GCM |

The HKDF input is the 32-byte X coordinate of the ECDH shared point.

### Important Parameters

- **Client nonce**: 32 bytes (64 hex characters) - for attestation replay protection
- **Encryption nonce**: 12 bytes - for AES-GCM
- **Public keys**: 65 bytes uncompressed (`04 || x || y`). The attestation may
  return the model key as 64 bytes without the `04` prefix; normalise it by
  length (128 hex characters), because the 64-byte form can itself start with
  `04`.

### Message Format

**Encrypted message**: `ephemeral_public (65 bytes) + nonce (12 bytes) + ciphertext + tag`

### Request Headers

```
X-Venice-TEE-Client-Pub-Key: <your-ephemeral-public-key-hex>
X-Venice-TEE-Model-Pub-Key: <model-public-key-from-attestation>
X-Venice-TEE-Signing-Algo: ecdsa
```

### Streaming Responses

The reply arrives as server-sent events. Each `choices[0].delta.content` is a
separate encrypted message in the format above. The reply is complete only
after a chunk with a `finish_reason` and the exact line `data: [DONE]`.

## E2EE-Capable Models

Use models with the `e2ee-` prefix. List available models:

```bash
venice models --e2ee
```

Or via API:
```bash
curl -s "https://api.venice.ai/api/v1/models?e2ee=true" \
  -H "Authorization: Bearer $VENICE_API_KEY" | jq '.data[].id'
```

## Security Considerations

1. **Ephemeral keys**: Generate a new key pair for each session
2. **Verify attestation**: Always verify the TEE attestation before trusting the
   key it carries, including the quote signature, certificate chain and
   measurements that these examples skip
3. **Nonce freshness**: Use cryptographically random nonces
4. **Don't reuse nonces**: Each encryption must use a unique nonce
5. **Fail closed**: Treat a chunk that is not ciphertext or fails to decrypt,
   and a stream that ends early, as errors rather than part of the reply
6. **Verify signatures** (optional): Use `X-Venice-TEE-Signature` header to verify responses

## Troubleshooting

### "Nonce must be exactly 32 bytes"
Use `secrets.token_hex(32)` (Python) or 32-byte random buffer (JS) for attestation nonce.

### "Invalid public key"
Ensure public keys use uncompressed format with `04` prefix (65 bytes total).

### "Decryption failed"
Check that you're parsing the response correctly:
- First 65 bytes: ephemeral public key
- Next 12 bytes: nonce  
- Remaining bytes: ciphertext + auth tag

### "Attestation rejected: ..."
The attestation failed one or more of the checks above, and the message lists
each one. The example stops before it sends your prompt.

### "Stream ended before data: [DONE]"
The connection closed before the reply was complete, so any text printed above
the error is partial.

## More Resources

- [Venice API Documentation](https://docs.venice.ai)
- [Venice CLI](https://github.com/veniceai/venice-cli)
- [Client-side attestation verification (issue #43)](https://github.com/veniceai/venice-cli/issues/43)
