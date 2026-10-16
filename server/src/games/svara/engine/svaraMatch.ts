// Свара — мач: маса, Вход, дилър, наддаване, обикновена Свара и Свара с
// ол-ин (чиста сървърна логика, Етап 2Б.2Б).
//
// Спецификация: temp/svara/Svara_Etap_2B2B_Spec_2026-10-15.md (локален
// документ на собственика, не е в Git). Номерата на правилата по-долу
// сочат разделите ѝ.
//
// НЕ е свързано с реалните жълтици, HTTP, WebSocket, SQLite или UI.
// Наградата за победителя, таймерите, persistence и reconnect са бъдещи етапи.
//
// Седемте блокиращи случая от частичния 2Б.2Б (§11), петте окончателни
// решения от втората вълна (15.10.2026 — пълна забрана на непълен тъмен
// ол-ин, нормален ол-ин след поглеждане, многослойна Свара с ол-ин при
// обикновена Свара, пренесена банка в основната, две независими Свари) и
// финалното решение за няколко едновременно спорни странични банки (§12,
// трета вълна) са реализирани. Към момента няма известен нерешен подслучай:
// `advanceAllInSvara` разрешава произволен брой едновременно заключени
// банки (основна + произволен брой странични) с едно общо раздаване и
// независима оценка на всяка банка — виж коментарите там.

import { SVARA_ORDERED_DECK, svaraCardCode, parseSvaraCardCode, SvaraInvalidInputError, type SvaraCard, type SvaraCardCode } from './svaraCards.js'
import { createShuffledSvaraDeck, createSvaraDeckFromCards, dealSvaraHands } from './svaraDeal.js'
import { evaluateSvaraHand } from './svaraHandEvaluation.js'
import { buildSvaraPotLayers } from './svaraPots.js'
import { createCryptoSvaraRandomSource, type SvaraRandomSource } from './svaraRandom.js'
import { svaraStartingChipsForEntry } from './svaraChips.js'
import {
  applySvaraBettingAction,
  createSvaraBetting,
  describeSvaraBettingOptions,
  forceSvaraFold,
  lookAtSvaraCards,
  SvaraBettingError,
  type SvaraBettingAction,
  type SvaraBettingOptions,
  type SvaraBettingState,
} from './svaraBetting.js'

// ── Типове ──────────────────────────────────────────────────────────────────

export type SvaraEntryPercent = 1 | 2 | 3 | 5
export type SvaraStartMode = 'auto' | 'manual'
export type SvaraSeatStatus = 'active' | 'absent' | 'exited' | 'eliminated'

export type SvaraMatchConfig = {
  tableId: string
  capacity: 2 | 3 | 4
  /** Такса за участие в маса (жълтици) — само за изчисляване на началните чипове. */
  entryFee: number
  /** Вход за обикновено раздаване като % от началните чипове (1 по подразбиране). */
  entryPercent: SvaraEntryPercent
  startMode: SvaraStartMode
  creatorId: string
}

export type SvaraMatchAccount = 'buy-in' | 'removed' | `stack:${string}` | `round:${string}` | `locked:${string}` | `carried:${string}`

export type SvaraMatchLedgerType =
  | 'starting-chips'
  | 'entry'
  | 'bet'
  | 'svara-join-fee'
  | 'carry-in'
  | 'uncalled-return'
  | 'pot-award'
  | 'pot-lock'
  | 'pot-carry'
  | 'pot-split'
  | 'split-remainder-removed'
  | 'exit-removed'

export type SvaraMatchLedgerEntry = {
  seq: number
  commandId: string
  type: SvaraMatchLedgerType
  from: SvaraMatchAccount
  to: SvaraMatchAccount
  amount: number
  roundId: string | null
  potId: string | null
  playerId: string | null
}

export type SvaraMatchLockedPot = {
  potId: string
  /** 'ordinary' — обикновена Свара; 'allin' — Свара с ол-ин (§7). */
  kind: 'ordinary' | 'allin'
  amount: number
  /** Правоимащи (равните; при обикновена Свара — и платилите такса). */
  eligible: string[]
  originRoundId: string
  /** Дилърът на раздаването, породило Сварата (за първия ѝ дилър, §6.5). */
  originDealerId: string
  /** Дилърът на последното продължение на тази Свара (ротация, §6.5). */
  lastSvaraDealerId: string | null
  continuation: number
  /** Само за 'allin': основната банка (повторно раздаване) или странична (подялба). */
  isMain: boolean
}

export type SvaraCarriedBalance = { carryId: string; amount: number; fromRoundId: string; fromPotId: string }

export type SvaraPotOutcome =
  | { kind: 'uncalled-return'; playerId: string }
  | { kind: 'awarded'; winner: string; byShowdown: boolean }
  | { kind: 'locked'; lockedPotId: string; tiedPlayers: string[]; lockKind: 'ordinary' | 'allin' }
  | { kind: 'carried'; carryId: string }
  | { kind: 'split'; tiedPlayers: string[]; share: number; removed: number }

export type SvaraRoundPotRecord = {
  potId: string
  source: 'round' | 'locked'
  amount: number
  contributions: Record<string, number>
  eligible: string[]
  outcome: SvaraPotOutcome
}

export type SvaraRoundRecord = {
  roundId: string
  kind: 'ordinary' | 'svara' | 'allin-svara'
  dealerId: string | null
  participants: string[]
  /** Показани карти (само на играчите, участвали в сравняване). */
  shownHands: Record<string, SvaraCardCode[]>
  points: Record<string, number>
  contributions: Record<string, number>
  folded: string[]
  anyVoluntaryBet: boolean
  pots: SvaraRoundPotRecord[]
}

type OrdinaryRound = {
  kind: 'ordinary'
  roundId: string
  dealerId: string
  participants: string[]
  hands: Record<string, SvaraCardCode[]>
  contributions: Record<string, number>
  deadMoney: number
  deadMoneyFrom: string[]
  isFourthHeadsUp: boolean
  betting: SvaraBettingState
}

type SvaraJoiningRound = { kind: 'svara-joining'; roundId: string; potId: string; fee: number; joiners: string[] }

type SvaraDealRound = {
  kind: 'svara'
  roundId: string
  potId: string
  dealerId: string
  participants: string[]
  hands: Record<string, SvaraCardCode[]>
  /** Само новите доброволни залози (заключената банка е отделна). */
  contributions: Record<string, number>
  betting: SvaraBettingState
}

type AllInSvaraRound = { kind: 'allin-svara'; roundId: string; potIds: string[]; iteration: number; sidesEvaluated: boolean }

export type SvaraRound = OrdinaryRound | SvaraJoiningRound | SvaraDealRound | AllInSvaraRound

export type SvaraMatchState = {
  config: SvaraMatchConfig
  startingChips: number
  entryChips: number
  /** 'closed' — масата е закрита преди старта (създателят напусна, случай №7). */
  phase: 'lobby' | 'in-progress' | 'finished' | 'closed'
  /** Места по часовниковата стрелка (ред на присъединяване). */
  seats: string[]
  status: Record<string, SvaraSeatStatus>
  stacks: Record<string, number>
  totalChips: number
  removedChips: number
  firstDealerId: string | null
  /** Дилърът на последното обикновено раздаване (обикновената ротация, §4.1). */
  ordinaryDealerId: string | null
  headsUpNoBetStreak: number
  roundCounter: number
  round: SvaraRound | null
  lockedPots: SvaraMatchLockedPot[]
  carried: SvaraCarriedBalance[]
  winnerId: string | null
  /** Archive containers are immutable after commit; live-linked history is copied with the game. */
  ledger: SvaraMatchLedgerEntry[]
  history: SvaraRoundRecord[]
  processedCommands: Record<string, { fingerprint: string; outcome: SvaraMatchOutcome }>
}

