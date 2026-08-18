/**
 * lafcheRetentionCleanup.ts — Lafche 200-post hard retention: DRY-RUN report
 * + explicit, batched --mode=apply backlog normalization.
 *
 * Production hotfix (root cause audit-и: unbounded client-side scroll-
 * triggered "load older" доведе до 900+ Lafche root nodes в DOM, защото
 * нищо никога не е пазило DB-то самото под LAFCHE_MESSAGE_HISTORY_LIMIT).
 *
 * Двата режима имат МНОГО различни safety гаранции:
 *
 *   --mode=dry-run (default) — 100% READ-ONLY. Извиква ИЗКЛЮЧИТЕЛНО
 *   read-only store функции (countLiveRootMessages, getLafcheRetentionVictims,
 *   getActiveEvidenceAttachmentReferences, getLikeCountsByMessageIds) плюс
 *   локални SELECT-само aggregate заявки върху отделна DatabaseSync connection.
 *   Никаква INSERT/UPDATE/DELETE заявка не се изпълнява в тази функция —
 *   виж checkLafcheRetentionCleanupDryRunReadOnly.ts за static/runtime proof.
 *
 *   --mode=apply --confirm-destructive-backlog-cleanup — РЕАЛНО DESTRUCTIVE.
 *   Bulk-нормализира ЦЕЛИЯ legacy backlog надолу до LAFCHE_MESSAGE_HISTORY_LIMIT
 *   на bounded batches (mirror на enforceLafcheRetention orchestration-а в
 *   index.ts за всеки victim: evidence-copy-преди-delete за image evidence,
 *   skip+retry-следващия-run при неуспешен copy, per-batch BEGIN IMMEDIATE
 *   транзакция вътре в hardDeleteRetentionVictims). Изисква И ДВЕТЕ explicit
 *   флагове (--mode=apply САМО не е достатъчен) — умишлено висок бар за
 *   случайно/автоматизирано изпълнение върху production DB. НЕ се изпълнява
 *   автоматично никъде (няма cron/hook, викащ този скрипт) — изисква ръчно
 *   изпълнение от оператор, СЛЕД преглед на --mode=dry-run числата.
 *
 * Употреба:
 *   tsx scripts/lafcheRetentionCleanup.ts
 *   tsx scripts/lafcheRetentionCleanup.ts --mode=dry-run
 *   tsx scripts/lafcheRetentionCleanup.ts --mode=apply --confirm-destructive-backlog-cleanup
 *
 * ВАЖНО: скриптът отваря СЪЩИЯ production DB файл read-write (node:sqlite
 * няма built-in readonly-open в тези store factory-та), но dry-run режимът
 * извиква ИЗКЛЮЧИТЕЛНО read-only функции — никаква мутация.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'
import { createTopicModerationStore, type TopicModerationStore } from '../src/db/topicModerationStore.js'
import {
  IMAGE_ATTACHMENT_FILENAME_PATTERN,
  writeWebpAttachmentFile,
} from '../src/uploads/imageAttachments.js'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const LAFCHE_TOPIC_ID = 'topic-lafche'
const LAFCHE_MESSAGE_HISTORY_LIMIT = 200
const APPLY_BATCH_SIZE = 50

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function serverRoot(): string {
  return resolve(scriptDir(), '..')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`
}

async function fileByteSize(directoryPath: string, filename: string): Promise<number | null> {
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) return null
  try {
    const stats = await stat(join(directoryPath, filename))
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * Отделна read-only-USE (никога UPDATE/DELETE извикано през нея) DatabaseSync
 * connection — само за aggregate SELECT COUNT/MIN/MAX заявки, които store
 * слоят нарочно не излага (dependent-rows-per-table breakdown, seq range) —
 * не искаме да добавяме нови production store методи само за reporting.
 */
function openReportingConnection(databaseFilePath: string): DatabaseSync {
  return new DatabaseSync(databaseFilePath, { open: true, readOnly: true })
}

