// checkReconnectDiagnostics.ts — Етап 0 (диагностика), сървърна страна,
// без мрежа:
//
//  [P1] evaluateSilentActiveRoomReconnect връща СЪЩИЯ код като досегашната
//       inline логика (копирана тук като оракул) за всички комбинации от
//       състояния — изнасянето не променя решенията
//  [P2] всяка конкретна причина (detail) е достижима и отговаря на кода
//  [P3] other_session_active носи блокиращата връзка (само за лога)
//  [F1] [resume] ред: един ред, валиден JSON, точен UTC at, само изброени
//       полета — без reconnectToken/cookie/session/attemptProof
//  [F2] [ws] client connected: старият префикс е непроменен (съществуващите
//       скриптове го разчитат) + at=<ISO>
//  [F3] [ws-handler-error]: тип на съобщението + грешка + първи frame, един ред
//  [F4] rate limit: най-много N реда в прозорец + обобщаващ ред за пропуснатите
//  [M1] parseClientMessage: reconnectAttempt само цяло число 1..1000
//
//   node node_modules/tsx/dist/cli.mjs scripts/checkReconnectDiagnostics.ts   (от server/)

import { evaluateSilentActiveRoomReconnect, type RecentlyClosedRoomConnection } from '../src/game/evaluateSilentActiveRoomReconnect.js'
import {
  createRateLimitedLogWriter,
  formatResumeRoomLogLine,
  formatWsConnectedLogLine,
  formatWsHandlerErrorLogLine,
} from '../src/diagnostics/reconnectDiagnostics.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import { findHumanParticipantByReconnectToken } from '../src/core/serverGameRuntimeHelpers.js'
import type { ServerConnection, ServerRoom } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const TTL = 150_000
const NOW = 10_000_000
const ROOM_ID = 'room-1'
const PROFILE = 'profile-me'
const TOKEN = 'reconnect-token-SECRET-123'

type Scenario = {
  profileId: string | null
  roomPresent: boolean
  reconnectOfSameAsConnection: boolean
  guestTrial: boolean
  tokenMatches: boolean
  ownerIsMe: boolean
  permanentlyLeft: boolean
  previous: 'live_ok' | 'live_other_profile' | 'live_other_room' | 'closed_ok' | 'closed_other_profile' | 'closed_other_room' | 'closed_expired' | 'unknown'
  seatConnection: 'previous' | 'null' | 'other'
  otherLive: 'none' | 'connected_unattached' | 'connected_attached' | 'disconnected'
}

