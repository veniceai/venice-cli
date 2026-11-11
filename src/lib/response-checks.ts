/**
 * Shape checks for API responses that commands print or save
 */

type Fields = Record<string, unknown>;
type Check = (value: unknown) => boolean;

export function unexpectedResponse(detail: string): Error {
  return new Error(`Unexpected response from Venice: ${detail}`);
}

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString: Check = (value) => typeof value === 'string';
const isNonEmptyString: Check = (value) => typeof value === 'string' && value.length > 0;
const isNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === 'boolean';
const isArrayOf = (value: unknown, check: Check) => Array.isArray(value) && value.every(check);
const isNullable = (value: unknown, check: Check) => value === null || check(value);
const isOptional = (value: unknown, check: Check) => value === undefined || isNullable(value, check);

export function assertClonedVoice(value: unknown): void {
  if (!isObject(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.model)) {
    throw unexpectedResponse('the cloned voice has no id or model.');
  }
}

export function assertTranscription(value: unknown): void {
  if (!isObject(value) || !isString(value.text)) {
    throw unexpectedResponse('the transcription has no text.');
  }
  const { duration, timestamps } = value;
  const isSegment: Check = (segment) =>
    isObject(segment) && isString(segment.text) && isNumber(segment.start) && isNumber(segment.end);
  if (
    !isOptional(duration, isNumber) ||
    !isOptional(timestamps, isObject) ||
    (isObject(timestamps) && !isOptional(timestamps.segment, (segments) => isArrayOf(segments, isSegment)))
  ) {
    throw unexpectedResponse('the transcription timing data is malformed.');
  }
}

export function assertTtsModels(value: unknown): void {
  const isTtsModel: Check = (model) => {
    if (!isObject(model) || !isNonEmptyString(model.id)) return false;
    const spec = model.model_spec;
    return isOptional(spec, isObject) && (!isObject(spec) || (
      isOptional(spec.voices, (voices) => isArrayOf(voices, isString)) &&
      isOptional(spec.default_voice, isString)
    ));
  };
  if (!isArrayOf(value, isTtsModel)) {
    throw unexpectedResponse('the TTS model list is malformed.');
  }
}

export function assertModelNameMapping(value: unknown, label: string): void {
  if (!isObject(value) || !isObject(value.data) || !Object.values(value.data).every(isString)) {
    throw unexpectedResponse(`the ${label} is missing or malformed.`);
  }
}

export function assertEmbeddings(value: unknown): void {
  const isEmbedding: Check = (item) =>
    isObject(item) && Number.isInteger(item.index) && isArrayOf(item.embedding, isNumber);
  if (!Array.isArray(value) || value.length === 0 || !value.every(isEmbedding)) {
    throw unexpectedResponse('no embedding vectors were returned.');
  }
}

const isApiKey: Check = (key) =>
  isObject(key) &&
  isNonEmptyString(key.id) &&
  isString(key.apiKeyType) &&
  isString(key.last6Chars) &&
  isOptional(key.description, isString) &&
  isOptional(key.createdAt, isString) &&
  isOptional(key.expiresAt, isString) &&
  isOptional(key.lastUsedAt, isString);

export function assertApiKeyList(value: unknown): void {
  if (!isArrayOf(value, isApiKey)) {
    throw unexpectedResponse('the API key list is missing or malformed.');
  }
}

export function assertApiKeyDetails(value: unknown): void {
  const isUsage: Check = (usage) =>
    isObject(usage) && isOptional(usage.usd, isString) && isOptional(usage.diem, isString);
  if (
    !isApiKey(value) ||
    !isObject(value) ||
    !isOptional(value.consumptionLimits, isObject) ||
    (isObject(value.consumptionLimits) && (
      !isOptional(value.consumptionLimits.usd, isNumber) ||
      !isOptional(value.consumptionLimits.diem, isNumber)
    )) ||
    !isOptional(value.limitPeriod, isString) ||
    !isOptional(value.modelPrivacy, isString) ||
    !isOptional(value.ipAllowlist, (list) => isArrayOf(list, isString)) ||
    !isOptional(value.usage, isObject) ||
    (isObject(value.usage) && !isOptional(value.usage.trailingSevenDays, isUsage)) ||
    !isOptional(value.currentPeriodUsage, isUsage)
  ) {
    throw unexpectedResponse('the API key details are missing or malformed.');
  }
}

export function assertApiKeyRateLimitLogs(value: unknown): void {
  const isEntry: Check = (entry) =>
    isObject(entry) &&
    isString(entry.apiKeyId) &&
    isString(entry.modelId) &&
    isString(entry.rateLimitTier) &&
    isString(entry.rateLimitType) &&
    isString(entry.timestamp);
  if (!isArrayOf(value, isEntry)) {
    throw unexpectedResponse('the rate limit logs are missing or malformed.');
  }
}

export function assertApiKeyRateLimits(value: unknown): void {
  const isLimit: Check = (limit) => isObject(limit) && isString(limit.type) && isNumber(limit.amount);
  const isModelLimits: Check = (model) =>
    isObject(model) && isOptional(model.apiModelId, isString) && isArrayOf(model.rateLimits, isLimit);
  if (
    !isObject(value) ||
    !isBoolean(value.accessPermitted) ||
    !isObject(value.apiTier) ||
    !isString(value.apiTier.id) ||
    !isBoolean(value.apiTier.isCharged) ||
    !isObject(value.balances) ||
    !isOptional(value.balances.USD, isNumber) ||
    !isOptional(value.balances.DIEM, isNumber) ||
    !isOptional(value.keyExpiration, isString) ||
    !isString(value.nextEpochBegins) ||
    !isArrayOf(value.rateLimits, isModelLimits)
  ) {
    throw unexpectedResponse('the rate limits are missing or malformed.');
  }
}