/**
 * PRAGMA table_info introspection — dry-run трябва да работи СРЕЩУ
 * PRE-migration production schema (преди 20260818_005 да бъде приложена),
 * защото искаме да можем да прегледаме числата ПРЕДИ да решим кога да
 * мигрираме+deploy-нем. createTopicModerationStore() eagerly prepare-ва
 * statements, реферриращи source_attachment_is_evidence_copy (виж
 * selectMuteEvidenceForProfileStatement/repointMuteEvidenceAttachmentStatement
 * в topicModerationStore.ts) — construction-ът ѝ хвърля ВЕДНАГА, ако
 * колоната липсва, дори ако конкретната функция никога не бъде извикана.
 * Затова buildDryRunReport проверява колоната ПРЕДИ да инстанцира
 * TopicModerationStore и, ако липсва, изчислява evidence reporting-а чрез
 * raw SQL на reportDb (винаги безопасно read-only) вместо store слоя.
 */
function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

/**
 * Legacy (pre-005) mirror на topicModerationStore.getActiveEvidenceAttachmentReferences
 * — САМО read-only reportDb, БЕЗ is_evidence_copy филтър (колоната не
 * съществува все още), затова СЕМАНТИЧНО коректно: на pre-migration schema
 * ВСЕКИ evidence ред е по дефиниция "все още не copy-нат" (концепцията
 * изобщо не съществува преди migration-а), точно каквото post-migration
 * функцията би върнала за WHERE is_evidence_copy = 0.
 */
function computeLegacyEvidenceAttachmentReferences(reportDb: DatabaseSync, storageFilenames: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const uniqueFilenames = [...new Set(storageFilenames.filter((f) => f.trim().length > 0))]
  if (uniqueFilenames.length === 0) return result

  const placeholders = uniqueFilenames.map(() => '?').join(',')
  const rows = reportDb.prepare(`
    SELECT mute_history_id, source_attachment_storage_filename FROM topic_mute_evidence
    WHERE source_attachment_storage_filename IN (${placeholders});
  `).all(...uniqueFilenames) as Array<{ mute_history_id: string; source_attachment_storage_filename: string }>

  for (const row of rows) {
    const existing = result.get(row.source_attachment_storage_filename) ?? []
    existing.push(row.mute_history_id)
    result.set(row.source_attachment_storage_filename, existing)
  }
  return result
}

type SeqRange = { oldestSeq: number; newestSeq: number } | null

function computeSeqRanges(
  reportDb: DatabaseSync,
  topicId: string,
  limit: number,
): { retained: SeqRange; victims: SeqRange; retainedIds: string[]; victimIds: string[] } {
  const rows = reportDb
    .prepare(
      `SELECT message_id, seq FROM topic_messages
       WHERE topic_id = ? AND parent_message_id IS NULL AND deleted_at IS NULL
       ORDER BY seq DESC;`,
    )
    .all(topicId) as Array<{ message_id: string; seq: number }>

  const retainedRows = rows.slice(0, limit)
  const victimRows = rows.slice(limit)

  const retained: SeqRange = retainedRows.length > 0
    ? { newestSeq: retainedRows[0]!.seq, oldestSeq: retainedRows[retainedRows.length - 1]!.seq }
    : null
  const victims: SeqRange = victimRows.length > 0
    ? { newestSeq: victimRows[0]!.seq, oldestSeq: victimRows[victimRows.length - 1]!.seq }
    : null

  return {
    retained,
    victims,
    retainedIds: retainedRows.map((r) => r.message_id),
    victimIds: victimRows.map((r) => r.message_id),
  }
}

