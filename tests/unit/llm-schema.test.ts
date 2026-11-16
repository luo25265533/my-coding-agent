import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  chatCompletionChunkSchema,
  chatCompletionSchema,
} from '../../src/llm/providers/openai-compatible/schema.js';

describe('chatCompletionSchema', () => {
  it('接受智谱实测响应体（含 reasoning_content 与 usage 明细）', () => {
    const parsed = chatCompletionSchema.safeParse({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: '42', reasoning_content: 'thinking...', role: 'assistant' },
        },
      ],
      model: 'glm-5.3',
      usage: {
        prompt_tokens: 51,
        completion_tokens: 17,
        total_tokens: 68,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 14 },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('剥离未知字段', () => {
    const parsed = chatCompletionSchema.parse({
      choices: [{ message: { content: 'x' } }],
      unexpected_field: 'ignored',
    });
    expect(parsed).not.toHaveProperty('unexpected_field');
  });

  it('content 为 null 时通过（工具调用场景）', () => {
    expect(
      chatCompletionSchema.safeParse({ choices: [{ message: { content: null } }] }).success,
    ).toBe(true);
  });

  it('缺 usage 时通过', () => {
    expect(
      chatCompletionSchema.safeParse({ choices: [{ message: { content: 'x' } }] }).success,
    ).toBe(true);
  });

  it('choices 为空数组时拒绝', () => {
    expect(chatCompletionSchema.safeParse({ choices: [] }).success).toBe(false);
  });

  it('缺 choices 时拒绝', () => {
    expect(chatCompletionSchema.safeParse({ model: 'glm-5.3' }).success).toBe(false);
  });

  it('message 缺失时拒绝', () => {
    expect(chatCompletionSchema.safeParse({ choices: [{ index: 0 }] }).success).toBe(false);
  });

  it('usage 字段类型错误时拒绝', () => {
    expect(
      chatCompletionSchema.safeParse({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 'many' },
      }).success,
    ).toBe(false);
  });
});

describe('chatCompletionChunkSchema', () => {
  it('接受 reasoning_content 增量', () => {
    const parsed = chatCompletionChunkSchema.safeParse({
      object: 'chat.completion.chunk',
      model: 'glm-5.3',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'The' } }],
    });
    expect(parsed.success).toBe(true);
  });

  it('接受末块（finish_reason + usage，delta.content 为空串）', () => {
    const parsed = chatCompletionChunkSchema.safeParse({
      choices: [{ index: 0, finish_reason: 'stop', delta: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
    });
    expect(parsed.success).toBe(true);
  });

  it('choices 缺失或为空时通过（部分供应商会发心跳块）', () => {
    expect(chatCompletionChunkSchema.safeParse({}).success).toBe(true);
    expect(chatCompletionChunkSchema.safeParse({ choices: [] }).success).toBe(true);
  });

  it('delta 为 null 时通过', () => {
    expect(chatCompletionChunkSchema.safeParse({ choices: [{ delta: null }] }).success).toBe(true);
  });
});

describe('apiErrorSchema', () => {
  it('接受智谱字符串 code（实测 1113）', () => {
    const parsed = apiErrorSchema.parse({
      error: { code: '1113', message: '余额不足或无可用资源包,请充值。' },
    });
    expect(parsed.error.code).toBe('1113');
  });

  it('接受数字 code', () => {
    expect(apiErrorSchema.parse({ error: { code: 429 } }).error.code).toBe(429);
  });

  it('接受 null code（OpenAI 风格）', () => {
    expect(apiErrorSchema.parse({ error: { code: null, message: 'x' } }).error.code).toBeNull();
  });

  it('缺 error 字段时拒绝', () => {
    expect(apiErrorSchema.safeParse({ message: 'x' }).success).toBe(false);
  });
});
