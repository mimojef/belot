// Свара — изолиран сървърен runtime за едновременни мачове (Етап 2Б.3.1).
//
// Тънка обвивка над чистия двигател (`engine/svaraMatch.ts`): пази текущото
// authoritative състояние на всеки мач в паметта и прилага команди атомарно.
// Правилата, банките и точкуването са САМО в двигателя — тук не се дублират.
//
// Без WebSocket/HTTP, реални сесии, timer handles или реални жълтици.
// 2Б.3.6А: синхронен persistence порт преди authoritative RAM commit;
// SQLite адаптерът остава извън runtime-а. Без порт — изолиран engine harness.
//
// Сигурност на командите:
//   • Самоличността на играча идва от доверен сървърен контекст
//     (`SvaraTrustedActor`), никога от полета в клиентската команда.
//   • Клиентските commandId се превеждат в собствено пространство на играча:
//     JSON.stringify(['p', playerId, clientCommandId]); системните — в
//     JSON.stringify(['s', systemCommandId]). JSON кодирането на масив от низове
//     е еднозначно (обратимо с JSON.parse), а различният етикет 'p'/'s'
//     изключва колизия между двете пространства при всякакви разделители и
//     специални символи.
//   • Участническите и системните команди са отделни интерфейси с отделни
//     бели списъци; участническият интерфейс отказва системни типове.
//
// Скрити карти: клиентският изглед се строи САМО чрез
// `createSvaraMatchPlayerView` (собствените карти — едва след „поглеждане“) и
// `describeSvaraMatchOptions` за самия зрител. Суровото състояние (ръце,
// история с показани карти, дневник) никога не се връща през клиентските
// методи — виж `createSvaraRuntimeClientFacade`. Протоколният snapshot за
// клиента (2Б.3.2) се строи от `protocol/svaraSnapshotProtocol.ts` върху
// вътрешното състояние, без да минава през `exportInternalStateForServer`.
//
// ОГРАНИЧЕНИЕ — един процес: всеки runtime е обикновен обект в паметта на
// ЕДИН Node процес. Ако сървърът работи в няколко PM2 процеса (cluster mode),
// всеки процес има собствен, несвързан runtime; Map-ът тук НЕ координира
// процеси. Преди свързване с реални WebSocket клиенти (2Б.3.3+) трябва да се
// изясни броят PM2 инстанции и да се осигури process affinity (всички играчи
// на една маса → един процес) или външна координация.

import { performance } from 'node:perf_hooks'
import { planSvaraDeadlines, svaraEpochNow, type SvaraDeadline } from './svaraDeadlines.js'
import { SvaraPersistenceError, type SvaraMatchPersistence, type SvaraStoredMatch } from './svaraPersistence.js'
import { validateSvaraStoredMatch } from './svaraStoredMatchValidation.js'
import { SvaraInvalidInputError } from '../engine/svaraCards.js'
import type { SvaraBettingAction, SvaraBettingOptions } from '../engine/svaraBetting.js'
import type { SvaraRandomSource } from '../engine/svaraRandom.js'
import {
  applySvaraMatchCommand,
  copyRestoredSvaraMatchForServer,
  createSvaraMatch,
  createSvaraMatchPlayerView,
  describeSvaraMatchOptions,
  describeSvaraLifecycle,
  type SvaraEntryPercent,
  type SvaraMatchCommand,
  type SvaraMatchEnv,
  type SvaraMatchPlayerView,
  type SvaraMatchState,
  type SvaraStartMode,
} from '../engine/svaraMatch.js'
import { createSvaraMatchSnapshotMessage, createSvaraPublicTable, type SvaraMatchSnapshotMessage, type SvaraPublicTable } from '../protocol/svaraSnapshotProtocol.js'

// ── Типове ──────────────────────────────────────────────────────────────────

export const SVARA_RUNTIME_LIMITS = {
  maxMatchIdLength: 64,
  maxPlayerIdLength: 128,
  maxClientCommandIdLength: 64,
  maxSystemCommandIdLength: 128,
} as const

