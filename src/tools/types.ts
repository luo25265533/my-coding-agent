import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import type { ConfirmFn } from '../security/approval.js';
import type { IgnoreMatcher } from '../security/ignore.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ToolContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly logger?: Logger | undefined;
  /** 遍历类工具共享的忽略规则；缺省时只用内置默认目录 */
  readonly ignore?: IgnoreMatcher | undefined;
  /** 高风险动作审批；缺省视为拒绝 */
  readonly confirm?: ConfirmFn | undefined;
  /** run_command 默认超时；缺省用工具内置默认值 */
  readonly commandTimeoutMs?: number | undefined;
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
