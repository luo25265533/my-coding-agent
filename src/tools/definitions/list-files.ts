import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertNotSensitive, resolveInsideWorkspace } from '../../security/path-guard.js';
import { throwIfAborted } from '../../shared/abort.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';
import { walkEntries, type WalkEntry } from '../walk.js';

export const listFilesParameters = z.object({
  path: z.string().min(1).default('.').describe('Directory to list, relative to the workspace'),
  recursive: z.boolean().optional().default(true).describe('Recurse into subdirectories'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(2)
    .describe('Directory depth when recursive (1 = direct children only)'),
  maxEntries: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(200)
    .describe('Maximum entries to return'),
});

export type ListFilesParams = z.infer<typeof listFilesParameters>;

export const listFilesTool: ToolDefinition<ListFilesParams> = {
  name: 'list_files',
  description:
    'List files and directories under a workspace path. Ignores node_modules, .git, dist, coverage and .agent, and never lists secret files.',
  parameters: listFilesParameters,
  riskLevel: 'low',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);
    const absoluteStart = resolveInsideWorkspace(ctx.workspace, params.path);
    assertNotSensitive(absoluteStart);

    const info = await stat(absoluteStart).catch(() => undefined);
    if (info === undefined) {
      return errorResult('TOOL_FAILED', `path not found: ${params.path}`);
    }
    if (!info.isDirectory()) {
      return errorResult(
        'TOOL_FAILED',
        `not a directory: ${params.path}; use read_file to inspect files`,
      );
    }

    const maxDepth = params.recursive ? params.maxDepth : 1;
    const entries: WalkEntry[] = [];
    let truncated = false;

    for await (const entry of walkEntries({
      workspace: ctx.workspace,
      start: absoluteStart,
      maxDepth,
      includeDirs: true,
      signal: ctx.signal,
    })) {
      if (entries.length >= params.maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }

    if (entries.length === 0) {
      return okResult('(empty directory)');
    }

    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const body = entries
      .map((entry) => {
        const pathText = entry.type === 'dir' ? `${entry.relativePath}/` : entry.relativePath;
        return `${entry.type.padEnd(4)} ${String(entry.size).padStart(7)}  ${pathText}`;
      })
      .join('\n');

    if (truncated) {
      return okResult(
        `${body}\n... (truncated at ${params.maxEntries} entries; narrow the path or raise maxEntries)`,
        { truncated: true, meta: { entries: entries.length } },
      );
    }
    return okResult(body, { meta: { entries: entries.length } });
  },
};