export type SvaraMatchCommand =
  | { type: 'join-seat'; commandId: string; playerId: string }
  | { type: 'leave-seat'; commandId: string; playerId: string }
  | { type: 'start-match'; commandId: string; playerId: string }
  | { type: 'start-next-round'; commandId: string }
  | { type: 'look'; commandId: string; playerId: string }
  | { type: 'act'; commandId: string; playerId: string; action: SvaraBettingAction }
  | { type: 'svara-join'; commandId: string; playerId: string }
  | { type: 'svara-start'; commandId: string }
  | { type: 'advance-allin-svara'; commandId: string }
  | { type: 'set-absent'; commandId: string; playerId: string; absent: boolean }
  | { type: 'exit'; commandId: string; playerId: string }
  | { type: 'absence-expired'; commandId: string; playerId: string }

export type SvaraMatchOutcome = {
  commandId: string
  type: SvaraMatchCommand['type']
  ledgerSeqFrom: number | null
  ledgerSeqTo: number | null
  /** Приключени рундове от тази команда (за одит). */
  completedRounds: string[]
}

export type SvaraMatchErrorCode =
  | 'invalid-command'
  | 'command-id-conflict'
  | 'wrong-phase'
  | 'unknown-player'
  | 'not-allowed'
  | 'no-round-available'
  | 'player-absent'
  | 'invariant-violation'
  | `betting:${string}`

export class SvaraMatchError extends Error {
  constructor(readonly code: SvaraMatchErrorCode, message: string) {
    super(message)
    this.name = 'SvaraMatchError'
  }
}

export type SvaraMatchEnv = {
  /** Криптографски източник по подразбиране. */
  random?: SvaraRandomSource
  /** Само за тестове: контролирано тесте за следващото раздаване. */
  createDeck?: () => readonly SvaraCard[]
}

export type SvaraMatchApplyResult = { state: SvaraMatchState; status: 'applied' | 'duplicate'; outcome: SvaraMatchOutcome }

// ── Помощни ─────────────────────────────────────────────────────────────────

const fail = (code: SvaraMatchErrorCode, message: string): never => {
  throw new SvaraMatchError(code, message)
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isChips = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function computeSvaraEntryChips(startingChips: number, percent: SvaraEntryPercent): number {
  if (![1, 2, 3, 5].includes(percent)) throw new SvaraInvalidInputError(`entryPercent must be 1, 2, 3 or 5, got ${String(percent)}`)
  // Цяло число, закръглено нагоре (§3.3).
  return Math.ceil((startingChips * percent) / 100)
}

/** Играчите от списъка в реда на местата, започвайки след after (по кръга). */
function clockwiseAfter(seats: readonly string[], after: string, members: readonly string[]): string[] {
  const start = seats.indexOf(after)
  const result: string[] = []
  for (let step = 1; step <= seats.length; step += 1) {
    const id = seats[(start + step) % seats.length]!
    if (members.includes(id)) result.push(id)
  }
  return result
}

function inSeatOrder(seats: readonly string[], members: readonly string[]): string[] {
  return seats.filter((id) => members.includes(id))
}

// ── Създаване ───────────────────────────────────────────────────────────────

export function createSvaraMatch(input: { tableId: string; capacity: 2 | 3 | 4; entryFee: number; entryPercent?: SvaraEntryPercent; startMode: SvaraStartMode; creatorId: string }): SvaraMatchState {
  if (!isNonEmptyString(input?.tableId)) throw new SvaraInvalidInputError('tableId required')
  if (![2, 3, 4].includes(input.capacity)) throw new SvaraInvalidInputError('capacity must be 2, 3 or 4')
  if (input.startMode !== 'auto' && input.startMode !== 'manual') throw new SvaraInvalidInputError('startMode must be auto or manual')
  if (!isNonEmptyString(input.creatorId)) throw new SvaraInvalidInputError('creatorId required')
  const startingChips = svaraStartingChipsForEntry(input.entryFee)
  const entryPercent = input.entryPercent ?? 1
  const entryChips = computeSvaraEntryChips(startingChips, entryPercent)
  return {
    config: { tableId: input.tableId, capacity: input.capacity, entryFee: input.entryFee, entryPercent, startMode: input.startMode, creatorId: input.creatorId },
    startingChips,
    entryChips,
    phase: 'lobby',
    seats: [input.creatorId],
    status: { [input.creatorId]: 'active' },
    stacks: {},
    totalChips: 0,
    removedChips: 0,
    firstDealerId: null,
    ordinaryDealerId: null,
    headsUpNoBetStreak: 0,
    roundCounter: 0,
    round: null,
    lockedPots: [],
    carried: [],
    winnerId: null,
    ledger: [],
    history: [],
    processedCommands: {},
  }
}

// ── Инварианти ──────────────────────────────────────────────────────────────

/**
 * §9: свободни стекове + внесени в текущия рунд + заключени + пренесени +
 * извадени от играта = начални игрови чипове; салдата съвпадат с дневника.
 */
export function assertSvaraMatchInvariants(state: SvaraMatchState): void {
  const violation = (message: string) => fail('invariant-violation', message)
  if (state.phase === 'lobby' || state.phase === 'closed') {
    if (state.ledger.length !== 0 || state.totalChips !== 0) violation('lobby must have no chips')
    if (state.phase === 'closed' && state.seats.length !== 0) violation('closed table must release all seats')
    return
  }
  if (state.totalChips !== state.startingChips * state.seats.length) violation('totalChips')
  const balances = new Map<string, number>()
  for (const id of state.seats) {
    if (!isChips(state.stacks[id])) violation(`stack of ${id}: ${String(state.stacks[id])}`)
    balances.set(`stack:${id}`, state.stacks[id]!)
  }
  let roundTotal = 0
  const round = state.round
  if (round && (round.kind === 'ordinary' || round.kind === 'svara')) {
    for (const [id, amount] of Object.entries(round.contributions)) {
      if (!round.participants.includes(id) || !isChips(amount)) violation(`round contribution ${id}`)
      roundTotal += amount
    }
    if (round.kind === 'ordinary') {
      if (!isChips(round.deadMoney)) violation('dead money')
      roundTotal += round.deadMoney
    }
    balances.set(`round:${round.roundId}`, roundTotal)
  }
  let lockedTotal = 0
  const potIds = new Set<string>()
  for (const pot of state.lockedPots) {
    if (!isChips(pot.amount) || pot.amount === 0) violation(`locked ${pot.potId} amount`)
    if (potIds.has(pot.potId)) violation(`duplicate locked ${pot.potId}`)
    potIds.add(pot.potId)
    if (pot.eligible.length < 1 || pot.eligible.some((id) => !state.seats.includes(id) || state.status[id] === 'exited')) violation(`locked ${pot.potId} eligible`)
    lockedTotal += pot.amount
    balances.set(`locked:${pot.potId}`, pot.amount)
  }
  let carriedTotal = 0
  for (const carry of state.carried) {
    if (!isChips(carry.amount) || carry.amount === 0) violation(`carried ${carry.carryId}`)
    carriedTotal += carry.amount
    balances.set(`carried:${carry.carryId}`, carry.amount)
  }
  if (!isChips(state.removedChips)) violation('removedChips')
  balances.set('removed', state.removedChips)
  const stacksTotal = state.seats.reduce((sum, id) => sum + state.stacks[id]!, 0)
  if (stacksTotal + roundTotal + lockedTotal + carriedTotal + state.removedChips !== state.totalChips) {
    violation(`chips ${stacksTotal}+${roundTotal}+${lockedTotal}+${carriedTotal}+${state.removedChips} ≠ ${state.totalChips}`)
  }
  const replay = new Map<string, number>()
  let seq = 0
  for (const entry of state.ledger) {
    if (entry.seq !== seq + 1) violation(`ledger seq ${entry.seq}`)
    seq = entry.seq
    if (!isChips(entry.amount) || entry.amount === 0) violation(`ledger amount ${entry.seq}`)
    replay.set(entry.from, (replay.get(entry.from) ?? 0) - entry.amount)
    replay.set(entry.to, (replay.get(entry.to) ?? 0) + entry.amount)
  }
  if (-(replay.get('buy-in') ?? 0) !== state.totalChips) violation('ledger buy-in')
  for (const [account, value] of replay) {
    if (account === 'buy-in') continue
    if (value !== (balances.get(account) ?? 0)) violation(`ledger ${account}: ${value} ≠ ${balances.get(account) ?? 0}`)
  }
  for (const [account, value] of balances) {
    if ((replay.get(account) ?? 0) !== value) violation(`balance ${account} not backed by ledger`)
  }
  if (state.phase === 'finished' && (state.round || state.lockedPots.length || state.carried.length)) violation('finished with open pots')
}

// ── Прилагане на команди ────────────────────────────────────────────────────

type Ctx = { state: SvaraMatchState; command: SvaraMatchCommand; env: SvaraMatchEnv; completedRounds: string[] }

// Ledger/command data is shared only after this module has recursively frozen it.
// Weak metadata is deliberately outside the serializable state. Restored or
// externally supplied data takes the detached-copy path on its first command.
const immutableArchives = new WeakSet<object>()
// Historical records may still alias a live pot after a repeated tie. Those
// records must be cloned WITH the game, preserving the reference engine's aliases.
const historyArchives = new WeakMap<SvaraRoundRecord[], readonly number[]>()

function freezeArchiveValue(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const nested of Object.values(value)) freezeArchiveValue(nested)
  Object.freeze(value)
}

