import type { AppConfig } from '../config/load.js';
import { runCommand } from '../cli/commands/run.js';
import type { RunEventSink } from '../cli/run-events.js';
import { createTaskStore } from '../memory/index.js';
import type { TaskRecord, TaskSummary } from '../memory/types.js';
import type { ConfirmRequest } from '../security/approval.js';
import { redactSecretValues } from '../security/child-env.js';
import { describeError } from '../shared/errors.js';
import type { Logger } from 'pino';

export type SessionStatus = 'idle' | 'running' | 'awaiting_plan' | 'awaiting_confirm' | 'finished';

export interface WebEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

export interface RunRequestInput {
  readonly task: string;
  readonly yes: boolean;
  readonly noVerify: boolean;
  readonly verify: string | undefined;
}

const EVENT_BUFFER_LIMIT = 5000;

interface PendingDecision {
  resolve(approved: boolean): void;
}

export class RunSession {
  private status: SessionStatus = 'idle';
  private taskId: string | undefined;
  private errorMessage: string | undefined;
  private events: WebEvent[] = [];
  private droppedEvents = 0;
  private nextSeq = 1;
  private subscribers = new Set<(event: WebEvent) => void>();
  private pendingPlan: PendingDecision | undefined;
  private pendingConfirm: PendingDecision | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  getStatus(): SessionStatus {
    return this.status;
  }

  /** 只有 idle 或 finished（含失败）时才能发起新任务 */
  canStart(): boolean {
    return this.status === 'idle' || this.status === 'finished';
  }

  snapshot(): {
    status: SessionStatus;
    taskId: string | undefined;
    error: string | undefined;
    droppedEvents: number;
    events: readonly WebEvent[];
  } {
    return {
      status: this.status,
      taskId: this.taskId,
      error: this.errorMessage,
      droppedEvents: this.droppedEvents,
      events: [...this.events],
    };
  }

