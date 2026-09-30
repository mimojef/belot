/**
 * backfillProfileVisitLinks.ts
 *
 * Контролиран, идемпотентен backfill на profile_visitor_links /
 * profile_ip_links от текущата raw история в site_visit_events (Фаза 1).
 * НЕ се изпълнява автоматично при server startup и НЕ е част от миграцията.
 *
 * Употреба (от server/):
 *   npx tsx scripts/backfillProfileVisitLinks.ts                  # dry-run: само план/броеве
 *   npx tsx scripts/backfillProfileVisitLinks.ts --execute        # реален backfill
 *   ... --db=/path/to/belot-v2.sqlite    (иначе: getServerDatabaseFilePath(--server-root))
 *   ... --server-root=/path/to/server    (по подразбиране: папката над scripts/)
 *   ... --batch-size=500                 (профила на batch транзакция)
 *
 * Две фази: (1) raw site_visit_events на batch-ове; (2) hard-deleted
 * профили от admin_profile_deletion_visitor_snapshots (raw profile_id им вече
 * е NULL — snapshot-ът е единственият оцелял източник).
 *
 * Безопасност:
 *   * всеки batch е кратка BEGIN IMMEDIATE транзакция (keyset по profile_id);
 *   * merge правилото min/max/max(count) прави повторното пускане безопасно
 *     и не удвоява вече dual-written събития (виж backfillProfileVisitLinks);
 *   * нищо не се трие — нито raw, нито compact;
 *   * connection-ът на скрипта има busy_timeout, за да изчаква write-ите на
 *     живия сървър. Сървърният siteVisitStore НЯМА busy_timeout (Фаза 2), така
 *     че page-view write, съвпаднал с batch lock, може да получи SQLITE_BUSY —
 *     дръж batch-овете малки и пускай при нисък трафик.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { backfillProfileVisitLinks } from '../src/db/profileVisitLinks.js'

function readArg(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
}

const execute = process.argv.includes('--execute')
const serverRoot = resolve(readArg('server-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const databasePath = resolve(readArg('db') ?? getServerDatabaseFilePath(serverRoot))
const batchSize = Number.parseInt(readArg('batch-size') ?? '500', 10)

if (!existsSync(databasePath)) {
  console.error(`[backfill] Базата не съществува: ${databasePath}`)
  process.exit(1)
}
if (!Number.isInteger(batchSize) || batchSize <= 0) {
  console.error('[backfill] --batch-size трябва да е положително цяло число.')
  process.exit(1)
}

const database = new DatabaseSync(databasePath, { readOnly: !execute })
database.exec('PRAGMA busy_timeout = 5000;')

const tableExists = (name: string) =>
  database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`).get(name) !== undefined
if (!tableExists('profile_visitor_links') || !tableExists('profile_ip_links')) {
  console.error('[backfill] Липсват profile_visitor_links/profile_ip_links — първо приложи миграция 20260930_001 (server restart).')
  process.exit(1)
}

const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n
const before = {
  rawEvents: count(`SELECT COUNT(*) AS n FROM site_visit_events;`),
  rawProfileEvents: count(`SELECT COUNT(*) AS n FROM site_visit_events WHERE profile_id IS NOT NULL;`),
  visitorLinks: count(`SELECT COUNT(*) AS n FROM profile_visitor_links;`),
  ipLinks: count(`SELECT COUNT(*) AS n FROM profile_ip_links;`),
}

console.log(`[backfill] DB: ${databasePath}`)
console.log(`[backfill] raw events=${before.rawEvents} (с профил=${before.rawProfileEvents}); compact: visitor links=${before.visitorLinks}, ip links=${before.ipLinks}`)

if (!execute) {
  const expectedVisitorLinks = count(`
    SELECT COUNT(*) AS n FROM (SELECT 1 FROM site_visit_events
      WHERE profile_id IS NOT NULL AND length(anonymous_visitor_id) > 0 GROUP BY profile_id, anonymous_visitor_id);
  `)
  const expectedIpLinks = count(`
    SELECT COUNT(*) AS n FROM (SELECT 1 FROM site_visit_events
      WHERE profile_id IS NOT NULL AND ip_address IS NOT NULL AND length(trim(ip_address)) > 0 GROUP BY profile_id, ip_address);
  `)
  const deletedSnapshotProfiles = count(`
    SELECT COUNT(DISTINCT s.deleted_profile_id) AS n FROM admin_profile_deletion_visitor_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = s.deleted_profile_id);
  `)
  console.log(`[backfill] DRY-RUN: raw уникални profile<->visitor=${expectedVisitorLinks}, profile<->ip=${expectedIpLinks}; hard-deleted профили със snapshot=${deletedSnapshotProfiles}.`)
  console.log('[backfill] Нищо не е записано. Добави --execute за реален backfill.')
  database.close()
  process.exit(0)
}

const startedAt = Date.now()
const result = backfillProfileVisitLinks(database, {
  batchSize,
  onBatch: ({ batch, profilesInBatch }) => {
    if (batch % 20 === 0) console.log(`[backfill] batch ${batch} (${profilesInBatch} профила)…`)
  },
})
const after = {
  visitorLinks: count(`SELECT COUNT(*) AS n FROM profile_visitor_links;`),
  ipLinks: count(`SELECT COUNT(*) AS n FROM profile_ip_links;`),
}
database.close()

console.log(`[backfill] Готово за ${Date.now() - startedAt}ms: batches=${result.batches}, профили=${result.profilesProcessed}, upsert-нати visitor links=${result.visitorLinkRowsWritten}, ip links=${result.ipLinkRowsWritten}.`)
console.log(`[backfill] Hard-deleted профили (от admin_profile_deletion_visitor_snapshots): visitor links=${result.deletedSnapshotVisitorLinkRowsWritten}, ip links=${result.deletedSnapshotIpLinkRowsWritten}.`)
console.log(`[backfill] compact след: visitor links=${after.visitorLinks}, ip links=${after.ipLinks}. Провери с scripts/verifyProfileVisitLinks.ts.`)
