const PASSTHROUGH = ['PATH', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP'] as const;

export function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}
