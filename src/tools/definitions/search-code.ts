import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertNotSensitive, resolveInsideWorkspace } from '../../security/path-guard.js';
import { looksBinary, walkEntries } from '../../security/walk.js';
import { throwIfAborted } from '../../shared/abort.js';
import { describeError } from '../../shared/errors.js';
import { compileGlob } from '../glob.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 20;
const MAX_LINE_LENGTH = 300;

export const searchCodeParameters = z.object({
  pattern: z.string().min(1).max(256).describe('Regular expression to search for'),
  path: z
    .string()
    .min(1)
    .default('.')
    .describe('File or directory to search, relative to the workspace'),
  glob: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Only search files whose path matches this glob, e.g. "*.ts" or "src/**/*.ts"'),
  caseSensitive: z.boolean().optional().default(false).describe('Match case-sensitively'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe('Maximum matches to return'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .default(0)
    .describe('Lines of context before and after each match'),
});

export type SearchCodeParams = z.infer<typeof searchCodeParameters>;

export const searchCodeTool: ToolDefinition<SearchCodeParams> = {
  name: 'search_code',
  description:
    'Search workspace files line by line with a regular expression. Skips secret files, binary files and files larger than 1 MB. Returns "path:line: text"; context rows (contextLines > 0) use "path-line- text".',
  parameters: searchCodeParameters,
  riskLevel: 'low',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);

    let regex: RegExp;
    try {
      regex = new RegExp(params.pattern, params.caseSensitive ? '' : 'i');
    } catch (error) {
      return errorResult(
        'TOOL_INVALID_ARGS',
        `invalid regular expression: ${describeError(error)}`,
      );
    }

    const absoluteStart = resolveInsideWorkspace(ctx.workspace, params.path);
    assertNotSensitive(absoluteStart);
    const info = await stat(absoluteStart).catch(() => undefined);
    if (info === undefined) {
      return errorResult('TOOL_FAILED', `path not found: ${params.path}`);
    }

    const matcher = params.glob === undefined ? undefined : compileGlob(params.glob);
    const matches: string[] = [];
    let matchCount = 0;
    let filesScanned = 0;
    let truncated = false;

    scan: for await (const entry of walkEntries({
      workspace: ctx.workspace,
      start: absoluteStart,
      maxDepth: MAX_DEPTH,
      ignore: ctx.ignore,
      signal: ctx.signal,
    })) {
      if (entry.type !== 'file' || entry.size > MAX_FILE_BYTES) {
        continue;
      }
      if (matcher !== undefined && !matcher(entry.relativePath)) {
        continue;
      }
      throwIfAborted(ctx.signal);

      const buffer = await readFile(entry.absolutePath).catch(() => undefined);
      if (buffer === undefined || looksBinary(buffer)) {
        continue;
      }
      filesScanned += 1;

      const lines = buffer.toString('utf8').split(/\r?\n/);
      let lastEmittedLine = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || !regex.test(line)) {
          continue;
        }
        if (matchCount >= params.maxResults) {
          truncated = true;
          break scan;
        }
        matchCount += 1;

        const matchLine = index + 1;
        if (params.contextLines === 0) {
          matches.push(formatLine(entry.relativePath, matchLine, 'match', line));
          continue;
        }

        const start = Math.max(1, matchLine - params.contextLines);
        const end = Math.min(lines.length, matchLine + params.contextLines);
        for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
          if (lineNumber !== matchLine && lineNumber <= lastEmittedLine) {
            continue;
          }
          const text = lines[lineNumber - 1];
          if (text === undefined) {
            continue;
          }
          matches.push(
            formatLine(
              entry.relativePath,
              lineNumber,
              lineNumber === matchLine ? 'match' : 'context',
              text,
            ),
          );
        }
        lastEmittedLine = end;
      }
    }

    if (matches.length === 0) {
      return okResult(`no matches for /${params.pattern}/`, { meta: { filesScanned } });
    }

    const body = matches.join('\n');
    if (truncated) {
      return okResult(
        `${body}\n... (truncated at ${params.maxResults} matches; narrow the pattern or path)`,
        { truncated: true, meta: { filesScanned, matches: matchCount } },
      );
    }
    return okResult(body, { meta: { filesScanned, matches: matchCount } });
  },
};

function formatLine(
  relativePath: string,
  lineNumber: number,
  kind: 'match' | 'context',
  line: string,
): string {
  const text = line.trim();
  const clipped = text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;
  const separator = kind === 'match' ? ':' : '-';
  return `${relativePath}${separator}${lineNumber}${separator} ${clipped}`;
}
