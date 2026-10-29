#!/usr/bin/env python3
"""
Venice AI E2EE Chat Example

=============================================================================
PROTOCOL SKETCH, NOT A VERIFIED E2EE CLIENT

This example shows the E2EE message flow and wire format. Before it encrypts
anything it checks the server's attestation report for consistency, but it
does not verify the Intel TDX quote signature, its certificate chain or the
enclave measurements (client-side verification is tracked publicly in issue
#43: https://github.com/veniceai/venice-cli/issues/43). It therefore does not
prove that the server cannot read your data.
=============================================================================

Flow:
  1. Fetch an attestation for a fresh nonce and apply the checks the Venice
     CLI applies before it encrypts (see check_attestation below).
  2. Encrypt the prompt to the attested signing key: ECDH on secp256k1,
     HKDF-SHA256, AES-256-GCM.
  3. Stream the reply and decrypt every chunk with this session's key.

The example exits with status 1, without the success banner, if the
attestation fails a check, a content chunk is not ciphertext or does not
decrypt, or the stream ends without a finish_reason and `data: [DONE]`.

Requirements (Python 3.9 or later):
    pip install cryptography requests

Usage:
    export VENICE_API_KEY="your-api-key"
    python e2ee_chat.py
"""

import codecs
import json
import os
import secrets
import string
import struct
import sys

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# Configuration
API_KEY = os.environ.get('VENICE_API_KEY')
# As in the Venice CLI, only test runs may send the API key to another server.
if os.environ.get('NODE_ENV') == 'test' and os.environ.get('VENICE_API_BASE_URL'):
    BASE_URL = os.environ['VENICE_API_BASE_URL']
else:
    BASE_URL = 'https://api.venice.ai/api/v1'
MODEL = 'e2ee-qwen3-5-122b-a10b'  # E2EE-capable model
HKDF_INFO = b'ecdsa_encryption'

# Encrypted message layout: ephemeral public key || nonce || ciphertext + tag
EPHEMERAL_PUBLIC_KEY_BYTES = 65
NONCE_BYTES = 12
GCM_TAG_BYTES = 16

# Intel TDX quote layout
TDX_TEE_TYPE = 0x81
QUOTE_HEADER_BYTES = 48
TD_REPORT_BODY_BYTES = {2: 584, 3: 648}  # v5 body type -> TD report 1.0 / 1.5
TD_ATTRIBUTES_OFFSET = 120  # within the TD report
REPORT_DATA_OFFSET = 520  # within the TD report

if not API_KEY:
    print('Error: VENICE_API_KEY environment variable not set', file=sys.stderr)
    print('Usage: export VENICE_API_KEY="your-api-key"', file=sys.stderr)
    sys.exit(1)


def as_dict(value) -> dict:
    """Treat anything that is not a JSON object as an empty one."""
    return value if isinstance(value, dict) else {}


def is_hex(s: str) -> bool:
    """Check for an even number of hex digits."""
    return len(s) % 2 == 0 and all(c in string.hexdigits for c in s)


def hex_to_bytes(hex_str: str, label: str = 'value') -> bytes:
    """Convert an optionally 0x-prefixed hex string to bytes."""
    clean = hex_str[2:] if hex_str.startswith('0x') else hex_str
    if not is_hex(clean):
        raise ValueError(f'{label} is not valid hex')
    return bytes.fromhex(clean)


_KECCAK_ROUND_CONSTANTS = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_KECCAK_ROTATIONS = [  # indexed by x + 5 * y
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
]
_MASK_64 = (1 << 64) - 1


def _keccak_f1600(state: list) -> None:
    for round_constant in _KECCAK_ROUND_CONSTANTS:
        # theta
        c = [state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20] for x in range(5)]
        for x in range(5):
            d = c[(x - 1) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & _MASK_64)
            for y in range(0, 25, 5):
                state[x + y] ^= d
        # rho and pi
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                word = state[x + 5 * y]
                shift = _KECCAK_ROTATIONS[x + 5 * y]
                b[y + 5 * ((2 * x + 3 * y) % 5)] = ((word << shift) | (word >> (64 - shift))) & _MASK_64
        # chi
        for y in range(0, 25, 5):
            for x in range(5):
                state[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & b[(x + 2) % 5 + y])
        # iota
        state[0] ^= round_constant


