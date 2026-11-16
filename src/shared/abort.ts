import { AgentError, ErrorCode } from './errors.js';

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AgentError(ErrorCode.LlmAborted, 'operation aborted');
  }
}
