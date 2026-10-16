/**
 * checkSvaraRuntime2B31.ts — Свара, Етап 2Б.3.1: изолиран сървърен runtime
 * за едновременни мачове (без WebSocket/HTTP/SQLite).
 *
 *  A. Регистрация, уникалност, независими мачове, несъществуващ мач.
 *  B. Самоличност и членство; невалиден ход без промяна на състоянието.
 *  C. Пространства на commandId (клиентски/системни), идемпотентност, конфликт.
 *  D. Скрити карти и липса на сурово състояние в клиентските методи.
 *  E. Изолация между маси, завършване, контролирано освобождаване.
 *  F. Отчетност, дълъг мач, едновременни мачове и измерване на растежа.
 *  G. Изолация на модула.
 *
 * Пускане (от server/): npm run check:svara-runtime-2b31
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  assertSvaraMatchInvariants,
  createSeededSvaraRandomSourceForTests,
  SvaraMatchError,
  type SvaraBettingAction,
  type SvaraMatchState,
} from '../src/games/svara/engine/index.js'
import {
  createSvaraMatchRuntime,
  createSvaraRuntimeClientFacade,
  svaraParticipantCommandKey,
  svaraSystemCommandKey,
  SvaraRuntimeError,
  type SvaraMatchRuntime,
  type SvaraRuntimePlayerView,
  type SvaraSystemCommand,
} from '../src/games/svara/runtime/svaraMatchRuntime.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

/** Очаква грешка с даден код (SvaraRuntimeError или SvaraMatchError). */
function expectError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    if ((error instanceof SvaraRuntimeError || error instanceof SvaraMatchError) && error.code === code) return
    throw new Error(`expected ${code}, got ${error instanceof Error ? `${error.name}:${(error as { code?: string }).code}: ${error.message}` : String(error)}`)
  }
  throw new Error(`expected ${code}, but no error was thrown`)
}

const A = { playerId: 'alice' }
const B = { playerId: 'bob' }
const C = { playerId: 'carol' }
const D = { playerId: 'dave' }

const snapshot = (rt: SvaraMatchRuntime, matchId: string) => JSON.stringify(rt.exportInternalStateForServer(matchId))

/** Маса за трима с автоматичен старт и първо раздаване. */
function startedTable(rt: SvaraMatchRuntime, matchId: string): void {
  rt.registerMatch({ matchId, creator: A, capacity: 3, entryFee: 100, startMode: 'auto' })
  rt.executeParticipantCommand(matchId, B, 'j', { type: 'join-seat' })
  rt.executeParticipantCommand(matchId, C, 'j', { type: 'join-seat' })
  rt.executeSystemCommand(matchId, 'round-1', { type: 'start-next-round' })
}

function handsOf(rt: SvaraMatchRuntime, matchId: string): Record<string, string[]> {
  const round = rt.exportInternalStateForServer(matchId).round
  assert(round && (round.kind === 'ordinary' || round.kind === 'svara'), 'expected a betting round')
  return round.hands
}

const FORBIDDEN_KEYS = ['"ledger"', '"history"', '"processedCommands"', '"hands"', '"shownHands"', '"deck"', '"random"', '"fingerprint"', '"betting"']

/**
 * Проверява, че изгледът на зрителя не съдържа чужди карти, собствени
 * непогледнати карти, вътрешни полета или пространствата на commandId.
 */
function assertViewIsSafe(view: SvaraRuntimePlayerView, state: SvaraMatchState): void {
  const json = JSON.stringify(view)
  for (const key of FORBIDDEN_KEYS) assert(!json.includes(key), `view leaks ${key}`)
  assert(!json.includes('[\\"p\\"') && !json.includes('[\\"s\\"'), 'view leaks namespaced commandIds')
  const round = state.round
  const visibleOwn = new Set<string>()
  if (round && (round.kind === 'ordinary' || round.kind === 'svara') && round.betting.looked.includes(view.viewerId)) {
    for (const code of round.hands[view.viewerId] ?? []) visibleOwn.add(code)
  }
  // 2Б.3.7.1: докато изборът „Покажи“/„Скрий“ чака, победителят продължава да
  // вижда собствената си (вече погледната) ръка — тя живее в round.cards, не
  // round.hands, след прехода. Веднъж показана, вече не е „скрита“ за никого.
  if (round && round.kind === 'reveal-choice' && round.winnerId === view.viewerId) {
    for (const code of round.cards) visibleOwn.add(code)
  }
  const hidden = new Set<string>()
  if (round && (round.kind === 'ordinary' || round.kind === 'svara')) {
    for (const [id, cards] of Object.entries(round.hands)) for (const code of cards) if (!(id === view.viewerId && visibleOwn.has(code))) hidden.add(code)
  }
  if (round && round.kind === 'reveal-choice' && round.decision === 'pending') {
    for (const code of round.cards) if (!visibleOwn.has(code)) hidden.add(code)
  }
  for (const record of state.history) for (const cards of Object.values(record.shownHands)) for (const code of cards) if (!visibleOwn.has(code)) hidden.add(code)
  for (const code of hidden) assert(!json.includes(`"${code}"`), `view of ${view.viewerId} leaks card ${code}`)
  const own = view.view.ownCards
  if (own) assert(own.length === visibleOwn.size && own.every((code) => visibleOwn.has(code)), 'ownCards must equal the looked own hand')
}

// ── Драйвер за случайна игра през runtime (сървърът решава системните команди) ──

type Driver = {
  rt: SvaraMatchRuntime
  matchId: string
  players: string[]
  pick: (n: number) => number
  seq: number
  sysSeq: number
  /** Пасивна игра — предимно откази, за дълъг мач. */
  passive: boolean
  absences: boolean
  /** Проверка на изгледите на всички след всяка команда. */
  checkViews: boolean
}

