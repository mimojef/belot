// Четене на belot hand журнала от активната SQLite база И от архивите
// (.zst, както и стари .gz) — без дублиране (по уникалното id на събитието,
// AUTOINCREMENT не се преизползва) и подредено по id (хронологично).
//
// Архивите са дневни партиди; четат се поточно само файловете, чийто ден
// попада в [since, until], а редовете се филтрират по подниз преди JSON
// парсване.

import { access } from 'node:fs/promises'
import { listBelotJournalArchiveFiles, type BelotJournalArchiveFile } from './belotHandJournalArchiveFiles.js'
import { readBelotJournalArchiveLines } from './belotHandJournalCompression.js'
import {
  createBelotHandJournalStore,
  getBelotHandJournalArchiveDirectory,
  getBelotHandJournalDatabasePath,
  toUtcDay,
  type BelotHandJournalQuery,
  type BelotHandJournalStoredEvent,
} from './belotHandJournalStore.js'

export type LoadBelotHandJournalResult = {
  events: BelotHandJournalStoredEvent[]
  fromDatabase: number
  fromArchives: number
  duplicatesSkipped: number
  archivesRead: string[]
  errors: string[]
}

const HAND_ID_RE = /"handId":"(h_[0-9a-f]+)"/

function matchesQuery(event: BelotHandJournalStoredEvent, query: BelotHandJournalQuery, handIds: Set<string> | null): boolean {
  if (query.roomId && event.roomId !== query.roomId) return false
  if (query.matchId && event.matchId !== query.matchId) return false
  if (query.handId && event.handId !== query.handId) return false
  if (handIds && (event.handId === null || !handIds.has(event.handId))) return false
  if (query.sinceMs !== undefined && event.occurredAtMs < query.sinceMs) return false
  if (query.untilMs !== undefined && event.occurredAtMs >= query.untilMs) return false
  if (query.anomaliesOnly && event.severity !== 'anomaly') return false
  if (query.eventTypes && query.eventTypes.length > 0 && !query.eventTypes.includes(event.eventType)) return false
  return true
}

function quickReject(line: string, query: BelotHandJournalQuery): boolean {
  if (query.roomId && !line.includes(`"roomId":${JSON.stringify(query.roomId)}`)) return true
  if (query.matchId && !line.includes(`"matchId":${JSON.stringify(query.matchId)}`)) return true
  if (query.handId && !line.includes(`"handId":${JSON.stringify(query.handId)}`)) return true
  if (query.anomaliesOnly && !line.includes('"severity":"anomaly"')) return true
  return false
}

export async function loadBelotHandJournalEvents(params: {
  directory: string
  query: BelotHandJournalQuery
  includeArchives?: boolean
  compression?: { disableNodeZstd?: boolean; disableZstdCli?: boolean }
}): Promise<LoadBelotHandJournalResult> {
  const { directory, query } = params
  const result: LoadBelotHandJournalResult = {
    events: [],
    fromDatabase: 0,
    fromArchives: 0,
    duplicatesSkipped: 0,
    archivesRead: [],
    errors: [],
  }
  const byId = new Map<number, BelotHandJournalStoredEvent>()
  const add = (event: BelotHandJournalStoredEvent, source: 'db' | 'archive') => {
    if (byId.has(event.id)) {
      result.duplicatesSkipped += 1
      return
    }
    byId.set(event.id, event)
    if (source === 'db') result.fromDatabase += 1
    else result.fromArchives += 1
  }

  const databasePath = getBelotHandJournalDatabasePath(directory)
  let store: Awaited<ReturnType<typeof createBelotHandJournalStore>> | null = null
  try {
    await access(databasePath)
    store = await createBelotHandJournalStore({ directory, readOnly: true })
  } catch (error) {
    result.errors.push(`базата не е достъпна (${databasePath}): ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (store) {
      for (const event of store.queryEvents(query)) add(event, 'db')
    }

    if (params.includeArchives !== false) {
      const sinceDay = query.sinceMs !== undefined ? toUtcDay(query.sinceMs) : null
      const untilDay = query.untilMs !== undefined ? toUtcDay(query.untilMs - 1) : null
      const archives = (await listBelotJournalArchiveFiles(getBelotHandJournalArchiveDirectory(directory))).filter(
        (file: BelotJournalArchiveFile) =>
          file.kind === 'archive' && (sinceDay === null || file.day >= sinceDay) && (untilDay === null || file.day <= untilDay),
      )
      const readArchive = async (file: BelotJournalArchiveFile, onLine: (line: string) => void) => {
        try {
          for await (const line of readBelotJournalArchiveLines(file.path, params.compression)) onLine(line)
        } catch (error) {
          result.errors.push(`архивът ${file.name} не може да бъде прочетен: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // По профил: 1) раздаванията от hand_started (в архивите и в базата);
      // 2) всички събития на тези раздавания — в архивите и в базата
      //    (раздаване около границата може да е частично в двете).
      let profileHandIds: Set<string> | null = null
      if (query.profileId) {
        profileHandIds = new Set<string>()
        for (const event of byId.values()) {
          if (event.eventType === 'hand_started' && event.handId) profileHandIds.add(event.handId)
        }
        const archiveOnlyHandIds = new Set<string>()
        const needle = JSON.stringify(query.profileId)
        for (const file of archives) {
          await readArchive(file, (line) => {
            if (!line.includes('"eventType":"hand_started"') || !line.includes(needle)) return
            const event = JSON.parse(line) as BelotHandJournalStoredEvent
            if (event.handId && event.profileIds?.includes(query.profileId!) && !profileHandIds!.has(event.handId)) {
              profileHandIds!.add(event.handId)
              archiveOnlyHandIds.add(event.handId)
            }
          })
        }
        // Раздаване с hand_started в архива може да продължава в базата.
        if (store && archiveOnlyHandIds.size > 0) {
          const ids = [...archiveOnlyHandIds]
          for (let index = 0; index < ids.length; index += 500) {
            for (const event of store.queryEvents({ ...query, profileId: undefined, handIds: ids.slice(index, index + 500) })) add(event, 'db')
          }
        }
      }

      const archiveQuery: BelotHandJournalQuery = { ...query, profileId: undefined }
      for (const file of archives) {
        result.archivesRead.push(file.name)
        await readArchive(file, (line) => {
          if (quickReject(line, archiveQuery)) return
          if (profileHandIds) {
            const match = HAND_ID_RE.exec(line)
            if (!match || !profileHandIds.has(match[1]!)) return
          }
          const event = JSON.parse(line) as BelotHandJournalStoredEvent
          if (matchesQuery(event, archiveQuery, profileHandIds)) add(event, 'archive')
        })
      }
    }
  } finally {
    store?.close()
  }

  result.events = [...byId.values()].sort((left, right) => left.id - right.id)
  if (query.limit !== undefined) result.events = result.events.slice(0, query.limit)
  return result
}
