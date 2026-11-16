const SENSITIVE_EXACT_NAMES = new Set([
  '.npmrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
]);
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12'];
const SENSITIVE_PREFIXES = ['id_rsa', 'id_ed25519'];

/** Windows 语义：文件名大小写不敏感。`.env.example` 是模板文件，不含真实密钥 */
export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env.example') {
    return false;
  }
  if (lower === '.env' || lower.startsWith('.env.')) {
    return true;
  }
  if (SENSITIVE_EXACT_NAMES.has(lower)) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  return SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
