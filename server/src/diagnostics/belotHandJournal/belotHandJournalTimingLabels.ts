// Phase 0B timing label-и на belot hand журнала — фиксиран, краен списък
// (никога day/id/номер на порция в името).
//
// Sync label-ите мерят реална синхронна работа в главната нишка (група
// 'journal'); async label-ите са wall време през await-и (група
// 'journalAsync') и НЕ означават блокиран event loop.

export const BELOT_HAND_JOURNAL_TIMING_LABELS = {
  // ── sync ──
  deleteDayChunk: 'maintenance.deleteDayChunk',
  deleteDayIdsChunk: 'maintenance.deleteDayIdsChunk',
  deleteScoredHandsChunk: 'maintenance.deleteScoredHandsChunk',
  reclaimFreelistRead: 'reclaim.freelistRead',
  reclaimVacuumStep: 'reclaim.vacuumStep',
  reclaimCheckpoint: 'reclaim.checkpoint',
  archivePageRead: 'archive.pageRead',
  archivePageEncode: 'archive.pageEncode',
  // ── async (wall) ──
  storageCheck: 'storageCheck',
  maintenance: 'maintenance',
  archiveCompress: 'archive.compress',
  archiveVerify: 'archive.verify',
  archiveFileSync: 'archive.fileSync',
  archiveDirectorySync: 'archive.directorySync',
  reclaimPre: 'maintenance.reclaim.pre',
  reclaimPost: 'maintenance.reclaim.post',
  reclaimFinal: 'maintenance.reclaim.final',
} as const

const ASYNC_TIMING_LABELS: ReadonlySet<string> = new Set([
  BELOT_HAND_JOURNAL_TIMING_LABELS.storageCheck,
  BELOT_HAND_JOURNAL_TIMING_LABELS.maintenance,
  BELOT_HAND_JOURNAL_TIMING_LABELS.archiveCompress,
  BELOT_HAND_JOURNAL_TIMING_LABELS.archiveVerify,
  BELOT_HAND_JOURNAL_TIMING_LABELS.archiveFileSync,
  BELOT_HAND_JOURNAL_TIMING_LABELS.archiveDirectorySync,
  BELOT_HAND_JOURNAL_TIMING_LABELS.reclaimPre,
  BELOT_HAND_JOURNAL_TIMING_LABELS.reclaimPost,
  BELOT_HAND_JOURNAL_TIMING_LABELS.reclaimFinal,
])

// true → 'journalAsync' (wall), false → 'journal' (sync main-thread).
export function isBelotHandJournalAsyncTimingLabel(label: string): boolean {
  return ASYNC_TIMING_LABELS.has(label)
}
