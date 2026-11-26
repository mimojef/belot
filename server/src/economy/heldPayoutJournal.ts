// Етап 3Б.2 — резервен файлов журнал (write-ahead) за задържаните изплащания.
//
// Ред в payoutMatchWinners (matchEconomyStore.ts):
//   1. журнал: атомарен запис на файла + fsync (файл и директория);
//   2. belot_held_payouts: INSERT (идемпотентен по match_scope);
//   3. само при потвърден успех на (2) — файлът се изтрива (+ fsync на директорията).
// Срив между (1) и (3) → файлът остава → при старт се прехвърля отново
// (ON CONFLICT DO NOTHING — без дубликат) и чак тогава се изтрива.
//
// Един файл на мач: held-<sha256(match_scope)[:32]>.json — стабилен
// идентификатор; повторен запис за същия мач презаписва същия файл.
// Атомарност: запис във временен файл (.tmp-…) → fsync → rename → fsync на
// директорията. Временен файл от прекъснат запис се чете при старт, ако е
// цял (иначе се докладва и се пази за ръчна проверка — никога не се трие сляпо).
//
// Журналът НЕ движи жълтици — съдържа само данните за регистъра.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { HeldPayoutRecord } from '../db/matchEconomyStore.js'

export const HELD_PAYOUT_JOURNAL_VERSION = 1

export type HeldPayoutJournalEntry = {
  version: typeof HELD_PAYOUT_JOURNAL_VERSION
  journalId: string
  matchScope: string
  writtenAt: string
  record: HeldPayoutRecord
}

export type HeldPayoutJournalScan = {
  /** По един запис на мач; files — всички файлове с този мач (финален + временни). */
  entries: Array<{ files: string[]; entry: HeldPayoutJournalEntry }>
  /** Нечетими файлове — пазят се и се докладват, не се трият. */
  unreadable: Array<{ file: string; message: string }>
}

export type HeldPayoutJournal = {
  directory: string
  write: (record: HeldPayoutRecord) => { ok: true; file: string } | { ok: false; message: string }
  remove: (matchScope: string) => { ok: true } | { ok: false; message: string }
  /** Изтрива конкретни файлове (финален + временни) на прехвърлен мач. */
  removeFiles: (files: readonly string[]) => { ok: true } | { ok: false; message: string }
  scan: () => HeldPayoutJournalScan
}

export type HeldPayoutJournalFs = {
  mkdirSync: typeof mkdirSync
  openSync: typeof openSync
  writeSync: typeof writeSync
  fsyncSync: typeof fsyncSync
  closeSync: typeof closeSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
  readdirSync: typeof readdirSync
  readFileSync: typeof readFileSync
}

const NODE_FS: HeldPayoutJournalFs = { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readdirSync, readFileSync }

export function heldPayoutJournalId(matchScope: string): string {
  return createHash('sha256').update(matchScope, 'utf8').digest('hex').slice(0, 32)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValidEntry(value: unknown): value is HeldPayoutJournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<HeldPayoutJournalEntry>
  return entry.version === HELD_PAYOUT_JOURNAL_VERSION
    && typeof entry.matchScope === 'string' && entry.matchScope.trim() !== ''
    && entry.journalId === heldPayoutJournalId(entry.matchScope)
    && typeof entry.record === 'object' && entry.record !== null
    && entry.record.matchScope === entry.matchScope
}

export function createHeldPayoutJournal(directory: string, fs: HeldPayoutJournalFs = NODE_FS): HeldPayoutJournal {
  const fileFor = (matchScope: string) => join(directory, `held-${heldPayoutJournalId(matchScope)}.json`)

  function ensureDirectory(): void {
    // 0o700 — само собственикът на процеса (PM2 потребителят) чете/пише.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  /** fsync на директорията — гарантира, че rename/unlink е на диска. */
  function syncDirectory(): void {
    let fd: number | null = null
    try {
      fd = fs.openSync(directory, 'r')
      fs.fsyncSync(fd)
    } catch (error) {
      // Windows не позволява fsync на директория (EPERM/EISDIR) — там NTFS
      // журналира метаданните; на Linux (production) грешката се пробросва.
      const code = (error as { code?: string }).code
      if (!(process.platform === 'win32' && (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES'))) throw error
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  }

  function write(record: HeldPayoutRecord): { ok: true; file: string } | { ok: false; message: string } {
    const file = fileFor(record.matchScope)
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
    const entry: HeldPayoutJournalEntry = {
      version: HELD_PAYOUT_JOURNAL_VERSION,
      journalId: heldPayoutJournalId(record.matchScope),
      matchScope: record.matchScope,
      writtenAt: new Date().toISOString(),
      record,
    }
    let fd: number | null = null
    try {
      ensureDirectory()
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeSync(fd, JSON.stringify(entry))
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tmp, file)
      syncDirectory()
      return { ok: true, file }
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd) } catch { /* original error wins */ }
      }
      try { fs.unlinkSync(tmp) } catch { /* may not exist */ }
      return { ok: false, message: messageOf(error) }
    }
  }

  function remove(matchScope: string): { ok: true } | { ok: false; message: string } {
    try {
      fs.unlinkSync(fileFor(matchScope))
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') return { ok: false, message: messageOf(error) }
    }
    try {
      syncDirectory()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  function removeFiles(files: readonly string[]): { ok: true } | { ok: false; message: string } {
    try {
      for (const file of files) {
        try {
          fs.unlinkSync(file)
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error
        }
      }
      syncDirectory()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  function scan(): HeldPayoutJournalScan {
    const result: HeldPayoutJournalScan = { entries: [], unreadable: [] }
    let names: string[]
    try {
      names = (fs.readdirSync(directory) as string[]).filter((name) => name.startsWith('held-')).sort()
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return result
      throw error
    }
    const byScope = new Map<string, { files: string[]; entry: HeldPayoutJournalEntry }>()
    // Първо завършените файлове, после временните (прекъснат запис преди rename).
    const ordered = [...names.filter((n) => n.endsWith('.json')), ...names.filter((n) => n.includes('.json.tmp-'))]
    for (const name of ordered) {
      const file = join(directory, name)
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8') as string) as unknown
        if (!isValidEntry(parsed)) {
          result.unreadable.push({ file, message: 'invalid journal entry' })
          continue
        }
        const existing = byScope.get(parsed.matchScope)
        if (existing) existing.files.push(file)
        else byScope.set(parsed.matchScope, { files: [file], entry: parsed })
      } catch (error) {
        result.unreadable.push({ file, message: messageOf(error) })
      }
    }
    result.entries = [...byScope.values()]
    return result
  }

  return { directory, write, remove, removeFiles, scan }
}