function copyMatchForCommand(state: SvaraMatchState): SvaraMatchState {
  const { ledger, history, processedCommands, ...live } = state
  const linked = historyArchives.get(history)
  const cloned = linked === undefined
    ? structuredClone({ live, history })
    : structuredClone({ live, history: linked.map((index) => history[index]!) })
  const nextHistory = linked === undefined ? cloned.history : history.slice()
  if (linked) linked.forEach((index, position) => { nextHistory[index] = cloned.history[position]! })
  return {
    ...state,
    ...cloned.live,
    ledger: immutableArchives.has(ledger) ? ledger.slice() : structuredClone(ledger),
    history: nextHistory,
    processedCommands: immutableArchives.has(processedCommands) ? { ...processedCommands } : structuredClone(processedCommands),
  }
}

function collectObjects(value: unknown, objects: WeakSet<object>): void {
  if (!value || typeof value !== 'object' || objects.has(value)) return
  objects.add(value)
  for (const nested of Object.values(value)) collectObjects(nested, objects)
}

function touchesObjects(value: unknown, objects: WeakSet<object>): boolean {
  return !!value && typeof value === 'object' &&
    (objects.has(value) || Object.values(value).some((nested) => touchesObjects(nested, objects)))
}

function sealHistory(next: SvaraMatchState, previous: SvaraMatchState): void {
  const prior = historyArchives.get(previous.history)
  const candidates = prior ? [...prior] : Array.from(previous.history.keys())
  for (let i = previous.history.length; i < next.history.length; i++) candidates.push(i)
  const linked: number[] = []
  if (candidates.length > 0) {
    const { ledger: _ledger, history: _history, processedCommands: _commands, ...live } = next
    const objects = new WeakSet<object>()
    collectObjects(live, objects)
    for (const index of candidates) {
      if (touchesObjects(next.history[index], objects)) linked.push(index)
      else freezeArchiveValue(next.history[index])
    }
  }
  Object.freeze(next.history)
  historyArchives.set(next.history, linked)
}

function sealMatchArchives(next: SvaraMatchState, previous: SvaraMatchState, commandId: string): void {
  const start = immutableArchives.has(previous.ledger) ? previous.ledger.length : 0
  for (let i = start; i < next.ledger.length; i++) freezeArchiveValue(next.ledger[i])
  Object.freeze(next.ledger)
  immutableArchives.add(next.ledger)
  sealHistory(next, previous)
  if (immutableArchives.has(previous.processedCommands)) {
    freezeArchiveValue(next.processedCommands[commandId])
    Object.freeze(next.processedCommands)
  } else {
    freezeArchiveValue(next.processedCommands)
  }
  immutableArchives.add(next.processedCommands)
}

export function applySvaraMatchCommand(state: SvaraMatchState, command: SvaraMatchCommand, env: SvaraMatchEnv = {}): SvaraMatchApplyResult {
  if (!command || typeof command !== 'object') fail('invalid-command', 'command required')
  if (!isNonEmptyString(command.commandId)) fail('invalid-command', 'commandId required')
  const fingerprint = stableStringify(command)
  const previous = state.processedCommands[command.commandId]
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('command-id-conflict', `commandId ${command.commandId} was used for a different command`)
    return { state, status: 'duplicate', outcome: previous.outcome }
  }
  const ctx: Ctx = { state: copyMatchForCommand(state), command, env, completedRounds: [] }
  const ledgerStart = ctx.state.ledger.length
  try {
    dispatch(ctx)
  } catch (error) {
    if (error instanceof SvaraBettingError) fail(`betting:${error.code}`, error.message)
    if (error instanceof SvaraInvalidInputError) fail('invalid-command', error.message)
    throw error
  }
  const next = ctx.state
  const added = next.ledger.length - ledgerStart
  const outcome: SvaraMatchOutcome = {
    commandId: command.commandId,
    type: command.type,
    ledgerSeqFrom: added > 0 ? next.ledger[ledgerStart]!.seq : null,
    ledgerSeqTo: added > 0 ? next.ledger[next.ledger.length - 1]!.seq : null,
    completedRounds: ctx.completedRounds,
  }
  next.processedCommands[command.commandId] = { fingerprint, outcome }
  assertSvaraMatchInvariants(next)
  sealMatchArchives(next, state, command.commandId)
  return { state: next, status: 'applied', outcome }
}

function dispatch(ctx: Ctx): void {
  const { command } = ctx
  switch (command.type) {
    case 'join-seat': return joinSeat(ctx, command.playerId)
    case 'leave-seat': return leaveSeat(ctx, command.playerId)
    case 'start-match': return startMatchByCreator(ctx, command.playerId)
    case 'start-next-round': return startNextRound(ctx)
    case 'look': return look(ctx, command.playerId)
    case 'act': return act(ctx, command.playerId, command.action)
    case 'svara-join': return svaraJoin(ctx, command.playerId)
    case 'svara-start': return svaraStart(ctx)
    case 'advance-allin-svara': return advanceAllInSvara(ctx)
    case 'set-absent': return setAbsent(ctx, command.playerId, command.absent)
    case 'exit': return exitMatch(ctx, command.playerId)
    case 'absence-expired': return absenceExpired(ctx, command.playerId)
    default: fail('invalid-command', `unknown command ${String((command as { type?: unknown }).type)}`)
  }
}

