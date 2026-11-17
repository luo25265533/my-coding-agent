import { z } from 'zod';
import { LOG_LEVELS } from '../shared/types.js';

export const LLM_PROVIDERS = ['mock', 'openai-compatible'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const optionalText = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

export const mockStepSchema = z.object({
  content: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string().min(1), arguments: z.string() })).optional(),
  reasoning: z.string().optional(),
});

export const mockScriptSchema = z.array(mockStepSchema);

export type MockStep = z.infer<typeof mockStepSchema>;

function booleanFlag(defaultValue: 'true' | 'false') {
  return z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((value) => value === 'true' || value === '1');
}

export const envSchema = z
  .object({
    LLM_PROVIDER: z.enum(LLM_PROVIDERS).default('mock'),
    LLM_API_KEY: optionalText,
    LLM_BASE_URL: optionalText,
    LLM_MODEL: optionalText,
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(60_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    AGENT_WORKSPACE: z.string().min(1).default('.'),
    AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(200).default(20),
    AGENT_PLAN_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(12),
    AGENT_STEP_MAX_ITERATIONS: z.coerce.number().int().min(1).max(100).default(10),
    AGENT_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
    AGENT_MAX_REPEATED_CALLS: z.coerce.number().int().min(2).max(100).default(3),
    AGENT_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(100).default(3),
    AGENT_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().min(1000).max(200_000).default(16_000),
    AGENT_RESPECT_GITIGNORE: booleanFlag('true'),
    AGENT_IGNORE: optionalText,
    AGENT_CONFIRM_HIGH_RISK: booleanFlag('true'),
    /** 高风险命令确认等待上限；超时按拒绝处理 */
    AGENT_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
    AGENT_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    AGENT_LOG_DIR: z.string().min(1).default('.agent/logs'),
    AGENT_LOG_PRETTY: booleanFlag('true'),
    AGENT_TASK_DB: z.string().min(1).default('.agent/tasks.db'),
    AGENT_VERIFY_COMMAND: z
      .string()
      .max(1000)
      .default('pnpm test')
      .refine((value) => !value.includes('\u0000'), 'must not contain NUL'),
    AGENT_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(300_000),
    /** 默认验证命令在改动全为静态资源时跳过 */
    AGENT_VERIFY_SKIP_STATIC: booleanFlag('true'),
    AGENT_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(2),
    AGENT_REPAIR_MAX_ITERATIONS: z.coerce.number().int().min(1).max(100).default(8),
    /** 仅 mock provider 使用：脚本化响应 JSON 的路径 */
    AGENT_MOCK_SCRIPT: optionalText,
    /** 本地 Web UI 监听端口；仅允许回环地址段端口 */
    AGENT_WEB_PORT: z.coerce.number().int().min(1024).max(65_535).default(3210),
    /** 本地 Web UI 绑定地址；仅允许回环 */
    AGENT_WEB_HOST: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER !== 'mock' && env.LLM_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_API_KEY'],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
    }
    if (env.LLM_PROVIDER === 'openai-compatible' && env.LLM_BASE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_BASE_URL'],
        message: 'required when LLM_PROVIDER=openai-compatible',
      });
    }
    if (env.LLM_PROVIDER !== 'mock' && env.LLM_MODEL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_MODEL'],
        message: `required when LLM_PROVIDER=${env.LLM_PROVIDER}`,
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;
