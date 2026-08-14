import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelFilters } from './models.js';
import type { Model } from '../types/index.js';

const models: Model[] = [
  {
    id: 'kimi-k2-5',
    type: 'text',
    model_spec: { capabilities: { privacy: true } },
  },
  {
    id: 'e2ee-qwen3-5-122b-a10b',
    type: 'text',
    model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
  },
  {
    id: 'tee-qwen3-5-122b-a10b',
    type: 'text',
    model_spec: { capabilities: { supportsTeeAttestation: true } },
  },
  {
    id: 'flux-2-pro',
    type: 'image',
  },
];

test('applyModelFilters --tee lists only TEE-attestable models', () => {
  const filtered = applyModelFilters(models, { tee: true });
  assert.deepEqual(filtered.map((m) => m.id), [
    'e2ee-qwen3-5-122b-a10b',
    'tee-qwen3-5-122b-a10b',
  ]);
});

test('applyModelFilters --e2ee lists only E2EE-capable models', () => {
  const filtered = applyModelFilters(models, { e2ee: true });
  assert.deepEqual(filtered.map((m) => m.id), ['e2ee-qwen3-5-122b-a10b']);
});
