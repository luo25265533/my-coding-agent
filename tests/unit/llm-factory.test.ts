import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config/load.js';
import { createLLMProvider } from '../../src/llm/factory.js';
import { ConfigError } from '../../src/shared/errors.js';

const fetchMock = vi.fn<typeof fetch>();

function configWith(env: NodeJS.ProcessEnv): AppConfig {
  return loadConfig({ envFilePath: null, env: { LLM_PROVIDER: 'mock', ...env } });
}

/** 绕开配置层校验，直接构造 AppConfig 以覆盖 factory 自身的兜底判断 */
function withLlm(llm: Partial<AppConfig['llm']>): AppConfig {
  const base = configWith({});
  return { ...base, llm: { ...base.llm, ...llm } };
}

const COMPLETE = {
  id: 'chatcmpl-factory',
  object: 'chat.completion',
  created: 1,
  model: 'configured-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('createLLMProvider', () => {
  it('mock provider 不需要密钥、端点与模型', async () => {
    const provider = createLLMProvider(configWith({ LLM_PROVIDER: 'mock' }));
    expect(provider.name).toBe('mock');
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('echo: hi');
  });

  it('mock provider 透传配置中的模型名', async () => {
    const provider = createLLMProvider(
      configWith({ LLM_PROVIDER: 'mock', LLM_MODEL: 'mock-named' }),
    );
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.model).toBe('mock-named');
  });

  it('openai-compatible 配齐三项后返回对应 provider', () => {
    const provider = createLLMProvider(
      configWith({
        LLM_PROVIDER: 'openai-compatible',
        LLM_API_KEY: 'placeholder-key',
        LLM_BASE_URL: 'https://api.example.com/v4',
        LLM_MODEL: 'configured-model',
      }),
    );
    expect(provider.name).toBe('openai-compatible');
  });

  it('配置层先拦截缺失字段，错误消息指向具体变量', () => {
    expect(() => configWith({ LLM_PROVIDER: 'openai-compatible' })).toThrow(ConfigError);
    expect(() => configWith({ LLM_PROVIDER: 'openai-compatible' })).toThrow(/LLM_API_KEY/);
  });

  it('程序化构造的配置缺任一必需字段时，factory 兜底抛 ConfigError', () => {
    const full = {
      provider: 'openai-compatible',
      apiKey: 'placeholder-key',
      baseUrl: 'https://api.example.com/v4',
      model: 'm',
    } as const;
    for (const field of ['apiKey', 'baseUrl', 'model'] as const) {
      const config = withLlm({ ...full, [field]: undefined });
      expect(() => createLLMProvider(config)).toThrow(ConfigError);
      expect(() => createLLMProvider(config)).toThrow(
        /requires LLM_API_KEY, LLM_BASE_URL and LLM_MODEL/,
      );
    }
  });

  it('把配置的端点与模型接到真实请求上', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(COMPLETE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = createLLMProvider(
      configWith({
        LLM_PROVIDER: 'openai-compatible',
        LLM_API_KEY: 'placeholder-key',
        LLM_BASE_URL: 'https://api.example.com/v4/',
        LLM_MODEL: 'configured-model',
      }),
    );
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.example.com/v4/chat/completions');
    const body = init?.body;
    if (typeof body !== 'string') {
      throw new Error('expected string body');
    }
    expect((JSON.parse(body) as Record<string, unknown>).model).toBe('configured-model');
  });
});