function buildWorld(s: Scenario) {
  const connectionId = 'conn-new'
  const reconnectOf = s.reconnectOfSameAsConnection ? connectionId : 'conn-prev'
  const seatConnectionId = s.seatConnection === 'previous' ? 'conn-prev' : s.seatConnection === 'other' ? 'conn-seat-other' : null
  const participant = {
    kind: 'human',
    reconnectToken: TOKEN,
    connectionId: seatConnectionId,
    permanentlyLeftAt: s.permanentlyLeft ? 123 : null,
    identity: { profileId: s.ownerIsMe ? PROFILE : 'profile-someone-else' },
    publicProfile: null,
  }
  const room = s.roomPresent
    ? ({
        id: ROOM_ID,
        config: { isGuestTrial: s.guestTrial },
        seats: { bottom: { participant }, right: { participant: null }, top: { participant: null }, left: { participant: null } },
      } as unknown as ServerRoom)
    : null
  const connections: Record<string, ServerConnection> = {}
  const conn = (id: string, profileId: string | null, currentRoomId: string | null, status: 'connected' | 'disconnected'): ServerConnection => ({
    id, status, connectedAt: 0, lastSeenAt: 0, remoteAddress: null, userAgent: null, currentRoomId, currentSeat: null, playerId: null, profileId, sessionId: null,
  })
  connections[connectionId] = conn(connectionId, s.profileId, null, 'connected')
  if (s.previous === 'live_ok') connections['conn-prev'] = conn('conn-prev', PROFILE, ROOM_ID, 'connected')
  if (s.previous === 'live_other_profile') connections['conn-prev'] = conn('conn-prev', 'profile-x', ROOM_ID, 'connected')
  if (s.previous === 'live_other_room') connections['conn-prev'] = conn('conn-prev', PROFILE, 'room-x', 'connected')
  if (s.otherLive === 'connected_unattached') connections['conn-other'] = conn('conn-other', PROFILE, null, 'connected')
  if (s.otherLive === 'connected_attached') connections['conn-other'] = conn('conn-other', PROFILE, 'room-z', 'connected')
  if (s.otherLive === 'disconnected') connections['conn-other'] = conn('conn-other', PROFILE, null, 'disconnected')
  const closed = new Map<string, RecentlyClosedRoomConnection>()
  if (s.previous === 'closed_ok') closed.set('conn-prev', { profileId: PROFILE, roomId: ROOM_ID, closedAt: NOW - 1_000 })
  if (s.previous === 'closed_other_profile') closed.set('conn-prev', { profileId: 'profile-x', roomId: ROOM_ID, closedAt: NOW - 1_000 })
  if (s.previous === 'closed_other_room') closed.set('conn-prev', { profileId: PROFILE, roomId: 'room-x', closedAt: NOW - 1_000 })
  if (s.previous === 'closed_expired') closed.set('conn-prev', { profileId: PROFILE, roomId: ROOM_ID, closedAt: NOW - TTL - 1 })
  const reconnectToken = s.tokenMatches ? TOKEN : 'wrong-token'
  return { connectionId, reconnectOf, room, connections, closed, reconnectToken }
}

// Оракул: досегашната inline функция от index.ts (преди Етап 0), дословно,
// с подадено отвън състояние вместо глобалното serverState.
function legacyValidate(w: ReturnType<typeof buildWorld>, profileId: string | null): 'other_session_active' | 'reconnect_unavailable' | null {
  const { connectionId, reconnectOf, room, reconnectToken } = w
  if (profileId === null || room === null || reconnectOf === connectionId) return 'reconnect_unavailable'
  if (room.config.isGuestTrial === true) return 'reconnect_unavailable'
  const seatMatch = findHumanParticipantByReconnectToken(room, reconnectToken)
  if (seatMatch === null) return 'reconnect_unavailable'
  const ownerProfileId = seatMatch.participant.identity.profileId ?? seatMatch.participant.publicProfile?.profileId ?? null
  if (ownerProfileId !== profileId || seatMatch.participant.permanentlyLeftAt != null) return 'reconnect_unavailable'
  const previousLive = w.connections[reconnectOf] ?? null
  if (previousLive !== null) {
    if (previousLive.profileId !== profileId || previousLive.currentRoomId !== room.id) return 'reconnect_unavailable'
  } else {
    const closed = w.closed.get(reconnectOf)
    if (closed === undefined || closed.profileId !== profileId || closed.roomId !== room.id || NOW - closed.closedAt > TTL) {
      return 'reconnect_unavailable'
    }
  }
  if (seatMatch.participant.connectionId !== null && seatMatch.participant.connectionId !== reconnectOf) return 'other_session_active'
  for (const other of Object.values(w.connections)) {
    if (other.profileId !== profileId || other.status !== 'connected') continue
    if (other.id === connectionId || other.id === reconnectOf) continue
    return 'other_session_active'
  }
  return null
}

function evaluate(s: Scenario) {
  const w = buildWorld(s)
  return {
    w,
    decision: evaluateSilentActiveRoomReconnect({
      connectionId: w.connectionId,
      profileId: s.profileId,
      reconnectOf: w.reconnectOf,
      room: w.room,
      reconnectToken: w.reconnectToken,
      connections: w.connections,
      getRecentlyClosed: (id) => w.closed.get(id),
      now: NOW,
      recentlyClosedTtlMs: TTL,
    }),
  }
}

