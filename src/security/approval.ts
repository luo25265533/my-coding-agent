export interface ConfirmRequest {
  readonly kind: 'overwrite_file' | 'run_command';
  readonly risk: 'high';
  /** 一行人类可读摘要，会直接展示给用户 */
  readonly summary: string;
  /** 覆盖路径 / 命令预览等细节，已由调用方截断 */
  readonly detail?: string | undefined;
}

export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

/**
 * 未注入确认回调、回调返回 false 或回调抛错，一律视为拒绝。
 * 工具层只关心结果，不区分「没有交互能力」与「用户说不」。
 */
export async function isApproved(
  confirm: ConfirmFn | undefined,
  request: ConfirmRequest,
): Promise<boolean> {
  if (confirm === undefined) {
    return false;
  }
  try {
    return (await confirm(request)) === true;
  } catch {
    return false;
  }
}