  subscribe(handler: (event: WebEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  start(input: RunRequestInput): void {
    if (!this.canStart()) {
      throw new Error('session is busy');
    }
    this.reset();
    this.started = true;
    this.setStatus('running');

    const controller = new AbortController();
    this.controller = controller;

    const sink: RunEventSink = {
      banner: (lines) => {
        this.emit('banner', { lines });
      },
      plan: (plan) => {
        this.emit('plan', plan);
        if (!input.yes) {
          this.setStatus('awaiting_plan');
        }
      },
      taskCreated: (taskIdValue) => {
        this.taskId = taskIdValue;
        this.emit('task_created', { taskId: taskIdValue });
      },
      toolCall: (call, iteration) => this.emit('tool_call', { call, iteration }),
      toolResult: (result, iteration, durationMs) =>
        this.emit('tool_result', { result, iteration, durationMs }),
      stepStart: (step, index, total) => this.emit('step_start', { step, index, total }),
      stepEnd: (result, index, total) => this.emit('step_end', { result, index, total }),
      verification: (result) => this.emit('verification', result),
      diff: (diff) => this.emit('diff', diff),
      repair: (outcome, maxAttempts) => this.emit('repair', { outcome, maxAttempts }),
      taskState: (state, taskIdValue) => this.emit('task_state', { state, taskId: taskIdValue }),
      contextTrim: (stats) => this.emit('context_trim', stats),
      answer: (content) => this.emit('answer', { content }),
    };

    const runPromise = runCommand([input.task], {
      config: this.config,
      workspace: this.config.agent.workspace,
      yes: input.yes,
      noVerify: input.noVerify,
      verify: input.verify,
      signal: controller.signal,
      sink,
      approvePlan: () => {
        return this.awaitDecision('plan').then((approved) => {
          if (approved) {
            this.setStatus('running');
          }
          return approved;
        });
      },
      confirm: (request: ConfirmRequest) => {
        this.emit('confirm_request', request);
        return this.awaitDecision('confirm').then((approved) => {
          if (approved) {
            this.setStatus('running');
          }
          return approved;
        });
      },
    });

    void runPromise.then(
      () => {
        this.setStatus('finished');
        this.emit('session_done', { taskId: this.taskId, error: undefined });
      },
      (error: unknown) => {
        this.errorMessage = redactSecretValues(describeError(error));
        this.setStatus('finished');
        this.emit('session_done', { taskId: this.taskId, error: this.errorMessage });
        this.logger.warn({ error: this.errorMessage }, 'web session run failed');
      },
    );
  }

  /** 任务尚未结束时中止当前运行；没有进行中的任务返回 false */
  abort(): boolean {
    if (!this.started || this.status === 'finished') {
      return false;
    }
    this.controller?.abort();
    // 卡在等待人工决策时，中止等价于拒绝，让 runCommand 立即结束
    if (this.pendingPlan !== undefined) {
      this.pendingPlan.resolve(false);
      this.pendingPlan = undefined;
    }
    if (this.pendingConfirm !== undefined) {
      this.pendingConfirm.resolve(false);
      this.pendingConfirm = undefined;
    }
    this.clearConfirmTimer();
    return true;
  }

  decidePlan(approved: boolean): boolean {
    return this.decide('plan', approved);
  }

  decideConfirm(approved: boolean): boolean {
    return this.decide('confirm', approved);
  }

  hasPendingPlan(): boolean {
    return this.pendingPlan !== undefined;
  }

  hasPendingConfirm(): boolean {
    return this.pendingConfirm !== undefined;
  }

  /** 每次调用新开只读 store：sql.js 是内存快照，长持有可能读到旧数据 */
  async listTasks(limit: number): Promise<readonly TaskSummary[]> {
    const store = await this.openReadOnlyStore();
    try {
      return await store.listTasks(limit);
    } finally {
      await store.close();
    }
  }

  async getTask(id: string): Promise<TaskRecord | undefined> {
    const store = await this.openReadOnlyStore();
    try {
      return await store.getTask(id);
    } finally {
      await store.close();
    }
  }

  private openReadOnlyStore() {
    return createTaskStore({
      dbPath: this.config.agent.taskDb,
      workspace: this.config.agent.workspace,
      readOnly: true,
    });
  }

  private awaitDecision(kind: 'plan' | 'confirm'): Promise<boolean> {
    this.setStatus(kind === 'plan' ? 'awaiting_plan' : 'awaiting_confirm');
    return new Promise<boolean>((resolve) => {
      if (kind === 'plan') {
        this.pendingPlan = { resolve };
        return;
      }
      const timeoutMs = this.config.agent.confirmTimeoutMs;
      this.pendingConfirm = { resolve };
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = undefined;
        if (this.pendingConfirm === undefined) {
          return;
        }
        this.pendingConfirm = undefined;
        this.emit('confirm_timeout', { timeoutMs });
        this.setStatus('running');
        resolve(false);
      }, timeoutMs);
      this.confirmTimer.unref?.();
    });
  }

  private decide(kind: 'plan' | 'confirm', approved: boolean): boolean {
    const pending = kind === 'plan' ? this.pendingPlan : this.pendingConfirm;
    if (pending === undefined) {
      return false;
    }
    if (kind === 'plan') {
      this.pendingPlan = undefined;
    } else {
      this.pendingConfirm = undefined;
      this.clearConfirmTimer();
    }
    pending.resolve(approved);
    return true;
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== undefined) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = undefined;
    }
  }

  private reset(): void {
    this.taskId = undefined;
    this.errorMessage = undefined;
    this.events = [];
    this.droppedEvents = 0;
    this.nextSeq = 1;
    this.pendingPlan = undefined;
    this.pendingConfirm = undefined;
    this.clearConfirmTimer();
    this.controller = undefined;
    this.started = false;
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.emit('session_status', { status });
  }

  private emit(type: string, data: unknown): void {
    const event: WebEvent = { seq: this.nextSeq, type, data };
    this.nextSeq += 1;
    this.events.push(event);
    if (this.events.length > EVENT_BUFFER_LIMIT) {
      /* v8 ignore next 3 -- 需要单任务 5000+ 事件，真实回放代价过高 */
      this.events.shift();
      this.droppedEvents += 1;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.logger.warn({ error }, 'sse subscriber threw');
      }
    }
  }
}
