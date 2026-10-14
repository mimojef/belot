// Файлове на архивите на belot hand журнала: имена, листинг, lock.
//
// Един архив = една UTC дневна партида, записана ведно и проверена:
//   belot-hand-journal-YYYY-MM-DD-id<minId>-<maxId>.jsonl.zst   (нов формат)
//   belot-hand-journal-YYYY-MM-DD-id<minId>-<maxId>.jsonl.gz    (резервен)
//   belot-hand-journal-YYYY-MM-DD-<timestamp>.jsonl.gz          (стар формат)
// Диапазонът от id-та в името позволява след рестарт да се разпознаят
// редовете в SQLite, които вече са архивирани (crash между финализиране на
// архива и изтриване на редовете), без дублиране.
//   *.tmp      — незавършен архив (изтрива се при следваща поддръжка)
//   *.corrupt  — архив, неуспял проверката (карантина, не се чете)

import { hostname } from 'node:os'
import { open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type BelotJournalArchiveFileKind = 'archive' | 'tmp' | 'corrupt'

export type BelotJournalArchiveFile = {
  name: string
  path: string
  kind: BelotJournalArchiveFileKind
  day: string
  minId: number | null
  maxId: number | null
  format: 'zst' | 'gz'
  bytes: number
}

const ARCHIVE_NAME_RE =
  /^belot-hand-journal-(\d{4}-\d{2}-\d{2})-(?:id(\d+)-(\d+)|\d+)\.jsonl\.(zst|gz)(\.tmp|\.corrupt)?$/

export function buildBelotJournalArchiveName(day: string, minId: number, maxId: number, extension: '.jsonl.zst' | '.jsonl.gz'): string {
  return `belot-hand-journal-${day}-id${minId}-${maxId}${extension}`
}

export function parseBelotJournalArchiveName(name: string): Omit<BelotJournalArchiveFile, 'path' | 'bytes'> | null {
  const match = ARCHIVE_NAME_RE.exec(name)
  if (!match) return null
  const suffix = match[5]
  return {
    name,
    kind: suffix === '.tmp' ? 'tmp' : suffix === '.corrupt' ? 'corrupt' : 'archive',
    day: match[1]!,
    minId: match[2] !== undefined ? Number(match[2]) : null,
    maxId: match[3] !== undefined ? Number(match[3]) : null,
    format: match[4] as 'zst' | 'gz',
  }
}

export async function listBelotJournalArchiveFiles(archiveDirectory: string): Promise<BelotJournalArchiveFile[]> {
  let names: string[]
  try {
    names = await readdir(archiveDirectory)
  } catch {
    return []
  }
  const files: BelotJournalArchiveFile[] = []
  for (const name of names) {
    const parsed = parseBelotJournalArchiveName(name)
    if (parsed === null) continue
    try {
      const info = await stat(join(archiveDirectory, name))
      files.push({ ...parsed, path: join(archiveDirectory, name), bytes: info.size })
    } catch {
      // изчезнал между readdir и stat
    }
  }
  return files.sort((left, right) =>
    left.day === right.day ? (left.minId ?? 0) - (right.minId ?? 0) || left.name.localeCompare(right.name) : left.day.localeCompare(right.day),
  )
}

// ─── Lock срещу паралелна поддръжка (и между процеси) ──────────────────────

export const BELOT_JOURNAL_MAINTENANCE_LOCK_NAME = 'belot-hand-journal-maintenance.lock'
const STALE_LOCK_MS = 3 * 60 * 60 * 1000

type LockContent = { pid: number; host: string; acquiredAtMs: number; token: string }

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type BelotJournalMaintenanceLock = { release: () => Promise<void> }

// Атомарно създаване (O_EXCL). Заварен lock се счита за изоставен, ако е по-
// стар от 3 часа или процесът му (на същия хост) вече не съществува — напр.
// рестарт по средата на архивиране.
export async function acquireBelotJournalMaintenanceLock(
  directory: string,
  nowMs: number,
): Promise<{ acquired: true; lock: BelotJournalMaintenanceLock; tookOverStale: LockContent | null } | { acquired: false; holder: LockContent | null }> {
  const lockPath = join(directory, BELOT_JOURNAL_MAINTENANCE_LOCK_NAME)
  const content: LockContent = {
    pid: process.pid,
    host: hostname(),
    acquiredAtMs: nowMs,
    token: `${process.pid}-${nowMs}-${Math.random().toString(36).slice(2)}`,
  }
  let tookOverStale: LockContent | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify(content))
        await handle.sync()
      } finally {
        await handle.close()
      }
      return {
        acquired: true,
        tookOverStale,
        lock: {
          release: async () => {
            try {
              const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockContent
              if (current.token === content.token) await rm(lockPath, { force: true })
            } catch {
              // вече няма lock
            }
          },
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let holder: LockContent | null = null
    let lockAgeMs = 0
    try {
      lockAgeMs = Date.now() - (await stat(lockPath)).mtimeMs
      holder = JSON.parse(await readFile(lockPath, 'utf8')) as LockContent
    } catch {
      holder = null
    }
    const stale =
      // Празен/нечетим lock: друг процес може да е между open и writeFile —
      // изоставен е само ако файлът е стар.
      (holder === null && lockAgeMs > 60_000) ||
      (holder !== null && nowMs - holder.acquiredAtMs > STALE_LOCK_MS) ||
      (holder !== null && holder.host === content.host && holder.pid !== process.pid && !isProcessAlive(holder.pid))
    if (!stale || attempt > 0) return { acquired: false, holder }
    tookOverStale = holder
    await rm(lockPath, { force: true })
  }
  return { acquired: false, holder: null }
}