function* allScenarios(): Generator<Scenario> {
  const bools = [false, true]
  for (const profileId of [null, PROFILE])
    for (const roomPresent of bools)
      for (const reconnectOfSameAsConnection of bools)
        for (const guestTrial of bools)
          for (const tokenMatches of bools)
            for (const ownerIsMe of bools)
              for (const permanentlyLeft of bools)
                for (const previous of ['live_ok', 'live_other_profile', 'live_other_room', 'closed_ok', 'closed_other_profile', 'closed_other_room', 'closed_expired', 'unknown'] as const)
                  for (const seatConnection of ['previous', 'null', 'other'] as const)
                    for (const otherLive of ['none', 'connected_unattached', 'connected_attached', 'disconnected'] as const)
                      yield { profileId, roomPresent, reconnectOfSameAsConnection, guestTrial, tokenMatches, ownerIsMe, permanentlyLeft, previous, seatConnection, otherLive }
}

console.log('\ncheckReconnectDiagnostics\n')

const detailsSeen = new Set<string>()
check('[P1] изнесената проверка връща същия код като досегашната логика за всички комбинации', () => {
  let count = 0
  for (const s of allScenarios()) {
    count += 1
    const { w, decision } = evaluate(s)
    const legacy = legacyValidate(w, s.profileId)
    const actual = decision.ok ? null : decision.code
    assert(actual === legacy, `разминаване при ${JSON.stringify(s)}: legacy=${legacy} actual=${actual}`)
    if (!decision.ok) detailsSeen.add(`${decision.code}:${decision.detail}`)
    else detailsSeen.add(`ok:${decision.previousConnection}`)
  }
  assert(count === 2 * 2 * 2 * 2 * 2 * 2 * 2 * 8 * 3 * 4, `комбинации: ${count}`)
})

check('[P2] всяка конкретна причина е достижима и съответства на кода', () => {
  const expected = [
    'reconnect_unavailable:no_profile', 'reconnect_unavailable:room_missing', 'reconnect_unavailable:same_connection',
    'reconnect_unavailable:guest_trial', 'reconnect_unavailable:token_not_found', 'reconnect_unavailable:token_owner_mismatch',
    'reconnect_unavailable:seat_permanently_left', 'reconnect_unavailable:previous_live_profile_mismatch',
    'reconnect_unavailable:previous_live_room_mismatch', 'reconnect_unavailable:previous_unknown',
    'reconnect_unavailable:previous_closed_profile_mismatch', 'reconnect_unavailable:previous_closed_room_mismatch',
    'reconnect_unavailable:previous_closed_expired', 'other_session_active:seat_held_by_other_connection',
    'other_session_active:other_live_connection', 'ok:live', 'ok:recently_closed',
  ]
  for (const key of expected) assert(detailsSeen.has(key), `недостижима: ${key}`)
  assert(detailsSeen.size === expected.length, `неочаквани: ${[...detailsSeen].filter((k) => !expected.includes(k)).join(', ')}`)
})

check('[P3] other_session_active носи блокиращата връзка и дали е прикрепена', () => {
  const base: Scenario = {
    profileId: PROFILE, roomPresent: true, reconnectOfSameAsConnection: false, guestTrial: false, tokenMatches: true,
    ownerIsMe: true, permanentlyLeft: false, previous: 'live_ok', seatConnection: 'previous', otherLive: 'connected_unattached',
  }
  const a = evaluate(base).decision
  assert(!a.ok && a.detail === 'other_live_connection' && a.blockingConnectionId === 'conn-other' && a.blockingConnectionAttached === false, JSON.stringify(a))
  const b = evaluate({ ...base, otherLive: 'connected_attached' }).decision
  assert(!b.ok && b.blockingConnectionAttached === true, JSON.stringify(b))
  const c = evaluate({ ...base, seatConnection: 'other', otherLive: 'none' }).decision
  assert(!c.ok && c.detail === 'seat_held_by_other_connection' && c.blockingConnectionId === 'conn-seat-other', JSON.stringify(c))
  const ok = evaluate({ ...base, otherLive: 'disconnected' }).decision
  assert(ok.ok && ok.previousConnection === 'live', JSON.stringify(ok))
})

