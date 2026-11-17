import { editFileTool } from './definitions/edit-file.js';
import { findFilesTool } from './definitions/find-files.js';
import { listFilesTool } from './definitions/list-files.js';
import { readFileTool } from './definitions/read-file.js';
import { runCommandTool } from './definitions/run-command.js';
import { searchCodeTool } from './definitions/search-code.js';
import { writeFileTool } from './definitions/write-file.js';
import { ToolRegistry } from './registry.js';

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(listFilesTool)
    .register(searchCodeTool)
    .register(findFilesTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(runCommandTool);
}

export { ToolRegistry, type RegisteredTool } from './registry.js';
export { dispatchToolCall } from './dispatch.js';
export { errorResult, okResult, type ToolErrorCode } from './result.js';
export type { RiskLevel, ToolContext, ToolDefinition, ToolResult } from './types.js';