function newDriver(rt: SvaraMatchRuntime, matchId: string, count: number, seed: number, mode: Partial<Pick<Driver, 'passive' | 'absences' | 'checkViews'>> = {}): Driver {
  const random = createSeededSvaraRandomSourceForTests(seed)
  const players = ['p0', 'p1', 'p2', 'p3'].slice(0, count)
  rt.registerMatch({ matchId, creator: { playerId: players[0]! }, capacity: count as 2 | 3 | 4, entryFee: 100 + 10 * random.nextInt(40), entryPercent: mode.passive ? 1 : ([1, 2, 3, 5] as const)[random.nextInt(4)], startMode: 'auto' })
  for (const id of players.slice(1)) rt.executeParticipantCommand(matchId, { playerId: id }, 'join', { type: 'join-seat' })
  return { rt, matchId, players, pick: (n) => random.nextInt(n), seq: 0, sysSeq: 0, passive: false, absences: false, checkViews: false, ...mode }
}

function driveStep(d: Driver): void {
  const { rt, matchId, pick } = d
  const v = rt.getPlayerView(matchId, { playerId: d.players[0]! }).view
  const status = v.status
  const activeIds = d.players.filter((id) => status[id] === 'active')
  const absentIds = d.players.filter((id) => status[id] === 'absent')
  const alive = [...activeIds, ...absentIds]
  const sys = (command: SvaraSystemCommand) => rt.executeSystemCommand(matchId, `sys-${(d.sysSeq += 1)}`, command)
  const part = (id: string, command: unknown) => rt.executeParticipantCommand(matchId, { playerId: id }, `c${(d.seq += 1)}`, command)
  if (d.absences && pick(80) === 0 && alive.length > 0) {
    const id = alive[pick(alive.length)]!
    sys({ type: 'set-absent', playerId: id, absent: status[id] === 'active' })
    return
  }
  if (absentIds.length > 0 && activeIds.length === 1 && pick(3) === 0) {
    sys({ type: 'absence-expired', playerId: absentIds[pick(absentIds.length)]! })
    return
  }
  if (v.roundKind === null) {
    try {
      sys({ type: 'start-next-round' })
    } catch (error) {
      if (error instanceof SvaraMatchError && error.code === 'no-round-available' && absentIds.length > 0) {
        sys({ type: 'set-absent', playerId: absentIds[0]!, absent: false })
        return
      }
      throw error
    }
    return
  }
  if (v.roundKind === 'svara-joining') {
    const absentHolder = v.lockedPots.flatMap((pot) => pot.eligible).find((id) => status[id] === 'absent')
    if (absentHolder) {
      sys({ type: 'set-absent', playerId: absentHolder, absent: false })
      return
    }
    const candidates = activeIds.filter((id) => v.stacks[id]! >= v.svaraJoinFee!)
    if (candidates.length > 0 && pick(3) === 0) {
      try {
        part(candidates[pick(candidates.length)]!, { type: 'svara-join' })
        return
      } catch (error) {
        if (!(error instanceof SvaraMatchError && error.code === 'not-allowed')) throw error
      }
    }
    sys({ type: 'svara-start' })
    return
  }
  if (v.roundKind === 'allin-svara') {
    sys({ type: 'advance-allin-svara' })
    return
  }
  if (v.roundKind === 'reveal-choice') {
    // 2Б.3.7.1: изборът не борави с карти в самата driver-логика (само
    // сървърен winnerId/decision), затова се чете директно от състоянието,
    // както handsOf прави за ръцете по-горе в този файл.
    const round = rt.exportInternalStateForServer(matchId).round as { decision: 'pending' | 'revealed'; winnerId: string; roundId: string }
    if (round.decision === 'pending') {
      if (status[round.winnerId] !== 'active') { sys({ type: 'set-absent', playerId: round.winnerId, absent: false }); return }
      part(round.winnerId, { type: 'hide-cards' })
    } else {
      sys({ type: 'close-reveal-display', roundId: round.roundId })
    }
    return
  }
  const actor = v.toAct
  assert(actor, 'betting round without toAct')
  if (status[actor] === 'absent') {
    sys({ type: 'set-absent', playerId: actor, absent: false })
    return
  }
  const own = rt.getPlayerView(matchId, { playerId: actor })
  const options = own.options!
  if (!own.view.ownLooked && (pick(3) === 0 || (options.lookRequired && !options.blindBet && options.call === null && options.allIn === null))) {
    part(actor, { type: 'look' })
    return
  }
  const choices: SvaraBettingAction[] = []
  if (d.passive) {
    if (options.noBet) choices.push({ kind: 'no-bet' })
    else if (options.fold && pick(10) !== 0) choices.push({ kind: 'fold' })
  }
  if (choices.length === 0) {
    if (options.fold && pick(4) === 0) choices.push({ kind: 'fold' })
    if (options.noBet) choices.push({ kind: 'no-bet' })
    if (options.call !== null) choices.push({ kind: 'call' })
    if (options.bet) choices.push({ kind: 'bet', total: options.bet.min + pick(Math.min(3, options.bet.max - options.bet.min + 1)) })
    if (options.blindBet) choices.push({ kind: 'blind-bet', total: options.blindBet.min })
    if (options.allIn !== null && !d.passive && pick(3) === 0) choices.push({ kind: 'all-in' })
    if (choices.length === 0) choices.push({ kind: 'fold' })
  }
  part(actor, { type: 'act', action: choices[pick(choices.length)]! })
}

function checkAllViews(d: Driver): void {
  const state = d.rt.exportInternalStateForServer(d.matchId)
  for (const id of state.seats) assertViewIsSafe(d.rt.getPlayerView(d.matchId, { playerId: id }), state)
}

