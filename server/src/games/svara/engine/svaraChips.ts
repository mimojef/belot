// Свара — симулирани игрови чипове: дневник, банки и разпределяне
// (чиста сървърна логика, Етап 2Б.2А).
//
// НЕ е свързано с реалните жълтици, HTTP, WebSocket, база данни или UI.
//
// Обхват на 2Б.2А (одобрен): дневник с инвариант след всяка операция,
// основна/странични банки с изрични правоимащи, връщане на непокрит
// залог, присъждане при един победител или заключване при равенство,
// няколко едновременни заключени банки (само като данни), защита от
// повторени команди чрез commandId.
//
// Умишлено НЕ е реализирано (правилата ще се уточнят отделно; командите
// не ги допускат или отказват с грешка): ред на ходовете и наддаване,
// минимални залози/повишавания, залагане на тъмно, анте при недостатъчни
// чипове, анте и раздаване за Свара, банки без нито един правоимащ,
// продължаване/разрешаване на заключените банки, доброволен изход.
//
// Потвърдено правило, използвано тук: началните чипове = входа ÷ 10.

import { assertValidSvaraCards, parseSvaraCardCode, SvaraInvalidInputError, type SvaraCardCode } from './svaraCards.js'
import { SVARA_CARDS_PER_PLAYER, SVARA_MAX_PLAYERS, SVARA_MIN_PLAYERS, type SvaraPlayerId } from './svaraDeal.js'
import { resolveSvaraShowdown } from './svaraHandEvaluation.js'
import { buildSvaraPotLayers, type SvaraPotLayer } from './svaraPots.js'

// ── Типове ──────────────────────────────────────────────────────────────────

export type SvaraLedgerAccount =
  | 'table-buy-in'
  | `stack:${string}`
  | `deal:${string}`
  | `locked:${string}`

export type SvaraLedgerEntryType =
  | 'starting-chips'
  | 'contribution'
  | 'uncalled-return'
  | 'pot-award'
  | 'pot-lock'

export type SvaraLedgerEntry = {
  seq: number
  commandId: string
  type: SvaraLedgerEntryType
  from: SvaraLedgerAccount
  to: SvaraLedgerAccount
  amount: number
  dealId: string | null
  potId: string | null
  playerId: SvaraPlayerId | null
  /** Само за 'contribution': анте или залог (без проверка на реда/минимумите). */
  reason?: 'ante' | 'bet'
}

export type SvaraLockedPot = {
  potId: string
  amount: number
  /** Играчите с право да продължат за банката (равните за първо място). */
  eligible: readonly SvaraPlayerId[]
  createdInDealId: string
  /** Точките на равните победители при заключването (за одит). */
  tiedPoints: number
}

export type SvaraActiveDeal = {
  dealId: string
  participants: readonly SvaraPlayerId[]
  contributions: Record<SvaraPlayerId, number>
  folded: SvaraPlayerId[]
}

export type SvaraPotResolution =
  | { kind: 'uncalled-return'; playerId: SvaraPlayerId }
  | { kind: 'awarded-uncontested'; winner: SvaraPlayerId }
  | { kind: 'awarded-showdown'; winner: SvaraPlayerId; points: Record<SvaraPlayerId, number> }
  | { kind: 'locked'; lockedPotId: string; tiedPlayers: SvaraPlayerId[]; points: Record<SvaraPlayerId, number> }

export type SvaraSettledPot = {
  potId: string
  index: number
  fromLevel: number
  toLevel: number
  amount: number
  contributions: Record<SvaraPlayerId, number>
  eligible: SvaraPlayerId[]
  resolution: SvaraPotResolution
}

export type SvaraCommandOutcome = {
  commandId: string
  type: SvaraChipCommand['type']
  /** Записите в дневника, добавени от командата (seq от–до, включително). */
  ledgerSeqFrom: number | null
  ledgerSeqTo: number | null
  settlement?: { dealId: string; pots: SvaraSettledPot[] }
}

export type SvaraChipTableState = {
  tableId: string
  entryFee: number
  startingChips: number
  /** Общо чипове на масата — константа след създаването. */
  totalChips: number
  playerIds: readonly SvaraPlayerId[]
  stacks: Record<SvaraPlayerId, number>
  deal: SvaraActiveDeal | null
  lockedPots: SvaraLockedPot[]
  usedDealIds: string[]
  ledger: SvaraLedgerEntry[]
  /** commandId → отпечатък на командата и резултатът ѝ (за идемпотентност). */
  processedCommands: Record<string, { fingerprint: string; outcome: SvaraCommandOutcome }>
}

