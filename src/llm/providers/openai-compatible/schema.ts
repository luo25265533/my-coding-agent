import { z } from 'zod';

const tokenDetailsSchema = z.object({
  cached_tokens: z.number().int().nonnegative().optional(),
  reasoning_tokens: z.number().int().nonnegative().optional(),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: tokenDetailsSchema.nullish(),
  completion_tokens_details: tokenDetailsSchema.nullish(),
});

export const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const messageSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullish(),
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(toolCallSchema).nullish(),
});

const choiceSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  finish_reason: z.string().nullish(),
  message: messageSchema,
});

export const chatCompletionSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(choiceSchema).min(1),
  usage: usageSchema.nullish(),
});

/** 流式分片允许字段缺失：name/arguments 会被切成多段累积 */
export const deltaToolCallSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().nullish(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.string().nullish(),
      arguments: z.string().nullish(),
    })
    .nullish(),
});

const deltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullish(),
  reasoning_content: z.string().nullish(),
  tool_calls: z.array(deltaToolCallSchema).nullish(),
});

const chunkChoiceSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  finish_reason: z.string().nullish(),
  delta: deltaSchema.nullish(),
});

export const chatCompletionChunkSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(chunkChoiceSchema).optional(),
  usage: usageSchema.nullish(),
});

/** 智谱 code 为字符串（实测 "1113"/"400"），OpenAI 可能为 null，故兼容 string|number|null */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).nullish(),
    message: z.string().nullish(),
    type: z.string().nullish(),
  }),
});

export type ChatCompletion = z.infer<typeof chatCompletionSchema>;
export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
