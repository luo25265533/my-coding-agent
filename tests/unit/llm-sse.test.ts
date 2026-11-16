import { describe, expect, it } from 'vitest';
import { createSseParser, SSE_DONE } from '../../src/llm/providers/openai-compatible/sse.js';

describe('createSseParser', () => {
  it('单个完整事件', () => {
    const parser = createSseParser();
    expect(parser.push('data: hello\n\n')).toEqual(['hello']);
  });

  it('一次分片内多个事件', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\n\ndata: b\n\n')).toEqual(['a', 'b']);
  });

  it('事件跨分片截断时不提前产出', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"x":')).toEqual([]);
    expect(parser.push('1}\n\n')).toEqual(['{"x":1}']);
  });

  it('逐字符喂入仍能正确重组', () => {
    const parser = createSseParser();
    const payload = 'data: {"a":1}\n\n';
    const collected: string[] = [];
    for (const char of payload) {
      collected.push(...parser.push(char));
    }
    expect(collected).toEqual(['{"a":1}']);
  });

  it('CRLF 分隔', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r\n\r\n')).toEqual(['a']);
  });

  it('单独 CR 分隔', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r\r')).toEqual(['a']);
  });

  it('末尾单独 CR 跨分片时不误判为事件结束', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual(['a']);
  });

  it('多行 data 按换行拼接', () => {
    const parser = createSseParser();
    expect(parser.push('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2']);
  });

  it('忽略注释与非 data 字段', () => {
    const parser = createSseParser();
    expect(parser.push(': keep-alive\nevent: message\nid: 7\ndata: a\n\n')).toEqual(['a']);
  });

  it('无 data 字段的事件被丢弃', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\n\n')).toEqual([]);
  });

  it('data: 后无空格也能解析', () => {
    const parser = createSseParser();
    expect(parser.push('data:a\n\n')).toEqual(['a']);
  });

  it('只去掉一个前导空格，保留后续空格', () => {
    const parser = createSseParser();
    expect(parser.push('data:  a \n\n')).toEqual([' a ']);
  });

  it('识别 [DONE] 终止符', () => {
    const parser = createSseParser();
    expect(parser.push('data: [DONE]\n\n')).toEqual([SSE_DONE]);
  });

  it('空分片不产出', () => {
    const parser = createSseParser();
    expect(parser.push('')).toEqual([]);
  });

  it('flush 取出未以空行结尾的残留', () => {
    const parser = createSseParser();
    expect(parser.push('data: tail')).toEqual([]);
    expect(parser.flush()).toEqual(['tail']);
  });

  it('flush 后缓冲清空', () => {
    const parser = createSseParser();
    parser.push('data: tail');
    parser.flush();
    expect(parser.flush()).toEqual([]);
  });

  it('连续空行不产生空事件', () => {
    const parser = createSseParser();
    expect(parser.push('\n\n\n\ndata: a\n\n')).toEqual(['a']);
  });
});
