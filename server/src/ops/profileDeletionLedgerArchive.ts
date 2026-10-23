// Самоизтриване, Етап 4C — архивиране на регистъра на окончателните
// изтривания извън VPS и възстановяване на най-новото надеждно състояние.
//
// Модел (виж ops/pikabg-backup/README.md, "Deletion ledger"):
//   1. snapshot — консистентно копие на ПЪЛНИТЕ редове на регистъра +
//      manifest (sha256, md5, байтове, брой редове/записи). Повреден регистър
//      (невалиден пълен ред / конфликт) -> грешка, нищо не се качва.
//   2. pikabg-ledger-backup качва snapshot + manifest (rclone) и проверява
//      MD5 на отдалеченото копие.
//   3. confirm — едва след проверката: ack за точния префикс на регистъра.
//      Worker-ът изтрива в базата само заявки, покрити от ack-а.
//   4. merge (при restore) — обединение на всички валидни отдалечени
//      snapshot-и (+ живия регистър, ако е наличен). Fail-closed: липса,
//      повреден най-нов snapshot или разклонена история -> грешка.
//
// Без лични данни: регистърът и manifest-ите съдържат само псевдонимни
// идентификатори, хешове и броячи.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  isSameProfileDeletionLedgerRecord,
  parseProfileDeletionLedgerBuffer,
  profileDeletionLedgerRecordKey,
  readProfileDeletionLedgerOffsiteAck,
  serializeProfileDeletionLedgerEntry,
  sha256Hex,
  writeFileAtomicallySync,
  writeProfileDeletionLedgerOffsiteAck,
  type ProfileDeletionLedgerRecord,
} from '../db/profileDeletionLedger.js'

export const LEDGER_SNAPSHOT_KIND = 'pikabg-profile-deletion-ledger-snapshot'

export type LedgerSnapshotManifest = {
  v: 1
  kind: typeof LEDGER_SNAPSHOT_KIND
  file: string
  bytes: number
  sha256: string
  md5: string
  lineCount: number
  entryCount: number
  createdAt: string
}

export class LedgerArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex')
}

function readExisting(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function isValidManifest(value: unknown): value is LedgerSnapshotManifest {
  if (value === null || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    m.v === 1 && m.kind === LEDGER_SNAPSHOT_KIND &&
    typeof m.file === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(m.file) &&
    Number.isInteger(m.bytes) && (m.bytes as number) >= 0 &&
    typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) &&
    typeof m.md5 === 'string' && /^[0-9a-f]{32}$/.test(m.md5) &&
    Number.isInteger(m.lineCount) && Number.isInteger(m.entryCount) &&
    typeof m.createdAt === 'string' && !Number.isNaN(Date.parse(m.createdAt))
  )
}

// ─── 1. snapshot ───────────────────────────────────────────────────────────
export type CreateLedgerSnapshotResult =
  | { status: 'unchanged'; bytes: number; sha256: string }
  | { status: 'created'; snapshotPath: string; manifestPath: string; manifest: LedgerSnapshotManifest }

export function createLedgerSnapshot(input: {
  ledgerPath: string
  outDir: string
  ackPath: string
  now?: Date
}): CreateLedgerSnapshotResult {
  const raw = readExisting(input.ledgerPath) ?? Buffer.alloc(0)
  const parsed = parseProfileDeletionLedgerBuffer(raw)
  if (parsed.invalidLineCount > 0 || parsed.conflictingDuplicateCount > 0) {
    throw new LedgerArchiveError(
      'ledger_corrupt',
      `invalidLines=${parsed.invalidLineCount} conflictingDuplicates=${parsed.conflictingDuplicateCount}`,
    )
  }
  // Само пълните редове: непълна опашка (запис в момента) не се архивира.
  const complete = raw.subarray(0, parsed.completeBytes)
  const sha256 = sha256Hex(complete)
  const ack = readProfileDeletionLedgerOffsiteAck(input.ackPath)
  if (ack !== null && ack.bytes === complete.length && ack.sha256 === sha256) {
    return { status: 'unchanged', bytes: complete.length, sha256 }
  }
  const createdAt = (input.now ?? new Date()).toISOString()
  const file = `profile-deletions-${compactStamp(createdAt)}-${sha256.slice(0, 12)}.jsonl`
  const manifest: LedgerSnapshotManifest = {
    v: 1,
    kind: LEDGER_SNAPSHOT_KIND,
    file,
    bytes: complete.length,
    sha256,
    md5: md5Hex(complete),
    lineCount: parsed.lineCount,
    // Етап 4F1: всички записи (самоизтриване + административни).
    entryCount: parsed.records.length,
    createdAt,
  }
  mkdirSync(input.outDir, { recursive: true, mode: 0o700 })
  const snapshotPath = join(input.outDir, file)
  const manifestPath = `${snapshotPath}.manifest.json`
  writeFileAtomicallySync(snapshotPath, complete, 0o600)
  writeFileAtomicallySync(manifestPath, `${JSON.stringify(manifest)}\n`, 0o600)
  return { status: 'created', snapshotPath, manifestPath, manifest }
}

