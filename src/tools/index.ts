import { listFilesTool } from './definitions/list-files.js';
import { readFileTool } from './definitions/read-file.js';
import { searchCodeTool } from './definitions/search-code.js';
import { ToolRegistry } from './registry.js';

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(readFileTool).register(listFilesTool).register(searchCodeTool);
}

export { ToolRegistry, type RegisteredTool } from './registry.js';
export { dispatchToolCall } from './dispatch.js';
export { errorResult, okResult, type ToolErrorCode } from './result.js';
export type { RiskLevel, ToolContext, ToolDefinition, ToolResult } from './types.js';