export type SvaraRuntimeErrorCode =
  | 'invalid-input'
  | 'match-exists'
  | 'match-not-found'
  | 'not-a-participant'
  | 'command-not-allowed'
  | 'match-not-finished'
  | 'stale-action'

/** Грешка на runtime слоя; грешките на правилата идват като SvaraMatchError от двигателя. */
export class SvaraRuntimeError extends Error {
  constructor(readonly code: SvaraRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'SvaraRuntimeError'
  }
}

/**
 * Доверена самоличност — попълва се от сървъра (автентикирана сесия),
 * НИКОГА от тялото на клиентско съобщение.
 */
export type SvaraTrustedActor = { readonly playerId: string }

/** Командите, които участник може да подаде от свое име. Без playerId и commandId. */
export type SvaraParticipantCommand =
  | { type: 'join-seat' }
  | { type: 'leave-seat' }
  | { type: 'start-match' }
  | { type: 'look' }
  | { type: 'act'; action: SvaraBettingAction }
  | { type: 'svara-join' }
  | { type: 'svara-decline' }
  | { type: 'request-return' }
  | { type: 'exit' }

/**
 * Вътрешни системни команди — само от сървърния код (бъдещи таймери,
 * присъствие). Runtime-ът не ги изпълнява сам и не измисля срокове.
 */
export type SvaraSystemCommand =
  | { type: 'start-next-round' }
  | { type: 'svara-start' }
  | { type: 'advance-allin-svara' }
  | { type: 'absence-expired'; playerId: string }
  | { type: 'set-absent'; playerId: string; absent: boolean }
  | { type: 'activate-returns' }
  | { type: 'turn-timeout'; playerId: string; roundId: string; actionVersion: number }
  | { type: 'close-svara-joining'; roundId: string }
  | { type: 'finish-presence-wait'; winnerId: string | null }

export type SvaraAutomaticCommand = Extract<SvaraSystemCommand, { type: 'start-next-round' | 'svara-start' | 'advance-allin-svara' | 'activate-returns' | 'turn-timeout' }>

export type SvaraRuntimeCommandResult = {
  status: 'applied' | 'duplicate'
  type: SvaraMatchCommand['type']
  completedRounds: string[]
  phase: SvaraMatchState['phase']
}

/** Изглед за един участник — без чужди карти, тестета, RNG или дневник. */
export type SvaraRuntimePlayerView = {
  matchId: string
  viewerId: string
  capacity: 2 | 3 | 4
  startMode: SvaraStartMode
  creatorId: string
  startingChips: number
  entryChips: number
  seats: string[]
  winnerId: string | null
  view: SvaraMatchPlayerView
  options: SvaraBettingOptions | null
}

/** Сървърна диагностика (само бройки и времена — без карти). */
export type SvaraMatchDiagnostics = {
  matchId: string
  phase: SvaraMatchState['phase']
  seats: number
  ledgerEntries: number
  historyRecords: number
  processedCommands: number
  /** Дължина на JSON сериализацията на цялото състояние (при поискване). */
  serializedBytes: number | null
  appliedCommands: number
  duplicateCommands: number
  rejectedCommands: number
  totalApplyMs: number
  maxApplyMs: number
  lastApplyMs: number
}

export type SvaraRuntimeOptions = {
  /** Криптографски източник по подразбиране (в двигателя); seeded — само за тестове. */
  random?: SvaraRandomSource
  persistence?: SvaraMatchPersistence
  now?: () => number
}

export type SvaraRegisterMatchInput = {
  matchId: string
  creator: SvaraTrustedActor
  capacity: 2 | 3 | 4
  entryFee: number
  entryPercent?: SvaraEntryPercent
  startMode: SvaraStartMode
}