export type SvaraChipCommand =
  | { type: 'begin-deal'; commandId: string; dealId: string; participants: SvaraPlayerId[] }
  | { type: 'contribute'; commandId: string; playerId: SvaraPlayerId; amount: number; reason: 'ante' | 'bet' }
  | { type: 'fold'; commandId: string; playerId: SvaraPlayerId }
  /** hands: картите на неотказалите играчи (нужни за банки с ≥ 2 правоимащи). */
  | { type: 'settle-deal'; commandId: string; hands: Record<SvaraPlayerId, SvaraCardCode[]> }

export type SvaraChipErrorCode =
  | 'invalid-command'
  | 'command-id-conflict'
  | 'no-active-deal'
  | 'deal-already-active'
  | 'unknown-player'
  | 'not-a-participant'
  | 'player-folded'
  | 'insufficient-chips'
  | 'missing-hand'
  | 'rule-not-implemented'
  | 'invariant-violation'

export class SvaraChipCommandError extends Error {
  constructor(readonly code: SvaraChipErrorCode, message: string) {
    super(message)
    this.name = 'SvaraChipCommandError'
  }
}

export type SvaraApplyResult = {
  state: SvaraChipTableState
  status: 'applied' | 'duplicate'
  outcome: SvaraCommandOutcome
}

// ── Помощни ─────────────────────────────────────────────────────────────────

const fail = (code: SvaraChipErrorCode, message: string): never => {
  throw new SvaraChipCommandError(code, message)
}

function isChipAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Стабилен JSON (сортирани ключове) — отпечатък на команда. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function svaraStartingChipsForEntry(entryFee: number): number {
  if (!Number.isSafeInteger(entryFee) || entryFee <= 0 || entryFee % 10 !== 0) {
    throw new SvaraInvalidInputError(`entryFee must be a positive integer divisible by 10, got ${String(entryFee)}`)
  }
  return entryFee / 10
}

// ── Създаване ───────────────────────────────────────────────────────────────

export function createSvaraChipTable(input: { tableId: string; entryFee: number; playerIds: SvaraPlayerId[] }): SvaraChipTableState {
  if (!isNonEmptyString(input?.tableId)) throw new SvaraInvalidInputError('tableId required')
  const startingChips = svaraStartingChipsForEntry(input.entryFee)
  const { playerIds } = input
  if (!Array.isArray(playerIds) || playerIds.length < SVARA_MIN_PLAYERS || playerIds.length > SVARA_MAX_PLAYERS) {
    throw new SvaraInvalidInputError(`playerIds: ${SVARA_MIN_PLAYERS}–${SVARA_MAX_PLAYERS} players required`)
  }
  if (!playerIds.every(isNonEmptyString) || new Set(playerIds).size !== playerIds.length) {
    throw new SvaraInvalidInputError('playerIds: non-empty, unique ids required')
  }
  const state: SvaraChipTableState = {
    tableId: input.tableId,
    entryFee: input.entryFee,
    startingChips,
    totalChips: startingChips * playerIds.length,
    playerIds: [...playerIds],
    stacks: Object.fromEntries(playerIds.map((id) => [id, startingChips])),
    deal: null,
    lockedPots: [],
    usedDealIds: [],
    ledger: playerIds.map((id, i) => ({
      seq: i + 1,
      commandId: 'create-table',
      type: 'starting-chips' as const,
      from: 'table-buy-in' as const,
      to: `stack:${id}` as const,
      amount: startingChips,
      dealId: null,
      potId: null,
      playerId: id,
    })),
    processedCommands: {},
  }
  assertSvaraChipInvariants(state)
  return state
}

// ── Инварианти ──────────────────────────────────────────────────────────────

