// checkReconnectAttemptProofs.ts — Етап 4, без мрежа:
//  [Q1] proof: само за удостоверени; проверка по профил и стойност;
//       освободена връзка -> невалиден; ограничена дължина; пази се само хешът
//  [Q2] доказан собствен опит, който ДЪРЖИ мястото (прикрепен, но потвърждението
//       е изгубено) -> позволено; без доказателство -> other_session_active
//  [Q3] доказан собствен полуотворен неприкрепен опит -> позволено
//  [Q4] чужда жива връзка (без доказателство) продължава да блокира, дори ако
//       клиентът докаже други свои опити
//  [Q5] без доказани опити -> поведението е идентично с досегашното
//  [Q6] parseClientMessage: priorAttempts до 32 валидни записа; невалидните се пропускат
//  [Q7] [resume] редът съдържа само id и бройки — никога proof
//  [Q8] верига: опит, доказал свои предишни, ги предава на следващия; само
//       регистрирани връзки на същия профил; освободена връзка отпада
//  [Q9] рискът: 9 поредни полуотворени опита, клиентът помни само последните 5
//       -> по веригата всички 8 предишни са доказани (без other_session_active)
//
//   node node_modules/tsx/dist/cli.mjs scripts/checkReconnectAttemptProofs.ts   (от server/)
import { createReconnectAttemptProofStore } from '../src/core/reconnectAttemptProofs.js'
import { evaluateSilentActiveRoomReconnect } from '../src/game/evaluateSilentActiveRoomReconnect.js'
import { formatResumeRoomLogLine } from '../src/diagnostics/reconnectDiagnostics.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import type { ServerConnection, ServerRoom } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${label}`) } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const ME = 'profile-me'
const ROOM = 'room-1'
const TOKEN = 'token-secret'
function conn(id: string, profileId: string | null, currentRoomId: string | null, status: 'connected' | 'disconnected' = 'connected'): ServerConnection {
  return { id, status, connectedAt: 0, lastSeenAt: 0, remoteAddress: null, userAgent: null, currentRoomId, currentSeat: null, playerId: null, profileId, sessionId: null }
}
function room(seatConnectionId: string | null): ServerRoom {
  const participant = { kind: 'human', reconnectToken: TOKEN, connectionId: seatConnectionId, permanentlyLeftAt: null, identity: { profileId: ME }, publicProfile: null }
  return { id: ROOM, config: { isGuestTrial: false }, seats: { bottom: { participant }, right: { participant: null }, top: { participant: null }, left: { participant: null } } } as unknown as ServerRoom
}
function evaluate(input: { seat: string | null; connections: ServerConnection[]; proven?: string[] }) {
  return evaluateSilentActiveRoomReconnect({
    connectionId: 'conn-C', profileId: ME, reconnectOf: 'conn-A', room: room(input.seat), reconnectToken: TOKEN,
    connections: Object.fromEntries(input.connections.map((c) => [c.id, c])),
    getRecentlyClosed: (id) => (id === 'conn-A' ? { profileId: ME, roomId: ROOM, closedAt: 1_000 } : undefined),
    now: 2_000, recentlyClosedTtlMs: 150_000,
    provenOwnConnectionIds: new Set(input.proven ?? []),
  })
}

console.log('\ncheckReconnectAttemptProofs\n')

check('[Q1] proof: само за удостоверени; профил + стойност; освободена връзка -> невалиден; дължина', () => {
  const store = createReconnectAttemptProofStore()
  assert(store.issue('g', null) === null && store.size() === 0, 'гост получи proof')
  const proof = store.issue('b', ME)
  assert(typeof proof === 'string' && proof.length >= 20, `proof=${proof}`)
  assert(store.verify('b', ME, proof!), 'валиден proof отхвърлен')
  assert(!store.verify('b', ME, proof!.slice(0, -1) + (proof!.endsWith('A') ? 'B' : 'A')), 'грешен proof приет')
  assert(!store.verify('b', 'profile-other', proof!), 'чужд профил приет')
  assert(!store.verify('x', ME, proof!), 'proof за друга връзка приет')
  assert(!store.verify('b', ME, 'x'.repeat(65)), 'прекалено дълъг proof')
  assert(!store.verify('b', null, proof!), 'гост приет')
  store.release('b')
  assert(!store.verify('b', ME, proof!) && store.size() === 0, 'освободена връзка все още валидна')
  const other = store.issue('c', ME)
  assert(other !== proof, 'proof-овете не са уникални')
})

