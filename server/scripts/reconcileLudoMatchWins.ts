/**
 * reconcileLudoMatchWins.ts
 *
 * Backfill за Ludo победите, пропуснати от 007130f (recordCompletedGameForProfile
 * записваше Ludo мачовете с hardcoded didWin=false).
 *
 * Кандидати (виж LUDO_MATCH_WIN_RECONCILIATION_CANDIDATES_SQL в
 * playerProgressStore.ts): съществуващ profile_completed_game_ledger ред със
 * source='ludo_match', did_win=0, чийто ludo_room_matches ред е finished с
 * winner_profile_id = ledger.profile_id. Ludo мачове без ledger ред (отпреди
 * 007130f) не се добавят; completed_games_count не се пипа.
 *
 * Употреба (от server/):
 *   tsx scripts/reconcileLudoMatchWins.ts --db=<path>          # read-only preview
 *   tsx scripts/reconcileLudoMatchWins.ts --db=<path> --apply  # прилага корекцията
 *
 * Preview режимът отваря базата readOnly — не може да модифицира DB.
 * --apply е идемпотентен: второ изпълнение -> 0 корекции.
 * Изисква приложена миграция 20260928_002 (did_win колона).
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createPlayerProgressStore,
  LUDO_MATCH_WIN_RECONCILIATION_PREVIEW_SQL,
  toLudoMatchWinReconciliationPreview,
  type LudoMatchWinReconciliationPreview,
} from '../src/db/playerProgressStore.js'

const args = process.argv.slice(2)
const dbArg = args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length)
const shouldApply = args.includes('--apply')

if (!dbArg) {
  console.error('Липсва --db=<path> към SQLite базата.')
  process.exit(1)
}

const databaseFilePath = resolve(dbArg)

if (!existsSync(databaseFilePath)) {
  console.error(`Базата не съществува: ${databaseFilePath}`)
  process.exit(1)
}

function printPreview(title: string, preview: LudoMatchWinReconciliationPreview): void {
  console.log(`\n${title}`)
  if (preview.profiles.length > 0) {
    console.table(
      preview.profiles.map((row) => ({
        profileId: row.profileId,
        displayName: row.displayName ?? '',
        missingWins: row.missingWins,
      })),
    )
  }
  console.log(`Профили за корекция: ${preview.totalProfiles}`)
  console.log(`Липсващи Ludo победи: ${preview.totalMissingWins}`)
}

function readPreviewReadOnly(): LudoMatchWinReconciliationPreview {
  const database = new DatabaseSync(databaseFilePath, { open: true, readOnly: true })
  try {
    const columns = database
      .prepare(`SELECT name FROM pragma_table_info('profile_completed_game_ledger')`)
      .all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'did_win')) {
      throw new Error('profile_completed_game_ledger.did_win липсва — миграция 20260928_002 не е приложена.')
    }
    const rows = database.prepare(LUDO_MATCH_WIN_RECONCILIATION_PREVIEW_SQL).all() as Array<{
      profile_id: string
      display_name: string | null
      missing_wins: number
    }>
    return toLudoMatchWinReconciliationPreview(rows)
  } finally {
    database.close()
  }
}

const preview = readPreviewReadOnly()
printPreview(`Ludo win reconciliation preview (${databaseFilePath})`, preview)

if (!shouldApply) {
  console.log('\nPreview режим — базата НЕ е променена. Добави --apply за корекция.')
} else {
  const store = await createPlayerProgressStore(databaseFilePath)
  try {
    const result = store.reconcileLudoMatchWins()
    console.log(`\nПриложено: профили=${result.profilesAffected}, победи=${result.winsReconciled}`)
    printPreview('Остатък след корекцията (очаква се 0):', store.previewLudoMatchWinReconciliation())
  } finally {
    store.close()
  }
}