/** Хвърля 'invariant-violation' при каквото и да е несъответствие. */
export function assertSvaraChipInvariants(state: SvaraChipTableState): void {
  const violation = (message: string) => fail('invariant-violation', message)
  if (!isChipAmount(state.totalChips) || state.totalChips !== state.startingChips * state.playerIds.length) violation('totalChips')

  const balances = new Map<string, number>()
  for (const id of state.playerIds) {
    const stack = state.stacks[id]
    if (!isChipAmount(stack)) violation(`stack of ${id}: ${String(stack)}`)
    balances.set(`stack:${id}`, stack!)
  }
  if (Object.keys(state.stacks).length !== state.playerIds.length) violation('stacks for unknown players')

  let dealTotal = 0
  if (state.deal) {
    const { participants, contributions, folded } = state.deal
    for (const [id, amount] of Object.entries(contributions)) {
      if (!participants.includes(id)) violation(`contribution from non-participant ${id}`)
      if (!isChipAmount(amount)) violation(`contribution of ${id}: ${String(amount)}`)
      dealTotal += amount
    }
    for (const id of folded) if (!participants.includes(id)) violation(`folded non-participant ${id}`)
    balances.set(`deal:${state.deal.dealId}`, dealTotal)
  }

  let lockedTotal = 0
  const lockedIds = new Set<string>()
  for (const pot of state.lockedPots) {
    if (!isChipAmount(pot.amount) || pot.amount <= 0) violation(`locked pot ${pot.potId} amount ${String(pot.amount)}`)
    if (lockedIds.has(pot.potId)) violation(`duplicate locked pot ${pot.potId}`)
    lockedIds.add(pot.potId)
    if (pot.eligible.length < 2 || pot.eligible.some((id) => !state.playerIds.includes(id))) violation(`locked pot ${pot.potId} eligible`)
    lockedTotal += pot.amount
    balances.set(`locked:${pot.potId}`, pot.amount)
  }

  const stacksTotal = state.playerIds.reduce((sum, id) => sum + state.stacks[id]!, 0)
  if (stacksTotal + dealTotal + lockedTotal !== state.totalChips) {
    violation(`chip total ${stacksTotal}+${dealTotal}+${lockedTotal} ≠ ${state.totalChips}`)
  }

  // Повторно изчисляване на всички сметки от дневника.
  const replay = new Map<string, number>()
  let previousSeq = 0
  for (const entry of state.ledger) {
    if (entry.seq !== previousSeq + 1) violation(`ledger seq ${entry.seq} after ${previousSeq}`)
    previousSeq = entry.seq
    if (!isChipAmount(entry.amount) || entry.amount === 0) violation(`ledger amount ${entry.seq}`)
    replay.set(entry.from, (replay.get(entry.from) ?? 0) - entry.amount)
    replay.set(entry.to, (replay.get(entry.to) ?? 0) + entry.amount)
  }
  if (-(replay.get('table-buy-in') ?? 0) !== state.totalChips) violation('ledger buy-in total')
  for (const [account, value] of replay) {
    if (account === 'table-buy-in') continue
    const expected = balances.get(account) ?? 0
    if (value !== expected) violation(`ledger balance ${account}: ${value} ≠ ${expected}`)
  }
  for (const [account, value] of balances) {
    if ((replay.get(account) ?? 0) !== value) violation(`state balance ${account} not backed by ledger`)
  }
}

// ── Прилагане на команди ────────────────────────────────────────────────────

export function applySvaraChipCommand(state: SvaraChipTableState, command: SvaraChipCommand): SvaraApplyResult {
  if (!command || typeof command !== 'object') fail('invalid-command', 'command required')
  if (!isNonEmptyString(command.commandId)) fail('invalid-command', 'commandId required')
  const fingerprint = stableStringify(command)
  const previous = state.processedCommands[command.commandId]
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('command-id-conflict', `commandId ${command.commandId} was used for a different command`)
    return { state, status: 'duplicate', outcome: previous.outcome }
  }

  const next = structuredClone(state)
  const ledgerStart = next.ledger.length
  let settlement: SvaraCommandOutcome['settlement']

  try {
    switch (command.type) {
      case 'begin-deal':
        beginDeal(next, command)
        break
      case 'contribute':
        contribute(next, command)
        break
      case 'fold':
        foldPlayer(next, command)
        break
      case 'settle-deal':
        settlement = settleDeal(next, command)
        break
      default:
        fail('invalid-command', `unknown command type ${String((command as { type?: unknown }).type)}`)
    }
  } catch (error) {
    // Невалидни карти/ръце от слоя с картите → единен код за командите.
    if (error instanceof SvaraInvalidInputError) fail('invalid-command', error.message)
    throw error
  }

  const added = next.ledger.length - ledgerStart
  const outcome: SvaraCommandOutcome = {
    commandId: command.commandId,
    type: command.type,
    ledgerSeqFrom: added > 0 ? next.ledger[ledgerStart]!.seq : null,
    ledgerSeqTo: added > 0 ? next.ledger[next.ledger.length - 1]!.seq : null,
    ...(settlement ? { settlement } : {}),
  }
  next.processedCommands[command.commandId] = { fingerprint, outcome }
  assertSvaraChipInvariants(next)
  return { state: next, status: 'applied', outcome }
}

function pushLedger(state: SvaraChipTableState, entry: Omit<SvaraLedgerEntry, 'seq'>): void {
  state.ledger.push({ seq: state.ledger.length + 1, ...entry })
}