function pushLedger(ctx: Ctx, entry: Omit<SvaraMatchLedgerEntry, 'seq' | 'commandId'>): void {
  if (entry.amount === 0) return
  ctx.state.ledger.push({ seq: ctx.state.ledger.length + 1, commandId: ctx.command.commandId, ...entry })
}

function requirePhase(ctx: Ctx, phase: SvaraMatchState['phase']): void {
  if (ctx.state.phase !== phase) fail('wrong-phase', `match is ${ctx.state.phase}, expected ${phase}`)
}

function requireSeated(ctx: Ctx, playerId: unknown): string {
  if (!isNonEmptyString(playerId) || !ctx.state.seats.includes(playerId)) fail('unknown-player', `unknown player ${String(playerId)}`)
  return playerId as string
}

function nextRoundId(ctx: Ctx, kind: string): string {
  ctx.state.roundCounter += 1
  return `${kind}-${ctx.state.roundCounter}`
}

function drawDeck(ctx: Ctx): SvaraCard[] {
  if (ctx.env.createDeck) return createSvaraDeckFromCards(ctx.env.createDeck())
  return createShuffledSvaraDeck(ctx.env.random ?? createCryptoSvaraRandomSource())
}

function dealTo(ctx: Ctx, players: string[]): Record<string, SvaraCardCode[]> {
  const deal = dealSvaraHands(players, drawDeck(ctx))
  return Object.fromEntries(players.map((id) => [id, deal.hands.get(id)!.map(svaraCardCode)]))
}

// ── Лоби (§3) ───────────────────────────────────────────────────────────────

function joinSeat(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'lobby')
  if (!isNonEmptyString(playerId)) fail('invalid-command', 'playerId required')
  const { state } = ctx
  if (state.seats.includes(playerId)) fail('not-allowed', `${playerId} is already seated`)
  if (state.seats.length >= state.config.capacity) fail('not-allowed', 'table is full')
  state.seats.push(playerId)
  state.status[playerId] = 'active'
  if (state.config.startMode === 'auto' && state.seats.length === state.config.capacity) startMatch(ctx)
}

function leaveSeat(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'lobby')
  requireSeated(ctx, playerId)
  if (playerId === ctx.state.config.creatorId) {
    // Случай №7: масата се закрива, всички чакащи се освобождават; без
    // прехвърляне на собствеността. Прекъсване на връзката не е напускане —
    // за него няма команда.
    ctx.state.phase = 'closed'
    ctx.state.seats = []
    ctx.state.status = {}
    return
  }
  ctx.state.seats = ctx.state.seats.filter((id) => id !== playerId)
  delete ctx.state.status[playerId]
}

function startMatchByCreator(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'lobby')
  if (ctx.state.config.startMode !== 'manual') fail('not-allowed', 'this table starts automatically')
  if (playerId !== ctx.state.config.creatorId) fail('not-allowed', 'only the creator can start the match')
  if (ctx.state.seats.length !== ctx.state.config.capacity) fail('not-allowed', 'all seats must be taken')
  startMatch(ctx)
}

function startMatch(ctx: Ctx): void {
  const { state } = ctx
  state.phase = 'in-progress'
  state.totalChips = state.startingChips * state.seats.length
  for (const id of state.seats) {
    state.stacks[id] = state.startingChips
    pushLedger(ctx, { type: 'starting-chips', from: 'buy-in', to: `stack:${id}`, amount: state.startingChips, roundId: null, potId: null, playerId: id })
  }
  // §4.1: първият дилър се избира случайно.
  const random = ctx.env.random ?? createCryptoSvaraRandomSource()
  state.firstDealerId = state.seats[random.nextInt(state.seats.length)]!
}

// ── Следващ рунд ────────────────────────────────────────────────────────────

function alivePlayers(state: SvaraMatchState): string[] {
  return state.seats.filter((id) => state.status[id] === 'active' || state.status[id] === 'absent')
}

function startNextRound(ctx: Ctx): void {
  requirePhase(ctx, 'in-progress')
  const { state } = ctx
  if (state.round) fail('not-allowed', `round ${state.round.roundId} is still in progress`)
  // §6.12: заключените обикновени Свари се разиграват последователно; Свара
  // с отсъстващ правоимащ може да изчаква (§8).
  const startable = state.lockedPots.find((pot) => pot.kind === 'ordinary' && pot.eligible.every((id) => state.status[id] === 'active'))
  if (startable) {
    const fee = Math.ceil(startable.amount / startable.eligible.length)
    state.round = { kind: 'svara-joining', roundId: nextRoundId(ctx, 'svara'), potId: startable.potId, fee, joiners: [] }
    return
  }
  const participants = state.seats.filter((id) => (state.status[id] === 'active' || state.status[id] === 'absent') && state.stacks[id]! > 0)
  if (participants.length < 2) fail('no-round-available', 'fewer than two players with chips and no startable Svara')
  startOrdinaryDeal(ctx, participants)
}

function startOrdinaryDeal(ctx: Ctx, participants: string[]): void {
  const { state } = ctx
  const dealerId = state.ordinaryDealerId === null
    ? (participants.includes(state.firstDealerId!) ? state.firstDealerId! : clockwiseAfter(state.seats, state.firstDealerId!, participants)[0]!)
    : clockwiseAfter(state.seats, state.ordinaryDealerId, participants)[0]!
  state.ordinaryDealerId = dealerId
  const roundId = nextRoundId(ctx, 'deal')
  const order = clockwiseAfter(state.seats, dealerId, participants) // първият след дилъра … дилърът
  const contributions: Record<string, number> = {}
  // §4.2: всички плащат фиксирания Вход; при недостиг — остатъка (ол-ин).
  for (const id of order) {
    const pay = Math.min(state.entryChips, state.stacks[id]!)
    state.stacks[id] = state.stacks[id]! - pay
    contributions[id] = pay
    pushLedger(ctx, { type: 'entry', from: `stack:${id}`, to: `round:${roundId}`, amount: pay, roundId, potId: null, playerId: id })
  }
  // Пренесени банки без правоимащ → в основната банка на това раздаване (§6.11).
  let deadMoney = 0
  const deadMoneyFrom: string[] = []
  for (const carry of state.carried) {
    deadMoney += carry.amount
    deadMoneyFrom.push(carry.carryId)
    pushLedger(ctx, { type: 'carry-in', from: `carried:${carry.carryId}`, to: `round:${roundId}`, amount: carry.amount, roundId, potId: carry.fromPotId, playerId: null })
  }
  state.carried = []
  const isFourthHeadsUp = order.length === 2 && state.headsUpNoBetStreak === 3
  const absent = order.filter((id) => state.status[id] === 'absent')
  const betting = createSvaraBetting({
    order,
    stacks: state.stacks,
    folded: absent, // §8: отсъстващият плаща Вход и автоматично отказва
    entryChips: state.entryChips,
    // „Без залог“ само ако и двамата могат да действат (иначе — колизия §10).
    allowNoBet: isFourthHeadsUp && order.every((id) => state.stacks[id]! > 0 && !absent.includes(id)),
  })
  state.round = { kind: 'ordinary', roundId, dealerId, participants: order, hands: dealTo(ctx, order), contributions, deadMoney, deadMoneyFrom, isFourthHeadsUp, betting }
  if (betting.complete) settleOrdinary(ctx)
}

// ── Действия в раздаване ────────────────────────────────────────────────────

function requireBettingRound(ctx: Ctx): OrdinaryRound | SvaraDealRound {
  const round = ctx.state.round
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) fail('not-allowed', 'no betting round in progress')
  return round as OrdinaryRound | SvaraDealRound
}

