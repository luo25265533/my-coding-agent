/**
 * 极简 glob 编译器：支持 `*`、`?`、`**`，大小写不敏感。
 * 不含 `/` 的模式匹配任意层级下的文件名；含 `/` 的模式从工作区根锚定。
 */
export function compileGlob(glob: string): (relativePath: string) => boolean {
  const normalized = glob.replace(/\\/g, '/');
  let source = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === undefined) {
      break;
    }
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  const prefix = normalized.includes('/') ? '' : '(?:.*/)?';
  const matcher = new RegExp(`^${prefix}${source}$`, 'i');
  return (relativePath) => matcher.test(relativePath);
}