check('[Q2] собствен опит ДЪРЖИ мястото (потвърждението е изгубено): доказан -> позволено; иначе other_session_active', () => {
  const connections = [conn('conn-C', ME, null), conn('conn-B', ME, ROOM)]
  const blocked = evaluate({ seat: 'conn-B', connections })
  assert(!blocked.ok && blocked.code === 'other_session_active' && blocked.detail === 'seat_held_by_other_connection', JSON.stringify(blocked))
  const allowed = evaluate({ seat: 'conn-B', connections, proven: ['conn-B'] })
  assert(allowed.ok && allowed.provenOwnConnectionIds.join(',') === 'conn-B', JSON.stringify(allowed))
})

check('[Q3] собствен полуотворен неприкрепен опит: доказан -> позволено; иначе other_live_connection', () => {
  const connections = [conn('conn-C', ME, null), conn('conn-B', ME, null)]
  const blocked = evaluate({ seat: null, connections })
  assert(!blocked.ok && blocked.detail === 'other_live_connection', JSON.stringify(blocked))
  const allowed = evaluate({ seat: null, connections, proven: ['conn-B'] })
  assert(allowed.ok && allowed.provenOwnConnectionIds.join(',') === 'conn-B', JSON.stringify(allowed))
})

check('[Q4] чужда жива връзка (друго устройство) блокира, дори при други доказани собствени опити', () => {
  const connections = [conn('conn-C', ME, null), conn('conn-B', ME, null), conn('conn-OTHER-DEVICE', ME, null)]
  const r = evaluate({ seat: null, connections, proven: ['conn-B'] })
  assert(!r.ok && r.code === 'other_session_active' && r.blockingConnectionId === 'conn-OTHER-DEVICE', JSON.stringify(r))
  const seatHeld = evaluate({ seat: 'conn-OTHER-DEVICE', connections: [conn('conn-C', ME, null), conn('conn-OTHER-DEVICE', ME, ROOM)], proven: ['conn-B'] })
  assert(!seatHeld.ok && seatHeld.detail === 'seat_held_by_other_connection', JSON.stringify(seatHeld))
})

check('[Q5] без доказани опити -> досегашното поведение', () => {
  const ok = evaluate({ seat: null, connections: [conn('conn-C', ME, null)] })
  assert(ok.ok && ok.provenOwnConnectionIds.length === 0 && ok.previousConnection === 'recently_closed', JSON.stringify(ok))
  const disconnected = evaluate({ seat: null, connections: [conn('conn-C', ME, null), conn('conn-B', ME, null, 'disconnected')] })
  assert(disconnected.ok, 'затворена връзка блокира')
})

check('[Q6] parseClientMessage: priorAttempts до 32 валидни записа; невалидните се пропускат; липсва при празно', () => {
  const base = { type: 'resume_room', roomId: 'r', reconnectToken: 't', reconnectOf: 'a' }
  const valid = Array.from({ length: 40 }, (_, i) => ({ connectionId: `c${i}`, proof: `p${i}` }))
  const parsed = parseClientMessage(JSON.stringify({ ...base, priorAttempts: valid })) as any
  assert(Array.isArray(parsed.priorAttempts) && parsed.priorAttempts.length === 32 && parsed.priorAttempts[31].connectionId === 'c31', JSON.stringify(parsed.priorAttempts?.length))
  const filler = Array.from({ length: 30 }, () => null)
  const mixed = parseClientMessage(JSON.stringify({ ...base, priorAttempts: [{ connectionId: 'ok', proof: 'p' }, { connectionId: 1, proof: 'p' }, { connectionId: 'x', proof: 'y'.repeat(65) }, { connectionId: 'ok2', proof: 'q', extra: 'drop' }, ...filler, { connectionId: 'late', proof: 'z' }] })) as any
  assert(JSON.stringify(mixed.priorAttempts) === JSON.stringify([{ connectionId: 'ok', proof: 'p' }, { connectionId: 'ok2', proof: 'q' }]), JSON.stringify(mixed.priorAttempts))
  // Обработват се само първите 32 сурови записа (ограничение на работата).
  assert(!mixed.priorAttempts.some((p: any) => p.connectionId === 'late'), 'запис след 32-рия')
  for (const bad of [undefined, [], 'x', {}, [1, 2]]) {
    const p = parseClientMessage(JSON.stringify({ ...base, priorAttempts: bad })) as any
    assert(p !== null && !('priorAttempts' in p), `прието ${JSON.stringify(bad)}`)
  }
})