/** Играе до края или до maxSteps; връща броя стъпки. */
function playOut(d: Driver, maxSteps: number): number {
  let steps = 0
  while (!d.rt.isMatchFinished(d.matchId) && steps < maxSteps) {
    driveStep(d)
    if (d.checkViews) checkAllViews(d)
    steps += 1
  }
  return steps
}

// ─── A. Регистрация ─────────────────────────────────────────────────────────
console.log('\n=== A. регистрация и независими мачове ===')

check('1. регистрация на мач: съществува, създателят е участник, изгледът е лоби', () => {
  const rt = createSvaraMatchRuntime()
  assert(!rt.hasMatch('t1'), 'not yet')
  rt.registerMatch({ matchId: 't1', creator: A, capacity: 2, entryFee: 100, startMode: 'manual' })
  assert(rt.hasMatch('t1') && rt.listMatchIds().join() === 't1', 'registered')
  assert(rt.isParticipant('t1', 'alice') && !rt.isParticipant('t1', 'bob'), 'membership')
  const view = rt.getPlayerView('t1', A)
  assert(view.view.phase === 'lobby' && view.seats.join() === 'alice' && view.creatorId === 'alice' && view.options === null, 'lobby view')
  assert(!rt.isMatchFinished('t1'), 'not finished')
  expectError(() => rt.registerMatch({ matchId: '', creator: A, capacity: 2, entryFee: 100, startMode: 'manual' }), 'invalid-input')
  expectError(() => rt.registerMatch({ matchId: 'x', creator: { playerId: '' }, capacity: 2, entryFee: 100, startMode: 'manual' }), 'invalid-input')
  expectError(() => rt.registerMatch({ matchId: 'y', creator: A, capacity: 5 as 4, entryFee: 100, startMode: 'manual' }), 'invalid-input')
  assert(rt.listMatchIds().join() === 't1', 'failed registrations leave nothing behind')
})

check('2. дублиран matchId се отказва, съществуващият мач не се променя', () => {
  const rt = createSvaraMatchRuntime()
  rt.registerMatch({ matchId: 't1', creator: A, capacity: 3, entryFee: 100, startMode: 'auto' })
  rt.executeParticipantCommand('t1', B, 'j', { type: 'join-seat' })
  const before = snapshot(rt, 't1')
  expectError(() => rt.registerMatch({ matchId: 't1', creator: C, capacity: 2, entryFee: 500, startMode: 'manual' }), 'match-exists')
  assert(snapshot(rt, 't1') === before, 'state unchanged')
})

check('3. няколко независими мача в един runtime', () => {
  const rt = createSvaraMatchRuntime()
  for (const id of ['m1', 'm2', 'm3']) rt.registerMatch({ matchId: id, creator: A, capacity: 2, entryFee: 100, startMode: 'auto' })
  const m2 = snapshot(rt, 'm2')
  const m3 = snapshot(rt, 'm3')
  rt.executeParticipantCommand('m1', B, 'j', { type: 'join-seat' })
  assert(rt.exportInternalStateForServer('m1').phase === 'in-progress', 'm1 started')
  assert(snapshot(rt, 'm2') === m2 && snapshot(rt, 'm3') === m3, 'others untouched')
  assert(rt.listMatchIds().sort().join() === 'm1,m2,m3', 'all present')
})

check('4. команда към несъществуващ мач → match-not-found', () => {
  const rt = createSvaraMatchRuntime()
  expectError(() => rt.executeParticipantCommand('nope', A, 'c1', { type: 'join-seat' }), 'match-not-found')
  expectError(() => rt.executeSystemCommand('nope', 's1', { type: 'start-next-round' }), 'match-not-found')
  expectError(() => rt.getPlayerView('nope', A), 'match-not-found')
  expectError(() => rt.isMatchFinished('nope'), 'match-not-found')
  expectError(() => rt.releaseMatch('nope'), 'match-not-found')
  assert(!rt.isParticipant('nope', 'alice') && !rt.hasMatch('nope'), 'boolean checks are false')
})

// ─── B. Самоличност и членство ──────────────────────────────────────────────
console.log('\n=== B. самоличност, членство, невалиден ход ===')

check('5. команда и изглед от неучастник се отказват без промяна', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  const before = snapshot(rt, 't')
  for (const command of [{ type: 'look' }, { type: 'act', action: { kind: 'fold' } }, { type: 'exit' }, { type: 'svara-join' }, { type: 'leave-seat' }, { type: 'start-match' }]) {
    expectError(() => rt.executeParticipantCommand('t', D, 'x1', command), 'not-a-participant')
  }
  expectError(() => rt.getPlayerView('t', D), 'not-a-participant')
  expectError(() => rt.executeSystemCommand('t', 'abs', { type: 'absence-expired', playerId: 'dave' }), 'not-a-participant')
  expectError(() => rt.executeSystemCommand('t', 'abs', { type: 'set-absent', playerId: 'dave', absent: true }), 'not-a-participant')
  // Заемане на място в започнал мач — отказ от правилата на двигателя.
  expectError(() => rt.executeParticipantCommand('t', D, 'x2', { type: 'join-seat' }), 'wrong-phase')
  expectError(() => rt.executeParticipantCommand('t', { playerId: '' }, 'x3', { type: 'look' }), 'invalid-input')
  expectError(() => rt.executeParticipantCommand('t', null as never, 'x3', { type: 'look' }), 'invalid-input')
  assert(snapshot(rt, 't') === before, 'state unchanged')
  assert(rt.getMatchDiagnostics('t').rejectedCommands === 1, 'only the engine-level refusal is counted as rejected')
})

