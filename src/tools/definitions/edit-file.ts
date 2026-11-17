import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { assertNotSensitive, resolveForWrite } from '../../security/path-guard.js';
import { looksBinary, toRelativePath } from '../../security/walk.js';
import { throwIfAborted } from '../../shared/abort.js';
import { atomicWriteFile } from '../../shared/atomic-write.js';
import { errorResult, okResult } from '../result.js';
import type { ToolDefinition } from '../types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OLD_CHARS = 20 * 1024;
const MAX_NEW_CHARS = 256 * 1024;

export const editFileParameters = z.object({
  path: z.string().min(1).max(512).describe('Existing text file, relative to the workspace'),
  old_string: z
    .string()
    .min(1)
    .max(MAX_OLD_CHARS)
    .describe('Exact text to replace; must match uniquely unless replaceAll is true'),
  new_string: z.string().max(MAX_NEW_CHARS).describe('Replacement text; may be empty'),
  replaceAll: z
    .boolean()
    .optional()
    .default(false)
    .describe('Replace every occurrence instead of requiring a unique match'),
});

export type EditFileParams = z.infer<typeof editFileParameters>;

export const editFileTool: ToolDefinition<EditFileParams> = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing workspace text file. Fails when old_string is missing or matches multiple locations without replaceAll. Writes atomically.',
  parameters: editFileParameters,
  riskLevel: 'high',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);

    const absolutePath = resolveForWrite(ctx.workspace, params.path);
    assertNotSensitive(absolutePath);
    const relativePath = toRelativePath(ctx.workspace, absolutePath);

    const info = await stat(absolutePath).catch(() => undefined);
    if (info === undefined) {
      return errorResult('TOOL_FAILED', `file not found: ${params.path}`);
    }
    if (!info.isFile()) {
      return errorResult('TOOL_FAILED', `not a regular file: ${params.path}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      return errorResult(
        'TOOL_FAILED',
        `file is too large to edit (${info.size} bytes > ${MAX_FILE_BYTES})`,
      );
    }

    const buffer = await readFile(absolutePath);
    if (looksBinary(buffer)) {
      return errorResult('TOOL_FAILED', `refusing to edit binary file: ${params.path}`);
    }

    const text = buffer.toString('utf8');
    const matches = countOccurrences(text, params.old_string);
    if (matches === 0) {
      return errorResult('TOOL_FAILED', `old_string not found in ${relativePath}`);
    }
    if (matches > 1 && !params.replaceAll) {
      return errorResult(
        'TOOL_FAILED',
        `old_string matches ${matches} locations in ${relativePath}; provide more context or set replaceAll=true`,
      );
    }

    const updated =
      matches === 1
        ? replaceOnce(text, params.old_string, params.new_string)
        : text.split(params.old_string).join(params.new_string);
    if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) {
      return errorResult(
        'TOOL_FAILED',
        `edited file would exceed ${MAX_FILE_BYTES} bytes; split the change`,
      );
    }

    throwIfAborted(ctx.signal);
    await atomicWriteFile(absolutePath, updated);

    return okResult(`edited ${relativePath} (${matches} replacement(s))`, {
      meta: { replacements: matches, bytes: Buffer.byteLength(updated, 'utf8') },
    });
  },
};

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceOnce(text: string, oldText: string, newText: string): string {
  const index = text.indexOf(oldText);
  return text.slice(0, index) + newText + text.slice(index + oldText.length);
}