def keccak_256(data: bytes) -> bytes:
    """Keccak-256 as used by Ethereum.

    hashlib.sha3_256 is the NIST SHA3-256 standard, which pads differently and
    produces different digests.
    """
    rate = 136
    padded = bytearray(data) + b'\x01'
    padded += b'\x00' * (-len(padded) % rate)
    padded[-1] |= 0x80
    state = [0] * 25
    for offset in range(0, len(padded), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(padded[offset + 8 * i:offset + 8 * i + 8], 'little')
        _keccak_f1600(state)
    return b''.join(word.to_bytes(8, 'little') for word in state[:4])


def parse_tdx_quote(quote_hex: str) -> dict:
    """Parse an Intel TDX quote and check that its layout is complete.

    Accepts version 4 or 5, TEE type 0x81, a TD report body, and signature data
    that ends exactly where the quote ends. Only fields are read; the signature
    is not verified.
    """
    quote = hex_to_bytes(quote_hex, 'TDX quote')
    if len(quote) < QUOTE_HEADER_BYTES:
        raise ValueError('TDX quote is shorter than its header')

    version, _attestation_key_type, tee_type = struct.unpack_from('<HHI', quote, 0)
    if version == 4:
        body_offset = QUOTE_HEADER_BYTES
        body_length = TD_REPORT_BODY_BYTES[2]
    elif version == 5:
        # Version 5 adds a body descriptor: type (u16) and size (u32).
        if len(quote) < QUOTE_HEADER_BYTES + 6:
            raise ValueError('TDX quote is truncated')
        body_type, declared_length = struct.unpack_from('<HI', quote, QUOTE_HEADER_BYTES)
        body_length = TD_REPORT_BODY_BYTES.get(body_type)
        if body_length is None or declared_length != body_length:
            raise ValueError(f'TDX quote has an unexpected body (type {body_type}, {declared_length} bytes)')
        body_offset = QUOTE_HEADER_BYTES + 6
    else:
        raise ValueError(f'unsupported TDX quote version {version}')

    if tee_type != TDX_TEE_TYPE:
        raise ValueError(f'unexpected TEE type {tee_type:#x} in quote, expected 0x81')

    signature_length_offset = body_offset + body_length
    if len(quote) < signature_length_offset + 4:
        raise ValueError('TDX quote is truncated')
    (signature_length,) = struct.unpack_from('<I', quote, signature_length_offset)
    if len(quote) != signature_length_offset + 4 + signature_length:
        raise ValueError('TDX quote length does not match its signature data length')

    body = quote[body_offset:body_offset + body_length]
    return {
        'td_attributes': body[TD_ATTRIBUTES_OFFSET:TD_ATTRIBUTES_OFFSET + 8],
        'report_data': body[REPORT_DATA_OFFSET:REPORT_DATA_OFFSET + 64],
    }


def parse_signing_key(key_hex: str) -> ec.EllipticCurvePublicKey:
    """Parse the model's signing key, accepting the 64-byte form without 04."""
    clean = key_hex[2:] if key_hex.startswith('0x') else key_hex
    # A 64-byte key can itself begin with 04, so normalise by length, not prefix.
    if len(clean) == 128:
        clean = '04' + clean
    if len(clean) != 130:
        raise ValueError('signing key is not a 64- or 65-byte uncompressed secp256k1 public key')
    key_bytes = hex_to_bytes(clean, 'signing key')
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), key_bytes)
    except ValueError:
        raise ValueError('signing key is not a valid uncompressed secp256k1 public key') from None


def public_key_bytes(key) -> bytes:
    """Uncompressed public key: 04 || x (32 bytes) || y (32 bytes)."""
    public_key = key.public_key() if isinstance(key, ec.EllipticCurvePrivateKey) else key
    return public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)


def ethereum_address(public_key: ec.EllipticCurvePublicKey) -> str:
    """Last 20 bytes of the Keccak-256 hash of x || y."""
    return keccak_256(public_key_bytes(public_key)[1:])[12:].hex()


