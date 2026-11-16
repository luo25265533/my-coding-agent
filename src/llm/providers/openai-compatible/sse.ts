export interface SseParser {
  /** 喂入任意分片，返回本次凑齐的完整事件 data 载荷 */
  push(text: string): string[];
  /** 流结束时取出残留缓冲 */
  flush(): string[];
}

export const SSE_DONE = '[DONE]';

export function createSseParser(): SseParser {
  let buffer = '';

  return {
    push(text: string): string[] {
      buffer += text;
      // 仅当末尾 \r 可能是跨分片 \r\n 的前半时才扣留；
      // 若其前已是换行，事件边界已确定，扣留只会白白延迟产出
      let trailingCr = '';
      if (buffer.endsWith('\r') && !/[\r\n]\r$/.test(buffer)) {
        trailingCr = '\r';
        buffer = buffer.slice(0, -1);
      }
      const blocks = normalize(buffer).split('\n\n');
      buffer = (blocks.pop() ?? '') + trailingCr;
      return blocks.map(extractData).filter((data): data is string => data !== undefined);
    },
    flush(): string[] {
      const rest = normalize(buffer);
      buffer = '';
      const data = extractData(rest);
      return data === undefined ? [] : [data];
    },
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractData(block: string): string | undefined {
  const payload: string[] = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const value = line.slice('data:'.length);
    payload.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return payload.length === 0 ? undefined : payload.join('\n');
}
