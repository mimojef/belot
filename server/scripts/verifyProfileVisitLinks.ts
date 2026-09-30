/**
 * verifyProfileVisitLinks.ts
 *
 * READ-ONLY проверка raw site_visit_events <-> compact profile_visitor_links /
 * profile_ip_links (Фаза 1). Отваря базата readOnly и чете в една read
 * транзакция (WAL snapshot) — безопасно срещу жив сървър. Exit code 1 при
 * каквато и да е разлика.
 *
 * Употреба (от server/):
 *   npx tsx scripts/verifyProfileVisitLinks.ts
 *   ... --db=/path/to/belot-v2.sqlite    (иначе: getServerDatabaseFilePath(--server-root))
 *   ... --server-root=/path/to/server
 *   ... --sample-size=200                (профили/IP-та за linked-profile и shared-IP проверките)
 *
 * Проверява (виж profileVisitLinkVerification.ts за правилата):
 *   A. уникални profile<->visitor връзки raw vs compact
 *   B. уникални profile<->IP връзки raw vs compact
 *   C. first_seen / last_seen / event_count за ВСЯКА връзка (не само sample)
 *   D. linked-profile equivalence (raw алгоритъм vs compact reader)
 *   E. shared-IP equivalence
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { verifyProfileVisitLinks } from '../src/db/profileVisitLinkVerification.js'

function readArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
}

const serverRoot = resolve(readArg('server-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const databasePath = resolve(readArg('db') ?? getServerDatabaseFilePath(serverRoot))
const sampleSize = Number.parseInt(readArg('sample-size') ?? '200', 10)

if (!existsSync(databasePath)) {
  console.error(`[verify] Базата не съществува: ${databasePath}`)
  process.exit(1)
}

const database = new DatabaseSync(databasePath, { readOnly: true })
database.exec('PRAGMA busy_timeout = 5000;')

const startedAt = Date.now()
const report = verifyProfileVisitLinks(database, { sampleSize })
database.close()

const line = (kind: string, s: typeof report.visitor) =>
  `  ${kind}: raw=${s.rawUniqueLinks} compact=${s.compactUniqueLinks} comparable=${s.compactComparableLinks} ` +
  `exact=${s.exactMatches} purged-history=${s.purgedHistoryMatches} deleted-profile-extras=${s.deletedProfileExtras} purged-only-extras=${s.purgedOnlyExtras}`

console.log(`[verify] DB: ${databasePath} (${Date.now() - startedAt}ms)`)
console.log(`[verify] raw events=${report.rawEventCount}, rawFloor=${report.rawFloor ?? '—'}`)
console.log(line('A profile<->visitor', report.visitor))
console.log(line('B profile<->ip     ', report.ip))
console.log(`  D linked-profile samples=${report.linkedProfileSamples}, E shared-ip samples=${report.sharedIpSamples}`)
report.samples.forEach((sample) => console.log(`  sample ${sample}`))

if (!report.ok) {
  console.error('[verify] FAIL — разлики между raw и compact:')
  report.failures.forEach((failure) => console.error(`  - ${failure}`))
  process.exit(1)
}
console.log('[verify] OK — compact историята е еквивалентна на raw в raw прозореца.')
