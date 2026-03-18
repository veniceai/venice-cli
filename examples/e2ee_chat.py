#!/usr/bin/env python3
"""
Venice AI E2EE Chat Example

Complete example of end-to-end encrypted communication with Venice AI API.
Your messages are encrypted client-side before transmission, and responses
are encrypted by the TEE before being sent back—Venice never sees plaintext.

Requirements:
    pip install cryptography ecdsa requests

Usage:
    export VENICE_API_KEY="your-api-key"
    python e2ee_chat.py
"""

import os
import json
import secrets
import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from ecdsa import SECP256k1, VerifyingKey, SigningKey

# Configuration
API_KEY = os.environ.get('VENICE_API_KEY')
BASE_URL = os.environ.get('VENICE_API_BASE_URL', 'https://api.venice.ai/api/v1')
MODEL = 'e2ee-qwen3-5-122b-a10b'  # E2EE-capable model
HKDF_INFO = b'ecdsa_encryption'

if not API_KEY:
    print('Error: VENICE_API_KEY environment variable not set')
    print('Usage: export VENICE_API_KEY="your-api-key"')
    exit(1)


def generate_key_pair():
    """Generate ephemeral secp256k1 key pair for E2EE session."""
    private_key = SigningKey.generate(curve=SECP256k1)
    public_key = private_key.get_verifying_key()
    # Uncompressed public key format: 04 || x (32 bytes) || y (32 bytes) = 65 bytes
    public_key_bytes = b'\x04' + public_key.to_string()
    return private_key, public_key_bytes.hex()


def fetch_attestation(model_id: str) -> dict:
    """Fetch and verify TEE attestation for a model."""
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
    
    # Verify attestation
    if attestation.get('verified') != True:
        raise ValueError(f"TEE attestation verification failed: {attestation}")
    
    if attestation.get('nonce') != client_nonce:
        raise ValueError('Attestation nonce mismatch - possible replay attack')
    
    # Get model's public key for encryption
    model_public_key = attestation.get('signing_key') or attestation.get('signing_public_key')
    if not model_public_key:
        raise ValueError('No signing key in attestation response')
    
    return {
        'model_public_key': model_public_key,
        'signing_address': attestation.get('signing_address'),
        'tee_provider': attestation.get('tee_provider'),
        'attestation': attestation
    }


def encrypt_message(plaintext: str, model_public_key_hex: str) -> str:
    """Encrypt a message using ECDH + HKDF + AES-256-GCM."""
    # Normalize public key (add 04 prefix if missing)
    key_hex = model_public_key_hex
    if not key_hex.startswith('04') and len(key_hex) == 128:
        key_hex = '04' + key_hex
    
    model_public_key_bytes = bytes.fromhex(key_hex)
    
    # Parse model's public key (skip 04 prefix)
    model_verifying_key = VerifyingKey.from_string(
        model_public_key_bytes[1:], 
        curve=SECP256k1
    )
    
    # Generate ephemeral key pair for this message
    ephemeral_private = SigningKey.generate(curve=SECP256k1)
    ephemeral_public = ephemeral_private.get_verifying_key()
    
    # ECDH: compute shared secret
    shared_point = model_verifying_key.pubkey.point * ephemeral_private.privkey.secret_multiplier
    shared_secret = shared_point.x().to_bytes(32, 'big')
    
    # Derive AES key using HKDF-SHA256
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=HKDF_INFO,
    )
    aes_key = hkdf.derive(shared_secret)
    
    # Generate random 12-byte nonce
    nonce = os.urandom(12)
    
    # Encrypt with AES-256-GCM
    aesgcm = AESGCM(aes_key)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode('utf-8'), None)
    
    # Format: ephemeral_public (65 bytes) + nonce (12 bytes) + ciphertext
    ephemeral_public_bytes = b'\x04' + ephemeral_public.to_string()
    result = ephemeral_public_bytes + nonce + ciphertext
    
    return result.hex()


def decrypt_chunk(ciphertext_hex: str, client_private_key: SigningKey) -> str:
    """Decrypt an E2EE response chunk."""
    raw = bytes.fromhex(ciphertext_hex)
    
    # Parse components (65 + 12 + ciphertext)
    server_ephemeral_pub = raw[:65]
    nonce = raw[65:77]
    ciphertext = raw[77:]
    
    # Parse server's ephemeral public key (skip 04 prefix)
    server_verifying_key = VerifyingKey.from_string(
        server_ephemeral_pub[1:],
        curve=SECP256k1
    )
    
    # ECDH: compute shared secret
    shared_point = server_verifying_key.pubkey.point * client_private_key.privkey.secret_multiplier
    shared_secret = shared_point.x().to_bytes(32, 'big')
    
    # Derive AES key
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=HKDF_INFO,
    )
    aes_key = hkdf.derive(shared_secret)
    
    # Decrypt
    aesgcm = AESGCM(aes_key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    
    return plaintext.decode('utf-8')


def is_hex_encrypted(s: str) -> bool:
    """Check if string looks like hex-encrypted content."""
    # Minimum: ephemeral_pub (65) + nonce (12) + tag (16) = 93 bytes = 186 hex
    if len(s) < 186:
        return False
    return all(c in '0123456789abcdefABCDEF' for c in s)


def chat_e2ee(prompt: str) -> str:
    """Send an E2EE-encrypted chat message and decrypt the response."""
    print('🔑 Generating ephemeral key pair...')
    client_private_key, client_public_key_hex = generate_key_pair()
    
    print('🔍 Fetching TEE attestation...')
    attestation_result = fetch_attestation(MODEL)
    model_public_key = attestation_result['model_public_key']
    print(f'✅ TEE attestation verified (provider: {attestation_result.get("tee_provider", "unknown")})')
    
    print('🔐 Encrypting message...')
    encrypted_content = encrypt_message(prompt, model_public_key)
    
    messages = [{'role': 'user', 'content': encrypted_content}]
    
    print('📤 Sending encrypted request...')
    response = requests.post(
        f'{BASE_URL}/chat/completions',
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json',
            'X-Venice-TEE-Client-Pub-Key': client_public_key_hex,
            'X-Venice-TEE-Model-Pub-Key': model_public_key,
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
    )
    response.raise_for_status()
    
    print('📥 Decrypting response...\n')
    print('-' * 50)
    
    full_content = ''
    for line in response.iter_lines():
        if not line:
            continue
        
        line_str = line.decode('utf-8')
        if not line_str.startswith('data: ') or '[DONE]' in line_str:
            continue
        
        try:
            chunk = json.loads(line_str[6:])
            content = chunk.get('choices', [{}])[0].get('delta', {}).get('content', '')
            
            if not content:
                continue
            
            # Decrypt if encrypted
            if is_hex_encrypted(content):
                decrypted = decrypt_chunk(content, client_private_key)
                full_content += decrypted
                print(decrypted, end='', flush=True)
            else:
                full_content += content
                print(content, end='', flush=True)
        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f'\n[Decryption error: {e}]')
    
    print('\n' + '-' * 50)
    print('\n🔐 Response decrypted end-to-end')
    
    return full_content


def main():
    print('=' * 60)
    print('Venice AI E2EE Chat Example')
    print('=' * 60)
    print(f'Model: {MODEL}')
    print(f'API: {BASE_URL}')
    print()
    
    prompt = input('Enter your message (or press Enter for default): ').strip()
    if not prompt:
        prompt = 'What is end-to-end encryption and why is it important for privacy?'
    
    print()
    chat_e2ee(prompt)


if __name__ == '__main__':
    main()
