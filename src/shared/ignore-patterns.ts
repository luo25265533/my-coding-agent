/** 把 `AGENT_IGNORE` 的逗号/换行文本解析为规则列表。 */
export function parseIgnorePatterns(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}