check('6. невалиден ход (не е на ред / под минимума / непознат тип) не променя състоянието и не заема commandId', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  const state = rt.exportInternalStateForServer('t')
  const round = state.round!
  assert(round.kind === 'ordinary', 'ordinary')
  const toAct = round.betting.toAct!
  const other = state.seats.find((id) => id !== toAct)!
  const before = snapshot(rt, 't')
  expectError(() => rt.executeParticipantCommand('t', { playerId: other }, 'm1', { type: 'act', action: { kind: 'call' } }), 'betting:not-your-turn')
  expectError(() => rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', { type: 'act', action: { kind: 'blind-bet', total: 1 } }), 'betting:below-minimum')
  expectError(() => rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', { type: 'act', action: { kind: 'steal' } }), 'invalid-input')
  expectError(() => rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', { type: 'act' }), 'invalid-input')
  expectError(() => rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', 'look'), 'invalid-input')
  expectError(() => rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', { type: 'join-seat' }), 'wrong-phase')
  assert(snapshot(rt, 't') === before, 'state unchanged after every refusal')
  // Отказаните команди не заемат идентификатора — валидна команда със същия id минава.
  const result = rt.executeParticipantCommand('t', { playerId: toAct }, 'm1', { type: 'act', action: { kind: 'fold' } })
  assert(result.status === 'applied', 'applied after refusals')
})

// ─── C. Пространства на commandId ───────────────────────────────────────────
console.log('\n=== C. commandId: пространства, идемпотентност, конфликт ===')

check('7. двама играчи с един и същ клиентски commandId не си пречат', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  const r1 = rt.executeParticipantCommand('t', A, 'same', { type: 'look' })
  const r2 = rt.executeParticipantCommand('t', B, 'same', { type: 'look' })
  const r3 = rt.executeParticipantCommand('t', C, 'same', { type: 'look' })
  assert(r1.status === 'applied' && r2.status === 'applied' && r3.status === 'applied', 'all applied')
  const state = rt.exportInternalStateForServer('t')
  const round = state.round!
  assert(round.kind === 'ordinary' && ['alice', 'bob', 'carol'].every((id) => round.betting.looked.includes(id)), 'each looked')
  // Още в началото B и C заеха 'j' за join-seat — също без конфликт.
  assert(Object.hasOwn(state.processedCommands, svaraParticipantCommandKey('bob', 'j')) && Object.hasOwn(state.processedCommands, svaraParticipantCommandKey('carol', 'j')), 'namespaced keys')
})

check('8. повторена команда от същия играч не се изпълнява втори път', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  const state = rt.exportInternalStateForServer('t')
  const toAct = state.round!.kind === 'ordinary' ? state.round!.betting.toAct! : ''
  rt.executeParticipantCommand('t', { playerId: toAct }, 'look-1', { type: 'look' })
  const bet = rt.getPlayerView('t', { playerId: toAct }).options!.bet!
  const command = { type: 'act', action: { kind: 'bet', total: bet.min } }
  const first = rt.executeParticipantCommand('t', { playerId: toAct }, 'bet-1', command)
  assert(first.status === 'applied', 'applied')
  const after = snapshot(rt, 't')
  const second = rt.executeParticipantCommand('t', { playerId: toAct }, 'bet-1', command)
  assert(second.status === 'duplicate' && second.type === 'act', 'duplicate')
  assert(snapshot(rt, 't') === after, 'no second application')
  // Също и със „шум“ в клиентските полета: те се игнорират и не променят отпечатъка.
  const third = rt.executeParticipantCommand('t', { playerId: toAct }, 'bet-1', { ...command, playerId: 'someone-else', extra: 1 })
  assert(third.status === 'duplicate', 'ignored fields do not alter fingerprint')
  const diag = rt.getMatchDiagnostics('t')
  assert(diag.duplicateCommands === 2, 'duplicates counted')
})

check('9. същият commandId с различно съдържание → command-id-conflict без промяна', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  rt.executeParticipantCommand('t', A, 'k', { type: 'look' })
  const before = snapshot(rt, 't')
  expectError(() => rt.executeParticipantCommand('t', A, 'k', { type: 'exit' }), 'command-id-conflict')
  assert(snapshot(rt, 't') === before, 'state unchanged')
  expectError(() => rt.executeSystemCommand('t', 'round-1', { type: 'svara-start' }), 'command-id-conflict')
  assert(snapshot(rt, 't') === before, 'state unchanged (system)')
})

check('10. клиентските и системните commandId са в отделни, еднозначни пространства', () => {
  const rt = createSvaraMatchRuntime()
  rt.registerMatch({ matchId: 't', creator: A, capacity: 3, entryFee: 100, startMode: 'auto' })
  // Клиентски id, равен на системния — без конфликт.
  rt.executeParticipantCommand('t', B, 'round-1', { type: 'join-seat' })
  rt.executeParticipantCommand('t', C, 's', { type: 'join-seat' })
  const r = rt.executeSystemCommand('t', 'round-1', { type: 'start-next-round' })
  assert(r.status === 'applied', 'system command applied despite equal client id')
  // Опит за „фалшифициране“ на системен ключ през клиентски id.
  const forged = [svaraSystemCommandKey('round-1'), '["s","round-1"]', 's:round-1', '"]', '","', '\\', '\u0000', 'round-1"]']
  for (const id of forged) {
    const result = rt.executeParticipantCommand('t', A, id, { type: 'look' })
    assert(result.status === 'applied' || result.status === 'duplicate', `forged id ${JSON.stringify(id)} handled as a plain client id`)
  }
  const keys = Object.keys(rt.exportInternalStateForServer('t').processedCommands)
  const parsed = keys.map((key) => JSON.parse(key) as string[])
  assert(parsed.every((p) => (p[0] === 'p' && p.length === 3) || (p[0] === 's' && p.length === 2)), 'every key decodes to exactly one namespace')
  assert(parsed.filter((p) => p[0] === 's').map((p) => p[1]).join() === 'round-1', 'only the real system command lives in the system namespace')
  // Еднозначност при разделители и специални символи.
  const tricky: Array<[string, string]> = [['a","b', 'c'], ['a', 'b","c'], ['a:b', 'c'], ['a', 'b:c'], ['a|b', 'c'], ['a', 'b|c'], ['a\\', '"c'], ['a', '\\"c'], ['p', 's'], ['s', 'p']]
  const encoded = new Set(tricky.map(([p, c]) => svaraParticipantCommandKey(p, c)))
  assert(encoded.size === tricky.length, 'no collisions between tricky pairs')
  for (const [p, c] of tricky) {
    assert(JSON.stringify(JSON.parse(svaraParticipantCommandKey(p, c))) === JSON.stringify(['p', p, c]), 'reversible')
    assert(svaraParticipantCommandKey(p, c) !== svaraSystemCommandKey(c) && svaraParticipantCommandKey(p, c) !== svaraSystemCommandKey(`${p}${c}`), 'never equals a system key')
  }
  expectError(() => rt.executeParticipantCommand('t', A, '', { type: 'look' }), 'invalid-input')
  expectError(() => rt.executeParticipantCommand('t', A, 'x'.repeat(65), { type: 'look' }), 'invalid-input')
  expectError(() => rt.executeSystemCommand('t', '', { type: 'start-next-round' }), 'invalid-input')
})

check('11. системни команди не могат да се изпълнят през участническия интерфейс; playerId от клиента се игнорира', () => {
  const rt = createSvaraMatchRuntime()
  startedTable(rt, 't')
  const before = snapshot(rt, 't')
  for (const type of ['start-next-round', 'svara-start', 'advance-allin-svara', 'absence-expired', 'set-absent', 'unknown', '__proto__', 'constructor']) {
    expectError(() => rt.executeParticipantCommand('t', A, `x-${type}`, { type, playerId: 'bob', absent: true }), 'command-not-allowed')
  }
  assert(snapshot(rt, 't') === before, 'state unchanged')
  // Клиентът не може да действа от чуждо име.
  rt.executeParticipantCommand('t', A, 'look', { type: 'look', playerId: 'bob' })
  const round = rt.exportInternalStateForServer('t').round!
  assert(round.kind === 'ordinary' && round.betting.looked.join() === 'alice', 'look applied to the trusted actor only')
  // Фасадата за клиентски слой няма системни методи и сурово състояние.
  const facade = createSvaraRuntimeClientFacade(rt) as unknown as Record<string, unknown>
  assert(Object.keys(facade).sort().join() === 'executeParticipantCommand,getPlayerSnapshot,getPlayerView,hasMatch,isParticipant', 'facade surface')
  for (const name of ['executeSystemCommand', 'exportInternalStateForServer', 'getMatchDiagnostics', 'releaseMatch', 'registerMatch']) assert(!(name in facade), `facade exposes ${name}`)
  assert(Object.isFrozen(facade), 'facade frozen')
  // Системен интерфейс отказва участнически типове.
  expectError(() => rt.executeSystemCommand('t', 'sx', { type: 'look' } as never), 'command-not-allowed')
  expectError(() => rt.executeSystemCommand('t', 'sx', { type: 'act', playerId: 'alice', action: { kind: 'fold' } } as never), 'command-not-allowed')
})

// ─── D. Скрити карти ────────────────────────────────────────────────────────
console.log('\n=== D. скрити карти ===')

check('12. чуждите карти са скрити (и след като всички са погледнали)', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(12) })
  startedTable(rt, 't')
  for (const actor of [A, B, C]) rt.executeParticipantCommand('t', actor, 'look', { type: 'look' })
  const hands = handsOf(rt, 't')
  const state = rt.exportInternalStateForServer('t')
  for (const actor of [A, B, C]) {
    const view = rt.getPlayerView('t', actor)
    assertViewIsSafe(view, state)
    const json = JSON.stringify(view)
    for (const [id, cards] of Object.entries(hands)) {
      if (id === actor.playerId) continue
      for (const code of cards) assert(!json.includes(`"${code}"`), `${actor.playerId} sees ${id}'s ${code}`)
    }
  }
})

