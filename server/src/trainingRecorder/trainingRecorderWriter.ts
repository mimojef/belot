import {
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { TrainingRecorderConfig } from './trainingRecorderConfig.js'
import type { MutableTrainingRecorderMetrics } from './trainingRecorderMetrics.js'

// ─── Active / closed file naming ──────────────────────────────────────────────
//
// While a file is being written it carries an `.active.jsonl` suffix. This
// makes it unambiguous — to this process AND to every other PM2 process
// sharing the same storage directory — that the file is still open and must
// never be touched by cleanup/retention/rotation logic. On rotation or
// graceful shutdown the file is renamed to the plain `.jsonl` suffix, which
// is the only state cleanup logic is allowed to consider for deletion.

const ACTIVE_SUFFIX = '.active.jsonl'
const CLOSED_SUFFIX = '.jsonl'
const RECORDER_FILE_BASE_PATTERN = /^process-[A-Za-z0-9_-]+-worker-[A-Za-z0-9_-]+-part-\d{4}$/

function isActiveFileName(name: string): boolean {
  return (
    name.endsWith(ACTIVE_SUFFIX) &&
    RECORDER_FILE_BASE_PATTERN.test(name.slice(0, -ACTIVE_SUFFIX.length))
  )
}

function isClosedFileName(name: string): boolean {
  return (
    name.endsWith(CLOSED_SUFFIX) &&
    !name.endsWith(ACTIVE_SUFFIX) &&
    RECORDER_FILE_BASE_PATTERN.test(name.slice(0, -CLOSED_SUFFIX.length))
  )
}

function activePathFor(basePath: string): string {
  return `${basePath}${ACTIVE_SUFFIX}`
}

function closedPathFor(basePath: string): string {
  return `${basePath}${CLOSED_SUFFIX}`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function localDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildBaseFilePath(config: TrainingRecorderConfig, datePart: string, part: number): string {
  const dir = join(config.storagePath, datePart)
  const partStr = String(part).padStart(4, '0')
  const name = `process-${config.processId}-worker-${config.workerId}-part-${partStr}`
  return join(dir, name)
}

// ─── Disk size helpers ────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function getFileSizeBytes(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath)
    return s.size
  } catch {
    return 0
  }
}

async function getDirectorySizeBytes(dirPath: string): Promise<number> {
  let total = 0

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const s = await stat(join(dirPath, entry.name))
          total += s.size
        } catch {
          // ignore
        }
      } else if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(join(dirPath, entry.name))
      }
    }
  } catch {
    // directory may not exist yet
  }

  return total
}

// ─── Retention: delete files older than N days ────────────────────────────────
//
// Active files (any process) are never deleted, and a date directory is only
// removed once it is completely empty.

async function purgeOldDateDirs(
  storagePath: string,
  retentionDays: number,
): Promise<void> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffStr = cutoffDate.toISOString().slice(0, 10)

  try {
    const entries = await readdir(storagePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Directory names are ISO date strings YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < cutoffStr) {
        const dirPath = join(storagePath, entry.name)
        try {
          const files = await readdir(dirPath)
          for (const f of files) {
            if (!isClosedFileName(f)) continue
            try {
              await unlink(join(dirPath, f))
            } catch {
              // best effort
            }
          }
          const remaining = await readdir(dirPath)
          if (remaining.length === 0) {
            const { rmdir } = await import('node:fs/promises')
            await rmdir(dirPath)
          }
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // best effort
  }
}

// ─── Total size enforcement: delete oldest closed files ───────────────────────
//
// Only ever considers *.jsonl files that are NOT *.active.jsonl — an active
// file belonging to this process or any other PM2 process is always safe.

async function enforceMaxTotalSize(
  storagePath: string,
  maxTotalBytes: number,
): Promise<boolean> {
  let totalBytes = await getDirectorySizeBytes(storagePath)

  if (totalBytes <= maxTotalBytes) {
    return true
  }

  const closedFiles: Array<{ path: string; mtime: number }> = []

  try {
    const dateDirs = await readdir(storagePath, { withFileTypes: true })
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory()) continue
      const dateDir2 = join(storagePath, dateDir.name)
      const files = await readdir(dateDir2, { withFileTypes: true })
      for (const f of files) {
        if (!f.isFile() || !isClosedFileName(f.name)) continue
        const fullPath = join(dateDir2, f.name)
        try {
          const s = await stat(fullPath)
          closedFiles.push({ path: fullPath, mtime: s.mtimeMs })
        } catch {
          // skip
        }
      }
    }
  } catch {
    return false
  }

  closedFiles.sort((a, b) => a.mtime - b.mtime)

  for (const f of closedFiles) {
    if (totalBytes <= maxTotalBytes) break
    try {
      const s = await stat(f.path)
      await unlink(f.path)
      totalBytes -= s.size
    } catch {
      // best effort
    }
  }

  return totalBytes <= maxTotalBytes
}