function countDependentRows(reportDb: DatabaseSync, victimIds: readonly string[]): Record<string, number> {
  if (victimIds.length === 0) {
    return {
      replies: 0,
      likes: 0,
      attachments: 0,
      deletion_events: 0,
      deletion_audit_log: 0,
      self_deletion_audit_log: 0,
      edit_events: 0,
      thread_read_state: 0,
    }
  }
  const placeholders = victimIds.map(() => '?').join(',')
  const countBy = (sql: string): number => {
    const row = reportDb.prepare(sql).get(...victimIds) as { cnt: number }
    return row.cnt
  }
  return {
    replies: countBy(`SELECT COUNT(*) as cnt FROM topic_messages WHERE parent_message_id IN (${placeholders}) AND deleted_at IS NULL;`),
    likes: countBy(`SELECT COUNT(*) as cnt FROM topic_message_likes WHERE message_id IN (${placeholders});`),
    attachments: countBy(`SELECT COUNT(*) as cnt FROM topic_message_attachments WHERE message_id IN (${placeholders});`),
    deletion_events: countBy(`SELECT COUNT(*) as cnt FROM topic_message_deletion_events WHERE message_id IN (${placeholders});`),
    deletion_audit_log: countBy(`SELECT COUNT(*) as cnt FROM topic_message_deletion_audit_log WHERE message_id IN (${placeholders});`),
    self_deletion_audit_log: countBy(`SELECT COUNT(*) as cnt FROM topic_message_self_deletion_audit_log WHERE message_id IN (${placeholders});`),
    edit_events: countBy(`SELECT COUNT(*) as cnt FROM topic_message_edit_events WHERE message_id IN (${placeholders});`),
    thread_read_state: countBy(`SELECT COUNT(*) as cnt FROM topic_thread_read_state WHERE root_message_id IN (${placeholders});`),
  }
}