function look(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const round = requireBettingRound(ctx)
  if (!round.participants.includes(playerId)) fail('not-allowed', `${playerId} is not in this round`)
  round.betting = lookAtSvaraCards(round.betting, playerId)
}

function act(ctx: Ctx, playerId: string, action: SvaraBettingAction): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const round = requireBettingRound(ctx)
  if (!round.participants.includes(playerId)) fail('not-allowed', `${playerId} is not in this round`)
  if (ctx.state.status[playerId] !== 'active') fail('player-absent', `${playerId} is ${ctx.state.status[playerId]} and cannot act`)
  if (!action || typeof action !== 'object') fail('invalid-command', 'action required')
  const { state, added } = applySvaraBettingAction(round.betting, playerId, action, ctx.state.stacks[playerId]!)
  round.betting = state
  if (added > 0) {
    ctx.state.stacks[playerId] = ctx.state.stacks[playerId]! - added
    round.contributions[playerId] = (round.contributions[playerId] ?? 0) + added
    pushLedger(ctx, { type: 'bet', from: `stack:${playerId}`, to: `round:${round.roundId}`, amount: added, roundId: round.roundId, potId: null, playerId })
  }
  if (round.betting.complete) {
    if (round.kind === 'ordinary') settleOrdinary(ctx)
    else settleSvaraDeal(ctx)
  }
}

// ── Разрешаване на обикновено раздаване (§4.6–4.8, §6.1, §7) ───────────────

type ShowdownPoints = Record<string, number>

function pointsFor(hands: Record<string, SvaraCardCode[]>, players: string[]): ShowdownPoints {
  return Object.fromEntries(players.map((id) => [id, evaluateSvaraHand(hands[id]!.map(parseSvaraCardCode)).points]))
}

function topPlayers(players: string[], points: ShowdownPoints): string[] {
  const top = Math.max(...players.map((id) => points[id]!))
  return players.filter((id) => points[id] === top)
}

function settleOrdinary(ctx: Ctx): void {
  const { state } = ctx
  const round = state.round as OrdinaryRound
  const { betting } = round
  const remaining = round.participants.filter((id) => !betting.folded.includes(id))
  // Случай №3: ако поне двама неотказали не са могли да направят доброволен
  // залог (ол-ин от Входа), картите се сравняват автоматично — без печалба на
  // дилъра. Дилърът печели само когато е единственият останал (§4.7).
  const layers = buildSvaraPotLayers({ participants: round.participants, contributions: round.contributions, folded: betting.folded })
  if (round.deadMoney > 0 && layers[0]) {
    layers[0] = { ...layers[0], amount: layers[0].amount + round.deadMoney }
  }
  const contested = layers.filter((layer) => layer.kind === 'contested')
  const points = remaining.length >= 2 ? pointsFor(round.hands, remaining) : {}
  const tied = new Set<number>()
  for (const layer of layers) {
    if (layer.kind === 'contested' && layer.eligible.length >= 2 && topPlayers([...layer.eligible], points).length > 1) tied.add(layer.index)
  }
  // Една спорна банка → обикновена Свара; основна + странични (ол-ин) →
  // Свара с ол-ин (§7), вкл. равенство само в странична банка (случай №1)
  // и равенство в НЯКОЛКО странични банки едновременно (Решение, §12 —
  // едно общо раздаване за всички засегнати банки, всяка разрешена
  // отделно; виж advanceAllInSvara).
  const mode: 'none' | 'ordinary-lock' | 'allin' = tied.size === 0 ? 'none' : contested.length >= 2 ? 'allin' : 'ordinary-lock'

  const record: SvaraRoundRecord = baseRecord(round, round.dealerId, remaining, points)
  const allinPotIds: string[] = []
  for (const layer of layers) {
    const potId = `${round.roundId}:pot-${layer.index}`
    const base = { potId, source: 'round' as const, amount: layer.amount, contributions: { ...layer.contributions }, eligible: [...layer.eligible] }
    if (layer.kind === 'uncalled') {
      const owner = layer.contributors[0]!
      if (layer.eligible.length === 0) {
        record.pots.push({ ...base, outcome: carryOut(ctx, round.roundId, potId, layer.amount) })
        continue
      }
      creditStack(ctx, 'uncalled-return', round.roundId, potId, owner, layer.amount)
      record.pots.push({ ...base, outcome: { kind: 'uncalled-return', playerId: owner } })
      continue
    }
    if (layer.eligible.length === 0) {
      record.pots.push({ ...base, outcome: carryOut(ctx, round.roundId, potId, layer.amount) })
      continue
    }
    if (layer.eligible.length === 1) {
      creditStack(ctx, 'pot-award', round.roundId, potId, layer.eligible[0]!, layer.amount)
      record.pots.push({ ...base, outcome: { kind: 'awarded', winner: layer.eligible[0]!, byShowdown: false } })
      continue
    }
    const best = topPlayers([...layer.eligible], points)
    if (best.length === 1) {
      creditStack(ctx, 'pot-award', round.roundId, potId, best[0]!, layer.amount)
      record.pots.push({ ...base, outcome: { kind: 'awarded', winner: best[0]!, byShowdown: true } })
      continue
    }
    const lockKind = mode === 'allin' ? 'allin' : 'ordinary'
    const lockedPotId = `${potId}:locked`
    lockPot(ctx, round.roundId, potId, lockedPotId, layer.amount, {
      kind: lockKind,
      eligible: best,
      originDealerId: round.dealerId,
      isMain: lockKind === 'allin' && layer.index === contested[0]!.index,
    })
    if (lockKind === 'allin') allinPotIds.push(lockedPotId)
    record.pots.push({ ...base, outcome: { kind: 'locked', lockedPotId, tiedPlayers: best, lockKind } })
  }

  // §4.8: поредица от раздавания без доброволни залози при двама.
  if (round.participants.length === 2) {
    state.headsUpNoBetStreak = round.isFourthHeadsUp ? 0 : betting.anyVoluntaryBet ? 0 : state.headsUpNoBetStreak + 1
  } else {
    state.headsUpNoBetStreak = 0
  }
  finishRound(ctx, record)
  if (allinPotIds.length > 0) {
    state.round = { kind: 'allin-svara', roundId: nextRoundId(ctx, 'allin'), potIds: allinPotIds, iteration: 0, sidesEvaluated: false }
  }
}

function baseRecord(round: OrdinaryRound | SvaraDealRound, dealerId: string | null, shown: string[], points: ShowdownPoints): SvaraRoundRecord {
  return {
    roundId: round.roundId,
    kind: round.kind,
    dealerId,
    participants: [...round.participants],
    shownHands: shown.length >= 2 ? Object.fromEntries(shown.map((id) => [id, [...round.hands[id]!]])) : {},
    points: { ...points },
    contributions: { ...round.contributions },
    folded: [...round.betting.folded],
    anyVoluntaryBet: round.betting.anyVoluntaryBet,
    pots: [],
  }
}

function creditStack(ctx: Ctx, type: 'uncalled-return' | 'pot-award', roundId: string, potId: string, playerId: string, amount: number): void {
  ctx.state.stacks[playerId] = ctx.state.stacks[playerId]! + amount
  pushLedger(ctx, { type, from: `round:${roundId}`, to: `stack:${playerId}`, amount, roundId, potId, playerId })
}

function carryOut(ctx: Ctx, roundId: string, potId: string, amount: number): SvaraPotOutcome {
  const carryId = `${potId}:carry`
  ctx.state.carried.push({ carryId, amount, fromRoundId: roundId, fromPotId: potId })
  pushLedger(ctx, { type: 'pot-carry', from: `round:${roundId}`, to: `carried:${carryId}`, amount, roundId, potId, playerId: null })
  return { kind: 'carried', carryId }
}

