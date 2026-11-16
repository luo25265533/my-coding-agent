import type { Logger } from 'pino';
import type { ZodType } from 'zod';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ToolContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
}

export interface ToolResult {
  readonly ok: boolean;
  /** 回传给模型的文本；失败时是可读的错误说明，便于模型自我纠正 */
  readonly content: string;
  readonly truncated?: boolean | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export interface ToolDefinition<P> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ZodType<P>;
  readonly riskLevel: RiskLevel;
  execute(params: P, ctx: ToolContext): Promise<ToolResult>;
}