check('[F1] [resume] ред: един ред, валиден JSON, UTC at, само изброени полета (без token/cookie/session)', () => {
  const entry = {
    connectionId: 'conn-new', profileId: PROFILE, roomId: ROOM_ID, mode: 'silent_reconnect' as const, reconnectOf: 'conn-prev',
    reconnectAttempt: 2, result: 'refused' as const, reason: 'other_session_active', detail: 'other_live_connection\n[resume] {"forged":1}',
    blockingConnectionId: 'conn-other', blockingConnectionAttached: false, displacedConnectionIds: [],
    // Полета, които НЕ трябва да стигнат до лога, дори ако някой ги подаде:
    reconnectToken: TOKEN, cookie: 'belot_session=abc', sessionToken: 'sess-xyz', attemptProof: 'proof-123',
  }
  const line = formatResumeRoomLogLine(entry as never, Date.UTC(2026, 10, 24, 20, 3, 23, 261))
  assert(!line.includes('\n'), 'редът съдържа нов ред')
  assert(line.startsWith('[resume] '), line)
  const parsed = JSON.parse(line.slice('[resume] '.length)) as Record<string, unknown>
  assert(parsed.at === '2026-11-24T20:03:23.261Z', `at=${parsed.at}`)
  assert(parsed.reason === 'other_session_active' && parsed.reconnectAttempt === 2 && parsed.mode === 'silent_reconnect', line)
  assert(parsed.blockingConnectionId === 'conn-other' && parsed.blockingConnectionAttached === false, line)
  for (const secret of [TOKEN, 'belot_session', 'sess-xyz', 'proof-123']) assert(!line.includes(secret), `изтичане: ${secret}`)
  assert(!('displacedConnectionIds' in parsed), 'празен списък не се записва')
  const ok = JSON.parse(formatResumeRoomLogLine({
    connectionId: 'c', profileId: null, roomId: 'r', mode: 'explicit', reconnectOf: null, reconnectAttempt: null,
    result: 'attached', reason: 'ok', seat: 'bottom', displacedConnectionIds: ['a', 'b'],
  }).slice('[resume] '.length)) as Record<string, unknown>
  assert(ok.result === 'attached' && ok.seat === 'bottom' && Array.isArray(ok.displacedConnectionIds) && !('reconnectOf' in ok) && !('reconnectAttempt' in ok), JSON.stringify(ok))
})

check('[F2] [ws] client connected: префиксът е непроменен (съвместим със съществуващите скриптове) + at=<ISO>', () => {
  const line = formatWsConnectedLogLine({ connectionId: 'abc-1', remoteAddress: '127.0.0.1', profileId: PROFILE, now: Date.UTC(2026, 10, 24, 20, 3, 12, 400) })
  assert(line === `[ws] client connected: abc-1 (127.0.0.1) profile=${PROFILE} at=2026-11-24T20:03:12.400Z`, line)
  const legacyRegex = /\[ws\] client connected: (\S+) \((.*?)\) profile=(\S+)/
  const m = legacyRegex.exec(line)
  assert(m !== null && m[1] === 'abc-1' && m[3] === PROFILE, 'старият regex вече не разчита реда')
  const guest = formatWsConnectedLogLine({ connectionId: 'g', remoteAddress: null, profileId: null, now: 0 })
  assert(guest === '[ws] client connected: g (unknown) profile=none at=1970-01-01T00:00:00.000Z', guest)
  // Етап 2: auth=session|none в края — старият regex и at= остават разчитаеми.
  const withAuth = formatWsConnectedLogLine({ connectionId: 'c', remoteAddress: null, profileId: PROFILE, authenticated: true, now: 0 })
  assert(withAuth === `[ws] client connected: c (unknown) profile=${PROFILE} at=1970-01-01T00:00:00.000Z auth=session`, withAuth)
  assert(legacyRegex.exec(withAuth)?.[3] === PROFILE, 'старият regex')
  assert(formatWsConnectedLogLine({ connectionId: 'c', remoteAddress: null, profileId: null, authenticated: false, now: 0 }).endsWith(' auth=none'), 'auth=none')
})

