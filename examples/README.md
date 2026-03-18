# Venice AI E2EE Examples

Complete examples of end-to-end encrypted communication with Venice AI API.

## What is E2EE?

End-to-end encryption ensures that your messages are:
1. **Encrypted client-side** before leaving your machine
2. **Processed inside a TEE** (Trusted Execution Environment) - a secure enclave
3. **Encrypted by the TEE** before responses are sent back to you

Venice never sees your plaintext data at any point.

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
pip install cryptography ecdsa requests
```

### JavaScript (Node.js)

```bash
npm install elliptic @noble/ciphers @noble/hashes
```

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

## Key Technical Details

### Cryptographic Primitives

| Component | Algorithm |
|-----------|-----------|
| Key Exchange | ECDH (secp256k1) |
| Key Derivation | HKDF-SHA256 |
| Encryption | AES-256-GCM |

### Important Parameters

- **Client nonce**: 32 bytes (64 hex characters) - for attestation replay protection
- **Encryption nonce**: 12 bytes - for AES-GCM
- **Public keys**: 65 bytes uncompressed (`04 || x || y`)

### Message Format

**Encrypted message**: `ephemeral_public (65 bytes) + nonce (12 bytes) + ciphertext + tag`

### Request Headers

```
X-Venice-TEE-Client-Pub-Key: <your-ephemeral-public-key-hex>
X-Venice-TEE-Model-Pub-Key: <model-public-key-from-attestation>
X-Venice-TEE-Signing-Algo: ecdsa
```

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
2. **Verify attestation**: Always verify the TEE attestation before trusting
3. **Nonce freshness**: Use cryptographically random nonces
4. **Don't reuse nonces**: Each encryption must use a unique nonce
5. **Verify signatures** (optional): Use `X-Venice-TEE-Signature` header to verify responses

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

## More Resources

- [Venice API Documentation](https://docs.venice.ai)
- [Venice CLI](https://github.com/veniceai/venice-cli)
- [E2EE Implementation Guide](../docs/guides/e2ee-implementation-guide.md)