function lockPot(ctx: Ctx, roundId: string, potId: string, lockedPotId: string, amount: number, details: { kind: 'ordinary' | 'allin'; eligible: string[]; originDealerId: string; isMain: boolean }): void {
  ctx.state.lockedPots.push({
    potId: lockedPotId,
    kind: details.kind,
    amount,
    eligible: [...details.eligible],
    originRoundId: roundId,
    originDealerId: details.originDealerId,
    lastSvaraDealerId: null,
    continuation: 0,
    isMain: details.isMain,
  })
  pushLedger(ctx, { type: 'pot-lock', from: `round:${roundId}`, to: `locked:${lockedPotId}`, amount, roundId, potId, playerId: null })
}

/** Затваря рунда, отпадане (§3 / 2Б.2А), край на мача. */
function finishRound(ctx: Ctx, record: SvaraRoundRecord | null): void {
  const { state } = ctx
  if (record) {
    state.history.push(record)
    ctx.completedRounds.push(record.roundId)
  }
  state.round = null
  for (const id of state.seats) {
    const status = state.status[id]
    if ((status === 'active' || status === 'absent') && state.stacks[id] === 0 && !state.lockedPots.some((pot) => pot.eligible.includes(id))) {
      state.status[id] = 'eliminated'
    }
  }
  const alive = alivePlayers(state)
  if (alive.length === 1 && state.lockedPots.length === 0 && state.carried.length > 0) {
    // Случай №6: последният играч получава всички пренесени банки преди края.
    const winner = alive[0]!
    for (const carry of state.carried) {
      state.stacks[winner] = state.stacks[winner]! + carry.amount
      pushLedger(ctx, { type: 'pot-award', from: `carried:${carry.carryId}`, to: `stack:${winner}`, amount: carry.amount, roundId: null, potId: carry.fromPotId, playerId: winner })
    }
    state.carried = []
  }
  if (alive.length <= 1 && state.lockedPots.length === 0 && state.carried.length === 0) {
    state.phase = 'finished'
    state.winnerId = alive[0] ?? null
  }
}

// ── Обикновена Свара (§6) ───────────────────────────────────────────────────

function lockedPot(state: SvaraMatchState, potId: string): SvaraMatchLockedPot {
  const pot = state.lockedPots.find((p) => p.potId === potId)
  if (!pot) fail('invariant-violation', `locked pot ${potId} missing`)
  return pot!
}

function svaraJoin(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const { state } = ctx
  const round = state.round
  if (!round || round.kind !== 'svara-joining') fail('not-allowed', 'no Svara is open for joining')
  const joining = round as SvaraJoiningRound
  const pot = lockedPot(state, joining.potId)
  if (pot.eligible.includes(playerId)) fail('not-allowed', `${playerId} already has rights to this Svara`)
  // §6.2: вече участващи в мача и неотпаднали; отсъстващ не прави доброволни действия.
  if (state.status[playerId] !== 'active') fail('not-allowed', `${playerId} is ${state.status[playerId]}`)
  // §6.2: само пълна такса.
  if (state.stacks[playerId]! < joining.fee) fail('not-allowed', `${playerId} has ${state.stacks[playerId]}, the full fee is ${joining.fee}`)
  state.stacks[playerId] = state.stacks[playerId]! - joining.fee
  pot.amount += joining.fee
  pot.eligible.push(playerId)
  joining.joiners.push(playerId)
  pushLedger(ctx, { type: 'svara-join-fee', from: `stack:${playerId}`, to: `locked:${pot.potId}`, amount: joining.fee, roundId: joining.roundId, potId: pot.potId, playerId })
}

function svaraStart(ctx: Ctx): void {
  requirePhase(ctx, 'in-progress')
  const { state } = ctx
  const round = state.round
  if (!round || round.kind !== 'svara-joining') fail('not-allowed', 'no Svara is open for joining')
  const joining = round as SvaraJoiningRound
  const pot = lockedPot(state, joining.potId)
  if (pot.eligible.some((id) => state.status[id] !== 'active')) fail('not-allowed', 'a player with rights is absent; the Svara waits')
  const participants = inSeatOrder(state.seats, pot.eligible)
  // §6.5: първият дилър — следващият правоимащ след дилъра на породилото раздаване;
  // след това ротация сред участниците.
  const reference = pot.lastSvaraDealerId ?? pot.originDealerId
  const dealerId = clockwiseAfter(state.seats, reference, participants)[0]!
  pot.lastSvaraDealerId = dealerId
  pot.continuation += 1
  const order = clockwiseAfter(state.seats, dealerId, participants)
  const betting = createSvaraBetting({ order, stacks: state.stacks, folded: [], entryChips: state.entryChips, allowNoBet: false })
  state.round = { kind: 'svara', roundId: joining.roundId, potId: pot.potId, dealerId, participants: order, hands: dealTo(ctx, order), contributions: {}, betting }
  // §6.9: ако никой правоимащ няма свободни чипове — автоматично сравняване.
  if (betting.complete) settleSvaraDeal(ctx)
}

function settleSvaraDeal(ctx: Ctx): void {
  const { state } = ctx
  const round = state.round as SvaraDealRound
  const { betting } = round
  const pot = lockedPot(state, round.potId)
  const remaining = round.participants.filter((id) => !betting.folded.includes(id))
  const points = remaining.length >= 2 ? pointsFor(round.hands, remaining) : {}
  const layers = buildSvaraPotLayers({ participants: round.participants, contributions: round.contributions, folded: betting.folded })
  const contested = layers.filter((layer) => layer.kind === 'contested')
  // Решение №3 (§6.13, случай №2): новите залози образуват собствени
  // основна/странични банки, отделно от старата заключена банка, и се
  // оценяват със същите карти. Равенство в тях при няколко слоя (нов
  // ол-ин) → Свара с ол-ин само за тези банки (§7, случай №1), включително
  // равенство в НЯКОЛКО странични банки едновременно (Решение, §12 — едно
  // общо раздаване, всяка банка разрешена отделно, виж advanceAllInSvara);
  // при равенство само в един слой → нова обикновена Свара. Старата
  // заключена банка НЕ се смесва с новите залози (отделен блок по-долу) —
  // при едновременно равенство в двете се получават две независими Свари
  // (Решение №5, §6.14/§7).
  const newBetsAllIn = contested.length >= 2
  const allinPotIds: string[] = []

  const record = baseRecord(round, round.dealerId, remaining, points)
  // Заключената банка: правоимащи са неотказалите участници (§6.7).
  const lockedBase = { potId: pot.potId, source: 'locked' as const, amount: pot.amount, contributions: {}, eligible: [...remaining] }
  if (remaining.length === 1) {
    awardLocked(ctx, pot, remaining[0]!, round.roundId)
    record.pots.push({ ...lockedBase, outcome: { kind: 'awarded', winner: remaining[0]!, byShowdown: false } })
  } else {
    const best = topPlayers(remaining, points)
    if (best.length === 1) {
      record.pots.push({ ...lockedBase, outcome: { kind: 'awarded', winner: best[0]!, byShowdown: true } })
      awardLocked(ctx, pot, best[0]!, round.roundId)
    } else {
      // Ново равенство: банката остава заключена между равните (§6.3 — нова такса при следващото продължение).
      pot.eligible = best
      record.pots.push({ ...lockedBase, outcome: { kind: 'locked', lockedPotId: pot.potId, tiedPlayers: best, lockKind: 'ordinary' } })
    }
  }
  // Новите доброволни залози — отделна банка/слоеве (§6.8).
  for (const layer of layers) {
    const potId = `${round.roundId}:bets-${layer.index}`
    const base = { potId, source: 'round' as const, amount: layer.amount, contributions: { ...layer.contributions }, eligible: [...layer.eligible] }
    if (layer.eligible.length === 0) {
      record.pots.push({ ...base, outcome: carryOut(ctx, round.roundId, potId, layer.amount) })
    } else if (layer.kind === 'uncalled') {
      creditStack(ctx, 'uncalled-return', round.roundId, potId, layer.contributors[0]!, layer.amount)
      record.pots.push({ ...base, outcome: { kind: 'uncalled-return', playerId: layer.contributors[0]! } })
    } else if (layer.eligible.length === 1) {
      creditStack(ctx, 'pot-award', round.roundId, potId, layer.eligible[0]!, layer.amount)
      record.pots.push({ ...base, outcome: { kind: 'awarded', winner: layer.eligible[0]!, byShowdown: false } })
    } else {
      const best = topPlayers([...layer.eligible], points)
      if (best.length === 1) {
        creditStack(ctx, 'pot-award', round.roundId, potId, best[0]!, layer.amount)
        record.pots.push({ ...base, outcome: { kind: 'awarded', winner: best[0]!, byShowdown: true } })
      } else {
        const lockedPotId = `${potId}:locked`
        const lockKind = newBetsAllIn ? 'allin' : 'ordinary'
        lockPot(ctx, round.roundId, potId, lockedPotId, layer.amount, { kind: lockKind, eligible: best, originDealerId: round.dealerId, isMain: newBetsAllIn && layer.index === contested[0]!.index })
        if (lockKind === 'allin') allinPotIds.push(lockedPotId)
        record.pots.push({ ...base, outcome: { kind: 'locked', lockedPotId, tiedPlayers: best, lockKind } })
      }
    }
  }
  finishRound(ctx, record)
  if (allinPotIds.length > 0) {
    state.round = { kind: 'allin-svara', roundId: nextRoundId(ctx, 'allin'), potIds: allinPotIds, iteration: 0, sidesEvaluated: false }
  }
}

