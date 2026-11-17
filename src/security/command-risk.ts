export type CommandVerdict =
  | { readonly level: 'deny'; readonly reason: string }
  | { readonly level: 'high'; readonly reason: string }
  | { readonly level: 'normal' };

interface Rule {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** 硬拒绝：不询问、不接受任何绕过，包括 --yes */
const DENY_RULES: readonly Rule[] = [
  { pattern: /\bgit\b[^\n;|&]*\bpush\b/i, reason: 'git push is never allowed' },
  { pattern: /\bsudo\b/i, reason: 'sudo is not allowed' },
  { pattern: /\bshutdown\b/i, reason: 'shutdown is destructive' },
  { pattern: /\breboot\b/i, reason: 'reboot is destructive' },
  { pattern: /\bdiskpart\b/i, reason: 'diskpart can destroy disks' },
  { pattern: /\bmkfs(?:\.\w+)?\b/i, reason: 'mkfs can destroy disks' },
  { pattern: /(?:^|[;&|]\s*)format(?:\.com)?(?:\s|$)/i, reason: 'format can destroy disks' },
  {
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+){1,3}(?:\/|~|\$HOME)(?:\s|$|\*)/i,
    reason: 'refusing to delete a root or home path',
  },
  {
    pattern: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+(?:"?[a-zA-Z]:[\\/]"?|\\|\/)(?:\s|$)/i,
    reason: 'refusing to delete a drive root',
  },
];

/** 高风险：必须经用户确认 */
const HIGH_RULES: readonly Rule[] = [
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\b|--recursive\b|--force\b)/i,
    reason: 'recursive or forced delete',
  },
  { pattern: /\b(?:del|erase)\b[^\n]*\/[fsq]/i, reason: 'forced delete' },
  { pattern: /\b(?:rmdir|rd)\b[^\n]*\/s/i, reason: 'recursive directory delete' },
  { pattern: /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i, reason: 'recursive or forced delete' },
  { pattern: /\bgit\s+reset\b[^\n]*--hard\b/i, reason: 'git reset --hard discards changes' },
  {
    pattern: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*[fdx]/i,
    reason: 'git clean deletes untracked files',
  },
  {
    pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?(?:\.|\*)/i,
    reason: 'git checkout/restore . discards changes',
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|cargo|gem)\s+publish\b|\btwine\s+upload\b/i,
    reason: 'publishing is externally visible',
  },
  { pattern: /\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd)\b/i, reason: 'piping into a shell' },
  { pattern: /\b(?:chmod|chown|icacls|takeown)\b/i, reason: 'changes permissions or ownership' },
  {
    pattern: /\b(?:kill|pkill|killall|taskkill|Stop-Process)\b/i,
    reason: 'terminates processes',
  },
  {
    pattern: /(?:^|[\s"'=/\\])\.env(?!\.example)(?:[.\s"'/\\]|$)/i,
    reason: 'references a secret file (.env)',
  },
  {
    pattern: /\b(?:id_rsa|id_ed25519|credentials)\b|\.pem\b|\.ssh\b|\.npmrc\b|\.git-credentials\b/i,
    reason: 'references a secret file',
  },
  { pattern: /\bdd\s+if=/i, reason: 'dd can overwrite devices' },
];

export function classifyCommand(command: string): CommandVerdict {
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(command)) {
      return { level: 'deny', reason: rule.reason };
    }
  }
  for (const rule of HIGH_RULES) {
    if (rule.pattern.test(command)) {
      return { level: 'high', reason: rule.reason };
    }
  }
  return { level: 'normal' };
}
