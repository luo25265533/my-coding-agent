import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertNotSensitive, resolveInsideWorkspace } from '../../security/path-guard.js';
import { toRelativePath, walkEntries } from '../../security/walk.js';
import { throwIfAborted } from '../../shared/abort.js';
import { compileGlob } from '../glob.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';

const MAX_DEPTH = 20;

export const findFilesParameters = z.object({
  glob: z
    .string()
    .min(1)
    .max(128)
    .describe('Case-insensitive glob on the relative path, e.g. "*.ts" or "src/**/*.ts"'),
  path: z.string().min(1).default('.').describe('Directory to search, relative to the workspace'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe('Maximum files to return'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .optional()
    .default(MAX_DEPTH)
    .describe('Maximum directory depth to traverse'),
});

export type FindFilesParams = z.infer<typeof findFilesParameters>;

export const findFilesTool: ToolDefinition<FindFilesParams> = {
  name: 'find_files',
  description:
    'Find files by a case-insensitive glob on the relative path. Honors ignore rules and never lists secret files. Returns "path (size bytes)".',
  parameters: findFilesParameters,
  riskLevel: 'low',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);
    const absoluteStart = resolveInsideWorkspace(ctx.workspace, params.path);
    assertNotSensitive(absoluteStart);

    const info = await stat(absoluteStart).catch(() => undefined);
    if (info === undefined) {
      return errorResult('TOOL_FAILED', `path not found: ${params.path}`);
    }

    const matcher = compileGlob(params.glob);
    const matches: string[] = [];
    let filesScanned = 0;
    let truncated = false;

    if (info.isFile()) {
      const relativePath = toRelativePath(ctx.workspace, absoluteStart);
      if (matcher(relativePath)) {
        matches.push(`${relativePath}  (${info.size} bytes)`);
      }
      filesScanned = 1;
    } else {
      if (!info.isDirectory()) {
        return errorResult('TOOL_FAILED', `not a directory: ${params.path}`);
      }
      scan: for await (const entry of walkEntries({
        workspace: ctx.workspace,
        start: absoluteStart,
        maxDepth: params.maxDepth,
        ignore: ctx.ignore,
        signal: ctx.signal,
      })) {
        filesScanned += 1;
        if (!matcher(entry.relativePath)) {
          continue;
        }
        if (matches.length >= params.maxResults) {
          truncated = true;
          break scan;
        }
        matches.push(`${entry.relativePath}  (${entry.size} bytes)`);
      }
    }

    if (matches.length === 0) {
      return okResult(`no files match ${params.glob}`, { meta: { filesScanned } });
    }

    matches.sort((left, right) => left.localeCompare(right));
    const body = matches.join('\n');
    if (truncated) {
      return okResult(
        `${body}\n... (truncated at ${params.maxResults} files; narrow the glob, path or maxDepth)`,
        { truncated: true, meta: { filesScanned, matches: matches.length } },
      );
    }
    return okResult(body, { meta: { filesScanned, matches: matches.length } });
  },
};
