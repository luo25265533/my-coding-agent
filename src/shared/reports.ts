import type { AgentStopReason } from './agent-stop.js';
import type { TokenUsage } from './token-usage.js';

export type VerificationStatus = 'passed' | 'failed' | 'skipped';

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly command: string;
  readonly attempt: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** 已截断、已脱敏 */
  readonly output: string;
  readonly reason: string | undefined;
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'other';

export interface DiffFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface DiffSummary {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly files: readonly DiffFile[];
  readonly totalInsertions: number;
  readonly totalDeletions: number;
  readonly truncated: boolean;
}

export interface RepairRecord {
  readonly answer: string;
  readonly stopReason: AgentStopReason;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: TokenUsage;
}