check('13. собствените карти са скрити преди „поглеждане“ (тъмно)', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(13) })
  startedTable(rt, 't')
  const hands = handsOf(rt, 't')
  const state = rt.exportInternalStateForServer('t')
  for (const actor of [A, B, C]) {
    const view = rt.getPlayerView('t', actor)
    assert(view.view.ownCards === null && view.view.ownLooked === false, 'no own cards before look')
    const json = JSON.stringify(view)
    for (const code of Object.values(hands).flat()) assert(!json.includes(`"${code}"`), `card ${code} leaked before look`)
    assertViewIsSafe(view, state)
  }
})

check('14. след „поглеждане“ — само собствените карти; другите остават скрити', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(14) })
  startedTable(rt, 't')
  rt.executeParticipantCommand('t', B, 'look', { type: 'look' })
  const hands = handsOf(rt, 't')
  const state = rt.exportInternalStateForServer('t')
  const bobView = rt.getPlayerView('t', B)
  assert(bobView.view.ownLooked && JSON.stringify(bobView.view.ownCards) === JSON.stringify(hands.bob), 'bob sees exactly his cards')
  assertViewIsSafe(bobView, state)
  for (const actor of [A, C]) {
    const view = rt.getPlayerView('t', actor)
    assert(view.view.ownCards === null, 'others still blind')
    for (const code of hands.bob!) assert(!JSON.stringify(view).includes(`"${code}"`), 'bob cards leaked')
  }
  // Изгледът е копие: промяната му не засяга сървърното състояние.
  bobView.view.ownCards!.length = 0
  bobView.view.stacks.bob = 999999
  assert(snapshot(rt, 't') === JSON.stringify(state), 'view is a detached copy')
})