check('[F3] [ws-handler-error]: тип + грешка + първи frame, един ред, ограничена дължина', () => {
  const error = new Error(`Participant connection mismatch.\nExpected "a", got "b"${'x'.repeat(500)}`)
  const line = formatWsHandlerErrorLogLine({ connectionId: 'conn-1', messageType: 'resume_room', error, now: 0 })
  assert(!line.includes('\n') && line.startsWith('[ws-handler-error] '), line)
  const parsed = JSON.parse(line.slice('[ws-handler-error] '.length)) as Record<string, string>
  assert(parsed.messageType === 'resume_room' && parsed.connectionId === 'conn-1', line)
  assert(parsed.error!.startsWith('Error: Participant connection mismatch.') && parsed.error!.length <= 301, `error length ${parsed.error!.length}`)
  assert(typeof parsed.frame === 'string' && parsed.frame.startsWith('at '), `frame=${parsed.frame}`)
  const nonError = JSON.parse(formatWsHandlerErrorLogLine({ connectionId: 'c', messageType: 'x', error: 'boom', now: 0 }).slice('[ws-handler-error] '.length)) as Record<string, string>
  assert(nonError.error === 'string: boom' && !('frame' in nonError), JSON.stringify(nonError))
})

check('[F4] rate limit: най-много N реда в прозорец; пропуснатите — един обобщаващ ред', () => {
  let now = 0
  const out: string[] = []
  const write = createRateLimitedLogWriter({ tag: '[ws-handler-error]', maxPerWindow: 3, windowMs: 60_000, write: (l) => out.push(l), now: () => now })
  for (let i = 0; i < 10; i++) write(`line-${i}`)
  assert(out.join(',') === 'line-0,line-1,line-2', out.join(','))
  now = 60_000
  write('line-next')
  assert(out.length === 5, `редове: ${out.length}`)
  const summary = JSON.parse(out[3]!.slice('[ws-handler-error] '.length)) as Record<string, unknown>
  assert(summary.suppressed === 7 && summary.windowMs === 60_000, out[3]!)
  assert(out[4] === 'line-next', out[4]!)
  now = 120_000
  write('quiet')
  assert(out.length === 6 && out[5] === 'quiet', 'без пропуснати не се пише обобщение')
})

check('[M1] parseClientMessage: reconnectAttempt се приема само като цяло число 1..1000; останалото е непроменено', () => {
  const base = { type: 'resume_room', roomId: 'r1', reconnectToken: 't1', reconnectOf: 'c-prev' }
  const ok = parseClientMessage(JSON.stringify({ ...base, reconnectAttempt: 3 })) as Record<string, unknown> | null
  assert(ok !== null && ok.reconnectAttempt === 3 && ok.reconnectOf === 'c-prev' && ok.silent === false, JSON.stringify(ok))
  for (const bad of [0, 1.5, '3', 1001, -1, null]) {
    const parsed = parseClientMessage(JSON.stringify({ ...base, reconnectAttempt: bad })) as Record<string, unknown> | null
    assert(parsed !== null && !('reconnectAttempt' in parsed), `прието невалидно ${JSON.stringify(bad)}: ${JSON.stringify(parsed)}`)
  }
  const without = parseClientMessage(JSON.stringify(base)) as Record<string, unknown> | null
  assert(without !== null && !('reconnectAttempt' in without), JSON.stringify(without))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
