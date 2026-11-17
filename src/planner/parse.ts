import path from 'node:path';
import { z } from 'zod';
import type { ZodError } from 'zod';
import { assertNotSensitive, resolveForWrite } from '../security/path-guard.js';
import { describeError } from '../shared/errors.js';
import type { PlanStep, TaskPlan } from './types.js';

export const MAX_PLAN_BYTES = 20 * 1024;

export interface ParsePlanOptions {
  readonly workspace: string;
  readonly maxSteps: number;
}

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanParseError';
  }
}

const stepSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value).trim()),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  files: z.array(z.string().trim().min(1).max(512)).max(20).optional().default([]),
});

function planSchema(maxSteps: number) {
  return z.object({
    goal: z.string().trim().min(1).max(500),
    steps: z.array(stepSchema).min(1).max(maxSteps),
    notes: z.string().trim().max(2000).nullable().optional(),
  });
}

export function parseTaskPlan(raw: string, options: ParsePlanOptions): TaskPlan {
  if (Buffer.byteLength(raw, 'utf8') > MAX_PLAN_BYTES) {
    throw new PlanParseError(`plan is too large (> ${MAX_PLAN_BYTES} bytes)`);
  }

  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new PlanParseError(`plan is not valid JSON: ${describeError(error)}`);
  }

  const result = planSchema(options.maxSteps).safeParse(parsed);
  if (!result.success) {
    throw new PlanParseError(formatIssues(result.error));
  }

  const steps = result.data.steps.map((step, index) => normalizeStep(step, index, options));
  validateStepIds(steps);

  const notes = result.data.notes;
  return {
    goal: result.data.goal,
    steps,
    notes: notes === null || notes === undefined || notes === '' ? undefined : notes,
  };
}

function normalizeStep(
  step: z.infer<typeof stepSchema>,
  index: number,
  options: ParsePlanOptions,
): PlanStep {
  if (step.id === '') {
    throw new PlanParseError(`steps.${index}.id: must not be empty`);
  }
  if (step.id.length > 32) {
    throw new PlanParseError(`steps.${index}.id: must be at most 32 characters`);
  }
  for (const file of step.files) {
    validatePlanPath(options.workspace, file, step.id);
  }
  return {
    id: step.id,
    title: step.title,
    description: step.description,
    files: step.files,
  };
}

function validateStepIds(steps: readonly PlanStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new PlanParseError(`duplicate step id: ${step.id}`);
    }
    seen.add(step.id);
  }
}

function validatePlanPath(workspace: string, file: string, stepId: string): void {
  if (path.isAbsolute(file)) {
    throw new PlanParseError(`step ${stepId}: file path must be relative: ${file}`);
  }
  if (file.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) {
    throw new PlanParseError(`step ${stepId}: refusing to plan writes inside .git: ${file}`);
  }
  try {
    assertNotSensitive(resolveForWrite(workspace, file));
  } catch (error) {
    throw new PlanParseError(`step ${stepId}: ${describeError(error)}`);
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new PlanParseError('plan response was empty');
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new PlanParseError('plan response did not contain a JSON object');
  }
  return candidate.slice(start, end + 1);
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}
