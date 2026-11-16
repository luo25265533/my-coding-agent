import { z } from 'zod';
import type { JsonSchemaObject, ToolSpec } from '../llm/types.js';
import { AgentError, ErrorCode } from '../shared/errors.js';
import { errorResult } from './result.js';
import type { RiskLevel, ToolContext, ToolDefinition, ToolResult } from './types.js';

export interface RegisteredTool {
  readonly name: string;
  readonly riskLevel: RiskLevel;
  readonly spec: ToolSpec;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  get size(): number {
    return this.#tools.size;
  }

  register<P>(definition: ToolDefinition<P>): this {
    if (this.#tools.has(definition.name)) {
      throw new AgentError(ErrorCode.Internal, `tool already registered: ${definition.name}`);
    }

    let parameters: JsonSchemaObject;
    try {
      // 注册期生成 schema：参数不可表达时在启动阶段暴露，而不是等到模型调用
      parameters = z.toJSONSchema(definition.parameters);
    } catch (error) {
      throw new AgentError(
        ErrorCode.Internal,
        `tool ${definition.name} has an unsupported parameter schema`,
        { cause: error },
      );
    }

    this.#tools.set(definition.name, {
      name: definition.name,
      riskLevel: definition.riskLevel,
      spec: { name: definition.name, description: definition.description, parameters },
      run: async (input, ctx) => {
        const parsed = definition.parameters.safeParse(input);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          return errorResult('TOOL_INVALID_ARGS', detail);
        }
        return definition.execute(parsed.data, ctx);
      },
    });
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  names(): readonly string[] {
    return [...this.#tools.keys()];
  }

  specs(): readonly ToolSpec[] {
    return [...this.#tools.values()].map((tool) => tool.spec);
  }
}