export async function buildDryRunReport(databaseFilePath: string, topicAttachmentUploadsPath: string): Promise<void> {
  const messageStore = await createTopicMessageStore(databaseFilePath)
  const reportDb = openReportingConnection(databaseFilePath)
  const hasEvidenceCopyColumn = tableHasColumn(reportDb, 'topic_mute_evidence', 'source_attachment_is_evidence_copy')
  const moderationStore = hasEvidenceCopyColumn ? await createTopicModerationStore(databaseFilePath) : null

  try {
    const currentCount = messageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
    console.log(`\n=== Lafche retention dry-run (READ-ONLY) ===\n`)
    if (!hasEvidenceCopyColumn) {
      console.log(`⚠ Migration 20260818_005_add_topic_mute_evidence_attachment_copy.sql ОЩЕ НЕ Е приложена на тази база — source_attachment_is_evidence_copy колоната липсва.`)
      console.log(`  Evidence reporting по-долу третира ВСИЧКИ mute evidence redove като pre-migration (нито един все още не е copy-нат) —`)
      console.log(`  точни числа за backfill-а, който ще е нужен СЛЕД migration + първия enforceLafcheRetention/apply run.\n`)
    }
    console.log(`Текущ брой LIVE Lafche root posts: ${currentCount}`)
    console.log(`Canonical newest retention limit: ${LAFCHE_MESSAGE_HISTORY_LIMIT}`)

    const { retained, victims: victimSeqRange, victimIds } = computeSeqRanges(reportDb, LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
    const retainedCount = Math.min(currentCount, LAFCHE_MESSAGE_HISTORY_LIMIT)
    const victimCount = Math.max(0, currentCount - LAFCHE_MESSAGE_HISTORY_LIMIT)

    console.log(`Retained count: ${retainedCount}`)
    console.log(`Victim count (постове отвъд newest ${LAFCHE_MESSAGE_HISTORY_LIMIT}): ${victimCount}`)
    console.log(`Retained seq range: ${retained ? `${retained.oldestSeq} .. ${retained.newestSeq}` : '(няма retained постове)'}`)
    console.log(`Victim seq range: ${victimSeqRange ? `${victimSeqRange.oldestSeq} .. ${victimSeqRange.newestSeq}` : '(няма victims)'}`)

    if (currentCount <= LAFCHE_MESSAGE_HISTORY_LIMIT) {
      console.log(`\nDB вече е <= ${LAFCHE_MESSAGE_HISTORY_LIMIT} — нищо за cleanup. (Steady-state retention hook-ът за нови постове вече ще пази това занапред.)`)
      return
    }

    const dependentCounts = countDependentRows(reportDb, victimIds)
    console.log(`\nDependent rows, засегнати от victim-ите (auto CASCADE при hard delete):`)
    console.log(`  - replies (topic_messages self-FK, live): ${dependentCounts.replies}`)
    console.log(`  - topic_message_likes: ${dependentCounts.likes}`)
    console.log(`  - topic_message_attachments: ${dependentCounts.attachments}`)
    console.log(`  - topic_message_deletion_events: ${dependentCounts.deletion_events}`)
    console.log(`  - topic_message_deletion_audit_log: ${dependentCounts.deletion_audit_log}`)
    console.log(`  - topic_message_self_deletion_audit_log: ${dependentCounts.self_deletion_audit_log}`)
    console.log(`  - topic_message_edit_events: ${dependentCounts.edit_events}`)
    console.log(`  - topic_thread_read_state: ${dependentCounts.thread_read_state}`)
    console.log(`Preserved (NOT deleted, независими snapshot/reference редове):`)
    console.log(`  - topic_mute_evidence (source_message_id → ON DELETE SET NULL, text snapshot self-contained; attachment repoint-нат преди delete)`)

    const victims = messageStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
    const victimAttachmentFilenames = victims
      .map((victim) => victim.attachmentFilename)
      .filter((filename): filename is string => filename !== null)
    console.log(`\nVictims с normal attachment metadata: ${victimAttachmentFilenames.length}`)

    let totalBytes = 0
    let resolvedFileCount = 0
    for (const filename of victimAttachmentFilenames) {
      const size = await fileByteSize(topicAttachmentUploadsPath, filename)
      if (size !== null) {
        totalBytes += size
        resolvedFileCount++
      }
    }
    const missingFileCount = victimAttachmentFilenames.length - resolvedFileCount
    console.log(`Физически файлове, реално намерени на диска: ${resolvedFileCount} / ${victimAttachmentFilenames.length}`)
    console.log(`Липсващи физически файлове (metadata съществува, файл не): ${missingFileCount}`)
    console.log(`Оценен общ размер (само намерените файлове): ${formatBytes(totalBytes)}`)

    const likeCounts = messageStore.getLikeCountsByMessageIds(victims.map((v) => v.messageId))
    let totalLikes = 0
    for (const count of likeCounts.values()) totalLikes += count
    console.log(`\nLikes/reactions върху victim-ите (общо): ${totalLikes}`)

    const evidenceReferences = victimAttachmentFilenames.length === 0
      ? new Map<string, string[]>()
      : hasEvidenceCopyColumn && moderationStore
        ? moderationStore.getActiveEvidenceAttachmentReferences(victimAttachmentFilenames)
        : computeLegacyEvidenceAttachmentReferences(reportDb, victimAttachmentFilenames)

    let victimsReferencedByEvidence = 0
    let imageEvidenceRequiringCopy = 0
    for (const [, muteHistoryIds] of evidenceReferences) {
      victimsReferencedByEvidence++
      imageEvidenceRequiringCopy += muteHistoryIds.length
    }

    // Text evidence: victim-и, реферирани от mute evidence чрез
    // source_message_id, БЕЗ attachment (snapshot текстът вече е
    // self-contained, source_message_id просто ще стане NULL — не изисква copy).
    const victimIdPlaceholders = victims.map(() => '?').join(',')
    const textEvidenceCount = victims.length > 0
      ? (reportDb
          .prepare(
            `SELECT COUNT(*) as cnt FROM topic_mute_evidence
             WHERE source_message_id IN (${victimIdPlaceholders}) AND (source_attachment_storage_filename IS NULL);`,
          )
          .get(...victims.map((v) => v.messageId)) as { cnt: number }).cnt
      : 0

    // Legacy evidence needing backfill: живи evidence redove, реферирани от
    // victim attachment filenames, чиито source_attachment_is_evidence_copy
    // все още е 0 (никога не е бил copy-нат/repoint-нат) — точно
    // imageEvidenceRequiringCopy множеството, explicit преброено тук за
    // яснота в report-а (същите редове, различен label за читателя).
    const legacyEvidenceNeedingBackfill = imageEvidenceRequiringCopy

    console.log(`Victims, реферирани от ЖИВ (все още не copy-нат) mute evidence: ${victimsReferencedByEvidence}`)
    console.log(`Text evidence redove (self-contained snapshot, source_message_id ще стане NULL, без нужда от copy): ${textEvidenceCount}`)
    console.log(`Image evidence redove, нуждаещи се от protected copy ПРЕДИ safe delete: ${imageEvidenceRequiringCopy}`)
    console.log(`Legacy evidence redove, нуждаещи се от backfill/repoint (is_evidence_copy=0): ${legacyEvidenceNeedingBackfill}`)
    console.log(`(При --mode=apply тези redove ще се copy-нат/repoint-нат ПРЕДИ съответният victim да бъде hard-deleted; ако copy-то се провали, ТОЗИ victim се пропуска за текущия run.)`)

    console.log(`\nЗа реален APPLY: tsx scripts/lafcheRetentionCleanup.ts --mode=apply --confirm-destructive-backlog-cleanup`)
    if (!hasEvidenceCopyColumn && imageEvidenceRequiringCopy > 0) {
      console.log(`⚠ --mode=apply ИЗИСКВА migration 20260818_005 да е приложена първо (image evidence copy protection зависи от колоната) — ${imageEvidenceRequiringCopy} image evidence redove не могат да бъдат безопасно защитени преди това.`)
    }
  } finally {
    messageStore.close()
    moderationStore?.close()
    reportDb.close()
  }
}

type ApplyBatchResult = {
  attemptedCount: number
  deletedCount: number
  skippedDueToEvidenceCopyFailure: string[]
}

/**
 * Mirror на index.ts enforceLafcheRetention() evidence-copy-преди-delete
 * логиката, приложена per-victim в рамките на един batch — двуфазов design
 * (async filesystem copy work ИЗЦЯЛО извън всякаква open DB transaction;
 * самото hard delete e чисто синхронно вътре в hardDeleteRetentionVictims).
 */
async function copyEvidenceAndDeleteBatch(
  messageStore: TopicMessageStore,
  moderationStore: TopicModerationStore,
  topicId: string,
  batch: readonly { messageId: string; attachmentFilename: string | null }[],
  topicAttachmentUploadsPath: string,
  evidenceAttachmentUploadsPath: string,
): Promise<ApplyBatchResult> {
  const skipped: string[] = []
  const deletableIds: string[] = []

  const batchFilenames = batch
    .map((v) => v.attachmentFilename)
    .filter((f): f is string => f !== null)
  const referencedByEvidence = batchFilenames.length > 0
    ? moderationStore.getActiveEvidenceAttachmentReferences(batchFilenames)
    : new Map<string, string[]>()

  for (const victim of batch) {
    if (victim.attachmentFilename !== null && referencedByEvidence.has(victim.attachmentFilename)) {
      const sourceFilename = victim.attachmentFilename
      let copiedFilename: string | null = null
      try {
        if (IMAGE_ATTACHMENT_FILENAME_PATTERN.test(sourceFilename)) {
          const sourceBuffer = await readFile(join(topicAttachmentUploadsPath, sourceFilename))
          const newFilename = `${randomUUID()}.webp`
          await writeWebpAttachmentFile(evidenceAttachmentUploadsPath, newFilename, sourceBuffer)
          copiedFilename = newFilename
        }
      } catch (error) {
        console.error(`[lafche-retention] evidence copy неуспешен за ${sourceFilename}:`, error instanceof Error ? error.message : String(error))
        copiedFilename = null
      }

      if (copiedFilename === null) {
        console.warn(`[lafche-retention] SKIP victim ${victim.messageId} (attachment ${sourceFilename}) тази обиколка — evidence copy неуспешен, retry следващия run.`)
        skipped.push(victim.messageId)
        continue
      }
      moderationStore.repointMuteEvidenceAttachmentToEvidenceCopy(sourceFilename, copiedFilename)
    }
    deletableIds.push(victim.messageId)
  }

  if (deletableIds.length > 0) {
    messageStore.hardDeleteRetentionVictims(topicId, deletableIds)
  }

  return { attemptedCount: batch.length, deletedCount: deletableIds.length, skippedDueToEvidenceCopyFailure: skipped }
}

export type ApplyRunResult = {
  outcome: 'normalized' | 'no-op' | 'blocked-by-evidence-copy-failures' | 'integrity-check-failed' | 'unexpected-remaining-backlog'
  startCount: number
  finalCount: number
  totalDeleted: number
  totalSkipped: number
  integrityOk: boolean
}

export async function runApply(
  databaseFilePath: string,
  topicAttachmentUploadsPath: string,
  evidenceAttachmentUploadsPath: string,
): Promise<ApplyRunResult> {
  const messageStore = await createTopicMessageStore(databaseFilePath)
  const moderationStore = await createTopicModerationStore(databaseFilePath)
  const reportDb = openReportingConnection(databaseFilePath)

  try {
    const startCount = messageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
    console.log(`\n=== Lafche retention APPLY (DESTRUCTIVE) ===\n`)
    console.log(`Начален брой LIVE Lafche root posts: ${startCount}`)
    console.log(`Canonical limit: ${LAFCHE_MESSAGE_HISTORY_LIMIT}`)

    if (startCount <= LAFCHE_MESSAGE_HISTORY_LIMIT) {
      console.log(`DB вече е <= ${LAFCHE_MESSAGE_HISTORY_LIMIT} — нищо за нормализиране. Изход без промени.`)
      return { outcome: 'no-op', startCount, finalCount: startCount, totalDeleted: 0, totalSkipped: 0, integrityOk: true }
    }

    let totalDeleted = 0
    let totalSkipped = 0
    const allSkippedIds: string[] = []
    let batchNumber = 0

    for (;;) {
      const victims = messageStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
      if (victims.length === 0) break

      // Пропускаме victims, които вече сме отбелязали като skip-нати в тази
      // сесия (evidence copy неуспешен) — те остават victims (все още отвъд
      // лимита) при следваща getLafcheRetentionVictims заявка, но НЕ бива да
      // ги опитваме отново в СЪЩИЯ run (щеше да е безкраен loop върху
      // persistently неуспешен copy, напр. трайно липсващ source файл).
      const remainingVictims = victims.filter((v) => !allSkippedIds.includes(v.messageId))
      if (remainingVictims.length === 0) {
        console.log(`\nОстанаха само victims, чийто evidence copy неуспя тази сесия (${allSkippedIds.length}) — спирам, за да не ги пропусна безкрайно. Retry-ни скрипта отделно за тях.`)
        break
      }

      const batch = remainingVictims.slice(0, APPLY_BATCH_SIZE)
      batchNumber++
      console.log(`\nBatch #${batchNumber}: обработвам ${batch.length} victims...`)

      const result = await copyEvidenceAndDeleteBatch(messageStore, moderationStore, LAFCHE_TOPIC_ID, batch, topicAttachmentUploadsPath, evidenceAttachmentUploadsPath)
      totalDeleted += result.deletedCount
      totalSkipped += result.skippedDueToEvidenceCopyFailure.length
      allSkippedIds.push(...result.skippedDueToEvidenceCopyFailure)
      console.log(`Batch #${batchNumber}: deleted=${result.deletedCount}, skipped=${result.skippedDueToEvidenceCopyFailure.length}`)
    }

    const finalCount = messageStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
    console.log(`\n=== Финална валидация ===`)
    console.log(`Общо изтрити: ${totalDeleted}`)
    console.log(`Общо пропуснати (evidence copy неуспешен, ще retry-нат следващия run): ${totalSkipped}`)
    console.log(`Финален брой LIVE Lafche root posts: ${finalCount}`)

    const integrityResult = reportDb.prepare('PRAGMA integrity_check;').all() as Array<{ integrity_check: string }>
    const integrityOk = integrityResult.length === 1 && integrityResult[0]!.integrity_check === 'ok'
    console.log(`PRAGMA integrity_check: ${integrityOk ? 'ok' : JSON.stringify(integrityResult)}`)

    if (!integrityOk) {
      console.error(`[lafche-retention] ГРЕШКА: integrity_check не върна "ok" след apply — DB може да е в неконсистентно състояние. Разследвай веднага.`)
      return { outcome: 'integrity-check-failed', startCount, finalCount, totalDeleted, totalSkipped, integrityOk: false }
    }

    if (finalCount > LAFCHE_MESSAGE_HISTORY_LIMIT && totalSkipped === 0) {
      console.error(`[lafche-retention] ГРЕШКА: финален count (${finalCount}) все още е над лимита (${LAFCHE_MESSAGE_HISTORY_LIMIT}) без нито един skip — неочаквано, разследвай.`)
      return { outcome: 'unexpected-remaining-backlog', startCount, finalCount, totalDeleted, totalSkipped, integrityOk: true }
    }

    if (finalCount > LAFCHE_MESSAGE_HISTORY_LIMIT && totalSkipped > 0) {
      console.warn(`[lafche-retention] DB остава над лимита само заради ${totalSkipped} evidence-copy-blocked victims — очаквано safe поведение (§6: evidence не бива да осиротее). Retry-ни скрипта, след като разследваш защо copy-то не успява (напр. липсващ source файл на диска).`)
      return { outcome: 'blocked-by-evidence-copy-failures', startCount, finalCount, totalDeleted, totalSkipped, integrityOk: true }
    }

    console.log(`\nУспех: DB е нормализирана до <= ${LAFCHE_MESSAGE_HISTORY_LIMIT}. Steady-state retention hook-ът (enforceLafcheRetention) вече ще пази това занапред при всеки нов Lafche пост.`)
    return { outcome: 'normalized', startCount, finalCount, totalDeleted, totalSkipped, integrityOk: true }
  } finally {
    messageStore.close()
    moderationStore.close()
    reportDb.close()
  }
}

async function main(): Promise<void> {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
  const mode = modeArg ? modeArg.slice('--mode='.length) : 'dry-run'
  const hasConfirmFlag = process.argv.includes('--confirm-destructive-backlog-cleanup')

  if (mode !== 'dry-run' && mode !== 'apply') {
    console.error(`[lafche-retention] Непознат --mode=${mode}. Позволени стойности: dry-run (default), apply.`)
    process.exitCode = 1
    return
  }

  if (mode === 'apply' && !hasConfirmFlag) {
    console.error('[lafche-retention] --mode=apply изисква И --confirm-destructive-backlog-cleanup (умишлено висок бар за destructive production операция).')
    console.error('[lafche-retention] Прегледай числата от --mode=dry-run първо. Виж файла header за пълния runbook. Изход без промени.')
    process.exitCode = 1
    return
  }

  const root = serverRoot()
  const databaseFilePath = getServerDatabaseFilePath(root)
  const topicAttachmentUploadsPath = join(root, 'uploads', 'topic-attachments')
  const evidenceAttachmentUploadsPath = join(root, 'uploads', 'topic-mute-evidence-attachments')

  if (mode === 'apply') {
    const result = await runApply(databaseFilePath, topicAttachmentUploadsPath, evidenceAttachmentUploadsPath)
    if (result.outcome === 'integrity-check-failed' || result.outcome === 'unexpected-remaining-backlog') {
      process.exitCode = 1
    }
    return
  }

  await buildDryRunReport(databaseFilePath, topicAttachmentUploadsPath)
}

main().catch((err) => {
  console.error('[lafche-retention] ГРЕШКА:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
