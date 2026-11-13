// Гласов чат — Етап 6: живо състояние на гласовите стаи за админ панела.
//
// Извиква се САМО от админ API-то (отворен панел), никога от игровия hot
// path. Всички LiveKit заявки минават през съществуващия dispatcher
// (≤4 едновременни, ограничени опашки, circuit breaker, timeout), с
// приоритет 'normal' — отнемането на права и DeleteRoom остават с предимство.
//
//   * ListRooms(само живите имена на активните маси) — една заявка;
//   * ListParticipants само за стаи с участници, най-много N на обновяване.
//
// Резултатът се кешира (по подразбиране 20 s) и се споделя от едновременните
// заявки (single-flight). Без идентичности, имена или метаданни — само броеве.
// При липсваща конфигурация / отворен breaker / грешка стойностите са null
// („Недостъпно“), никога 0.

import type { VoiceLiveKitApi } from './voiceLiveKitApi.js'
import type { VoiceLiveKitDispatcher } from './voiceLiveKitDispatcher.js'
import type { VoiceAdminTableRow } from './voiceChatService.js'

export const VOICE_ADMIN_LIVE_CACHE_TTL_MS = 20_000
export const VOICE_ADMIN_LIVE_MAX_PARTICIPANT_QUERIES = 20

export type VoiceAdminLiveRoomCounts = {
  /** null = не е проверено/недостъпно (не 0). */
  participants: number | null
  microphoneOn: number | null
  listening: number | null
}

export type VoiceAdminLiveTable = VoiceAdminTableRow & {
  /** Има ли реална LiveKit стая с това име (null = неизвестно). */
  roomExists: boolean | null
  counts: VoiceAdminLiveRoomCounts
}

export type VoiceAdminLiveSnapshot = {
  status: 'ok' | 'partial' | 'not_configured' | 'unavailable'
  /** Код без лични данни: breaker_open, queue_full, transient, rejected… */
  reason: string | null
  sampledAt: string | null
  totals: {
    reservedTables: number
    activeRooms: number | null
    participants: number | null
    microphoneOn: number | null
    listening: number | null
  }
  tables: VoiceAdminLiveTable[]
}

export type VoiceAdminLiveProbe = {
  getSnapshot: () => Promise<VoiceAdminLiveSnapshot>
  /** Изчиства кешираните LiveKit данни (напр. след смяна на режима). */
  invalidate: () => void
}

const UNKNOWN_COUNTS: VoiceAdminLiveRoomCounts = { participants: null, microphoneOn: null, listening: null }
const ZERO_COUNTS: VoiceAdminLiveRoomCounts = { participants: 0, microphoneOn: 0, listening: 0 }

/**
 * Кешира се САМО отговорът на LiveKit (по име на стая). Списъкът с маси и
 * резервираните слотове се четат свежо при всяко извикване — прекратена маса
 * изчезва веднага, без остарели кеширани данни.
 */
type LiveSample =
  | { kind: 'offline'; status: 'not_configured' | 'unavailable'; reason: string | null }
  | { kind: 'ok'; sampledAt: string; partial: boolean; rooms: ReadonlyMap<string, { exists: boolean; counts: VoiceAdminLiveRoomCounts }> }

