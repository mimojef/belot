/**
 * sanitizeOutput.ts
 *
 * Defense-in-depth проверка: сканира generated dataset/summary файлове за
 * забранени production-sensitive маркери (raw roomId/profileId/email/ip/
 * password/token/secret/session identifiers и т.н.), дори ако export
 * логиката вече не би трябвало да ги включва. При съвпадение — критична
 * находка, builder-ът трябва да излезе с non-zero exit code.
 */

import { readFile } from 'node:fs/promises'

export type SanitizationViolation = {
  file: string
  line: number
  pattern: string
  snippet: string
}

// JSON key-shaped patterns — засичат само реални ключове ("...":), не случайни
// поднизове (напр. "roomKey" не съвпада с /"roomId"\s*:/).
const FORBIDDEN_KEY_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'roomId', pattern: /"roomId"\s*:/i },
  { label: 'profileId', pattern: /"profileId"\s*:/i },
  { label: 'accountId', pattern: /"accountId"\s*:/i },
  { label: 'playerId', pattern: /"playerId"\s*:/i },
  { label: 'connectionId', pattern: /"connectionId"\s*:/i },
  { label: 'reconnectToken', pattern: /"reconnectToken"\s*:/i },
  { label: 'sessionId', pattern: /"sessionId"\s*:/i },
  { label: 'deviceId', pattern: /"deviceId"\s*:/i },
  { label: 'email', pattern: /"email"\s*:/i },
  { label: 'username', pattern: /"username"\s*:/i },
  { label: 'displayName', pattern: /"displayName"\s*:/i },
  { label: 'ip', pattern: /"ip(?:Address)?"\s*:/i },
  { label: 'password', pattern: /"password"\s*:/i },
  { label: 'token', pattern: /"(?:access|refresh|auth)?[tT]oken"\s*:/i },
  { label: 'secret', pattern: /"secret"\s*:/i },
]

const EMAIL_LIKE_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
const IPV4_LIKE_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/

export async function scanFileForForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const violations: SanitizationViolation[] = []

  lines.forEach((line, idx) => {
    for (const { label, pattern } of FORBIDDEN_KEY_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, line: idx + 1, pattern: label, snippet: line.slice(0, 200) })
      }
    }
    if (EMAIL_LIKE_PATTERN.test(line)) {
      violations.push({ file: filePath, line: idx + 1, pattern: 'email-like', snippet: line.slice(0, 200) })
    }
    if (IPV4_LIKE_PATTERN.test(line)) {
      violations.push({ file: filePath, line: idx + 1, pattern: 'ipv4-like', snippet: line.slice(0, 200) })
    }
  })

  return violations
}
