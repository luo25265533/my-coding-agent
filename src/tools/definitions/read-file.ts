import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertNotSensitive, resolveInsideWorkspace } from '../../security/path-guard.js';
import { throwIfAborted } from '../../shared/abort.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';
import { looksBinary } from '../../security/walk.js';

const MAX_LINES = 400;
const MAX_BYTES = 256 * 1024;

export const readFileParameters = z.object({
  path: z.string().min(1).describe('File path, relative to the workspace'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First line to return (1-based). Use it to page through long files'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINES)
    .optional()
    .describe(`Maximum number of lines (default and max: ${MAX_LINES})`),
});

export type ReadFileParams = z.infer<typeof readFileParameters>;

export const readFileTool: ToolDefinition<ReadFileParams> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace and return numbered lines. Use offset/limit to page through large files.',
  parameters: readFileParameters,
  riskLevel: 'low',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);
    const absolutePath = resolveInsideWorkspace(ctx.workspace, params.path);
    assertNotSensitive(absolutePath);

    const info = await stat(absolutePath).catch(() => undefined);
    if (info === undefined) {
      return errorResult('TOOL_FAILED', `file not found: ${params.path}`);
    }
    if (info.isDirectory()) {
      return errorResult('TOOL_FAILED', `path is a directory: ${params.path}; use list_files`);
    }
    if (!info.isFile()) {
      return errorResult('TOOL_FAILED', `not a regular file: ${params.path}`);
    }
    if (info.size > MAX_BYTES) {
      return errorResult(
        'TOOL_FAILED',
        `file is too large (${info.size} bytes > ${MAX_BYTES}); use search_code to locate the relevant part`,
      );
    }

    const buffer = await readFile(absolutePath);
    if (looksBinary(buffer)) {
      return errorResult('TOOL_FAILED', `refusing to read binary file: ${params.path}`);
    }

    const text = buffer.toString('utf8');
    if (text === '') {
      return okResult('(empty file)');
    }

    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    const offset = params.offset ?? 1;
    const limit = params.limit ?? MAX_LINES;
    const start = offset - 1;
    if (start >= lines.length) {
      return errorResult(
        'TOOL_FAILED',
        `offset ${offset} is beyond end of file (${lines.length} lines)`,
      );
    }

    const selected = lines.slice(start, start + limit);
    const width = String(start + selected.length).length;
    const body = selected
      .map((line, index) => `${String(start + index + 1).padStart(width)} | ${line}`)
      .join('\n');

    const remaining = lines.length - (start + selected.length);
    if (remaining > 0) {
      const nextOffset = start + selected.length + 1;
      return okResult(
        `${body}\n... (truncated: ${remaining} more lines; continue with offset=${nextOffset})`,
        { truncated: true, meta: { totalLines: lines.length } },
      );
    }
    return okResult(body, { meta: { totalLines: lines.length } });
  },
};