check('14b. случайна игра: след всяка команда изгледите на всички са безопасни (вкл. след шоудаун и Свари)', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(1414) })
  let steps = 0
  let finished = 0
  for (let m = 0; m < 40; m += 1) {
    const d = newDriver(rt, `v${m}`, 2 + (m % 3), 9000 + m, { absences: true, checkViews: true })
    steps += playOut(d, 400)
    if (rt.isMatchFinished(d.matchId)) finished += 1
    // Резултатите от команди не носят сурово състояние.
    const result = JSON.stringify(rt.getPlayerView(d.matchId, { playerId: 'p0' }))
    for (const key of FORBIDDEN_KEYS) assert(!result.includes(key), `leak ${key}`)
  }
  console.log(`      стъпки ${steps}, завършени мачове ${finished}/40`)
  assert(steps > 1500, 'coverage')
})

// ─── E. Изолация, завършване, освобождаване ─────────────────────────────────
console.log('\n=== E. изолация между маси, завършване, освобождаване ===')

check('15. две маси с едни и същи играчи и commandId имат отделни състояния', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(15) })
  startedTable(rt, 'x')
  startedTable(rt, 'y')
  const y = snapshot(rt, 'y')
  rt.executeParticipantCommand('x', A, 'look', { type: 'look' })
  rt.executeParticipantCommand('x', B, 'look', { type: 'look' })
  assert(snapshot(rt, 'y') === y, 'y untouched by x')
  const r = rt.executeParticipantCommand('y', A, 'look', { type: 'look' })
  assert(r.status === 'applied', 'same client id on another table is a new command')
  const viewX = rt.getPlayerView('x', B)
  const viewY = rt.getPlayerView('y', B)
  assert(viewX.view.ownLooked && !viewY.view.ownLooked, 'per-table looked status')
  // Две отделни инстанции на runtime също не споделят нищо.
  const other = createSvaraMatchRuntime()
  assert(!other.hasMatch('x') && other.listMatchIds().length === 0, 'runtime instances isolated')
  startedTable(other, 'x')
  assert(snapshot(rt, 'y') !== '' && rt.getPlayerView('x', A).view.ownLooked && !other.getPlayerView('x', A).view.ownLooked, 'same matchId in two runtimes is independent')
})

check('16. завършването на един мач не засяга другите', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(16) })
  const fast = newDriver(rt, 'fast', 2, 1601)
  const slow = newDriver(rt, 'slow', 4, 1602)
  playOut(slow, 30)
  const slowBefore = snapshot(rt, 'slow')
  playOut(fast, 5000)
  assert(rt.isMatchFinished('fast'), 'fast match finished')
  assert(snapshot(rt, 'slow') === slowBefore, 'slow untouched')
  assert(rt.hasMatch('fast'), 'finished match is not auto-released')
  const finalState = rt.exportInternalStateForServer('fast')
  assert(finalState.phase === 'finished' && finalState.winnerId !== null, 'winner set')
  expectError(() => rt.executeSystemCommand('fast', 'after', { type: 'start-next-round' }), 'wrong-phase')
  playOut(slow, 50)
  assertSvaraMatchInvariants(rt.exportInternalStateForServer('slow'))
})

check('17. контролирано освобождаване от паметта', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(17) })
  startedTable(rt, 'live')
  expectError(() => rt.releaseMatch('live'), 'match-not-finished')
  expectError(() => rt.releaseMatch('live', { allowUnfinished: 'yes' as never }), 'match-not-finished')
  assert(rt.hasMatch('live'), 'still present')
  const fin = newDriver(rt, 'fin', 2, 1701)
  playOut(fin, 5000)
  assert(rt.isMatchFinished('fin') && rt.hasMatch('fin'), 'finished but kept')
  assert(rt.releaseMatch('fin').phase === 'finished' && !rt.hasMatch('fin'), 'released finished')
  expectError(() => rt.getPlayerView('fin', { playerId: 'p0' }), 'match-not-found')
  // Затворена преди старта маса (създателят напусна) е крайна.
  rt.registerMatch({ matchId: 'closed', creator: A, capacity: 3, entryFee: 100, startMode: 'auto' })
  rt.executeParticipantCommand('closed', B, 'j', { type: 'join-seat' })
  rt.executeParticipantCommand('closed', A, 'leave', { type: 'leave-seat' })
  assert(rt.isMatchFinished('closed'), 'closed is terminal')
  assert(rt.executeParticipantCommand('closed', A, 'leave', { type: 'leave-seat' }).status === 'duplicate', 'retry of leave after the seat is gone stays idempotent')
  expectError(() => rt.executeParticipantCommand('closed', B, 'look', { type: 'look' }), 'not-a-participant')
  rt.releaseMatch('closed')
  assert(rt.releaseMatch('live', { allowUnfinished: true }).phase === 'in-progress' && !rt.hasMatch('live'), 'explicit discard of unfinished')
  assert(rt.listMatchIds().length === 0, 'empty')
  // Освободеният id може да се регистрира отново като нов мач.
  rt.registerMatch({ matchId: 'live', creator: B, capacity: 2, entryFee: 100, startMode: 'manual' })
  assert(rt.getPlayerView('live', B).view.phase === 'lobby', 'fresh match')
})

// ─── F. Отчетност, дълъг мач, растеж ────────────────────────────────────────
console.log('\n=== F. отчетност, дълъг мач, едновременни мачове, растеж ===')

