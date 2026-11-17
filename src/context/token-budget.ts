import type { ChatMessage } from '../llm/types.js';

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 8;

/**
 * 保守的 token 估算：CJK 字符按 1 token，其余字符按 0.25 token（4 字符/token）。
 * 仅用于预算控制，不保证与供应商计费一致。
 */
export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  let tokens = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    tokens += isCjk(codePoint) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content);
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        total +=
          TOOL_CALL_OVERHEAD_TOKENS + estimateTokens(call.name) + estimateTokens(call.arguments);
      }
    }
  }
  return total;
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  );
}