export function createVoiceAdminLiveProbe(deps: {
  listTables: () => VoiceAdminTableRow[]
  api: Pick<VoiceLiveKitApi, 'listRooms' | 'listParticipants'> | null
  dispatcher: VoiceLiveKitDispatcher
  now?: () => number
  cacheTtlMs?: number
  maxParticipantQueries?: number
}): VoiceAdminLiveProbe {
  const now = deps.now ?? (() => Date.now())
  const cacheTtlMs = deps.cacheTtlMs ?? VOICE_ADMIN_LIVE_CACHE_TTL_MS
  const maxParticipantQueries = deps.maxParticipantQueries ?? VOICE_ADMIN_LIVE_MAX_PARTICIPANT_QUERIES
  let cached: { at: number; sample: LiveSample } | null = null
  let inFlight: Promise<LiveSample> | null = null
  /** invalidate() -> по-старо извличане не записва кеша и не се преизползва. */
  let epoch = 0

  async function sampleLiveKit(liveNames: string[]): Promise<LiveSample> {
    const api = deps.api
    if (api === null) return { kind: 'offline', status: 'not_configured', reason: null }
    const roomsOut = new Map<string, { exists: boolean; counts: VoiceAdminLiveRoomCounts }>()
    if (liveNames.length === 0) return { kind: 'ok', sampledAt: new Date(now()).toISOString(), partial: false, rooms: roomsOut }
    const rooms = await deps.dispatcher.run({ name: 'AdminListRooms', priority: 'normal', idempotent: true, run: () => api.listRooms(liveNames) })
    if (!rooms.ok) return { kind: 'offline', status: 'unavailable', reason: rooms.code }
    const existing = new Map(rooms.value.map((room) => [room.name, room.numParticipants]))
    let queried = 0
    let partial = false
    const listParticipants = api.listParticipants
    for (const name of liveNames) {
      const reported = existing.get(name)
      if (reported === undefined || reported === 0) {
        roomsOut.set(name, { exists: reported !== undefined, counts: ZERO_COUNTS })
        continue
      }
      if (listParticipants === undefined || queried >= maxParticipantQueries) {
        // Броят е известен от ListRooms, разделянето микрофон/слушане — не.
        roomsOut.set(name, { exists: true, counts: { participants: reported, microphoneOn: null, listening: null } })
        partial = true
        continue
      }
      queried += 1
      const result = await deps.dispatcher.run({ name: 'AdminListParticipants', priority: 'normal', idempotent: true, run: () => listParticipants(name) })
      if (!result.ok) {
        roomsOut.set(name, { exists: true, counts: { participants: reported, microphoneOn: null, listening: null } })
        partial = true
        continue
      }
      const connected = result.value.filter((participant) => participant.state !== 'disconnected')
      const microphoneOn = connected.filter((participant) => participant.microphonePublished && !participant.microphoneMuted).length
      roomsOut.set(name, { exists: true, counts: { participants: connected.length, microphoneOn, listening: connected.length - microphoneOn } })
    }
    return { kind: 'ok', sampledAt: new Date(now()).toISOString(), partial, rooms: roomsOut }
  }

  /** Свежият списък с маси + кешираните LiveKit данни (само за още живите имена). */
  function compose(sample: LiveSample, tables: VoiceAdminTableRow[]): VoiceAdminLiveSnapshot {
    if (sample.kind === 'offline') {
      return {
        status: sample.status,
        reason: sample.reason,
        sampledAt: null,
        totals: { reservedTables: tables.length, activeRooms: null, participants: null, microphoneOn: null, listening: null },
        tables: tables.map((table) => ({ ...table, roomExists: null, counts: UNKNOWN_COUNTS })),
      }
    }
    let partial = sample.partial
    const liveTables: VoiceAdminLiveTable[] = tables.map((table) => {
      if (table.liveRoomName === null) return { ...table, roomExists: false, counts: ZERO_COUNTS }
      const room = sample.rooms.get(table.liveRoomName)
      if (room === undefined) {
        // Нова генерация след последното четене — още непроверена.
        partial = true
        return { ...table, roomExists: null, counts: UNKNOWN_COUNTS }
      }
      return { ...table, roomExists: room.exists, counts: room.counts }
    })
    const sum = (pick: (value: VoiceAdminLiveRoomCounts) => number | null): number | null => {
      let total = 0
      for (const table of liveTables) {
        const part = pick(table.counts)
        if (part === null) return null
        total += part
      }
      return total
    }
    const activeRooms = liveTables.some((table) => table.roomExists === null) ? null : liveTables.filter((table) => table.roomExists === true).length
    return {
      status: partial ? 'partial' : 'ok',
      reason: partial ? 'participant_breakdown_incomplete' : null,
      sampledAt: sample.sampledAt,
      totals: {
        reservedTables: tables.length,
        activeRooms,
        participants: sum((value) => value.participants),
        microphoneOn: sum((value) => value.microphoneOn),
        listening: sum((value) => value.listening),
      },
      tables: liveTables,
    }
  }

  return {
    async getSnapshot() {
      if (cached === null || now() - cached.at >= cacheTtlMs) {
        if (inFlight === null) {
          const started = epoch
          const liveNames = deps.listTables().map((table) => table.liveRoomName).filter((name): name is string => name !== null)
          inFlight = sampleLiveKit(liveNames)
            .catch((): LiveSample => ({ kind: 'offline', status: 'unavailable', reason: 'internal_error' }))
            .then((sample) => {
              if (started === epoch) cached = { at: now(), sample }
              return sample
            })
            .finally(() => {
              if (started === epoch) inFlight = null
            })
        }
        const sample = await inFlight
        return compose(sample, deps.listTables())
      }
      return compose(cached.sample, deps.listTables())
    },
    invalidate() {
      epoch += 1
      cached = null
      inFlight = null
    },
  }
}
