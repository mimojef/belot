// CLI за извличане на belot hand журнала на VPS (само за собственика/админ
// със shell достъп — няма HTTP endpoint).
//
//   node dist/diagnostics/belotHandJournal/belotHandJournalCli.js --room=<roomId>
//   node dist/diagnostics/belotHandJournal/belotHandJournalCli.js --profile=<profileId> --since=2026-10-01
//   node dist/diagnostics/belotHandJournal/belotHandJournalCli.js --anomalies --since=2026-10-13 --format=json
//
// Флагове: --room --match --hand --profile --since --until (ISO дата/време)
//          --anomalies (само аномалии) --archives (търси и в .jsonl.gz
//          архивите) --format=text|json|jsonl --dir=<диагностична директория>
//          --limit=<брой> --verify-sweeps (независимо преизчисляване на
//          „Долу картите“ гаранцията от записаните ръце)

import { access } from 'node:fs/promises'
import {
  createBelotHandJournalStore,
  getBelotHandJournalArchiveDirectory,
  getBelotHandJournalDatabasePath,
  getDefaultBelotHandJournalDirectory,
  listBelotHandJournalArchiveFiles,
  readBelotHandJournalArchive,
  type BelotHandJournalQuery,
  type BelotHandJournalStoredEvent,
} from './belotHandJournalStore.js'
import { formatBelotHandJournalReport } from './formatBelotHandJournalReport.js'
import { verifyBelotSweepEventsOffline } from './verifyBelotSweepEventsOffline.js'

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue
    const [key, ...rest] = raw.slice(2).split('=')
    args.set(key!, rest.length > 0 ? rest.join('=') : 'true')
  }
  return args
}

function parseTime(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`Невалидна стойност за --${name}: ${value}`)
  return parsed
}

function matchesQuery(event: BelotHandJournalStoredEvent, query: BelotHandJournalQuery, handIdsForProfile: Set<string> | null): boolean {
  if (query.roomId && event.roomId !== query.roomId) return false
  if (query.matchId && event.matchId !== query.matchId) return false
  if (query.handId && event.handId !== query.handId) return false
  if (handIdsForProfile && (event.handId === null || !handIdsForProfile.has(event.handId))) return false
  if (query.sinceMs !== undefined && event.occurredAtMs < query.sinceMs) return false
  if (query.untilMs !== undefined && event.occurredAtMs >= query.untilMs) return false
  if (query.anomaliesOnly && event.severity !== 'anomaly') return false
  return true
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.has('help')) {
    console.log('Usage: belotHandJournalCli --room=|--match=|--hand=|--profile= [--since=] [--until=] [--anomalies] [--archives] [--format=text|json|jsonl] [--dir=] [--limit=] [--verify-sweeps]')
    return
  }
  const directory = args.get('dir') ?? getDefaultBelotHandJournalDirectory()
  const query: BelotHandJournalQuery = {
    roomId: args.get('room'),
    matchId: args.get('match'),
    handId: args.get('hand'),
    profileId: args.get('profile'),
    sinceMs: parseTime(args.get('since'), 'since'),
    untilMs: parseTime(args.get('until'), 'until'),
    anomaliesOnly: args.has('anomalies'),
    limit: args.has('limit') ? Number(args.get('limit')) : undefined,
  }
  if (!query.roomId && !query.matchId && !query.handId && !query.profileId && query.sinceMs === undefined && !query.anomaliesOnly) {
    throw new Error('Задай поне един филтър: --room, --match, --hand, --profile, --since или --anomalies')
  }

  const events: BelotHandJournalStoredEvent[] = []
  const databasePath = getBelotHandJournalDatabasePath(directory)
  try {
    await access(databasePath)
    const store = await createBelotHandJournalStore({ directory, readOnly: true })
    try {
      events.push(...store.queryEvents(query))
    } finally {
      store.close()
    }
  } catch (error) {
    console.error(`[belot-hand-journal] базата не е достъпна (${databasePath}): ${error instanceof Error ? error.message : String(error)}`)
  }

  if (args.has('archives')) {
    for (const file of await listBelotHandJournalArchiveFiles(getBelotHandJournalArchiveDirectory(directory))) {
      const archived = await readBelotHandJournalArchive(file)
      const handIdsForProfile = query.profileId
        ? new Set(
            archived
              .filter((event) => event.eventType === 'hand_started' && event.profileIds?.includes(query.profileId!))
              .map((event) => event.handId!)
          )
        : null
      events.push(...archived.filter((event) => matchesQuery(event, query, handIdsForProfile)))
    }
  }

  if (args.has('verify-sweeps')) {
    const results = verifyBelotSweepEventsOffline(events)
    for (const result of results) {
      console.log(`[verify-sweeps] ${result.ok ? 'OK ' : 'FAIL'} ${result.eventType} room=${result.roomId} hand=${result.handId ?? '-'} claimant=${result.claimantSeat} at=${result.occurredAt} eligible=${result.eligible}`)
    }
    console.log(`[verify-sweeps] checked=${results.length} failed=${results.filter((r) => !r.ok).length}`)
    if (results.some((r) => !r.ok)) process.exitCode = 2
  }

  const format = args.get('format') ?? 'text'
  if (format === 'json') {
    console.log(JSON.stringify(events, null, 2))
  } else if (format === 'jsonl') {
    for (const event of events) console.log(JSON.stringify(event))
  } else {
    console.log(formatBelotHandJournalReport(events))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
