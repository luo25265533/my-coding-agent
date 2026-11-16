import type { Logger } from 'pino';
import type { AppConfig } from '../config/load.js';
import { ConfigError } from '../shared/errors.js';
import { createMockProvider } from './providers/mock.js';
import { createOpenAiCompatibleProvider } from './providers/openai-compatible/client.js';
import type { LLMProvider } from './types.js';

export interface CreateProviderOptions {
  readonly logger?: Logger | undefined;
}

export function createLLMProvider(
  config: AppConfig,
  options: CreateProviderOptions = {},
): LLMProvider {
  if (config.llm.provider === 'mock') {
    return createMockProvider({
      model: config.llm.model,
      script: config.agent.mockScript,
    });
  }

  const { apiKey, baseUrl, model, timeoutMs, maxRetries } = config.llm;
  if (apiKey === undefined || baseUrl === undefined || model === undefined) {
    throw new ConfigError(
      'openai-compatible provider requires LLM_API_KEY, LLM_BASE_URL and LLM_MODEL',
    );
  }

  return createOpenAiCompatibleProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    maxRetries,
    logger: options.logger,
  });
}