def check_attestation(attestation, model_id: str, client_nonce: str) -> ec.EllipticCurvePublicKey:
    """Apply the checks the Venice CLI applies before it encrypts.

    They test the server's report for consistency; they do not verify the TDX
    quote signature, its certificate chain or the enclave measurements.
    Returns the model's signing key.
    """
    if not isinstance(attestation, dict):
        raise ValueError('Attestation response is not a JSON object')

    failures = []

    if attestation.get('verified') is not True:
        failures.append('the server did not report verified: true')
    if attestation.get('nonce') != client_nonce:
        failures.append('the attestation does not echo our nonce')
    if attestation.get('model') != model_id:
        failures.append(f'the attested model {json.dumps(attestation.get("model"))} is not {model_id}')

    quote = None
    intel_quote = attestation.get('intel_quote')
    if not isinstance(intel_quote, str) or not intel_quote:
        failures.append('no Intel TDX quote was returned')
    else:
        try:
            quote = parse_tdx_quote(intel_quote)
            if quote['td_attributes'][0] & 0x01:
                failures.append('the TDX quote has the TD debug bit set')
        except ValueError as error:
            failures.append(str(error))

    verification = as_dict(attestation.get('server_verification'))
    if as_dict(verification.get('tdx')).get('valid') is not True:
        failures.append('server_verification.tdx.valid is not true')
    if as_dict(verification.get('nonceBinding')).get('bound') is not True:
        failures.append('server_verification.nonceBinding.bound is not true')
    if attestation.get('nvidia_payload') and as_dict(verification.get('nvidia')).get('valid') is not True:
        failures.append('server_verification.nvidia.valid is not true')

    signing_key = None
    signing_key_hex = attestation.get('signing_key') or attestation.get('signing_public_key')
    if not isinstance(signing_key_hex, str) or not signing_key_hex:
        failures.append('no signing key was returned')
    else:
        try:
            signing_key = parse_signing_key(signing_key_hex)
        except ValueError as error:
            failures.append(str(error))

    if signing_key is not None:
        address = ethereum_address(signing_key)
        if quote is not None and quote['report_data'][:20].hex() != address:
            failures.append('the signing key does not match the address in the TDX REPORTDATA')
        if attestation.get('signing_address'):
            reported = str(attestation['signing_address']).lower().removeprefix('0x')
            if reported != address:
                failures.append('signing_address does not match the signing key')

    if failures:
        raise ValueError('Attestation rejected: ' + '; '.join(failures))
    return signing_key


def fetch_attestation(model_id: str) -> dict:
    """Fetch an attestation for a fresh nonce and check it."""
    # Generate 32-byte nonce (64 hex chars) - required by all TEE providers
    client_nonce = secrets.token_hex(32)

    response = requests.get(
        f'{BASE_URL}/tee/attestation',
        params={'model': model_id, 'nonce': client_nonce},
        headers={'Authorization': f'Bearer {API_KEY}'},
        timeout=30
    )
    response.raise_for_status()
    attestation = response.json()
    signing_key = check_attestation(attestation, model_id, client_nonce)

    return {
        'model_public_key': attestation.get('signing_key') or attestation.get('signing_public_key'),
        'signing_key': signing_key,
        'tee_provider': attestation.get('tee_provider'),
    }


def derive_aes_key(private_key: ec.EllipticCurvePrivateKey, public_key: ec.EllipticCurvePublicKey) -> bytes:
    """Derive the AES-256-GCM key for one message from an ECDH shared secret."""
    # exchange() returns the 32-byte X coordinate, which is the HKDF input.
    shared_x = private_key.exchange(ec.ECDH(), public_key)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=HKDF_INFO).derive(shared_x)


def encrypt_message(plaintext: str, model_public_key: ec.EllipticCurvePublicKey) -> str:
    """Encrypt a message to the model's signing key using ECDH + HKDF + AES-256-GCM."""
    # Generate ephemeral key pair for this message
    ephemeral_private = ec.generate_private_key(ec.SECP256K1())
    aes_key = derive_aes_key(ephemeral_private, model_public_key)
    nonce = os.urandom(NONCE_BYTES)
    ciphertext = AESGCM(aes_key).encrypt(nonce, plaintext.encode('utf-8'), None)
    return (public_key_bytes(ephemeral_private) + nonce + ciphertext).hex()


def is_hex_ciphertext(s: str) -> bool:
    """Check that a content chunk has the shape of an encrypted message."""
    min_length = (EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES + GCM_TAG_BYTES) * 2
    return len(s) >= min_length and is_hex(s)


def decrypt_chunk(ciphertext_hex: str, client_private_key: ec.EllipticCurvePrivateKey) -> bytes:
    """Decrypt an E2EE response chunk; raises if it was not encrypted to our key."""
    raw = bytes.fromhex(ciphertext_hex)
    server_ephemeral_public = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256K1(), raw[:EPHEMERAL_PUBLIC_KEY_BYTES]
    )
    nonce = raw[EPHEMERAL_PUBLIC_KEY_BYTES:EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES]
    ciphertext = raw[EPHEMERAL_PUBLIC_KEY_BYTES + NONCE_BYTES:]

    aes_key = derive_aes_key(client_private_key, server_ephemeral_public)
    return AESGCM(aes_key).decrypt(nonce, ciphertext, None)


def stream_lines(response):
    """Yield complete lines from the response; an unterminated last line is dropped."""
    buffer = b''
    for data in response.iter_content(chunk_size=None):
        buffer += data
        *lines, buffer = buffer.split(b'\n')
        for line in lines:
            yield line.removesuffix(b'\r').decode('utf-8')