export type SvaraMatchRuntime = {
  registerMatch(input: SvaraRegisterMatchInput): void
  /** Atomic server-only batch import. No commands, SQL writes or timer handles. */
  restoreMatchesForServer(snapshots: readonly SvaraStoredMatch[]): void
  hasMatch(matchId: string): boolean
  listMatchIds(): string[]
  getPublicTable(matchId: string): SvaraPublicTable
  isParticipant(matchId: string, playerId: string): boolean
  isMatchFinished(matchId: string): boolean
  executeParticipantCommand(matchId: string, actor: SvaraTrustedActor, clientCommandId: string, command: unknown, expectedRevision?: number): SvaraRuntimeCommandResult
  executeSystemCommand(matchId: string, systemCommandId: string, command: SvaraSystemCommand): SvaraRuntimeCommandResult
  getMatchRevision(matchId: string): number
  getDeadlinesForServer(matchId: string): SvaraDeadline[]
  exportStoredMatchForServer(matchId: string): SvaraStoredMatch
  getLifecycleView(matchId: string): ReturnType<typeof describeSvaraLifecycle> & { revision: number }
  /** Server-only orchestration hint. Never closes an available joining opportunity. */
  getAutomaticCommand(matchId: string): SvaraAutomaticCommand | null
  getPlayerView(matchId: string, actor: SvaraTrustedActor): SvaraRuntimePlayerView
  /** Защитен индивидуален snapshot за клиента (2Б.3.2) — само за самия доверен участник. */
  getPlayerSnapshot(matchId: string, actor: SvaraTrustedActor): SvaraMatchSnapshotMessage
  /** САМО сървърно: дълбоко копие на пълното състояние (за бъдеща persistence). Никога към клиент. */
  exportInternalStateForServer(matchId: string): SvaraMatchState
  getMatchDiagnostics(matchId: string, options?: { measureBytes?: boolean }): SvaraMatchDiagnostics
  /** Изрично освобождаване; незавършен мач — само с allowUnfinished: true. */
  releaseMatch(matchId: string, options?: { allowUnfinished?: boolean }): { phase: SvaraMatchState['phase'] }
}

/** Методите, които бъдещ клиентски (WS) слой има право да вика. */
export type SvaraRuntimeClientFacade = Pick<SvaraMatchRuntime, 'hasMatch' | 'isParticipant' | 'executeParticipantCommand' | 'getPlayerView' | 'getPlayerSnapshot'>

// ── Помощни ─────────────────────────────────────────────────────────────────

const PARTICIPANT_TYPES = new Set(['join-seat', 'leave-seat', 'start-match', 'look', 'act', 'svara-join', 'svara-decline', 'request-return', 'exit'])
const SYSTEM_TYPES = new Set(['start-next-round', 'svara-start', 'advance-allin-svara', 'absence-expired', 'set-absent', 'activate-returns', 'turn-timeout', 'close-svara-joining', 'finish-presence-wait'])
const ACTION_KINDS = new Set(['fold', 'call', 'all-in', 'no-bet', 'bet', 'blind-bet'])

const fail = (code: SvaraRuntimeErrorCode, message: string): never => {
  throw new SvaraRuntimeError(code, message)
}

function requireId(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    fail('invalid-input', `${label} must be a non-empty string of at most ${maxLength} characters`)
  }
  return value as string
}

/** Еднозначно пространство на клиентските commandId за всеки играч. */
export function svaraParticipantCommandKey(playerId: string, clientCommandId: string): string {
  return JSON.stringify(['p', playerId, clientCommandId])
}

/** Отделно пространство за системните commandId (не може да се получи от клиентски id). */
export function svaraSystemCommandKey(systemCommandId: string): string {
  return JSON.stringify(['s', systemCommandId])
}