export function readLedgerSnapshotManifest(manifestPath: string): LedgerSnapshotManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new LedgerArchiveError('manifest_unreadable', basename(manifestPath))
  }
  if (!isValidManifest(parsed)) throw new LedgerArchiveError('manifest_invalid', basename(manifestPath))
  return parsed
}

/** Проверява snapshot файла спрямо manifest-а (байтове, sha256, md5, съдържание). */
export function verifyLedgerSnapshot(snapshotPath: string, manifest: LedgerSnapshotManifest): ProfileDeletionLedgerRecord[] {
  const buffer = readExisting(snapshotPath)
  if (buffer === null) throw new LedgerArchiveError('snapshot_missing', manifest.file)
  if (buffer.length !== manifest.bytes || sha256Hex(buffer) !== manifest.sha256 || md5Hex(buffer) !== manifest.md5) {
    throw new LedgerArchiveError('snapshot_checksum_mismatch', manifest.file)
  }
  const parsed = parseProfileDeletionLedgerBuffer(buffer)
  if (
    parsed.trailingPartialBytes !== 0 || parsed.invalidLineCount !== 0 || parsed.conflictingDuplicateCount !== 0 ||
    parsed.lineCount !== manifest.lineCount || parsed.records.length !== manifest.entryCount
  ) {
    throw new LedgerArchiveError('snapshot_content_invalid', manifest.file)
  }
  return parsed.records
}

// ─── 3. confirm (ack) ──────────────────────────────────────────────────────
export function confirmLedgerSnapshotOffsite(input: {
  ledgerPath: string
  snapshotPath: string
  manifestPath: string
  remotePath: string
  ackPath: string
  now?: Date
}): void {
  const manifest = readLedgerSnapshotManifest(input.manifestPath)
  const entries = verifyLedgerSnapshot(input.snapshotPath, manifest)
  // Регистърът трябва още да започва ТОЧНО със същите байтове (само е растял).
  const live = readExisting(input.ledgerPath) ?? Buffer.alloc(0)
  if (live.length < manifest.bytes || sha256Hex(live.subarray(0, manifest.bytes)) !== manifest.sha256) {
    throw new LedgerArchiveError('ledger_changed_since_snapshot', 'регистърът не започва със snapshot-а')
  }
  writeProfileDeletionLedgerOffsiteAck(input.ackPath, {
    v: 1,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    lineCount: manifest.lineCount,
    entryCount: entries.length,
    remotePath: input.remotePath,
    confirmedAt: (input.now ?? new Date()).toISOString(),
  })
}

// ─── 4. merge (при restore) ────────────────────────────────────────────────
export type LedgerMergeReport = {
  validSnapshots: Array<{ file: string; createdAt: string; entryCount: number }>
  invalidSnapshots: Array<{ file: string; code: string }>
  newestSnapshot: string | null
  localLedger: 'absent' | 'used'
  entryCount: number
  warnings: string[]
}

function findManifests(directory: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.jsonl.manifest.json')) found.push(full)
    }
  }
  if (existsSync(directory)) walk(directory)
  return found
}

function isBytePrefix(prefix: Buffer, whole: Buffer): boolean {
  return whole.length >= prefix.length && whole.subarray(0, prefix.length).equals(prefix)
}

