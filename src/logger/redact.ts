export const REDACT_CENSOR = '[REDACTED]';

export const REDACT_PATHS: readonly string[] = [
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'LLM_API_KEY',
  '*.LLM_API_KEY',
];
