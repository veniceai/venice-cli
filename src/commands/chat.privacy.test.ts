import assert from 'node:assert/strict';
import test from 'node:test';
import { modelIdImpliesPrivateMode, modelIdRequiresE2EE, resolveChatPrivacyMode } from './chat.js';
import { isE2EEModel } from '../types/index.js';
import type { Model } from '../types/index.js';

const e2eeModel: Model = {
  id: 'e2ee-qwen3-5-122b-a10b',
  type: 'text',
  model_spec: { capabilities: { supportsE2EE: true, supportsTeeAttestation: true } },
};

const plainModel: Model = {
  id: 'kimi-k2-5',
  type: 'text',
};

test('modelIdImpliesPrivateMode detects E2EE/TEE ids without a catalog', () => {
  assert.equal(modelIdImpliesPrivateMode('e2ee-qwen3-5-122b-a10b'), true);
  assert.equal(modelIdImpliesPrivateMode('tee-qwen3-5-122b-a10b'), true);
  assert.equal(modelIdImpliesPrivateMode('kimi-k2-5'), false);
});

test('catalog failure + E2EE model id fails closed', () => {
  const result = resolveChatPrivacyMode({
    modelId: 'e2ee-qwen3-5-122b-a10b',
    catalogFailed: true,
  });
  assert.equal(result.useE2EE, false);
  assert.match(result.error || '', /refusing to send this request in the clear/);
});

test('catalog failure + --e2ee fails closed', () => {
  const result = resolveChatPrivacyMode({
    modelId: 'unknown-model',
    catalogFailed: true,
    e2eeFlag: true,
  });
  assert.match(result.error || '', /refusing to send this request in the clear/);
});

test('catalog failure + plain model continues without encryption', () => {
  const result = resolveChatPrivacyMode({
    modelId: 'kimi-k2-5',
    catalogFailed: true,
  });
  assert.deepEqual(result, { useE2EE: false, useTEE: false });
});

test('known E2EE model auto-enables encryption', () => {
  const result = resolveChatPrivacyMode({
    modelId: e2eeModel.id,
    modelInfo: e2eeModel,
    catalogFailed: false,
  });
  assert.deepEqual(result, { useE2EE: true, useTEE: false });
});

for (const modelInfo of [
  {
    id: 'e2ee-missing-capabilities',
    type: 'text',
  },
  {
    id: 'e2ee-false-capabilities',
    type: 'text',
    model_spec: {
      capabilities: { supportsE2EE: false, supportsTeeAttestation: false },
    },
  },
  {
    id: 'tee-missing-capabilities',
    type: 'text',
  },
  {
    id: 'tee-false-capabilities',
    type: 'text',
    model_spec: {
      capabilities: { supportsE2EE: false, supportsTeeAttestation: false },
    },
  },
] satisfies Model[]) {
  test(`${modelInfo.id} fails closed when catalog confirms no private capability`, () => {
    const result = resolveChatPrivacyMode({
      modelId: modelInfo.id,
      modelInfo,
      catalogFailed: false,
    });

    assert.equal(result.useE2EE, false);
    assert.equal(result.useTEE, false);
    assert.match(result.error || '', /refusing to send this request in the clear/);
  });
}

test('--no-e2ee uses TEE for a model with confirmed private capabilities', () => {
  const result = resolveChatPrivacyMode({
    modelId: e2eeModel.id,
    modelInfo: e2eeModel,
    catalogFailed: false,
    e2eeFlag: false,
  });
  assert.equal(result.useE2EE, false);
  assert.equal(result.useTEE, true);
  assert.match(result.notice || '', /end-to-end encryption is off/);
});

test('plain model is unchanged when the catalog is available', () => {
  const result = resolveChatPrivacyMode({
    modelId: plainModel.id,
    modelInfo: plainModel,
    catalogFailed: false,
  });
  assert.deepEqual(result, { useE2EE: false, useTEE: false });
});

test('--no-e2ee leaves a normal plain model in plaintext mode', () => {
  const result = resolveChatPrivacyMode({
    modelId: plainModel.id,
    modelInfo: plainModel,
    catalogFailed: false,
    e2eeFlag: false,
  });
  assert.deepEqual(result, { useE2EE: false, useTEE: false });
});

const teeOnlyModel: Model = {
  id: 'tee-qwen3-5-122b-a10b',
  type: 'text',
  model_spec: { capabilities: { supportsTeeAttestation: true } },
};

const e2eeOnlyModel: Model = {
  id: 'private-model',
  type: 'text',
  model_spec: { capabilities: { supportsE2EE: true } },
};

const plainCapabilityError = /refusing to send this request in the clear/;

test('modelIdRequiresE2EE matches any id containing e2ee, case-insensitively', () => {
  assert.equal(modelIdRequiresE2EE('e2ee-qwen3-5-122b-a10b'), true);
  assert.equal(modelIdRequiresE2EE('qwen-E2EE-preview'), true);
  assert.equal(modelIdRequiresE2EE('tee-qwen3-5-122b-a10b'), false);
});