function awardLocked(ctx: Ctx, pot: SvaraMatchLockedPot, playerId: string, roundId: string | null): void {
  ctx.state.stacks[playerId] = ctx.state.stacks[playerId]! + pot.amount
  pushLedger(ctx, { type: 'pot-award', from: `locked:${pot.potId}`, to: `stack:${playerId}`, amount: pot.amount, roundId, potId: pot.potId, playerId })
  ctx.state.lockedPots = ctx.state.lockedPots.filter((p) => p.potId !== pot.potId)
}

function carryLocked(ctx: Ctx, pot: SvaraMatchLockedPot, roundId: string | null): void {
  const carryId = `${pot.potId}:carry`
  ctx.state.carried.push({ carryId, amount: pot.amount, fromRoundId: roundId ?? pot.originRoundId, fromPotId: pot.potId })
  pushLedger(ctx, { type: 'pot-carry', from: `locked:${pot.potId}`, to: `carried:${carryId}`, amount: pot.amount, roundId, potId: pot.potId, playerId: null })
  ctx.state.lockedPots = ctx.state.lockedPots.filter((p) => p.potId !== pot.potId)
}

// ── Свара с ол-ин (§7) ──────────────────────────────────────────────────────

/**
 * Поддържа произволен брой едновременно заключени банки от едно раздаване
 * с ол-ин — не само „основна + точно една странична“ (§12, финално
 * решение за няколко едновременно спорни странични банки): всички банки в
 * `allin.potIds` (независимо дали е сред тях заключена основна банка) делят
 * ЕДНО общо ново раздаване за обединените им правоимащи (contenders);
 * всяка банка пази собствената си сума и списък правоимащи и се оценява
 * ОТДЕЛНО (topPlayers само сред собствените си eligible), но със СЪЩИТЕ
 * нови карти. Най-много ЕДНА банка е `isMain` (основната — единствената
 * с index === contested[0].index при заключването; структурно не могат да
 * съществуват две); само тя получава ново раздаване при повторно
 * равенство (§7.4). Всяка друга (странична) банка — независимо колко общо
 * има — се разделя поравно при равенство (първо или повторно), без ново
 * раздаване за нея (§7.5–7.6); вече разрешени банки не се преразглеждат
 * (премахват се от `allin.potIds` веднага след awardLocked/split).
 */
function advanceAllInSvara(ctx: Ctx): void {
  requirePhase(ctx, 'in-progress')
  const { state } = ctx
  const round = state.round
  if (!round || round.kind !== 'allin-svara') fail('not-allowed', 'no all-in Svara in progress')
  const allin = round as AllInSvaraRound
  const pots = allin.potIds.map((id) => lockedPot(state, id))
  const contenders = inSeatOrder(state.seats, [...new Set(pots.flatMap((pot) => pot.eligible))])
  allin.iteration += 1
  // §7.1–7.4: три нови карти за всеки съответен правоимащ; без Вход и наддаване.
  const hands = dealTo(ctx, contenders)
  const points = pointsFor(hands, contenders)
  const record: SvaraRoundRecord = {
    roundId: `${allin.roundId}#${allin.iteration}`,
    kind: 'allin-svara',
    dealerId: null,
    participants: contenders,
    shownHands: hands,
    points,
    contributions: {},
    folded: [],
    anyVoluntaryBet: false,
    pots: [],
  }
  for (const pot of pots) {
    const base = { potId: pot.potId, source: 'locked' as const, amount: pot.amount, contributions: {}, eligible: [...pot.eligible] }
    // §7.3: всяка банка само сред своите правоимащи, със същите нови карти.
    const best = topPlayers(pot.eligible, points)
    if (best.length === 1) {
      record.pots.push({ ...base, outcome: { kind: 'awarded', winner: best[0]!, byShowdown: true } })
      awardLocked(ctx, pot, best[0]!, allin.roundId)
      continue
    }
    if (pot.isMain) {
      // §7.4: ново равенство в основната — само равните получават нови карти.
      pot.eligible = best
      record.pots.push({ ...base, outcome: { kind: 'locked', lockedPotId: pot.potId, tiedPlayers: best, lockKind: 'allin' } })
      continue
    }
    // §7.5–7.6: странична банка — подялба; остатъкът излиза от играта.
    const share = Math.floor(pot.amount / best.length)
    const removed = pot.amount - share * best.length
    for (const id of best) {
      state.stacks[id] = state.stacks[id]! + share
      pushLedger(ctx, { type: 'pot-split', from: `locked:${pot.potId}`, to: `stack:${id}`, amount: share, roundId: allin.roundId, potId: pot.potId, playerId: id })
    }
    if (removed > 0) {
      state.removedChips += removed
      pushLedger(ctx, { type: 'split-remainder-removed', from: `locked:${pot.potId}`, to: 'removed', amount: removed, roundId: allin.roundId, potId: pot.potId, playerId: null })
    }
    state.lockedPots = state.lockedPots.filter((p) => p.potId !== pot.potId)
    record.pots.push({ ...base, outcome: { kind: 'split', tiedPlayers: best, share, removed } })
  }
  allin.sidesEvaluated = true
  allin.potIds = allin.potIds.filter((id) => state.lockedPots.some((pot) => pot.potId === id))
  state.history.push(record)
  ctx.completedRounds.push(record.roundId)
  if (allin.potIds.length === 0) finishRound(ctx, null)
}

// ── Отсъствие и изход (§8) ──────────────────────────────────────────────────