/** Строи командата наново от белия списък — непознати полета (вкл. playerId) се игнорират. */
function normalizeParticipantCommand(input: unknown, commandId: string, playerId: string): SvaraMatchCommand {
  if (!input || typeof input !== 'object') fail('invalid-input', 'command must be an object')
  const type = (input as { type?: unknown }).type
  if (typeof type !== 'string' || !PARTICIPANT_TYPES.has(type)) {
    fail('command-not-allowed', `command type ${String(type)} is not available to participants`)
  }
  if (type !== 'act') return { type, commandId, playerId } as SvaraMatchCommand
  const action = (input as { action?: unknown }).action
  if (!action || typeof action !== 'object') fail('invalid-input', 'action required')
  const kind = (action as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !ACTION_KINDS.has(kind)) fail('invalid-input', `unknown action ${String(kind)}`)
  const normalized: SvaraBettingAction = kind === 'bet' || kind === 'blind-bet'
    ? { kind, total: (action as { total?: unknown }).total as number }
    : ({ kind } as SvaraBettingAction)
  return { type: 'act', commandId, playerId, action: normalized }
}

function normalizeSystemCommand(input: SvaraSystemCommand, commandId: string): SvaraMatchCommand {
  if (!input || typeof input !== 'object') fail('invalid-input', 'command must be an object')
  const type = (input as { type?: unknown }).type
  if (typeof type !== 'string' || !SYSTEM_TYPES.has(type)) fail('command-not-allowed', `command type ${String(type)} is not a system command`)
  switch (input.type) {
    case 'start-next-round':
    case 'svara-start':
    case 'advance-allin-svara':
    case 'activate-returns':
      return { type: input.type, commandId }
    case 'turn-timeout':
      if (!Number.isSafeInteger(input.actionVersion) || input.actionVersion < 0) fail('invalid-input', 'invalid action version')
      return { type: input.type, commandId, playerId: requireId(input.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'playerId'),
        roundId: requireId(input.roundId, 128, 'roundId'), actionVersion: input.actionVersion }
    case 'close-svara-joining':
      return { type: input.type, commandId, roundId: requireId(input.roundId, 128, 'roundId') }
    case 'finish-presence-wait':
      return { type: input.type, commandId, winnerId: input.winnerId === null ? null : requireId(input.winnerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'winnerId') }
    case 'absence-expired':
      return { type: 'absence-expired', commandId, playerId: requireId(input.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'playerId') }
    case 'set-absent':
      return { type: 'set-absent', commandId, playerId: requireId(input.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'playerId'), absent: input.absent }
  }
}

const isTerminal = (state: SvaraMatchState) => state.phase === 'finished' || state.phase === 'closed'

// ── Runtime ─────────────────────────────────────────────────────────────────

type MatchEntry = {
  state: SvaraMatchState
  revision: number
  deadlines: SvaraDeadline[]
  deadlineSequence: number
  stats: { applied: number; duplicate: number; rejected: number; totalMs: number; maxMs: number; lastMs: number }
}

