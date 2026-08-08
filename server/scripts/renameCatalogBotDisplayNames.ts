/**
 * One-time rename of the 300 permanent catalog bot profiles
 * (bot-f-000..149, bot-m-000..149) to the fixed A–F + 6-digit display names
 * in server/src/db/botCatalogDisplayNames.ts.
 *
 * SAFETY:
 *  - Dry-run mode is DEFAULT. Nothing is written unless --apply is passed.
 *  - Only writes profiles.display_name / profiles.normalized_display_name /
 *    profiles.updated_at, scoped to profile_kind='bot'. No other column, no
 *    other table (wallet, progress, bot_metadata, bot_allowed_stakes) is
 *    ever written.
 *  - Runs pre-flight checks (exact 300/150/150 counts, format, uniqueness
 *    against every existing profile) before opening any transaction; aborts
 *    with no writes if any check fails.
 *  - Snapshots every non-name field for all 300 targets before the update
 *    and re-snapshots after, inside the same transaction — rolls back
 *    automatically if anything besides the name fields changed.
 *  - Idempotent: safe to re-run — if names are already applied, the
 *    uniqueness pre-check will simply find each bot already holding its own
 *    target name (no-op update, changes=1 still expected since the row
 *    exists) rather than colliding with another profile.
 *
 * USAGE:
 *   npx tsx server/scripts/renameCatalogBotDisplayNames.ts [options]
 *
 * OPTIONS:
 *   --server-root=<path>   Path to server directory (default: cwd)
 *   --apply                Write to DB (default: dry-run)
 *
 * COMMANDS:
 *   dry-run (default, from project root):
 *     npx tsx server/scripts/renameCatalogBotDisplayNames.ts --server-root=server
 *
 *   apply (writes to DB):
 *     npx tsx server/scripts/renameCatalogBotDisplayNames.ts --server-root=server --apply
 */

import { resolve } from 'node:path'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { renameCatalogBotDisplayNames } from '../src/db/renameBotCatalogDisplayNames.js'

type SqliteModule = typeof import('node:sqlite')

const args = process.argv.slice(2)
const applyMode = args.includes('--apply')
const serverRootArg = args.find((a) => a.startsWith('--server-root='))?.split('=')[1]
const serverRoot = serverRootArg ? resolve(serverRootArg) : resolve('.')
const dbFilePath = getServerDatabaseFilePath(serverRoot)

async function main(): Promise<void> {
  console.log(`\nRename catalog bot display names`)
  console.log(`  Mode: ${applyMode ? '⚡ APPLY (writes to DB)' : '🔍 DRY-RUN (no writes)'}`)
  console.log(`  DB:   ${dbFilePath}\n`)

  const sqliteModule: SqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(dbFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')

  try {
    const result = renameCatalogBotDisplayNames(database, { apply: applyMode })

    if (result.preflightIssues.length > 0) {
      console.error(`Pre-flight FAILED — ${result.preflightIssues.length} issue(s), no writes performed:\n`)
      for (const issue of result.preflightIssues) {
        console.error(`  ${issue.profileId}: ${issue.reason}`)
      }
      process.exit(1)
    }

    console.log(`Pre-flight OK — ${result.totalTargets} target profiles, per-letter counts:`)
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F']) {
      console.log(`  ${letter}: ${result.perLetterCounts[letter] ?? 0}`)
    }

    if (!result.applied) {
      console.log(`\nDry-run complete — no writes performed. Run with --apply to write.`)
      return
    }

    if (result.snapshotMismatches.length > 0) {
      console.error(`\nABORTED — non-name fields changed for ${result.snapshotMismatches.length} profile(s), rolled back:`)
      for (const mismatch of result.snapshotMismatches) {
        console.error(`  ${mismatch.profileId}: ${mismatch.reason}`)
      }
      process.exit(1)
    }

    console.log(`\nApplied — renamed ${result.renamedCount} bot profile(s). All non-name fields verified unchanged.`)
  } finally {
    database.close()
  }
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