export function mergeLedgerSnapshots(input: {
  snapshotDir: string
  localLedgerPath?: string | null
  /** Най-новият snapshot е повреден/непълен — използвай предишните (след ръчна проверка). */
  acceptMissingNewest?: boolean
  /** Няма нито един snapshot и няма жив регистър — изрично потвърждение, че изтривания не е имало. */
  confirmNoDeletionsEver?: boolean
}): { entries: ProfileDeletionLedgerRecord[]; report: LedgerMergeReport } {
  const warnings: string[] = []
  const candidates: Array<{ manifest: LedgerSnapshotManifest; snapshotPath: string; manifestPath: string }> = []
  const invalidSnapshots: LedgerMergeReport['invalidSnapshots'] = []
  for (const manifestPath of findManifests(input.snapshotDir)) {
    try {
      const manifest = readLedgerSnapshotManifest(manifestPath)
      candidates.push({ manifest, snapshotPath: manifestPath.slice(0, -'.manifest.json'.length), manifestPath })
    } catch (error) {
      invalidSnapshots.push({ file: basename(manifestPath), code: error instanceof LedgerArchiveError ? error.code : 'manifest_error' })
    }
  }
  // Snapshot файл без manifest = непълно качване.
  const walkSnapshots = (dir: string): string[] => {
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walkSnapshots(full) : name.endsWith('.jsonl') ? [full] : []
    })
  }
  for (const snapshotPath of walkSnapshots(input.snapshotDir)) {
    if (!existsSync(`${snapshotPath}.manifest.json`)) invalidSnapshots.push({ file: basename(snapshotPath), code: 'manifest_missing' })
  }

  candidates.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt) || a.manifest.bytes - b.manifest.bytes)
  const valid: Array<{ manifest: LedgerSnapshotManifest; buffer: Buffer; entries: ProfileDeletionLedgerRecord[] }> = []
  for (const candidate of candidates) {
    try {
      const entries = verifyLedgerSnapshot(candidate.snapshotPath, candidate.manifest)
      valid.push({ manifest: candidate.manifest, buffer: readFileSync(candidate.snapshotPath), entries })
    } catch (error) {
      invalidSnapshots.push({ file: candidate.manifest.file, code: error instanceof LedgerArchiveError ? error.code : 'snapshot_error' })
    }
  }

  const newestCandidate = candidates.length > 0 ? candidates[candidates.length - 1]! : null
  if (newestCandidate !== null && !valid.some((item) => item.manifest.file === newestCandidate.manifest.file)) {
    if (input.acceptMissingNewest !== true) {
      throw new LedgerArchiveError('newest_snapshot_invalid', `${newestCandidate.manifest.file} — нужна е ръчна проверка (--accept-missing-newest)`)
    }
    warnings.push(`newest_snapshot_invalid_accepted:${newestCandidate.manifest.file}`)
  }
  if (invalidSnapshots.length > 0) warnings.push(`invalid_snapshots:${invalidSnapshots.length}`)

  // Append-only: всеки по-стар валиден snapshot трябва да е байтов префикс на по-новия.
  for (let index = 1; index < valid.length; index += 1) {
    if (!isBytePrefix(valid[index - 1]!.buffer, valid[index]!.buffer)) {
      throw new LedgerArchiveError('ledger_history_diverged', `${valid[index - 1]!.manifest.file} не е префикс на ${valid[index]!.manifest.file}`)
    }
  }

  let localEntries: ProfileDeletionLedgerRecord[] = []
  let localLedger: LedgerMergeReport['localLedger'] = 'absent'
  if (input.localLedgerPath) {
    const localBuffer = readExisting(input.localLedgerPath)
    if (localBuffer !== null) {
      const parsed = parseProfileDeletionLedgerBuffer(localBuffer)
      if (parsed.invalidLineCount > 0 || parsed.conflictingDuplicateCount > 0) {
        throw new LedgerArchiveError('local_ledger_corrupt', `invalidLines=${parsed.invalidLineCount}`)
      }
      if (parsed.trailingPartialBytes > 0) warnings.push('local_ledger_trailing_partial_ignored')
      const complete = localBuffer.subarray(0, parsed.completeBytes)
      const newestValid = valid.length > 0 ? valid[valid.length - 1]!.buffer : Buffer.alloc(0)
      if (!isBytePrefix(newestValid, complete) && !isBytePrefix(complete, newestValid)) {
        throw new LedgerArchiveError('local_ledger_diverged', 'живият регистър и най-новият snapshot не са префикс един на друг')
      }
      if (complete.length < newestValid.length) warnings.push('local_ledger_older_than_newest_snapshot')
      localEntries = parsed.records
      localLedger = 'used'
    }
  }

  if (valid.length === 0 && localLedger === 'absent') {
    if (input.confirmNoDeletionsEver !== true) {
      throw new LedgerArchiveError('no_ledger_available', 'няма валиден snapshot и няма жив регистър (--confirm-no-deletions-ever само ако изтривания никога не е имало)')
    }
    warnings.push('confirmed_no_deletions_ever')
  }

  const merged = new Map<string, ProfileDeletionLedgerRecord>()
  for (const entry of [...valid.flatMap((item) => item.entries), ...localEntries]) {
    const key = profileDeletionLedgerRecordKey(entry)
    const existing = merged.get(key)
    if (existing === undefined) merged.set(key, entry)
    else if (!isSameProfileDeletionLedgerRecord(existing, entry)) {
      throw new LedgerArchiveError('ledger_conflict', `key=${key}`)
    }
  }

  return {
    entries: [...merged.values()],
    report: {
      validSnapshots: valid.map((item) => ({ file: item.manifest.file, createdAt: item.manifest.createdAt, entryCount: item.entries.length })),
      invalidSnapshots,
      newestSnapshot: newestCandidate?.manifest.file ?? null,
      localLedger,
      entryCount: merged.size,
      warnings,
    },
  }
}

export function writeMergedLedger(outPath: string, entries: readonly ProfileDeletionLedgerRecord[]): void {
  writeFileAtomicallySync(outPath, entries.map(serializeProfileDeletionLedgerEntry).join(''), 0o600)
}
