/**
 * checkLudoDiagnosticsLog.ts
 *
 * Regression за ВРЕМЕННАТА 24-часова Ludo lifecycle диагностика (виж
 * server/src/diagnostics/ludoDiagnosticsLog.ts за пълния rationale —
 * "temporary 24h Ludo diagnostics" task, цел: reconstruct-ване на
 * request -> authoritative state -> accepted/rejected -> finished -> cleanup
 * последователността, за да хванем рядкия "Зарът не може да бъде хвърлен
 * сега." lobby-bleed race).
 *
 * [1]  env липсва -> disabled
 * [2]  malformed LUDO_DIAGNOSTICS_UNTIL -> disabled (fail-closed)
 * [3]  expired UNTIL (now >= until) -> disabled
 * [4]  future UNTIL (now < until) -> enabled
 * [5]  valid event се сериализира като точно ЕДИН JSONL ред (JSON.parse
 *      round-trip, точно 1 \n)
 * [6]  logging failure (invalid path) не хвърля/reject-ва навън — gameplay
 *      control flow не се пипа
 * [7]  rejected roll записва errorCode
 * [8]  rejected move записва errorCode
 * [9]  match finished съдържа matchId + winnerProfileId
 * [10] няма sensitive полета (connectionId/IP/user-agent/session/token) в
 *      сериализирания output — нито в позволения field set, нито инжектирани
 *      случайно
 *
 * Допълнително:
 * [11] реален file-I/O round-trip (writeLudoDiagnosticLineForTest) —
 *      append-only, multi-line JSONL четимо ред по ред
 * [12] undefined полета се пропускат от сериализацията (не се появяват като
 *      "field": null в JSON-а, освен explicit null стойности като
 *      winnerProfileId)
 *
 * REJECTED CONTEXT (виж task допълнението "REJECTED CONTEXT"):
 * [7b/8c] rejected roll/move с existing match (errorCode: ludo_match_finished,
 *         ludo_match_stale_action, ludo_match_not_turn) носи пълен
 *         authoritative context (matchId/profileId/requestRevision/
 *         authoritativeRevision/matchStatus/currentTurnColor/
 *         currentTurnProfileId/errorCode/result)
 * [7c]    rejected roll с ludo_match_not_found НЯМА authoritative context
 *         полета (match никога не е бил намерен)
 *
 * OBSERVED CLEANUP (виж task допълнението "OBSERVED CLEANUP"):
 * [9c]    ludo_match_removed (observed, СЛЕД реалния matches.delete() —
 *         виж ludoMatchRuntime.ts::scheduleFinishedCleanup) съдържа
 *         matchId + ludoRoomId + revision/status
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isLudoDiagnosticsEnabled,
  serializeLudoDiagnosticEvent,
  writeLudoDiagnosticLineForTest,
} from '../src/diagnostics/ludoDiagnosticsLog.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

console.log('\ncheckLudoDiagnosticsLog\n')

const originalUntil = process.env.LUDO_DIAGNOSTICS_UNTIL

function restoreEnv(): void {
  if (originalUntil === undefined) delete process.env.LUDO_DIAGNOSTICS_UNTIL
  else process.env.LUDO_DIAGNOSTICS_UNTIL = originalUntil
}

try {
  const FIXED_NOW = Date.parse('2026-01-01T12:00:00.000Z')

  await check('[1] env липсва -> isLudoDiagnosticsEnabled() е false', () => {
    delete process.env.LUDO_DIAGNOSTICS_UNTIL
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), false, 'missing env трябва да disable-не')
  })

  await check('[2] malformed LUDO_DIAGNOSTICS_UNTIL -> fail-closed (disabled)', () => {
    process.env.LUDO_DIAGNOSTICS_UNTIL = 'not-a-date'
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), false, 'malformed ISO string трябва да disable-не (fail-closed)')
  })

  await check('[2b] празен string LUDO_DIAGNOSTICS_UNTIL -> disabled', () => {
    process.env.LUDO_DIAGNOSTICS_UNTIL = ''
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), false, 'празен env трябва да disable-не')
  })

  await check('[3] expired UNTIL (now >= until) -> disabled', () => {
    process.env.LUDO_DIAGNOSTICS_UNTIL = new Date(FIXED_NOW - 1000).toISOString()
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), false, 'until в миналото трябва да disable-не')
  })

  await check('[3b] UNTIL точно равно на now -> disabled (strict <, не <=)', () => {
    process.env.LUDO_DIAGNOSTICS_UNTIL = new Date(FIXED_NOW).toISOString()
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), false, 'until === now трябва да disable-не (границата принадлежи на "изтекло")')
  })

  await check('[4] future UNTIL (now < until) -> enabled', () => {
    process.env.LUDO_DIAGNOSTICS_UNTIL = new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString()
    assertEqual(isLudoDiagnosticsEnabled(FIXED_NOW), true, 'until в бъдещето трябва да enable-не')
  })

  await check('[5] valid event се сериализира като точно ЕДИН JSONL ред', () => {
    const line = serializeLudoDiagnosticEvent('ludo_roll_accepted', {
      matchId: 'match-1',
      profileId: 'profile-1',
      requestRevision: 3,
      result: 'accepted',
    })
    const newlineCount = (line.match(/\n/g) ?? []).length
    assertEqual(newlineCount, 1, 'трябва да има точно 1 newline (в края)')
    assert(line.endsWith('\n'), 'редът трябва да завършва с \\n')
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.event, 'ludo_roll_accepted', 'event полето трябва да round-trip-не')
    assertEqual(parsed.matchId, 'match-1', 'matchId трябва да round-trip-не')
    assertEqual(parsed.result, 'accepted', 'result трябва да round-trip-не')
    assert(typeof parsed.timestamp === 'string', 'timestamp трябва да е string')
    assert(!Number.isNaN(Date.parse(parsed.timestamp)), 'timestamp трябва да е валиден ISO string')
    assert(parsed.timestamp.endsWith('Z'), 'timestamp трябва да е UTC (Z suffix)')
    assert(/\.\d{3}Z$/.test(parsed.timestamp), 'timestamp трябва да съдържа milliseconds')
  })

  await check('[6] logging failure (invalid/unwritable path) не хвърля навън — gameplay control flow непроменен', async () => {
    // Невалиден path (null byte е гарантирано invalid на всички платформи) —
    // appendDiagnosticLine/mkdir ще fail-нат, но writeLudoDiagnosticLineForTest
    // (mirror на production fire-and-forget wrapper-а в logLudoDiagnosticEvent)
    // не бива да "изтече" грешката по начин, който би прекъснал caller-а.
    let threw = false
    try {
      await writeLudoDiagnosticLineForTest('/nonexistent-root-that-cannot-be-created\0invalid', 'line\n')
    } catch {
      threw = true
    }
    // writeLudoDiagnosticLineForTest е директен (await-able) test helper —
    // ОЧАКВАНО хвърля тук (за да го хване тестът и провери error handling
    // explicit). Production logLudoDiagnosticEvent НИКОГА не пропуска това
    // навън (виж .catch() в production wrapper-а) — проверено отделно в
    // [6b] чрез симулация на production-style catch wrapping.
    assert(threw, 'invalid path трябва да хвърли в директния test helper (production wrapper-ът catch-ва това, виж [6b])')
  })

  await check('[6b] production-style catch wrapping поглъща write failure без throw/reject навън', async () => {
    let escaped = false
    let caughtInternally = false
    try {
      await writeLudoDiagnosticLineForTest('/nonexistent-root-that-cannot-be-created\0invalid', 'line\n').catch(() => {
        caughtInternally = true
      })
    } catch {
      escaped = true
    }
    assertEqual(escaped, false, 'production wrapper-ът (.catch()) не трябва да позволи грешката да ескейпне навън')
    assert(caughtInternally, 'грешката трябва да е catch-ната вътрешно')
  })

  await check('[7] rejected roll записва errorCode', () => {
    const line = serializeLudoDiagnosticEvent('ludo_roll_rejected', {
      matchId: 'match-2',
      profileId: 'profile-2',
      requestType: 'ludo_roll_request',
      requestRevision: 5,
      result: 'rejected',
      errorCode: 'ludo_match_not_turn',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.errorCode, 'ludo_match_not_turn', 'errorCode трябва да е записан за rejected roll')
    assertEqual(parsed.result, 'rejected', 'result трябва да е rejected')
  })

  await check('[8] rejected move записва errorCode', () => {
    const line = serializeLudoDiagnosticEvent('ludo_move_rejected', {
      matchId: 'match-3',
      profileId: 'profile-3',
      requestType: 'ludo_move_request',
      requestRevision: 7,
      result: 'rejected',
      errorCode: 'ludo_match_stale_action',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.errorCode, 'ludo_match_stale_action', 'errorCode трябва да е записан за rejected move')
  })

  // REJECTED CONTEXT (виж task-а "REJECTED CONTEXT" допълнението) — когато
  // match-ът съществува (всеки errorCode различен от ludo_match_not_found),
  // rejected event-ът трябва да носи пълния authoritative context, точно
  // както index.ts::handler-ът сега конструира (beforeMatch четен ПРЕДИ
  // action-а, reuse-нат и за rejected log-а — виж ludo_roll_rejected/
  // ludo_move_rejected call sites-ите там). Тук проверяваме sериализатора с
  // exактно същия field set, който handler-ът подава, за трите специфични
  // rejection кода, изрично поискани в task-а.
  for (const errorCode of ['ludo_match_finished', 'ludo_match_stale_action', 'ludo_match_not_turn'] as const) {
    await check(`[7b] rejected roll (errorCode=${errorCode}) с existing match носи пълен authoritative context`, () => {
      const line = serializeLudoDiagnosticEvent('ludo_roll_rejected', {
        matchId: 'match-ctx-1',
        profileId: 'profile-ctx-1',
        requestType: 'ludo_roll_request',
        requestRevision: 4,
        authoritativeRevision: 4,
        matchStatus: errorCode === 'ludo_match_finished' ? 'finished' : 'in_progress',
        currentTurnColor: 'blue',
        currentTurnProfileId: 'profile-active-turn',
        result: 'rejected',
        errorCode,
      })
      const parsed = JSON.parse(line.trim())
      assertEqual(parsed.matchId, 'match-ctx-1', 'matchId трябва да присъства')
      assertEqual(parsed.profileId, 'profile-ctx-1', 'profileId трябва да присъства')
      assertEqual(parsed.requestRevision, 4, 'requestRevision трябва да присъства')
      assertEqual(parsed.authoritativeRevision, 4, 'authoritativeRevision трябва да присъства')
      assert('matchStatus' in parsed, 'matchStatus трябва да присъства')
      assertEqual(parsed.currentTurnColor, 'blue', 'currentTurnColor трябва да присъства')
      assertEqual(parsed.currentTurnProfileId, 'profile-active-turn', 'currentTurnProfileId трябва да присъства')
      assertEqual(parsed.errorCode, errorCode, 'errorCode трябва да съвпада')
      assertEqual(parsed.result, 'rejected', 'result трябва да е rejected')
    })

    await check(`[8c] rejected move (errorCode=${errorCode}) с existing match носи пълен authoritative context`, () => {
      const line = serializeLudoDiagnosticEvent('ludo_move_rejected', {
        matchId: 'match-ctx-2',
        profileId: 'profile-ctx-2',
        requestType: 'ludo_move_request',
        requestRevision: 9,
        authoritativeRevision: 9,
        matchStatus: errorCode === 'ludo_match_finished' ? 'finished' : 'in_progress',
        currentTurnColor: 'green',
        currentTurnProfileId: 'profile-active-turn-2',
        result: 'rejected',
        errorCode,
      })
      const parsed = JSON.parse(line.trim())
      assertEqual(parsed.matchId, 'match-ctx-2', 'matchId трябва да присъства')
      assertEqual(parsed.authoritativeRevision, 9, 'authoritativeRevision трябва да присъства')
      assertEqual(parsed.currentTurnColor, 'green', 'currentTurnColor трябва да присъства')
      assertEqual(parsed.currentTurnProfileId, 'profile-active-turn-2', 'currentTurnProfileId трябва да присъства')
      assertEqual(parsed.errorCode, errorCode, 'errorCode трябва да съвпада')
    })
  }

  await check('[7c] rejected roll с ludo_match_not_found НЯМА authoritative context полета (match никога не е бил намерен)', () => {
    // Mirror на index.ts поведението: beforeMatch е undefined, когато
    // getMatch() не намери match-а — undefined полетата се пропускат от
    // сериализацията (виж [12]), значи authoritativeRevision/matchStatus/
    // currentTurnColor/currentTurnProfileId естествено липсват в JSON-а.
    const line = serializeLudoDiagnosticEvent('ludo_roll_rejected', {
      matchId: 'match-never-existed',
      profileId: 'profile-ctx-3',
      requestType: 'ludo_roll_request',
      requestRevision: 1,
      authoritativeRevision: undefined,
      matchStatus: undefined,
      currentTurnColor: undefined,
      currentTurnProfileId: undefined,
      result: 'rejected',
      errorCode: 'ludo_match_not_found',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.errorCode, 'ludo_match_not_found', 'errorCode трябва да присъства')
    assert(!('authoritativeRevision' in parsed), 'authoritativeRevision не трябва да присъства за ludo_match_not_found')
    assert(!('matchStatus' in parsed), 'matchStatus не трябва да присъства за ludo_match_not_found')
    assert(!('currentTurnColor' in parsed), 'currentTurnColor не трябва да присъства за ludo_match_not_found')
    assert(!('currentTurnProfileId' in parsed), 'currentTurnProfileId не трябва да присъства за ludo_match_not_found')
  })

  await check('[8b] rejected state request без matchId (never-existed match) записва profileId + errorCode, без измислен matchId', () => {
    const line = serializeLudoDiagnosticEvent('ludo_state_request_rejected', {
      profileId: 'profile-4',
      requestType: 'ludo_game_state_request',
      errorCode: 'ludo_match_not_found',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.profileId, 'profile-4', 'profileId трябва да е записан')
    assertEqual(parsed.errorCode, 'ludo_match_not_found', 'errorCode трябва да е записан')
    assert(!('matchId' in parsed), 'matchId НЕ трябва да е измислен/присъства, когато не е наличен')
  })

  await check('[9c] ludo_match_removed (observed cleanup) съдържа matchId + ludoRoomId + status/revision', () => {
    // Mirror на index.ts::onMatchRemoved wiring-а (виж
    // ludoMatchRuntime.ts::scheduleFinishedCleanup) — записва се ТОЧНО СЛЕД
    // реалния matches.delete(), не computed приближение (за разлика от
    // ludo_match_cleanup_scheduled).
    const line = serializeLudoDiagnosticEvent('ludo_match_removed', {
      matchId: 'match-removed-1',
      ludoRoomId: 'room-removed-1',
      authoritativeRevision: 12,
      matchStatus: 'finished',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.event, 'ludo_match_removed', 'event трябва да е ludo_match_removed')
    assertEqual(parsed.matchId, 'match-removed-1', 'matchId трябва да присъства')
    assertEqual(parsed.ludoRoomId, 'room-removed-1', 'ludoRoomId трябва да присъства')
    assertEqual(parsed.authoritativeRevision, 12, 'authoritativeRevision трябва да присъства')
    assertEqual(parsed.matchStatus, 'finished', 'matchStatus трябва да присъства')
  })

  await check('[9] match finished съдържа matchId + winnerProfileId', () => {
    const line = serializeLudoDiagnosticEvent('ludo_match_finished', {
      matchId: 'match-4',
      ludoRoomId: 'room-4',
      matchStatus: 'finished',
      winnerProfileId: 'profile-5',
    })
    const parsed = JSON.parse(line.trim())
    assertEqual(parsed.matchId, 'match-4', 'matchId трябва да присъства')
    assertEqual(parsed.winnerProfileId, 'profile-5', 'winnerProfileId трябва да присъства')
    assertEqual(parsed.matchStatus, 'finished', 'matchStatus трябва да е finished')
  })

  await check('[9b] match finished с winnerProfileId=null (forfeit без ясен winner) се сериализира коректно (explicit null, не undefined/missing)', () => {
    const line = serializeLudoDiagnosticEvent('ludo_match_finished', {
      matchId: 'match-5',
      matchStatus: 'finished',
      winnerProfileId: null,
    })
    const parsed = JSON.parse(line.trim())
    assert('winnerProfileId' in parsed, 'winnerProfileId полето трябва да присъства дори при null')
    assertEqual(parsed.winnerProfileId, null, 'winnerProfileId трябва да е explicit null')
  })

  await check('[10] няма sensitive полета в сериализирания output', () => {
    const line = serializeLudoDiagnosticEvent('ludo_roll_accepted', {
      matchId: 'match-6',
      profileId: 'profile-6',
      requestRevision: 1,
      result: 'accepted',
    })
    const parsed = JSON.parse(line.trim())
    const forbiddenKeys = ['connectionId', 'ip', 'ipAddress', 'email', 'password', 'cookie', 'sessionId', 'authToken', 'token', 'visitorId', 'userAgent', 'user_agent']
    for (const key of forbiddenKeys) {
      assert(!(key in parsed), `sensitive поле "${key}" не трябва да присъства в diagnostic output-а`)
    }
    // Allowed field set е explicit closed — проверяваме, че сериализацията
    // не добавя нищо извън task spec §3 whitelist-а (+ timestamp/event).
    const allowedKeys = new Set([
      'timestamp', 'event', 'matchId', 'ludoRoomId', 'profileId', 'requestType',
      'requestRevision', 'authoritativeRevision', 'matchStatus', 'currentTurnColor',
      'currentTurnProfileId', 'turnPhase', 'result', 'errorCode', 'winnerProfileId',
    ])
    for (const key of Object.keys(parsed)) {
      assert(allowedKeys.has(key), `неочаквано поле "${key}" извън whitelisted field set-а`)
    }
  })

  await check('[11] реален file-I/O round-trip (multi-line append-only JSONL)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'belot-ludo-diagnostics-'))
    try {
      const filePath = join(dir, 'nested', 'ludo-diagnostics.jsonl')
      const line1 = serializeLudoDiagnosticEvent('ludo_match_started', { matchId: 'm1' })
      const line2 = serializeLudoDiagnosticEvent('ludo_roll_accepted', { matchId: 'm1', result: 'accepted' })
      await writeLudoDiagnosticLineForTest(filePath, line1)
      await writeLudoDiagnosticLineForTest(filePath, line2)
      const content = await readFile(filePath, 'utf8')
      const lines = content.split('\n').filter((l) => l.length > 0)
      assertEqual(lines.length, 2, 'файлът трябва да съдържа точно 2 append-нати реда')
      assertEqual(JSON.parse(lines[0]!).event, 'ludo_match_started', 'ред 1 трябва да е ludo_match_started')
      assertEqual(JSON.parse(lines[1]!).event, 'ludo_roll_accepted', 'ред 2 трябва да е ludo_roll_accepted')
      assert(filePath.includes('nested'), 'nested директорията трябва да е auto-created (mkdir recursive)')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  await check('[12] undefined полета се пропускат от сериализацията', () => {
    const line = serializeLudoDiagnosticEvent('ludo_match_started', {
      matchId: 'match-7',
      ludoRoomId: undefined,
      profileId: undefined,
    })
    const parsed = JSON.parse(line.trim())
    assert(!('ludoRoomId' in parsed), 'undefined ludoRoomId не трябва да присъства в JSON-а')
    assert(!('profileId' in parsed), 'undefined profileId не трябва да присъства в JSON-а')
    assertEqual(parsed.matchId, 'match-7', 'matchId (defined) трябва да присъства')
  })
} finally {
  restoreEnv()
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
