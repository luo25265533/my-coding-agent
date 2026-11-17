import path from 'node:path';
import { collectDiff } from './diff.js';
import type { Evaluator, EvaluatorOptions } from './types.js';
import { verifyCommand } from './verify.js';

export { collectDiff, diffSince, isStaticOnlyDiff, type CollectDiffOptions } from './diff.js';
export { verifyCommand, type VerifyCommandOptions } from './verify.js';
export type {
  DiffFile,
  DiffFileStatus,
  DiffSummary,
  Evaluator,
  EvaluatorOptions,
  VerificationResult,
  VerificationStatus,
  VerifyRequest,
} from './types.js';

export function createEvaluator(options: EvaluatorOptions): Evaluator {
  const workspace = path.resolve(options.workspace);
  return {
    verify: (request) =>
      verifyCommand({
        workspace,
        request,
        confirm: options.confirm,
        signal: options.signal,
        env: options.env,
        logger: options.logger,
      }),
    diff: () =>
      collectDiff({
        workspace,
        signal: options.signal,
        env: options.env,
      }),
  };
}
