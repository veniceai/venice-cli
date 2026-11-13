/**
 * Warnings Venice attaches to API responses, collected over one command so each is shown once: in a warnings
 * field when a JSON result carries them, or else on stderr after the command.
 */

export type ResponseWarning = { type: 'deprecated_model'; model?: string; replacement?: string; message: string };

const warnings = new Map<string, ResponseWarning>();
let delivered = false;

export function noteResponseWarnings(headers: Headers, model?: string): void {
  if (headers.get('x-venice-deprecated') !== 'true') return;
  const replacement = headers.get('x-venice-deprecated-replacement') || undefined;
  const message = `${model ?? 'The requested model'} is deprecated${replacement ? `; switch to ${replacement}` : ''}.`;
  warnings.set(message, {
    type: 'deprecated_model',
    ...(model ? { model } : {}),
    ...(replacement ? { replacement } : {}),
    message,
  });
}

/** The warnings field for a JSON result, which counts as showing them. Empty when Venice sent none. */
export function warningsField(): { warnings?: ResponseWarning[] } {
  if (warnings.size === 0) return {};
  delivered = true;
  return { warnings: [...warnings.values()] };
}

/** Warnings no JSON result has carried yet. */
export function undeliveredWarnings(): ResponseWarning[] {
  return delivered ? [] : [...warnings.values()];
}

export function modelOfRequestBody(body: unknown): string | undefined {
  const model = body && typeof body === 'object' ? (body as Record<string, unknown>).model : undefined;
  return typeof model === 'string' ? model : undefined;
}