function requireDeal(state: SvaraChipTableState): SvaraActiveDeal {
  return state.deal ?? fail('no-active-deal', 'no active deal')
}

function requireActiveParticipant(state: SvaraChipTableState, playerId: unknown): SvaraActiveDeal {
  const deal = requireDeal(state)
  if (!isNonEmptyString(playerId) || !state.playerIds.includes(playerId)) fail('unknown-player', `unknown player ${String(playerId)}`)
  if (!deal.participants.includes(playerId as string)) fail('not-a-participant', `${String(playerId)} is not in deal ${deal.dealId}`)
  if (deal.folded.includes(playerId as string)) fail('player-folded', `${String(playerId)} has folded`)
  return deal
}

function beginDeal(state: SvaraChipTableState, command: Extract<SvaraChipCommand, { type: 'begin-deal' }>): void {
  if (state.deal) fail('deal-already-active', `deal ${state.deal.dealId} is still active`)
  if (!isNonEmptyString(command.dealId)) fail('invalid-command', 'dealId required')
  if (state.usedDealIds.includes(command.dealId)) fail('invalid-command', `dealId ${command.dealId} already used`)
  const { participants } = command
  if (!Array.isArray(participants) || participants.length < SVARA_MIN_PLAYERS || participants.length > SVARA_MAX_PLAYERS) {
    fail('invalid-command', `participants: ${SVARA_MIN_PLAYERS}–${SVARA_MAX_PLAYERS} required`)
  }
  if (new Set(participants).size !== participants.length) fail('invalid-command', 'duplicate participant')
  for (const id of participants) {
    if (!isNonEmptyString(id) || !state.playerIds.includes(id)) fail('unknown-player', `unknown player ${String(id)}`)
    // Анте/участие без чипове (вкл. раздаване за Свара) — правилата не са уточнени.
    if (state.stacks[id] === 0) fail('rule-not-implemented', `${id} has no chips; participation without chips is not specified yet`)
  }
  state.deal = { dealId: command.dealId, participants: [...participants], contributions: {}, folded: [] }
  state.usedDealIds.push(command.dealId)
}

function contribute(state: SvaraChipTableState, command: Extract<SvaraChipCommand, { type: 'contribute' }>): void {
  const deal = requireActiveParticipant(state, command.playerId)
  if (command.reason !== 'ante' && command.reason !== 'bet') fail('invalid-command', `reason must be 'ante' or 'bet'`)
  if (!isChipAmount(command.amount) || command.amount === 0) fail('invalid-command', `amount must be a positive integer, got ${String(command.amount)}`)
  const stack = state.stacks[command.playerId]!
  // Ол-ин = вноска, която изчерпва стека; повече от наличното е невъзможно.
  if (command.amount > stack) fail('insufficient-chips', `${command.playerId} has ${stack}, tried ${command.amount}`)
  state.stacks[command.playerId] = stack - command.amount
  deal.contributions[command.playerId] = (deal.contributions[command.playerId] ?? 0) + command.amount
  pushLedger(state, {
    commandId: command.commandId,
    type: 'contribution',
    from: `stack:${command.playerId}`,
    to: `deal:${deal.dealId}`,
    amount: command.amount,
    dealId: deal.dealId,
    potId: null,
    playerId: command.playerId,
    reason: command.reason,
  })
}

function foldPlayer(state: SvaraChipTableState, command: Extract<SvaraChipCommand, { type: 'fold' }>): void {
  const deal = requireActiveParticipant(state, command.playerId)
  deal.folded.push(command.playerId)
}

