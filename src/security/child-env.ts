const SECRET_ENV = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const REDACTED = '[REDACTED]';
/** 过短的值可能是普通单词，全局替换会破坏文本 */
const MIN_REDACT_LENGTH = 4;

/** 子进程环境净化：删除密钥类变量，避免模型通过 env 读取密钥 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_ENV.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

/** 把当前环境中密钥类变量的值从文本中移除，用于验证输出落库/回显前的脱敏 */
export function redactSecretValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (
      SECRET_ENV.test(key) &&
      typeof value === 'string' &&
      value.length >= MIN_REDACT_LENGTH &&
      value !== REDACTED
    ) {
      values.add(value);
    }
  }

  let redacted = text;
  for (const value of [...values].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}