// ─── Writer state ─────────────────────────────────────────────────────────────

export type TrainingRecorderWriter = {
  write(line: string): Promise<void>
  getCurrentFilePath(): string | null
  shutdown(timeoutMs: number): Promise<void>
}

export function createTrainingRecorderWriter(
  config: TrainingRecorderConfig,
  metrics: MutableTrainingRecorderMetrics,
): TrainingRecorderWriter {
  const maxFileBytes = config.maxFileMb * 1024 * 1024
  const maxTotalBytes = config.maxTotalGb * 1024 * 1024 * 1024

  let currentActiveFilePath: string | null = null
  let currentDatePart: string = ''
  let currentPart: number = 1
  let currentFileBytes: number = 0
  let lastCleanupAt: number = 0
  let shutdownRequested = false

  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

  async function ensureDirectory(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  // Finalizes an in-progress file so cleanup/retention logic on this or any
  // other process may consider it. Fail-open: if rename fails (e.g. locked
  // by antivirus), the file simply stays *.active.jsonl until the next
  // rotation/shutdown attempt — it is never left in a data-loss state, and
  // is never auto-deleted while active.
  async function finalizeActiveFile(activePath: string): Promise<void> {
    const closedPath = closedPathFor(activePath.slice(0, -ACTIVE_SUFFIX.length))
    try {
      if (!(await fileExists(activePath))) {
        return
      }
      await rename(activePath, closedPath)
    } catch (error) {
      console.warn(
        `[training-recorder] Failed to finalize active file (left as .active.jsonl, will retry later): ${activePath}`,
        error,
      )
    }
  }

  async function openNewBaseFile(): Promise<string> {
    const datePart = localDateString()

    if (datePart !== currentDatePart) {
      currentDatePart = datePart
      currentPart = 1
    }

    const basePath = buildBaseFilePath(config, datePart, currentPart)
    await ensureDirectory(dirname(basePath))

    // If either the active or the closed variant already exists (e.g. after
    // a restart, or another process/part is using this slot), bump the part
    // number rather than reusing/overwriting it.
    if ((await fileExists(activePathFor(basePath))) || (await fileExists(closedPathFor(basePath)))) {
      currentPart += 1
      return openNewBaseFile()
    }

    return basePath
  }

  async function rotateIfNeeded(): Promise<void> {
    const datePart = localDateString()
    const needsDateRotation = datePart !== currentDatePart
    const needsSizeRotation = currentFileBytes >= maxFileBytes

    if (currentActiveFilePath === null || needsDateRotation || needsSizeRotation) {
      if (currentActiveFilePath !== null) {
        await finalizeActiveFile(currentActiveFilePath)
      }

      if (needsDateRotation && currentDatePart !== '') {
        currentPart = 1
      } else if (needsSizeRotation && currentActiveFilePath !== null) {
        currentPart += 1
      }

      const basePath = await openNewBaseFile()
      currentActiveFilePath = activePathFor(basePath)
      currentFileBytes = await getFileSizeBytes(currentActiveFilePath)
    }
  }

  async function runPeriodicCleanup(): Promise<void> {
    const now = Date.now()
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
    lastCleanupAt = now

    await purgeOldDateDirs(config.storagePath, config.retentionDays)

    const ok = await enforceMaxTotalSize(config.storagePath, maxTotalBytes)
    if (!ok) {
      console.warn(
        '[training-recorder] Could not free enough disk space — recorder paused.',
      )
      metrics.healthy = false
      metrics.lastErrorAt = Date.now()
    }

    try {
      const total = await getDirectorySizeBytes(config.storagePath)
      metrics.totalDirectoryBytes = total
    } catch {
      // best effort
    }
  }

  async function write(line: string): Promise<void> {
    if (shutdownRequested || !metrics.healthy) return

    try {
      await rotateIfNeeded()
      await runPeriodicCleanup()

      if (!metrics.healthy) return

      const data = line + '\n'
      await appendFile(currentActiveFilePath!, data, 'utf8')

      const written = Buffer.byteLength(data, 'utf8')
      currentFileBytes += written
      metrics.currentFileBytes = currentFileBytes
      metrics.writtenRecords += 1
      metrics.lastWriteAt = Date.now()
    } catch (error) {
      metrics.healthy = false
      metrics.failedRecords += 1
      metrics.lastErrorAt = Date.now()
      console.error('[training-recorder] Write failed — recorder paused:', error)
    }
  }

  async function shutdown(timeoutMs: number): Promise<void> {
    shutdownRequested = true
    // Writer is append-only without open handles — no explicit close needed.
    // Wait briefly so any in-flight write can complete.
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(timeoutMs, 500)))

    if (currentActiveFilePath !== null) {
      await finalizeActiveFile(currentActiveFilePath)
      currentActiveFilePath = null
    }
  }

  function getCurrentFilePath(): string | null {
    return currentActiveFilePath
  }

  return { write, getCurrentFilePath, shutdown }
}
