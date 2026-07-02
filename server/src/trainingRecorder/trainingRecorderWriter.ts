import {
  appendFile,
  mkdir,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import type { TrainingRecorderConfig } from './trainingRecorderConfig.js'
import type { MutableTrainingRecorderMetrics } from './trainingRecorderMetrics.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function localDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildFilePath(config: TrainingRecorderConfig, datePart: string, part: number): string {
  const dir = join(config.storagePath, datePart)
  const partStr = String(part).padStart(4, '0')
  const name = `process-${config.processId}-worker-${config.workerId}-part-${partStr}.jsonl`
  return join(dir, name)
}

// ─── Disk size helpers ────────────────────────────────────────────────────────

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
            await unlink(join(dirPath, f))
          }
          const { rmdir } = await import('node:fs/promises')
          await rmdir(dirPath)
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

async function enforceMaxTotalSize(
  storagePath: string,
  maxTotalBytes: number,
  activeFilePath: string,
): Promise<boolean> {
  let totalBytes = await getDirectorySizeBytes(storagePath)

  if (totalBytes <= maxTotalBytes) {
    return true
  }

  // Collect all closed JSONL files (excluding active) sorted oldest-first
  const closedFiles: Array<{ path: string; mtime: number }> = []

  try {
    const dateDirs = await readdir(storagePath, { withFileTypes: true })
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory()) continue
      const dateDir2 = join(storagePath, dateDir.name)
      const files = await readdir(dateDir2, { withFileTypes: true })
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
        const fullPath = join(dateDir2, f.name)
        if (fullPath === activeFilePath) continue
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

  let currentFilePath: string | null = null
  let currentDatePart: string = ''
  let currentPart: number = 1
  let currentFileBytes: number = 0
  let lastCleanupAt: number = 0
  let shutdownRequested = false

  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

  async function ensureDirectory(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  async function openNewFile(): Promise<string> {
    const datePart = localDateString()

    // If date changed, reset part counter
    if (datePart !== currentDatePart) {
      currentDatePart = datePart
      currentPart = 1
    }

    const filePath = buildFilePath(config, datePart, currentPart)
    await ensureDirectory(dirname(filePath))

    // Check if file already exists and get its size
    const existingSize = await getFileSizeBytes(filePath)
    if (existingSize > 0) {
      // File exists (e.g. after restart) — bump part
      currentPart += 1
      return openNewFile()
    }

    return filePath
  }

  async function rotateIfNeeded(): Promise<void> {
    const datePart = localDateString()
    const needsDateRotation = datePart !== currentDatePart
    const needsSizeRotation = currentFileBytes >= maxFileBytes

    if (currentFilePath === null || needsDateRotation || needsSizeRotation) {
      if (needsDateRotation && currentDatePart !== '') {
        currentPart = 1
      } else if (needsSizeRotation && currentFilePath !== null) {
        currentPart += 1
      }
      currentFilePath = await openNewFile()
      currentFileBytes = await getFileSizeBytes(currentFilePath)
    }
  }

  async function runPeriodicCleanup(): Promise<void> {
    const now = Date.now()
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
    lastCleanupAt = now

    await purgeOldDateDirs(config.storagePath, config.retentionDays)

    if (currentFilePath !== null) {
      const ok = await enforceMaxTotalSize(config.storagePath, maxTotalBytes, currentFilePath)
      if (!ok) {
        console.warn(
          '[training-recorder] Could not free enough disk space — recorder paused.',
        )
        metrics.healthy = false
        metrics.lastErrorAt = Date.now()
      }
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
      await appendFile(currentFilePath!, data, 'utf8')

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
  }

  function getCurrentFilePath(): string | null {
    return currentFilePath
  }

  return { write, getCurrentFilePath, shutdown }
}