check('18. отчетни инварианти и системни команди без частични промени', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(18) })
  startedTable(rt, 't')
  const before = snapshot(rt, 't')
  // Невалидни системни команди: без частична промяна.
  expectError(() => rt.executeSystemCommand('t', 'n1', { type: 'start-next-round' }), 'not-allowed')
  expectError(() => rt.executeSystemCommand('t', 'n2', { type: 'svara-start' }), 'not-allowed')
  expectError(() => rt.executeSystemCommand('t', 'n3', { type: 'advance-allin-svara' }), 'not-allowed')
  expectError(() => rt.executeSystemCommand('t', 'n4', { type: 'set-absent', playerId: 'alice', absent: 'yes' as never }), 'invalid-command')
  expectError(() => rt.executeSystemCommand('t', 'n5', { type: 'set-absent', playerId: '', absent: true }), 'invalid-input')
  assert(snapshot(rt, 't') === before, 'unchanged')
  // Случайна игра в няколко мача: инвариантите важат за всяко състояние.
  let checked = 0
  for (let m = 0; m < 30; m += 1) {
    const d = newDriver(rt, `a${m}`, 2 + (m % 3), 1800 + m, { absences: true })
    for (let i = 0; i < 300 && !rt.isMatchFinished(d.matchId); i += 1) {
      driveStep(d)
      const state = rt.exportInternalStateForServer(d.matchId)
      assertSvaraMatchInvariants(state)
      const stacks = state.seats.reduce((sum, id) => sum + state.stacks[id]!, 0)
      const round = state.round && (state.round.kind === 'ordinary' || state.round.kind === 'svara') ? Object.values(state.round.contributions).reduce((a, b) => a + b, 0) + (state.round.kind === 'ordinary' ? state.round.deadMoney : 0) : 0
      const locked = state.lockedPots.reduce((sum, pot) => sum + pot.amount, 0)
      const carried = state.carried.reduce((sum, c) => sum + c.amount, 0)
      assert(stacks + round + locked + carried + state.removedChips === state.totalChips, 'conservation')
      assert(state.ledger.every((e) => (JSON.parse(e.commandId) as string[])[0] === 'p' || (JSON.parse(e.commandId) as string[])[0] === 's'), 'ledger entries carry namespaced command ids')
      checked += 1
    }
  }
  console.log(`      проверени състояния: ${checked}`)
  assert(checked > 1000, 'coverage')
})

type Checkpoint = { commands: number; ledger: number; history: number; processed: number; bytes: number; windowAvgMs: number; windowMaxMs: number }

/** Дълъг мач: пасивна игра (предимно откази → дилърът печели Входа). */
function runLongMatch(target: number, checkpoints: number[]): { rows: Checkpoint[]; finishedEarly: boolean; rt: SvaraMatchRuntime } {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(19) })
  const d = newDriver(rt, 'long', 4, 1901, { passive: true })
  const rows: Checkpoint[] = []
  let windowMax = 0
  let windowTotal = 0
  let windowCount = 0
  let lastApplied = rt.getMatchDiagnostics('long').appliedCommands
  while (!rt.isMatchFinished('long') && lastApplied < target) {
    driveStep(d)
    const diag = rt.getMatchDiagnostics('long')
    if (diag.appliedCommands > lastApplied) {
      windowTotal += diag.lastApplyMs
      windowMax = Math.max(windowMax, diag.lastApplyMs)
      windowCount += 1
    }
    lastApplied = diag.appliedCommands
    if (checkpoints.includes(lastApplied) && rows.every((r) => r.commands !== lastApplied)) {
      const full = rt.getMatchDiagnostics('long', { measureBytes: true })
      rows.push({ commands: lastApplied, ledger: full.ledgerEntries, history: full.historyRecords, processed: full.processedCommands, bytes: full.serializedBytes!, windowAvgMs: windowTotal / Math.max(1, windowCount), windowMaxMs: windowMax })
      windowTotal = 0
      windowMax = 0
      windowCount = 0
    }
  }
  return { rows, finishedEarly: rt.isMatchFinished('long'), rt }
}

// По подразбиране 3000 команди (~30 с); пълното измерване: npm run check:svara-runtime-2b31 -- --long=8000
const LONG_TARGET = Math.max(1000, Number(process.argv.find((arg) => arg.startsWith('--long='))?.slice(7) ?? 3000) || 3000)
const LONG_CHECKPOINTS = [500, 1000, 2000, 3000, 4000, 6000, 8000, 12000, 16000].filter((n) => n < LONG_TARGET).concat(LONG_TARGET)
let longRun: ReturnType<typeof runLongMatch> | null = null

check(`19. дълъг мач с ${LONG_TARGET} последователни команди: инварианти, идемпотентност на стари команди`, () => {
  const started = performance.now()
  longRun = runLongMatch(LONG_TARGET, LONG_CHECKPOINTS)
  const seconds = (performance.now() - started) / 1000
  const { rt } = longRun
  assert(!longRun.finishedEarly, 'passive long match should not finish before the target')
  const state = rt.exportInternalStateForServer('long')
  assertSvaraMatchInvariants(state)
  const diag = rt.getMatchDiagnostics('long')
  assert(diag.appliedCommands >= LONG_TARGET, 'reached target')
  assert(diag.processedCommands === diag.appliedCommands, 'every applied command (incl. join-seat) is remembered')
  // Най-старите команди все още се разпознават като повтори.
  assert(rt.executeParticipantCommand('long', { playerId: 'p1' }, 'join', { type: 'join-seat' }).status === 'duplicate', 'first command still deduplicated')
  assert(rt.executeSystemCommand('long', 'sys-1', { type: 'start-next-round' }).status === 'duplicate', 'first system command still deduplicated')
  console.log(`      ${diag.appliedCommands} приложени команди за ${seconds.toFixed(1)} с; рундове ${state.history.length}; общо време в двигателя ${diag.totalApplyMs.toFixed(0)} мс; макс. ${diag.maxApplyMs.toFixed(2)} мс`)
})

