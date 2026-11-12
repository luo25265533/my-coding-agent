import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AgentError, ErrorCode } from './errors.js';

const packageInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export type PackageInfo = z.infer<typeof packageInfoSchema>;

export function readPackageInfo(): PackageInfo {
  // src/shared/ 与 dist/shared/ 同为两层深度，该相对路径在开发与构建产物下都指向仓库根
  const url = new URL('../../package.json', import.meta.url);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    throw new AgentError(ErrorCode.Internal, `Failed to read package.json (${url.href})`, {
      cause: error,
    });
  }

  const parsed = packageInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError(ErrorCode.Internal, 'package.json must contain name and version', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
