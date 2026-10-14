// CLI за извличане на belot hand журнала на VPS (само за собственика/админ
// със shell достъп — няма HTTP endpoint).
//
//   npm run -s diagnostics:belot-hands:prod -- --room=<roomId>
//   npm run -s diagnostics:belot-hands:prod -- --profile=<profileId> --since=2026-10-01
//   npm run -s diagnostics:belot-hands:prod -- --anomalies --since=2026-10-13 --format=json
//   npm run -s diagnostics:belot-hands:prod -- --status
//
// Флагове: --room --match --hand --profile --since --until (ISO дата/време)
//          --anomalies (само аномалии) --format=text|json|jsonl
//          --dir=<диагностична директория> --limit=<брой>
//          --verify-sweeps (независимо преизчисляване на „Долу картите“
//          гаранцията от записаните ръце)
//          --no-archives (само активната база; по подразбиране се търси и в
//          архивите .zst/.gz за дните в [since, until]; --archives се
//          приема за съвместимост)
//          --status (размер, архиви, ZSTD, последни събития на хранилището)

import { access } from 'node:fs/promises'
import {
  isNodeZstdAvailable,
  isZstdCliAvailable,
  selectBelotJournalCompressionBackend,
} from './belotHandJournalCompression.js'
import {
  createBelotHandJournalStore,
  getBelotHandJournalDatabasePath,
  getDefaultBelotHandJournalDirectory,
  type BelotHandJournalQuery,
} from './belotHandJournalStore.js'
import { formatBelotHandJournalReport } from './formatBelotHandJournalReport.js'
import { loadBelotHandJournalEvents } from './loadBelotHandJournalEvents.js'
import {
  measureBelotHandJournalStorage,
  resolveBelotHandJournalStorageConfig,
  BELOT_HAND_JOURNAL_SYSTEM_ROOM_ID,
} from './runBelotHandJournalMaintenance.js'
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

const mb = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`)

async function printStatus(directory: string): Promise<void> {
  const config = resolveBelotHandJournalStorageConfig()
  const databasePath = getBelotHandJournalDatabasePath(directory)
  console.log(`Директория: ${directory}`)
  console.log(
    `Политика: активни ${config.activeDays} дни в SQLite, общо ${config.maxAgeDays} дни, ZSTD ниво ${config.zstdLevel}, лимит ${mb(config.maxTotalBytes)} (предупреждение при ${Math.round(config.warnRatio * 100)}%), мин. свободно място ${mb(config.minFreeDiskBytes)}`,
  )
  console.log(
    `ZSTD: вграден в Node ${process.version}: ${isNodeZstdAvailable() ? 'да' : 'не'}; zstd CLI: ${isZstdCliAvailable() ? 'да' : 'не'}; нови архиви ще се пишат с: ${selectBelotJournalCompressionBackend({ zstdLevel: config.zstdLevel })}`,
  )
  try {
    await access(databasePath)
  } catch {
    console.log(`Базата още не съществува (${databasePath}).`)
    return
  }
  const store = await createBelotHandJournalStore({ directory, readOnly: true })
  try {
    const usage = await measureBelotHandJournalStorage(store)
    console.log(
      `Размер общо: ${mb(usage.totalBytes)} (${Math.round((usage.totalBytes / config.maxTotalBytes) * 100)}% от лимита) = база ${mb(usage.dbBytes)} + WAL ${mb(usage.walBytes)} + SHM ${mb(usage.shmBytes)} + .zst ${mb(usage.zstArchiveBytes)} + .gz ${mb(usage.gzArchiveBytes)} + .tmp ${mb(usage.tmpBytes)} + .corrupt ${mb(usage.corruptBytes)}`,
    )
    const days = store.listDays()
    console.log(`Активни дни в SQLite: ${days.length > 0 ? `${days[0]} … ${days[days.length - 1]} (${days.length})` : 'няма'}`)
    const archives = usage.archiveFiles
    console.log(`Архиви: ${archives.filter((file) => file.kind === 'archive').length}${archives.length > 0 ? ` (${archives[0]!.day} … ${archives[archives.length - 1]!.day})` : ''}`)
    for (const file of archives) {
      console.log(`  ${file.kind.padEnd(7)} ${file.name}  ${mb(file.bytes)}`)
    }
    const storageEvents = store
      .queryEvents({ roomId: BELOT_HAND_JOURNAL_SYSTEM_ROOM_ID })
      .slice(-15)
    console.log(`Последни събития на хранилището (${storageEvents.length}):`)
    for (const event of storageEvents) {
      const payload = event.payload as { kind?: string; detail?: string }
      console.log(`  ${event.occurredAt} ${event.severity === 'anomaly' ? '!!' : '  '} ${payload.kind}: ${payload.detail}`)
    }
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.has('help')) {
    console.log(
      'Usage: belotHandJournalCli --room=|--match=|--hand=|--profile= [--since=] [--until=] [--anomalies] [--no-archives] [--format=text|json|jsonl] [--dir=] [--limit=] [--verify-sweeps] | --status',
    )
    return
  }
  const directory = args.get('dir') ?? getDefaultBelotHandJournalDirectory()
  if (args.has('status')) {
    await printStatus(directory)
    return
  }
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
    throw new Error('Задай поне един филтър: --room, --match, --hand, --profile, --since, --anomalies или --status')
  }

  const loaded = await loadBelotHandJournalEvents({ directory, query, includeArchives: !args.has('no-archives') })
  for (const error of loaded.errors) console.error(`[belot-hand-journal] ${error}`)
  console.error(
    `[belot-hand-journal] събития: ${loaded.events.length} (база ${loaded.fromDatabase}, архиви ${loaded.fromArchives} от ${loaded.archivesRead.length} файла, пропуснати дубликати ${loaded.duplicatesSkipped})`,
  )
  const events = loaded.events

  if (args.has('verify-sweeps')) {
    const results = verifyBelotSweepEventsOffline(events)
    for (const result of results) {
      console.error(`[verify-sweeps] ${result.ok ? 'OK ' : 'FAIL'} ${result.eventType} room=${result.roomId} hand=${result.handId ?? '-'} claimant=${result.claimantSeat} at=${result.occurredAt} eligible=${result.eligible}`)
    }
    console.error(`[verify-sweeps] checked=${results.length} failed=${results.filter((r) => !r.ok).length}`)
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
