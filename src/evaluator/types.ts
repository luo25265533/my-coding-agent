import type { Logger } from 'pino';
import type { ConfirmFn } from '../security/approval.js';
import type {
  DiffFile,
  DiffFileStatus,
  DiffSummary,
  VerificationResult,
  VerificationStatus,
} from '../shared/reports.js';

export type { DiffFile, DiffFileStatus, DiffSummary, VerificationResult, VerificationStatus };

export interface VerifyRequest {
  readonly command: string;
  readonly timeoutMs: number;
  readonly attempt: number;
  /** 相对 workspace；缺省为 workspace 根 */
  readonly cwd?: string | undefined;
}

export interface Evaluator {
  verify(request: VerifyRequest): Promise<VerificationResult>;
  diff(): Promise<DiffSummary>;
}

export interface EvaluatorOptions {
  readonly workspace: string;
  readonly signal?: AbortSignal | undefined;
  readonly confirm?: ConfirmFn | undefined;
  /** 用于子进程净化与输出脱敏；缺省 process.env */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger?: Logger | undefined;
}
