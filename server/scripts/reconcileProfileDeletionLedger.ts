/**
 * reconcileProfileDeletionLedger.ts
 *
 * Самоизтриване на профили — Етап 4: процедура СЛЕД restore на SQLite/uploads
 * backup и ПРЕДИ платформата да бъде пусната отново за потребители.
 *
 * Сравнява независимия регистър на необратимите изтривания (append-only
 * JSONL извън базата, виж src/db/profileDeletionLedger.ts) с възстановената
 * база и открива профили, които backup-ът е "възкресил".
 *
 * По подразбиране САМО ОТЧЕТ (нищо не се променя). Изпълнение — само при
 * изрично:
 *     --apply --confirm=REAPPLY-PROFILE-DELETIONS --uploads-root=<dir>
 * и при СПРЯН сървър (няма друг процес, който пише в базата).
 *
 * Употреба:
 *   npx tsx scripts/reconcileProfileDeletionLedger.ts \
 *     --db=<restored belot-v2.sqlite> --ledger=<profile-deletions.jsonl> \
 *     [--apply --confirm=REAPPLY-PROFILE-DELETIONS --uploads-root=<restored uploads dir>]
 *
 * Категории за всеки запис от регистъра:
 *   absent             — профилът липсва във възстановената база (нищо за правене);
 *   request_present    — профилът и заявката му са в базата; при --apply се
 *                        обработва от СЪЩИЯ worker код (само тази заявка);
 *   request_missing    — backup-ът е по-стар от заявката; при --apply същото
 *                        изтриване в базата + физическо изтриване на файловете;
 *   identity_mismatch  — profile_id съвпада, но account/created_at не —
 *                        НИКОГА не се пипа, нужна е ръчна проверка;
 *   blocked            — защитна проверка (активна игра/турнир/...) — ръчна проверка.
 *
 * Изход: само request_id/profile_id и кодове — без имена, имейли или токени.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { readProfileDeletionLedger } from '../src/db/profileDeletionLedger.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'

const REAPPLY_CONFIRMATION_PHRASE = 'REAPPLY-PROFILE-DELETIONS'

function readArg(name: string): string | null {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

const dbPath = readArg('db')
const ledgerPath = readArg('ledger')
const uploadsRoot = readArg('uploads-root')
const apply = process.argv.slice(2).includes('--apply')
const confirmation = readArg('confirm')

function fail(message: string): never {
  console.error(`[reconcile] ERROR: ${message}`)
  process.exit(2)
}

if (dbPath === null || ledgerPath === null) fail('нужни са --db=<път> и --ledger=<път>')
if (!existsSync(dbPath)) fail('базата не съществува')
if (apply) {
  if (confirmation !== REAPPLY_CONFIRMATION_PHRASE) fail(`--apply изисква --confirm=${REAPPLY_CONFIRMATION_PHRASE}`)
  if (uploadsRoot === null || !existsSync(uploadsRoot)) fail('--apply изисква съществуващ --uploads-root=<директория>')
}

const ledger = readProfileDeletionLedger(ledgerPath)
console.log(`[reconcile] mode=${apply ? 'APPLY' : 'report-only'} ledgerEntries=${ledger.entries.length} invalidLines=${ledger.invalidLineCount}`)

const { DatabaseSync } = await import('node:sqlite')
const readDb = new DatabaseSync(resolve(dbPath), { readOnly: true })
const selectProfile = readDb.prepare('SELECT account_id, created_at FROM profiles WHERE profile_id = ? LIMIT 1;')
const selectRequest = readDb.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;')

type Category = 'absent' | 'request_present' | 'request_missing' | 'identity_mismatch'
const classified: Array<{ entry: (typeof ledger.entries)[number]; category: Category; requestStatus: string | null }> = []
for (const entry of ledger.entries) {
  const profile = selectProfile.get(entry.profileId) as { account_id: string | null; created_at: string } | undefined
  const request = selectRequest.get(entry.requestId) as { status: string } | undefined
  let category: Category
  if (profile === undefined) category = 'absent'
  else if (profile.account_id !== entry.accountIdSnapshot || profile.created_at !== entry.profileCreatedAtSnapshot) category = 'identity_mismatch'
  else category = request === undefined ? 'request_missing' : 'request_present'
  classified.push({ entry, category, requestStatus: request?.status ?? null })
}
readDb.close()

for (const item of classified) {
  console.log(`[reconcile] ${item.category} requestId=${item.entry.requestId} profileId=${item.entry.profileId}${item.requestStatus === null ? '' : ` requestStatus=${item.requestStatus}`}`)
}
const counts = classified.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.category]: (acc[item.category] ?? 0) + 1 }), {})
console.log(`[reconcile] summary ${JSON.stringify(counts)}`)

if (!apply) {
  console.log('[reconcile] Нищо не е променено (report-only). За изпълнение виж коментара в началото на скрипта.')
  process.exit(0)
}

const roots: ProfileDeletionUploadRoots = {
  avatars: join(uploadsRoot as string, 'avatars'),
  profileGallery: join(uploadsRoot as string, 'profile-gallery'),
  chatAttachments: join(uploadsRoot as string, 'chat-attachments'),
  topicAttachments: join(uploadsRoot as string, 'topic-attachments'),
  topicMuteEvidenceAttachments: join(uploadsRoot as string, 'topic-mute-evidence-attachments'),
  supportAttachments: join(uploadsRoot as string, 'support-attachments'),
}

const executor = await createProfileDeletionExecutor(resolve(dbPath))
let exitCode = 0
try {
  const presentIds = classified.filter((item) => item.category === 'request_present').map((item) => item.entry.requestId)
  if (presentIds.length > 0) {
    const worker = createProfileDeletionWorker({
      executor,
      workerId: `reconcile:${process.pid}`,
      uploadRoots: roots,
      removeFile: removeProfileDeletionFile,
      appendLedgerEntry: null,
      onlyRequestIds: presentIds,
      log: (message) => console.log(message),
    })
    console.log(`[reconcile] worker ${JSON.stringify(await worker.runOnce())}`)
  }

  for (const item of classified.filter((candidate) => candidate.category === 'request_missing')) {
    const result = executor.replayDeletionForRestore(item.entry)
    if (result.kind !== 'deleted') {
      console.log(`[reconcile] replay requestId=${item.entry.requestId} result=${result.kind}${result.kind === 'blocked' ? ` code=${result.code}` : ''}`)
      if (result.kind === 'blocked' || result.kind === 'identity_mismatch') exitCode = 1
      continue
    }
    let deleted = 0
    let skipped = 0
    let failedFiles = 0
    for (const file of result.files) {
      if (executor.isStorageRefReferenced(file.fileKind, file.storageRef)) {
        skipped += 1
        continue
      }
      const outcome = await removeProfileDeletionFile(file.fileKind, file.storageRef, roots)
      if (outcome.outcome === 'deleted' || outcome.outcome === 'missing') deleted += 1
      else failedFiles += 1
    }
    if (failedFiles > 0) exitCode = 1
    console.log(`[reconcile] replayed requestId=${item.entry.requestId} files deleted=${deleted} skippedShared=${skipped} failed=${failedFiles}`)
  }
} finally {
  executor.close()
}

if (classified.some((item) => item.category === 'identity_mismatch')) exitCode = 1
process.exit(exitCode)