test('isE2EEModel relies on the capability, not the catalog type', () => {
  assert.equal(isE2EEModel({ ...e2eeModel, type: 'asr' }), true);
  assert.equal(isE2EEModel({ ...e2eeModel, type: undefined }), true);
  assert.equal(isE2EEModel({ id: 'x', type: 'text', model_spec: { capabilities: { supportsE2EE: false } } }), false);
});

test('a private model id absent from a reachable catalog fails closed', () => {
  for (const modelId of ['e2ee-not-listed', 'tee-not-listed', 'model-tee']) {
    const result = resolveChatPrivacyMode({ modelId, catalogFailed: false });
    assert.equal(result.useE2EE, false, modelId);
    assert.equal(result.useTEE, false, modelId);
    assert.match(result.error || '', plainCapabilityError, modelId);
  }
});

test('--e2ee on a model absent from the catalog fails closed', () => {
  const result = resolveChatPrivacyMode({ modelId: 'unlisted-model', catalogFailed: false, e2eeFlag: true });
  assert.match(result.error || '', plainCapabilityError);
});

test('a plain model absent from the catalog stays in plaintext mode', () => {
  assert.deepEqual(
    resolveChatPrivacyMode({ modelId: 'unlisted-model', catalogFailed: false }),
    { useE2EE: false, useTEE: false }
  );
});

test('--e2ee on a model without the E2EE capability is refused', () => {
  for (const modelInfo of [plainModel, teeOnlyModel]) {
    const result = resolveChatPrivacyMode({ modelId: modelInfo.id, modelInfo, catalogFailed: false, e2eeFlag: true });
    assert.equal(result.useE2EE, false, modelInfo.id);
    assert.equal(result.useTEE, false, modelInfo.id);
    assert.match(result.error || '', /does not support E2EE encryption/, modelInfo.id);
  }
});

test('--e2ee on an E2EE model enables encryption', () => {
  for (const modelInfo of [e2eeModel, e2eeOnlyModel]) {
    assert.deepEqual(
      resolveChatPrivacyMode({ modelId: modelInfo.id, modelInfo, catalogFailed: false, e2eeFlag: true }),
      { useE2EE: true, useTEE: false },
      modelInfo.id
    );
  }
});

test('an e2ee model id whose catalog entry advertises only TEE is refused, not downgraded', () => {
  const result = resolveChatPrivacyMode({
    modelId: e2eeModel.id,
    modelInfo: { ...teeOnlyModel, id: e2eeModel.id },
    catalogFailed: false,
  });
  assert.equal(result.useE2EE, false);
  assert.equal(result.useTEE, false);
  assert.match(result.error || '', /does not support E2EE encryption/);
});

test('an e2ee model id keeps E2EE when the catalog types it as something other than text', () => {
  for (const type of ['asr', 'chat', undefined]) {
    assert.deepEqual(
      resolveChatPrivacyMode({ modelId: e2eeModel.id, modelInfo: { ...e2eeModel, type }, catalogFailed: false }),
      { useE2EE: true, useTEE: false },
      String(type)
    );
  }
});

test('a TEE-only model uses TEE mode', () => {
  for (const modelInfo of [teeOnlyModel, { ...teeOnlyModel, id: 'qwen3-5-122b-a10b' }]) {
    assert.deepEqual(
      resolveChatPrivacyMode({ modelId: modelInfo.id, modelInfo, catalogFailed: false }),
      { useE2EE: false, useTEE: true },
      modelInfo.id
    );
  }
});

test('--no-e2ee on a TEE-only model uses TEE mode without a downgrade notice', () => {
  assert.deepEqual(
    resolveChatPrivacyMode({ modelId: teeOnlyModel.id, modelInfo: teeOnlyModel, catalogFailed: false, e2eeFlag: false }),
    { useE2EE: false, useTEE: true }
  );
});

test('--no-e2ee on an E2EE-only model still attests in TEE mode and announces the downgrade', () => {
  const result = resolveChatPrivacyMode({
    modelId: e2eeOnlyModel.id,
    modelInfo: e2eeOnlyModel,
    catalogFailed: false,
    e2eeFlag: false,
  });
  assert.equal(result.useE2EE, false);
  assert.equal(result.useTEE, true);
  assert.match(result.notice || '', /--no-e2ee: end-to-end encryption is off/);
});

test('--no-e2ee on an e2ee model id with TEE-only capabilities announces the downgrade', () => {
  const result = resolveChatPrivacyMode({
    modelId: e2eeModel.id,
    modelInfo: { ...teeOnlyModel, id: e2eeModel.id },
    catalogFailed: false,
    e2eeFlag: false,
  });
  assert.equal(result.useE2EE, false);
  assert.equal(result.useTEE, true);
  assert.match(result.notice || '', /end-to-end encryption is off/);
});

test('an E2EE-capable model without a private id auto-enables encryption', () => {
  assert.deepEqual(
    resolveChatPrivacyMode({ modelId: e2eeOnlyModel.id, modelInfo: e2eeOnlyModel, catalogFailed: false }),
    { useE2EE: true, useTEE: false }
  );
});
