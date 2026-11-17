import { describe, expect, it } from 'vitest';
import { estimateMessagesTokens, estimateTokens } from '../../src/context/token-budget.js';
import type { ChatMessage } from '../../src/llm/types.js';

describe('estimateTokens', () => {
  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('ASCII 按约 4 字符/token 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('CJK 字符按 1 token/字', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('代码库理解')).toBe(5);
  });

  it('中英混合累加后向上取整', () => {
    expect(estimateTokens('abc你好')).toBe(3);
  });

  it('长度增加时估算单调不减', () => {
    const short = estimateTokens('const value = 1;');
    const long = estimateTokens('const value = 1;'.repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});

describe('estimateMessagesTokens', () => {
  it('包含每条消息的固定开销', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'abcd' },
      { role: 'user', content: 'abcd' },
    ];
    expect(estimateMessagesTokens(messages)).toBe(10);
  });

  it('assistant 的工具调用参数计入估算', () => {
    const plain: ChatMessage[] = [{ role: 'assistant', content: '' }];
    const withCall: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"note.txt"}' }],
      },
    ];
    expect(estimateMessagesTokens(withCall)).toBeGreaterThan(estimateMessagesTokens(plain));
  });
});
