import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isApproved } from '../../security/approval.js';
import { assertNotSensitive, resolveForWrite } from '../../security/path-guard.js';
import { toRelativePath } from '../../security/walk.js';
import { throwIfAborted } from '../../shared/abort.js';
import { errorResult, okResult } from '../result.js';
import { atomicWriteFile } from '../../shared/atomic-write.js';
import type { ToolDefinition } from '../types.js';

const MAX_BYTES = 256 * 1024;

export const writeFileParameters = z.object({
  path: z.string().min(1).max(512).describe('File path, relative to the workspace'),
  content: z.string().max(MAX_BYTES).describe('Complete file content (UTF-8)'),
});

export type WriteFileParams = z.infer<typeof writeFileParameters>;

export const writeFileTool: ToolDefinition<WriteFileParams> = {
  name: 'write_file',
  description:
    'Write a complete UTF-8 file inside the workspace. Creates parent directories. Overwriting a non-empty file requires user confirmation.',
  parameters: writeFileParameters,
  riskLevel: 'high',
  async execute(params, ctx) {
    throwIfAborted(ctx.signal);

    const bytes = Buffer.byteLength(params.content, 'utf8');
    if (bytes > MAX_BYTES) {
      return errorResult(
        'TOOL_FAILED',
        `content is too large (${bytes} bytes > ${MAX_BYTES}); split the change or use edit_file`,
      );
    }

    const absolutePath = resolveForWrite(ctx.workspace, params.path);
    assertNotSensitive(absolutePath);
    const relativePath = toRelativePath(ctx.workspace, absolutePath);

    const info = await stat(absolutePath).catch(() => undefined);
    if (info !== undefined && info.isDirectory()) {
      return errorResult('TOOL_FAILED', `path is a directory: ${params.path}`);
    }
    if (info !== undefined && !info.isFile()) {
      return errorResult('TOOL_FAILED', `not a regular file: ${params.path}`);
    }

    if (info !== undefined && info.size > 0) {
      const approved = await isApproved(ctx.confirm, {
        kind: 'overwrite_file',
        risk: 'high',
        summary: `overwrite existing file ${relativePath} (${info.size} bytes)`,
        detail: relativePath,
      });
      if (!approved) {
        return errorResult('TOOL_DENIED', `overwrite denied: ${params.path}`);
      }
    }

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await atomicWriteFile(absolutePath, params.content);

    return okResult(`wrote ${relativePath} (${bytes} bytes)`, {
      meta: {
        created: info === undefined,
        overwritten: info !== undefined,
        bytes,
      },
    });
  },
};
