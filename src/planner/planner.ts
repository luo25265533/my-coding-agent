import type { Logger } from 'pino';
import { buildRepoMap } from '../context/repo-map.js';
import type { ChatMessage, LLMProvider } from '../llm/types.js';
import { addUsage, EMPTY_USAGE } from '../llm/types.js';
import type { IgnoreMatcher } from '../security/ignore.js';
import { throwIfAborted } from '../shared/abort.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { parseTaskPlan, PlanParseError } from './parse.js';
import { buildPlanSystemPrompt, REPAIR_PROMPT } from './prompt.js';
import type { Planner, PlanResult } from './types.js';

const REPO_MAP_RATIO = 0.25;
const MIN_REPO_MAP_TOKENS = 400;
const MAX_REPO_MAP_TOKENS = 2000;
const MAX_ATTEMPTS = 2;

export interface CreatePlannerOptions {
  readonly provider: LLMProvider;
  readonly workspace: string;
  readonly ignore: IgnoreMatcher;
  readonly contextBudgetTokens: number;
  readonly maxSteps: number;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
}

export function createPlanner(options: CreatePlannerOptions): Planner {
  return {
    async plan(task: string): Promise<PlanResult> {
      throwIfAborted(options.signal);

      const repoMapBudget = Math.min(
        MAX_REPO_MAP_TOKENS,
        Math.max(MIN_REPO_MAP_TOKENS, Math.floor(options.contextBudgetTokens * REPO_MAP_RATIO)),
      );
      const repoMap = await buildRepoMap({
        workspace: options.workspace,
        budgetTokens: repoMapBudget,
        ignore: options.ignore,
        signal: options.signal,
        logger: options.logger,
      });

      const system = [buildPlanSystemPrompt(options.maxSteps), repoMap.text]
        .filter((part) => part !== '')
        .join('\n\n');
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: task },
      ];

      let usage = EMPTY_USAGE;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(options.signal);
        const response = await options.provider.chat({
          messages,
          signal: options.signal,
        });
        usage = addUsage(usage, response.usage);

        try {
          const plan = parseTaskPlan(response.content, {
            workspace: options.workspace,
            maxSteps: options.maxSteps,
          });
          options.logger?.info(
            {
              attempt,
              steps: plan.steps.length,
              repoMapTokens: repoMap.estimatedTokens,
            },
            'plan parsed',
          );
          return {
            plan,
            usage,
            attempts: attempt,
            repoMapTokens: repoMap.estimatedTokens,
          };
        } catch (error) {
          if (!(error instanceof PlanParseError)) {
            throw error;
          }
          lastError = error.message;
          options.logger?.warn({ attempt, reason: lastError }, 'plan validation failed');
          if (attempt < MAX_ATTEMPTS) {
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content: REPAIR_PROMPT.replace('{ERROR}', lastError),
            });
          }
        }
      }

      throw new AgentError(
        ErrorCode.PlannerInvalid,
        `planner failed to produce a valid plan after ${MAX_ATTEMPTS} attempts: ${lastError}`,
      );
    },
  };
}