export function createSvaraMatchRuntime(options: SvaraRuntimeOptions = {}): SvaraMatchRuntime {
  // Собствено състояние за всяка инстанция — без глобални променливи на модула.
  const matches = new Map<string, MatchEntry>()
  const env: SvaraMatchEnv = options.random ? { random: options.random } : {}
  const now = options.now ?? svaraEpochNow
  const writing = new Set<string>()
  const stored = (matchId: string, entry: Pick<MatchEntry, 'state' | 'revision' | 'deadlines' | 'deadlineSequence'>): SvaraStoredMatch =>
    ({ formatVersion: 1, matchId, state: entry.state, revision: entry.revision, deadlines: entry.deadlines, deadlineSequence: entry.deadlineSequence })

  const entryOf = (matchId: string): MatchEntry => {
    const entry = typeof matchId === 'string' ? matches.get(matchId) : undefined
    if (!entry) fail('match-not-found', `match ${String(matchId)} is not registered`)
    return entry as MatchEntry
  }

  /** Атомарно: новото състояние се приема само при успех; иначе остава старото. */
  const apply = (entry: MatchEntry, command: SvaraMatchCommand): SvaraRuntimeCommandResult => {
    const matchId = entry.state.config.tableId
    if (writing.has(matchId)) throw new SvaraPersistenceError('revision-conflict')
    writing.add(matchId)
    const started = performance.now()
    try {
      const result = applySvaraMatchCommand(entry.state, command, env)
      if (result.status === 'applied') {
        const revision = entry.revision + 1
        const planned = planSvaraDeadlines(result.state, revision, entry.deadlines, entry.deadlineSequence, now())
        // The candidate remains private until the synchronous SQLite COMMIT returns.
        // Failure leaves state, revision, IDs and absolute deadlines untouched.
        options.persistence?.save(stored(matchId, { state: result.state, revision, ...planned }), entry.revision)
        entry.state = result.state
        entry.revision = revision
        entry.deadlines = planned.deadlines
        entry.deadlineSequence = planned.deadlineSequence
        const elapsed = performance.now() - started
        entry.stats.applied += 1
        entry.stats.totalMs += elapsed
        entry.stats.maxMs = Math.max(entry.stats.maxMs, elapsed)
        entry.stats.lastMs = elapsed
      } else entry.stats.duplicate += 1
      return { status: result.status, type: result.outcome.type, completedRounds: [...result.outcome.completedRounds], phase: entry.state.phase }
    } catch (error) {
      entry.stats.rejected += 1
      throw error
    } finally { writing.delete(matchId) }
  }

  const runtime: SvaraMatchRuntime = {
    restoreMatchesForServer(snapshots) {
      const prepared = new Map<string, MatchEntry>(), participants = new Set<string>()
      for (const entry of matches.values()) for (const playerId of entry.state.seats) {
        if (['active', 'absent'].includes(entry.state.status[playerId]!)) participants.add(playerId)
      }
      for (const snapshot of snapshots) {
        validateSvaraStoredMatch(snapshot)
        const matchId = snapshot.matchId
        if (matches.has(matchId) || prepared.has(matchId) || writing.has(matchId)) throw new SvaraPersistenceError('match-exists')
        if (!['lobby', 'in-progress'].includes(snapshot.state.phase)) throw new SvaraPersistenceError('invalid-snapshot')
        for (const playerId of snapshot.state.seats) if (['active', 'absent'].includes(snapshot.state.status[playerId]!)) {
          if (participants.has(playerId)) throw new SvaraPersistenceError('commitment-conflict')
          participants.add(playerId)
        }
        prepared.set(matchId, { state: copyRestoredSvaraMatchForServer(snapshot.state), revision: snapshot.revision,
          deadlines: structuredClone(snapshot.deadlines), deadlineSequence: snapshot.deadlineSequence,
          stats: { applied: 0, duplicate: 0, rejected: 0, totalMs: 0, maxMs: 0, lastMs: 0 } })
      }
      for (const [matchId, entry] of prepared) matches.set(matchId, entry)
    },
    registerMatch(input) {
      if (!input || typeof input !== 'object') fail('invalid-input', 'input required')
      const matchId = requireId(input.matchId, SVARA_RUNTIME_LIMITS.maxMatchIdLength, 'matchId')
      const creatorId = requireId(input.creator?.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'creator.playerId')
      if (matches.has(matchId)) fail('match-exists', `match ${matchId} is already registered`)
      let state: SvaraMatchState
      try {
        state = createSvaraMatch({ tableId: matchId, capacity: input.capacity, entryFee: input.entryFee, entryPercent: input.entryPercent, startMode: input.startMode, creatorId })
      } catch (error) {
        if (error instanceof SvaraInvalidInputError) fail('invalid-input', error.message)
        throw error
      }
      if (writing.has(matchId)) throw new SvaraPersistenceError('revision-conflict')
      writing.add(matchId)
      try {
        const entry: MatchEntry = { state: state!, revision: 0, deadlines: [], deadlineSequence: 0, stats: { applied: 0, duplicate: 0, rejected: 0, totalMs: 0, maxMs: 0, lastMs: 0 } }
        options.persistence?.save(stored(matchId, entry), null)
        matches.set(matchId, entry)
      } finally { writing.delete(matchId) }
    },

    hasMatch(matchId) {
      return typeof matchId === 'string' && matches.has(matchId)
    },

    listMatchIds() {
      return [...matches.keys()]
    },

    getPublicTable(matchId) {
      return createSvaraPublicTable(matchId, entryOf(matchId).state)
    },

    isParticipant(matchId, playerId) {
      const entry = typeof matchId === 'string' ? matches.get(matchId) : undefined
      return !!entry && typeof playerId === 'string' && entry.state.seats.includes(playerId)
    },

    isMatchFinished(matchId) {
      return isTerminal(entryOf(matchId).state)
    },

    executeParticipantCommand(matchId, actor, clientCommandId, command, expectedRevision) {
      const entry = entryOf(matchId)
      const playerId = requireId(actor?.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'actor.playerId')
      const clientId = requireId(clientCommandId, SVARA_RUNTIME_LIMITS.maxClientCommandIdLength, 'clientCommandId')
      const normalized = normalizeParticipantCommand(command, svaraParticipantCommandKey(playerId, clientId), playerId)
      // Всички команди освен заемане на място изискват участник в мача.
      // Повтор на вече обработена команда на СЪЩИЯ играч (ключът съдържа
      // playerId) отива към двигателя за идемпотентност/конфликт — напр.
      // повторено „напускане“ след като мястото вече е освободено.
      const alreadyProcessed = Object.hasOwn(entry.state.processedCommands, normalized.commandId)
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        fail('invalid-input', 'expectedRevision must be a non-negative safe integer')
      }
      // Duplicates/conflicts go to the engine BEFORE the stale check: a retry
      // after a lost response must not debit chips again or become a new move.
      if (!alreadyProcessed && expectedRevision !== undefined && expectedRevision !== entry.revision) {
        fail('stale-action', 'the match has advanced')
      }
      if (!alreadyProcessed && normalized.type !== 'join-seat' && (!entry.state.seats.includes(playerId) || entry.state.status[playerId] === 'exited')) {
        fail('not-a-participant', `${playerId} is not a participant of ${matchId}`)
      }
      return apply(entry, normalized)
    },

    getMatchRevision(matchId) {
      return entryOf(matchId).revision
    },

    getDeadlinesForServer(matchId) { return structuredClone(entryOf(matchId).deadlines) },
    exportStoredMatchForServer(matchId) { return structuredClone(stored(matchId, entryOf(matchId))) },

    getLifecycleView(matchId) {
      const entry = entryOf(matchId)
      return { ...describeSvaraLifecycle(entry.state), revision: entry.revision }
    },

    getAutomaticCommand(matchId) {
      const { state } = entryOf(matchId)
      if (state.phase !== 'in-progress') return null
      const round = state.round
      const view = describeSvaraLifecycle(state)
      if (view.atBoundary && view.readyPlayerIds.length < 2) return null
      if (view.atBoundary && view.returningPlayerIds.length > 0) return { type: 'activate-returns' }
      if (view.actorAbsent && view.actorId && view.roundId) return { type: 'turn-timeout', playerId: view.actorId, roundId: view.roundId, actionVersion: view.actionVersion }
      if (!round) {
        const startable = state.lockedPots.some((pot) => pot.kind === 'ordinary' && pot.eligible.every((id) => state.status[id] === 'active'))
        const funded = state.seats.filter((id) => (state.status[id] === 'active' || state.status[id] === 'absent') && state.stacks[id]! > 0)
        return startable || funded.length >= 2 ? { type: 'start-next-round' } : null
      }
      if (round.kind === 'allin-svara') return { type: 'advance-allin-svara' }
      if (round.kind !== 'svara-joining') return null
      return view.joining?.holdersReady && (!view.joining.open || view.joining.undecided.length === 0) ? { type: 'svara-start' } : null
    },

    executeSystemCommand(matchId, systemCommandId, command) {
      const entry = entryOf(matchId)
      const systemId = requireId(systemCommandId, SVARA_RUNTIME_LIMITS.maxSystemCommandIdLength, 'systemCommandId')
      const normalized = normalizeSystemCommand(command, svaraSystemCommandKey(systemId))
      if ('playerId' in normalized && !entry.state.seats.includes(normalized.playerId)) {
        fail('not-a-participant', `${normalized.playerId} is not a participant of ${matchId}`)
      }
      return apply(entry, normalized)
    },

    getPlayerView(matchId, actor) {
      const entry = entryOf(matchId)
      const viewerId = requireId(actor?.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'actor.playerId')
      const { state } = entry
      if (!state.seats.includes(viewerId)) fail('not-a-participant', `${viewerId} is not a participant of ${matchId}`)
      const options = describeSvaraMatchOptions(state, viewerId)
      return {
        matchId,
        viewerId,
        capacity: state.config.capacity,
        startMode: state.config.startMode,
        creatorId: state.config.creatorId,
        startingChips: state.startingChips,
        entryChips: state.entryChips,
        seats: [...state.seats],
        winnerId: state.winnerId,
        view: createSvaraMatchPlayerView(state, viewerId),
        options: options ? structuredClone(options) : null,
      }
    },

    getPlayerSnapshot(matchId, actor) {
      const entry = entryOf(matchId)
      const viewerId = requireId(actor?.playerId, SVARA_RUNTIME_LIMITS.maxPlayerIdLength, 'actor.playerId')
      if (!entry.state.seats.includes(viewerId)) fail('not-a-participant', `${viewerId} is not a participant of ${matchId}`)
      return createSvaraMatchSnapshotMessage(matchId, entry.state, viewerId)
    },

    exportInternalStateForServer(matchId) {
      return structuredClone(entryOf(matchId).state)
    },

    getMatchDiagnostics(matchId, diagnosticsOptions = {}) {
      const entry = entryOf(matchId)
      const { state, stats } = entry
      return {
        matchId,
        phase: state.phase,
        seats: state.seats.length,
        ledgerEntries: state.ledger.length,
        historyRecords: state.history.length,
        processedCommands: Object.keys(state.processedCommands).length,
        serializedBytes: diagnosticsOptions.measureBytes ? Buffer.byteLength(JSON.stringify(state), 'utf8') : null,
        appliedCommands: stats.applied,
        duplicateCommands: stats.duplicate,
        rejectedCommands: stats.rejected,
        totalApplyMs: stats.totalMs,
        maxApplyMs: stats.maxMs,
        lastApplyMs: stats.lastMs,
      }
    },

    releaseMatch(matchId, releaseOptions = {}) {
      const entry = entryOf(matchId)
      if (writing.has(matchId)) throw new SvaraPersistenceError('revision-conflict')
      // Без автоматично освобождаване: извикващият решава кога (в 2Б.3.6 —
      // след успешна persistence). Незавършен мач изисква изрично разрешение.
      if (!isTerminal(entry.state) && releaseOptions.allowUnfinished !== true) {
        fail('match-not-finished', `match ${matchId} is ${entry.state.phase}; pass allowUnfinished to discard it`)
      }
      matches.delete(matchId)
      return { phase: entry.state.phase }
    },
  }
  return runtime
}

/** Само методите, позволени за бъдещ клиентски слой — без системни команди и сурово състояние. */
export function createSvaraRuntimeClientFacade(runtime: SvaraMatchRuntime): SvaraRuntimeClientFacade {
  return Object.freeze({
    hasMatch: (matchId: string) => runtime.hasMatch(matchId),
    isParticipant: (matchId: string, playerId: string) => runtime.isParticipant(matchId, playerId),
    executeParticipantCommand: (matchId: string, actor: SvaraTrustedActor, clientCommandId: string, command: unknown, expectedRevision?: number) =>
      runtime.executeParticipantCommand(matchId, actor, clientCommandId, command, expectedRevision),
    getPlayerView: (matchId: string, actor: SvaraTrustedActor) => runtime.getPlayerView(matchId, actor),
    getPlayerSnapshot: (matchId: string, actor: SvaraTrustedActor) => runtime.getPlayerSnapshot(matchId, actor),
  })
}
