export const AGENT_STOP_REASONS = [
  'answer',
  'empty_answer',
  'output_truncated',
  'repeated_tool_call',
  'tool_failure_limit',
  'max_iterations',
] as const;

export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];