check('20. измерване на растежа на състоянието и времето за обработка', () => {
  assert(longRun, 'long run available')
  const rows = longRun.rows
  assert(rows.length === LONG_CHECKPOINTS.length, `all checkpoints reached (${rows.length})`)
  console.log('      команди | дневник | история | processed | JSON KB | B/команда | ср. мс/команда в прозореца | макс. мс')
  for (const r of rows) {
    console.log(`      ${String(r.commands).padStart(7)} | ${String(r.ledger).padStart(7)} | ${String(r.history).padStart(7)} | ${String(r.processed).padStart(9)} | ${(r.bytes / 1024).toFixed(0).padStart(7)} | ${(r.bytes / r.commands).toFixed(0).padStart(9)} | ${r.windowAvgMs.toFixed(3).padStart(26)} | ${r.windowMaxMs.toFixed(2)}`)
  }
  // Растежът е линеен по броя команди (без скрито натрупване): байтове/команда в тесен диапазон.
  const perCommand = rows.map((r) => r.bytes / r.commands)
  const minPer = Math.min(...perCommand)
  const maxPer = Math.max(...perCommand)
  assert(maxPer / minPer < 1.6, `bytes per command should stay roughly constant (${minPer.toFixed(0)}..${maxPer.toFixed(0)})`)
  // Времето за команда расте с размера (structuredClone на цялото състояние) — тук само груба горна граница.
  assert(rows[rows.length - 1]!.windowAvgMs < 100, 'average apply time stays below 100 ms at the largest checkpoint')

  // Типична дължина на завършен мач при случайна игра.
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(20) })
  const lengths: number[] = []
  const bytes: number[] = []
  for (let m = 0; m < 60; m += 1) {
    const d = newDriver(rt, `len${m}`, 2 + (m % 3), 2000 + m)
    playOut(d, 20000)
    if (!rt.isMatchFinished(d.matchId)) continue
    const diag = rt.getMatchDiagnostics(d.matchId, { measureBytes: true })
    lengths.push(diag.appliedCommands)
    bytes.push(diag.serializedBytes!)
    rt.releaseMatch(d.matchId)
  }
  lengths.sort((a, b) => a - b)
  bytes.sort((a, b) => a - b)
  const q = (list: number[], p: number) => list[Math.min(list.length - 1, Math.floor(p * list.length))]!
  console.log(`      завършени случайни мачове: ${lengths.length}/60; команди медиана ${q(lengths, 0.5)}, p90 ${q(lengths, 0.9)}, макс. ${lengths[lengths.length - 1]}; JSON медиана ${(q(bytes, 0.5) / 1024).toFixed(0)} KB, макс. ${(bytes[bytes.length - 1]! / 1024).toFixed(0)} KB`)
  assert(lengths.length >= 50, 'most random matches finish')
})

check('21. едновременни мачове (20, редувани команди): изолация, инварианти, производителност', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(21) })
  const drivers = Array.from({ length: 20 }, (_, i) => newDriver(rt, `c${i}`, 2 + (i % 3), 2100 + i, { absences: i % 2 === 0, passive: i % 5 === 0 }))
  const started = performance.now()
  let steps = 0
  for (let turn = 0; turn < 400; turn += 1) {
    for (const d of drivers) {
      if (rt.isMatchFinished(d.matchId)) continue
      driveStep(d)
      steps += 1
    }
  }
  const ms = performance.now() - started
  let bytes = 0
  for (const d of drivers) {
    const state = rt.exportInternalStateForServer(d.matchId)
    assertSvaraMatchInvariants(state)
    assert(state.config.tableId === d.matchId, 'own config')
    const own = new Set(d.players)
    for (const key of Object.keys(state.processedCommands)) {
      const parts = JSON.parse(key) as string[]
      assert(parts[0] === 's' || own.has(parts[1]!), 'only own players in processed commands')
    }
    assert(state.seats.every((id) => own.has(id)), 'own seats')
    bytes += rt.getMatchDiagnostics(d.matchId, { measureBytes: true }).serializedBytes!
  }
  console.log(`      ${steps} стъпки в 20 мача за ${ms.toFixed(0)} мс (${(ms / steps).toFixed(3)} мс/стъпка); общо JSON ${(bytes / 1024).toFixed(0)} KB; завършени ${drivers.filter((d) => rt.isMatchFinished(d.matchId)).length}`)
  assert(steps > 1500, 'coverage')
})

// ─── G. Изолация на модула ──────────────────────────────────────────────────
console.log('\n=== G. изолация на модула ===')

check('22. runtime импортира само engine/protocol, deadline planner, persistence порт и perf_hooks; без DB/transport/handles', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'runtime', 'svaraMatchRuntime.ts')
  const source = readFileSync(file, 'utf8')
  // Само кодът, без коментарите (заглавието документира, че няма WebSocket).
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  for (const match of source.matchAll(/from '([^']+)'/g)) {
    assert(/^\.\.\/engine\/svara[A-Za-z]+\.js$/.test(match[1]!) || match[1] === '../protocol/svaraSnapshotProtocol.js' || match[1] === 'node:perf_hooks' ||
      match[1] === './svaraDeadlines.js' || match[1] === './svaraPersistence.js' || match[1] === './svaraStoredMatchValidation.js', `imports ${match[1]}`)
  }
  for (const banned of ['WebSocket', 'sqlite', 'setTimeout', 'setInterval', 'process.env', 'buildSvaraDeckForHands', 'createDeck']) {
    assert(!code.includes(banned), `runtime code mentions ${banned}`)
  }
  // Няма променливи на ниво модул освен константи.
  const topLevelMutable = source.split('\n').filter((line) => /^(let|var) /.test(line))
  assert(topLevelMutable.length === 0, `top-level mutable: ${topLevelMutable.join(' | ')}`)
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