def read_encrypted_reply(response, client_private_key: ec.EllipticCurvePrivateKey) -> tuple:
    """Read the event stream and print each decrypted chunk as it arrives.

    Raises if a content chunk is not ciphertext or does not decrypt, or if the
    stream ends without a finish_reason and a `data: [DONE]` line.
    """
    # One decoder for the whole reply, because a character may span two chunks.
    reply_decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    reply = ''
    chunks = 0
    finish_reason = None

    for line in stream_lines(response):
        # Skip blank lines, comments and SSE fields other than data.
        if not line.startswith('data:'):
            continue
        data = line[6:] if line.startswith('data: ') else line[5:]

        if data == '[DONE]':
            if not finish_reason:
                raise ValueError('Stream ended without a finish_reason')
            reply += reply_decoder.decode(b'', final=True)
            return reply, chunks, finish_reason

        try:
            event = json.loads(data)
        except ValueError:
            raise ValueError('Received a stream event that is not valid JSON') from None
        if not isinstance(event, dict):
            raise ValueError('Received a stream event that is not a JSON object')
        if event.get('error'):
            raise ValueError(f'Server reported an error mid-stream: {json.dumps(event["error"])}')

        choices = event.get('choices')
        choice = as_dict(choices[0]) if isinstance(choices, list) and choices else {}
        content = as_dict(choice.get('delta')).get('content')
        if content is not None and content != '':
            if not isinstance(content, str) or not is_hex_ciphertext(content):
                raise ValueError('Received a content chunk that is not E2EE ciphertext')
            try:
                plaintext = decrypt_chunk(content, client_private_key)
            except Exception as error:
                raise ValueError(f'Could not decrypt a content chunk ({type(error).__name__})') from None
            text = reply_decoder.decode(plaintext)
            reply += text
            chunks += 1
            print(text, end='', flush=True)

        if isinstance(choice.get('finish_reason'), str) and choice['finish_reason']:
            finish_reason = choice['finish_reason']

    raise ValueError('Stream ended before data: [DONE]')


def chat_e2ee(prompt: str) -> str:
    """Send an E2EE-encrypted chat message and decrypt the response."""
    print('🔑 Generating ephemeral key pair...')
    client_private_key = ec.generate_private_key(ec.SECP256K1())
    # Uncompressed: 04 + x + y = 130 hex chars
    client_public_key_hex = public_key_bytes(client_private_key).hex()

    print('🔍 Fetching TEE attestation...')
    attestation_result = fetch_attestation(MODEL)
    print(f'✅ Attestation report passed the client-side checks '
          f'(provider: {attestation_result["tee_provider"] or "unknown"})')
    print('   The TDX quote signature, certificate chain and measurements were not verified.')

    print('🔐 Encrypting message...')
    encrypted_content = encrypt_message(prompt, attestation_result['signing_key'])

    messages = [{'role': 'user', 'content': encrypted_content}]

    print('📤 Sending encrypted request...')
    with requests.post(
        f'{BASE_URL}/chat/completions',
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json',
            'X-Venice-TEE-Client-Pub-Key': client_public_key_hex,
            'X-Venice-TEE-Model-Pub-Key': attestation_result['model_public_key'],
            'X-Venice-TEE-Signing-Algo': 'ecdsa'
        },
        json={
            'model': MODEL,
            'messages': messages,
            'stream': True,
            'max_tokens': 500,
        },
        stream=True,
        timeout=60
    ) as response:
        response.raise_for_status()

        content_type = response.headers.get('Content-Type', '')
        if content_type.split(';')[0].strip().lower() != 'text/event-stream':
            raise ValueError(f'Expected an event stream, got content type {json.dumps(content_type)}')

        print('📥 Decrypting response...\n')
        print('-' * 50)

        reply, chunks, finish_reason = read_encrypted_reply(response, client_private_key)

    print('\n' + '-' * 50)
    print(f'\n🔐 Response decrypted ({chunks} encrypted chunks, finish_reason: {json.dumps(finish_reason)})')

    return reply


def main():
    print('=' * 60)
    print('Venice AI E2EE Chat Example (protocol sketch)')
    print('=' * 60)
    print(f'Model: {MODEL}')
    print(f'API: {BASE_URL}')
    print()

    prompt = input('Enter your message (or press Enter for default): ').strip()
    if not prompt:
        prompt = 'What is end-to-end encryption and why is it important for privacy?'

    print()
    try:
        chat_e2ee(prompt)
    except Exception as error:
        print(f'\n❌ Error: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