check('[Q7] [resume] редът: само id и бройки — никога proof', () => {
  const line = formatResumeRoomLogLine({
    connectionId: 'conn-C', profileId: ME, roomId: ROOM, mode: 'silent_reconnect', reconnectOf: 'conn-A', reconnectAttempt: 3,
    result: 'attached', reason: 'ok', seat: 'bottom', priorAttemptCount: 2, verifiedPriorAttemptCount: 1, provenOwnConnectionIds: ['conn-B'],
    ...({ priorAttempts: [{ connectionId: 'conn-B', proof: 'PROOF-SECRET-123' }], attemptProof: 'PROOF-SECRET-456' } as object),
  } as never, 0)
  const p = JSON.parse(line.slice('[resume] '.length))
  assert(p.priorAttemptCount === 2 && p.verifiedPriorAttemptCount === 1 && p.provenOwnConnectionIds[0] === 'conn-B', line)
  assert(!line.includes('PROOF-SECRET'), 'proof в лога')
})

check('[Q8] верига: наследяване само на регистрирани връзки на същия профил; освободена отпада', () => {
  const store = createReconnectAttemptProofStore()
  const pB = store.issue('B', ME)!
  const pC = store.issue('C', ME)!
  const pD = store.issue('D', ME)!
  store.issue('E', ME)
  assert([...store.resolveOwned('C', ME, [{ connectionId: 'B', proof: pB }])].join(',') === 'B', 'C доказва B')
  assert([...store.resolveOwned('D', ME, [{ connectionId: 'C', proof: pC }])].sort().join(',') === 'B,C', 'D наследява B през C')
  store.release('B')
  assert([...store.resolveOwned('E', ME, [{ connectionId: 'D', proof: pD }])].sort().join(',') === 'C,D', 'освободената B не се наследява')
  // Чужд профил: нито директно, нито по веригата.
  const pX = store.issue('X', 'profile-other')!
  store.issue('Y', 'profile-other')
  assert(store.resolveOwned('Y', 'profile-other', [{ connectionId: 'D', proof: pD }]).size === 0, 'чужд профил доказа D')
  assert(store.resolveOwned('E', ME, [{ connectionId: 'X', proof: pX }]).size === 0, 'чужда връзка приета')
  // Грешен proof не дава и наследство.
  assert(store.resolveOwned('E', ME, [{ connectionId: 'D', proof: 'wrong' }]).size === 0, 'грешен proof')
})

check('[Q9] 9 поредни полуотворени опита, клиентът помни само последните 5: всички 8 предишни са доказани', () => {
  const store = createReconnectAttemptProofStore()
  const attempts: Array<{ connectionId: string; proof: string }> = []
  let lastOwned = new Set<string>()
  for (let i = 1; i <= 9; i++) {
    const id = `A${i}`
    const proof = store.issue(id, ME)!
    lastOwned = store.resolveOwned(id, ME, attempts.slice(-5)) // клиент със стария лимит 5
    attempts.push({ connectionId: id, proof })
  }
  assert(lastOwned.size === 8 && [1, 2, 3, 4, 5, 6, 7, 8].every((i) => lastOwned.has(`A${i}`)), [...lastOwned].join(','))
  // Без веригата (нито един resume_room не е стигнал до сървъра) — директно
  // всички 31 предишни опита от тавана 32.
  const direct = createReconnectAttemptProofStore()
  const list = Array.from({ length: 31 }, (_, i) => ({ connectionId: `Z${i}`, proof: direct.issue(`Z${i}`, ME)! }))
  direct.issue('NOW', ME)
  assert(direct.resolveOwned('NOW', ME, list).size === 31, 'директни 31')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