function settleDeal(state: SvaraChipTableState, command: Extract<SvaraChipCommand, { type: 'settle-deal' }>): { dealId: string; pots: SvaraSettledPot[] } {
  const deal = requireDeal(state)
  const hands = command.hands
  if (!hands || typeof hands !== 'object' || Array.isArray(hands)) fail('invalid-command', 'hands must be an object')
  for (const id of Object.keys(hands)) {
    if (!deal.participants.includes(id)) fail('not-a-participant', `hand for non-participant ${id}`)
    if (deal.folded.includes(id)) fail('player-folded', `hand for folded player ${id}`)
  }
  const parsedHands = new Map(Object.entries(hands).map(([id, codes]) => {
    if (!Array.isArray(codes)) fail('invalid-command', `hand of ${id} must be an array of card codes`)
    const cards = codes.map((code) => parseSvaraCardCode(code))
    assertValidSvaraCards(cards, SVARA_CARDS_PER_PLAYER, `hand of ${id}`)
    return [id, cards]
  }))
  // Една карта не може да е в две ръце (проверка между всички подадени ръце).
  const seenCards = new Map<string, string>()
  for (const [id, codes] of Object.entries(hands)) {
    for (const code of codes) {
      const owner = seenCards.get(code)
      if (owner) fail('invalid-command', `card ${code} in hands of ${owner} and ${id}`)
      seenCards.set(code, id)
    }
  }

  const layers = buildSvaraPotLayers({ participants: deal.participants, contributions: deal.contributions, folded: deal.folded })
  const pots: SvaraSettledPot[] = []
  const dealAccount = `deal:${deal.dealId}` as const

  for (const layer of layers) {
    const potId = `${deal.dealId}:pot-${layer.index}`
    const resolution = resolveLayer(layer, potId, parsedHands)
    pots.push({
      potId,
      index: layer.index,
      fromLevel: layer.fromLevel,
      toLevel: layer.toLevel,
      amount: layer.amount,
      contributions: { ...layer.contributions },
      eligible: [...layer.eligible],
      resolution,
    })
  }

  // Движенията се записват едва след като ВСИЧКИ слоеве са разрешени —
  // при грешка в който и да е слой състоянието не се променя.
  for (const pot of pots) {
    const { resolution } = pot
    if (resolution.kind === 'locked') {
      state.lockedPots.push({
        potId: resolution.lockedPotId,
        amount: pot.amount,
        eligible: [...resolution.tiedPlayers],
        createdInDealId: deal.dealId,
        tiedPoints: resolution.points[resolution.tiedPlayers[0]!]!,
      })
      pushLedger(state, { commandId: command.commandId, type: 'pot-lock', from: dealAccount, to: `locked:${resolution.lockedPotId}`, amount: pot.amount, dealId: deal.dealId, potId: pot.potId, playerId: null })
      continue
    }
    const receiver = resolution.kind === 'uncalled-return' ? resolution.playerId : resolution.winner
    state.stacks[receiver] = state.stacks[receiver]! + pot.amount
    pushLedger(state, {
      commandId: command.commandId,
      type: resolution.kind === 'uncalled-return' ? 'uncalled-return' : 'pot-award',
      from: dealAccount,
      to: `stack:${receiver}`,
      amount: pot.amount,
      dealId: deal.dealId,
      potId: pot.potId,
      playerId: receiver,
    })
  }
  state.deal = null
  return { dealId: deal.dealId, pots }
}

function resolveLayer(layer: SvaraPotLayer, potId: string, hands: Map<string, ReturnType<typeof parseSvaraCardCode>[]>): SvaraPotResolution {
  if (layer.eligible.length === 0) {
    // Процедурата за банка без нито един правоимащ не е уточнена.
    return fail('rule-not-implemented', `pot ${potId} has no eligible player; this case is not specified yet`)
  }
  if (layer.kind === 'uncalled') {
    // Единственият вносител е и единственият правоимащ (иначе eligible е празно).
    return { kind: 'uncalled-return', playerId: layer.contributors[0]! }
  }
  if (layer.eligible.length === 1) return { kind: 'awarded-uncontested', winner: layer.eligible[0]! }

  for (const id of layer.eligible) if (!hands.has(id)) fail('missing-hand', `hand of ${id} required for pot ${potId}`)
  const showdown = resolveSvaraShowdown(layer.eligible.map((id) => ({ playerId: id, cards: hands.get(id)! })))
  const points = Object.fromEntries([...showdown.evaluations].map(([id, evaluation]) => [id, evaluation.points]))
  if (showdown.isTie) return { kind: 'locked', lockedPotId: `${potId}:locked`, tiedPlayers: [...showdown.winners], points }
  return { kind: 'awarded-showdown', winner: showdown.winners[0]!, points }
}

// ── Заявки ──────────────────────────────────────────────────────────────────

/**
 * Потвърдено: играч без чипове отпада само ако няма права върху заключена
 * банка. По време на раздаване неотказал участник не се смята за отпаднал.
 */
export function isSvaraPlayerEliminated(state: SvaraChipTableState, playerId: SvaraPlayerId): boolean {
  if (!state.playerIds.includes(playerId)) throw new SvaraInvalidInputError(`unknown player ${playerId}`)
  if (state.stacks[playerId]! > 0) return false
  if (state.lockedPots.some((pot) => pot.eligible.includes(playerId))) return false
  if (state.deal && state.deal.participants.includes(playerId) && !state.deal.folded.includes(playerId)) return false
  return true
}