function setAbsent(ctx: Ctx, playerId: string, absent: boolean): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const { state } = ctx
  if (typeof absent !== 'boolean') fail('invalid-command', 'absent must be boolean')
  const status = state.status[playerId]
  if (status !== 'active' && status !== 'absent') fail('not-allowed', `${playerId} is ${status}`)
  if (!absent) {
    state.status[playerId] = 'active'
    return
  }
  const round = state.round
  // Случай №5: отсъствието в Свара не е отказ — правата се пазят, а ходът
  // изчаква завръщането (act изисква активен играч).
  state.status[playerId] = 'absent'
  // Отсъстващият автоматично отказва обикновените раздавания.
  if (round?.kind === 'ordinary' && round.participants.includes(playerId)) {
    round.betting = forceSvaraFold(round.betting, playerId)
    if (round.betting.complete) settleOrdinary(ctx)
  }
}

/** Правата върху заключени банки извън текущия рунд отпадат; 1 правоимащ → печели; 0 → пренос. */
function dropLockedRights(ctx: Ctx, playerId: string): void {
  const { state } = ctx
  const activeRound = state.round
  const busy = new Set<string>()
  if (activeRound?.kind === 'svara') busy.add(activeRound.potId)
  if (activeRound?.kind === 'allin-svara') activeRound.potIds.forEach((id) => busy.add(id))
  for (const pot of [...state.lockedPots]) {
    if (!pot.eligible.includes(playerId)) continue
    pot.eligible = pot.eligible.filter((id) => id !== playerId)
    if (busy.has(pot.potId) && activeRound?.kind === 'svara') continue // решава се при разрешаването на рунда
    if (pot.eligible.length === 1) awardLocked(ctx, pot, pot.eligible[0]!, activeRound?.roundId ?? null)
    else if (pot.eligible.length === 0) carryLocked(ctx, pot, activeRound?.roundId ?? null)
  }
  if (activeRound?.kind === 'svara-joining' && !state.lockedPots.some((pot) => pot.potId === activeRound.potId)) {
    state.round = null
  }
  if (activeRound?.kind === 'allin-svara') {
    activeRound.potIds = activeRound.potIds.filter((id) => state.lockedPots.some((pot) => pot.potId === id))
    if (activeRound.potIds.length === 0) finishRound(ctx, null)
  }
}

function exitMatch(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const { state } = ctx
  const status = state.status[playerId]
  if (status !== 'active' && status !== 'absent' && status !== 'eliminated') fail('not-allowed', `${playerId} has already exited`)
  // Неизползваните чипове излизат от играта; направените залози остават.
  const unused = state.stacks[playerId]!
  if (unused > 0) {
    state.stacks[playerId] = 0
    state.removedChips += unused
    pushLedger(ctx, { type: 'exit-removed', from: `stack:${playerId}`, to: 'removed', amount: unused, roundId: state.round?.roundId ?? null, potId: null, playerId })
  }
  state.status[playerId] = 'exited'
  const round = state.round
  let roundToSettle: 'ordinary' | 'svara' | null = null
  if ((round?.kind === 'ordinary' || round?.kind === 'svara') && round.participants.includes(playerId)) {
    round.betting = forceSvaraFold(round.betting, playerId)
    if (round.betting.complete) roundToSettle = round.kind
  }
  dropLockedRights(ctx, playerId)
  if (roundToSettle === 'ordinary') settleOrdinary(ctx)
  else if (roundToSettle === 'svara') settleSvaraDeal(ctx)
  else if (!state.round) finishRound(ctx, null)
}

function absenceExpired(ctx: Ctx, playerId: string): void {
  requirePhase(ctx, 'in-progress')
  requireSeated(ctx, playerId)
  const { state } = ctx
  if (state.status[playerId] !== 'absent') fail('not-allowed', `${playerId} is not absent`)
  // §8: последният шанс важи, когато на масата остане само един активен играч.
  if (state.seats.filter((id) => state.status[id] === 'active').length !== 1) fail('not-allowed', 'more than one active player remains')
  // Случай №5: след последния шанс отсъстващият губи правата си; банките
  // се разпределят според останалите правоимащи.
  const round = state.round
  let svaraToSettle = false
  if (round?.kind === 'svara' && round.participants.includes(playerId) && !round.betting.folded.includes(playerId)) {
    round.betting = forceSvaraFold(round.betting, playerId)
    svaraToSettle = round.betting.complete
  }
  dropLockedRights(ctx, playerId)
  if (svaraToSettle) settleSvaraDeal(ctx)
  else if (!state.round) finishRound(ctx, null)
}

// ── Изглед за играч и опции ─────────────────────────────────────────────────

export type SvaraMatchPlayerView = {
  phase: SvaraMatchState['phase']
  roundKind: SvaraRound['kind'] | null
  dealerId: string | null
  toAct: string | null
  /** Собствените карти — само след „поглеждане“ (иначе тъмното няма смисъл). */
  ownCards: SvaraCardCode[] | null
  ownLooked: boolean
  stacks: Record<string, number>
  status: Record<string, SvaraSeatStatus>
  seatsWithCards: Array<{ playerId: string; cardCount: number }>
  lockedPots: Array<{ potId: string; kind: 'ordinary' | 'allin'; amount: number; eligible: string[] }>
  carriedTotal: number
  svaraJoinFee: number | null
}

export function createSvaraMatchPlayerView(state: SvaraMatchState, viewerId: string): SvaraMatchPlayerView {
  const round = state.round
  const betting = round && (round.kind === 'ordinary' || round.kind === 'svara') ? round : null
  const looked = betting ? betting.betting.looked.includes(viewerId) : false
  return {
    phase: state.phase,
    roundKind: round?.kind ?? null,
    dealerId: betting?.dealerId ?? null,
    toAct: betting?.betting.toAct ?? null,
    ownCards: betting && looked && betting.hands[viewerId] ? [...betting.hands[viewerId]!] : null,
    ownLooked: looked,
    stacks: { ...state.stacks },
    status: { ...state.status },
    seatsWithCards: betting ? betting.participants.filter((id) => !betting.betting.folded.includes(id)).map((playerId) => ({ playerId, cardCount: 3 })) : [],
    lockedPots: state.lockedPots.map((pot) => ({ potId: pot.potId, kind: pot.kind, amount: pot.amount, eligible: [...pot.eligible] })),
    carriedTotal: state.carried.reduce((sum, carry) => sum + carry.amount, 0),
    svaraJoinFee: round?.kind === 'svara-joining' ? round.fee : null,
  }
}

export function describeSvaraMatchOptions(state: SvaraMatchState, playerId: string): SvaraBettingOptions | null {
  const round = state.round
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara') || state.status[playerId] !== 'active') return null
  return describeSvaraBettingOptions(round.betting, playerId, state.stacks[playerId] ?? 0)
}

/** Само за тестове: тесте с дадени ръце за играчите в реда на раздаване. */
export function buildSvaraDeckForHands(order: string[], hands: Record<string, string>): SvaraCard[] {
  const wanted = order.map((id) => (hands[id] ?? '').split(' ').filter(Boolean))
  const used = new Set(wanted.flat())
  const rest = SVARA_ORDERED_DECK.map(svaraCardCode).filter((code) => !used.has(code))
  const deck: string[] = []
  for (let round = 0; round < 3; round += 1) {
    order.forEach((id, i) => {
      const code = wanted[i]![round] ?? rest.shift()
      if (!code) throw new SvaraInvalidInputError(`no card for ${id}`)
      deck.push(code)
    })
  }
  return [...deck, ...rest].map(parseSvaraCardCode)
}
