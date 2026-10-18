import { assertSvaraMatchInvariants, describeSvaraLifecycle, type SvaraMatchState } from '../engine/svaraMatch.js'
import { parseSvaraCardCode } from '../engine/svaraCards.js'
import { svaraStartingChipsForEntry } from '../engine/svaraChips.js'
import { planSvaraDeadlines } from './svaraDeadlines.js'
import { SvaraPersistenceError, type SvaraStoredMatch } from './svaraPersistence.js'

const require = (condition: unknown): void => { if (!condition) throw new Error() }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length
const member = (value: unknown, ids: string[]) => typeof value === 'string' && ids.includes(value)
const subset = (value: unknown, ids: string[]) => strings(value) && value.every((id) => ids.includes(id))
const amounts = (value: unknown, ids: string[]) => object(value) && Object.entries(value).every(([id, amount]) => ids.includes(id) && integer(amount))
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const actions = ['fold', 'call', 'all-in', 'no-bet', 'bet', 'blind-bet']
const participantTypes = ['join-seat', 'leave-seat', 'start-match', 'look', 'act', 'svara-join', 'svara-decline', 'request-return', 'exit', 'reveal-cards', 'hide-cards']
const systemTypes = ['start-next-round', 'svara-start', 'advance-allin-svara', 'absence-expired', 'set-absent', 'activate-returns', 'turn-timeout', 'close-svara-joining', 'finish-presence-wait', 'expire-reveal-choice', 'close-reveal-display', 'finish-dealing', 'advance-showdown-display', 'close-payout-display']
const ledgerTypes = ['absence-pot-award', 'abandoned-pot-removed', 'starting-chips', 'entry', 'bet', 'svara-join-fee', 'carry-in', 'uncalled-return', 'pot-award', 'pot-lock', 'pot-carry', 'pot-split', 'split-remainder-removed', 'exit-removed']

function hands(value: unknown, players: string[], full: boolean): void {
  require(object(value))
  const entries = Object.entries(value as Record<string, unknown>)
  require(!full || entries.length === players.length)
  const seen = new Set<string>()
  for (const [id, cards] of entries) {
    require(players.includes(id) && Array.isArray(cards) && cards.length === 3)
    for (const card of cards as unknown[]) {
      require(typeof card === 'string'); parseSvaraCardCode(card as string)
      require(!seen.has(card as string)); seen.add(card as string)
    }
  }
}

function validateRecord(record: any, seats: string[]): void {
  require(object(record) && text(record.roundId))
  require(['ordinary', 'svara', 'allin-svara'].includes(record.kind) && subset(record.participants, seats) && subset(record.folded, record.participants))
  require(record.dealerId === null || member(record.dealerId, seats))
  hands(record.shownHands, record.participants, false)
  require(amounts(record.points, record.participants) && amounts(record.contributions, record.participants) && typeof record.anyVoluntaryBet === 'boolean' && Array.isArray(record.pots))
  for (const pot of record.pots) {
    require(object(pot) && text(pot.potId) && ['round', 'locked'].includes(pot.source) && integer(pot.amount) && amounts(pot.contributions, seats) && subset(pot.eligible, seats) && object(pot.outcome))
    // 2Б.3.7.6А: ново, незадължително поле — по-стар (преди тази стъпка)
    // съхранен запис легитимно го няма (виж round.dealing по-горе за същия
    // прецедент), без миграция на данни.
    require(pot.isMain === undefined || typeof pot.isMain === 'boolean')
    const out = pot.outcome
    require(['uncalled-return', 'awarded', 'locked', 'carried', 'split'].includes(out.kind))
    if (out.kind === 'awarded') require(member(out.winner, seats) && typeof out.byShowdown === 'boolean')
    if (out.kind === 'uncalled-return') require(member(out.playerId, seats))
    if (out.kind === 'carried') require(text(out.carryId))
    if (out.kind === 'locked') require(text(out.lockedPotId) && subset(out.tiedPlayers, seats) && ['ordinary', 'allin'].includes(out.lockKind))
    if (out.kind === 'split') require(subset(out.tiedPlayers, seats) && integer(out.share) && integer(out.removed))
  }
}

function betting(value: any, players: string[]): void {
  require(object(value) && subset(value.order, players) && value.order.length === players.length)
  for (const field of ['folded', 'allIn', 'looked', 'pending', 'acted', 'raiseLocked', 'noBet']) require(subset(value[field], players))
  require(integer(value.entryChips) && value.entryChips > 0 && amounts(value.voluntary, players) && integer(value.currentBet))
  for (const field of ['anyVoluntaryBet', 'allowNoBet', 'complete']) require(typeof value[field] === 'boolean')
  require(value.firstActor === null || member(value.firstActor, players))
  require(value.complete ? value.toAct === null : member(value.toAct, value.pending))
  require(object(value.blind) && ['available', 'active', 'closed'].includes(value.blind.status) && integer(value.blind.lastBlindTotal))
  require(Array.isArray(value.log))
  for (const item of value.log) require(object(item) && member(item.playerId, players) && [...actions, 'forced-fold'].includes(item.kind) &&
    integer(item.total) && integer(item.added) && typeof item.allIn === 'boolean' && typeof item.blind === 'boolean')
}

function validateStructure(state: SvaraMatchState): void {
  const s: any = state
  require(object(s.config) && [2, 3, 4].includes(s.config.capacity) && [1, 2, 3, 5].includes(s.config.entryPercent) && ['auto', 'manual'].includes(s.config.startMode))
  require(text(s.config.creatorId) && integer(s.config.entryFee) && s.startingChips === svaraStartingChipsForEntry(s.config.entryFee))
  require(s.entryChips === Math.ceil(s.startingChips * s.config.entryPercent / 100))
  require(strings(s.seats) && s.seats.length <= s.config.capacity && s.seats.every((id: string) => id.length <= 128))
  require(s.phase === 'closed' ? s.seats.length === 0 : s.seats.length > 0)
  require(object(s.status) && exactKeys(s.status, s.seats) && Object.values(s.status).every((status) => ['active', 'absent', 'exited', 'eliminated'].includes(status as string)))
  const started = s.phase === 'in-progress' || s.phase === 'finished'
  require(object(s.stacks) && amounts(s.stacks, s.seats) && exactKeys(s.stacks, started ? s.seats : []))
  require(!started || s.seats.length === s.config.capacity)
  for (const field of ['totalChips', 'removedChips', 'headsUpNoBetStreak', 'roundCounter']) require(integer(s[field]))
  for (const field of ['firstDealerId', 'ordinaryDealerId', 'winnerId']) require(s[field] === null || member(s[field], s.seats))
  require(!started || member(s.firstDealerId, s.seats))
  require(s.phase !== 'in-progress' || s.winnerId === null)
  require(subset(s.pendingReturns, s.seats) && [null, 'prolonged-absence', 'all-absent'].includes(s.finishReason))
  require(Array.isArray(s.lockedPots) && Array.isArray(s.carried) && Array.isArray(s.history) && Array.isArray(s.ledger) && object(s.processedCommands))
  if (!started) require(s.round === null && s.firstDealerId === null && s.ordinaryDealerId === null && s.winnerId === null &&
    s.roundCounter === 0 && s.headsUpNoBetStreak === 0 && s.removedChips === 0 && s.history.length === 0 &&
    s.lockedPots.length === 0 && s.carried.length === 0 && s.pendingReturns.length === 0 && s.finishReason === null)
  if (s.phase === 'in-progress') require(s.finishReason === null)
  const potIds = new Set<string>(), carryIds = new Set<string>()
  for (const pot of s.lockedPots) {
    require(object(pot) && text(pot.potId) && !potIds.has(pot.potId)); potIds.add(pot.potId)
    require(['ordinary', 'allin'].includes(pot.kind) && integer(pot.amount) && pot.amount > 0 && subset(pot.eligible, s.seats) && pot.eligible.length > 0)
    require(text(pot.originRoundId) && member(pot.originDealerId, s.seats) && (pot.lastSvaraDealerId === null || member(pot.lastSvaraDealerId, s.seats)))
    require(integer(pot.continuation) && typeof pot.isMain === 'boolean')
  }
  for (const carry of s.carried) {
    require(object(carry) && text(carry.carryId) && !carryIds.has(carry.carryId)); carryIds.add(carry.carryId)
    require(integer(carry.amount) && carry.amount > 0 && text(carry.fromRoundId) && text(carry.fromPotId))
  }
  const round = s.round
  require(round === null || object(round))
  if (round) {
    require(text(round.roundId) && ['ordinary', 'svara', 'svara-joining', 'allin-svara', 'reveal-choice', 'showdown-display'].includes(round.kind) && s.phase === 'in-progress')
    if (round.kind === 'ordinary' || round.kind === 'svara') {
      require(subset(round.participants, s.seats) && round.participants.length >= 2 && member(round.dealerId, round.participants) && amounts(round.contributions, round.participants))
      hands(round.hands, round.participants, true); betting(round.betting, round.participants)
      require(round.betting.entryChips === s.entryChips)
      // 2Б.3.7.4Б: optional field — a pre-2Б.3.7.4Б stored round legitimately
      // lacks it entirely (treated as false/already-active, never migrated).
      require(round.dealing === undefined || typeof round.dealing === 'boolean')
      if (round.kind === 'ordinary') require(integer(round.deadMoney) && strings(round.deadMoneyFrom) && typeof round.isFourthHeadsUp === 'boolean')
      else require(potIds.has(round.potId))
    } else if (round.kind === 'svara-joining') {
      require(potIds.has(round.potId) && integer(round.fee) && round.fee > 0 && subset(round.joiners, s.seats) && subset(round.declined, s.seats) && typeof round.closed === 'boolean')
    } else if (round.kind === 'reveal-choice') {
      require(member(round.winnerId, s.seats) && ['pending', 'revealed'].includes(round.decision) && integer(round.points))
      require(Array.isArray(round.cards) && round.cards.length === 3 && new Set(round.cards).size === 3)
      for (const card of round.cards) { require(typeof card === 'string'); parseSvaraCardCode(card) }
      validateRecord(round.record, s.seats)
    } else if (round.kind === 'showdown-display') {
      require(subset(round.comparedPlayers, s.seats) && round.comparedPlayers.length >= 2)
      hands(round.cards, round.comparedPlayers, true)
      require(amounts(round.points, round.comparedPlayers) && Array.isArray(round.payoutSteps) && typeof round.svaraTie === 'boolean' && ['showdown', 'payout'].includes(round.phase))
      require(round.dealerId === null || member(round.dealerId, s.seats))
      const stepOrders = new Set<number>()
      for (const step of round.payoutSteps) {
        require(object(step) && text(step.stepId) && text(step.potId) && typeof step.isMain === 'boolean' && integer(step.amount) && step.amount > 0)
        require(subset(step.winners, s.seats) && step.winners.length >= 1)
        require(step.share === null || (integer(step.share) && step.share > 0))
        require(integer(step.removed) && integer(step.order) && !stepOrders.has(step.order)); stepOrders.add(step.order)
      }
      require(round.record === null || (object(round.record) && (validateRecord(round.record, s.seats), true)))
      require(round.nextRound === null || (object(round.nextRound) && strings(round.nextRound.potIds) && round.nextRound.potIds.length > 0 && round.nextRound.potIds.every((id: string) => potIds.has(id))))
    } else require(strings(round.potIds) && round.potIds.length > 0 && round.potIds.every((id: string) => potIds.has(id)) && integer(round.iteration) && typeof round.sidesEvaluated === 'boolean')
  }
  const historyIds = new Set<string>()
  for (const record of s.history) {
    require(object(record) && !historyIds.has(record.roundId)); historyIds.add(record.roundId)
    validateRecord(record, s.seats)
  }
  for (const [key, record] of Object.entries(s.processedCommands) as Array<[string, any]>) {
    require(object(record) && text(record.fingerprint) && object(record.outcome))
    const command = JSON.parse(record.fingerprint), space = JSON.parse(key), outcome = record.outcome
    require(Array.isArray(space) && (space[0] === 'p' ? space.length === 3 && text(space[1]) && text(space[2]) && participantTypes.includes(command.type) && command.playerId === space[1] :
      space[0] === 's' && space.length === 2 && text(space[1]) && systemTypes.includes(command.type)))
    require(command.commandId === key && outcome.commandId === key && outcome.type === command.type && strings(outcome.completedRounds))
    require(outcome.ledgerSeqFrom === null ? outcome.ledgerSeqTo === null : integer(outcome.ledgerSeqFrom) && outcome.ledgerSeqFrom > 0 &&
      integer(outcome.ledgerSeqTo) && outcome.ledgerSeqTo >= outcome.ledgerSeqFrom && outcome.ledgerSeqTo <= s.ledger.length)
    if (outcome.ledgerSeqFrom !== null) for (let i = outcome.ledgerSeqFrom - 1; i < outcome.ledgerSeqTo; i++) require(s.ledger[i]?.commandId === key)
  }
  for (const entry of s.ledger) require(object(entry) && ledgerTypes.includes(entry.type) && text(entry.from) && text(entry.to) &&
    text(entry.commandId) && Object.hasOwn(s.processedCommands, entry.commandId) && (entry.roundId === null || text(entry.roundId)) &&
    (entry.potId === null || text(entry.potId)) && (entry.playerId === null || member(entry.playerId, s.seats)))
}

/** Full untrusted-disk validation for import; the lighter mode is for engine-validated writes. */
export function validateSvaraStoredMatch(value: unknown, full = true): asserts value is SvaraStoredMatch {
  try {
    require(object(value) && value.formatVersion === 1 && text(value.matchId) && value.matchId.length <= 64 && object(value.state))
    const snapshot = value as SvaraStoredMatch, state = snapshot.state
    require(object(state.config) && state.config.tableId === snapshot.matchId && ['lobby', 'in-progress', 'finished', 'closed'].includes(state.phase))
    require(integer(snapshot.revision) && object(state.processedCommands) && Object.keys(state.processedCommands).length === snapshot.revision)
    require(integer(snapshot.deadlineSequence) && Array.isArray(snapshot.deadlines))
    if (full) validateStructure(state)
    assertSvaraMatchInvariants(state)
    const kinds = new Set<string>(), generations = new Set<number>(), view = describeSvaraLifecycle(state)
    for (const d of snapshot.deadlines) {
      require(object(d) && state.phase === 'in-progress' && d.phase === 'in-progress' && ['dealing', 'turn', 'svara-joining', 'presence-wait', 'reveal-choice', 'reveal-display', 'showdown-display', 'payout-display'].includes(d.kind) && !kinds.has(d.kind))
      require(text(d.key) && integer(d.deadlineAt) && d.deadlineAt > 0 && integer(d.generation) && d.generation > 0 && d.generation <= snapshot.deadlineSequence && !generations.has(d.generation))
      require(integer(d.baseRevision) && d.baseRevision <= snapshot.revision && integer(d.actionVersion) && (d.roundId === null || text(d.roundId)))
      require(d.playerId === (d.kind === 'turn' ? view.actorId : d.kind === 'presence-wait' ? view.readyPlayerIds[0] ?? null
        : d.kind === 'reveal-choice' || d.kind === 'reveal-display' ? view.revealChoice?.winnerId ?? null : null))
      if (d.kind === 'dealing' || d.kind === 'turn' || d.kind === 'svara-joining' || d.kind === 'reveal-choice' || d.kind === 'reveal-display' || d.kind === 'showdown-display' || d.kind === 'payout-display') {
        require(d.roundId === view.roundId && d.actionVersion === view.actionVersion)
      }
      kinds.add(d.kind); generations.add(d.generation)
    }
    const expected = planSvaraDeadlines(state, snapshot.revision, snapshot.deadlines, snapshot.deadlineSequence, 0)
    require(expected.deadlineSequence === snapshot.deadlineSequence && JSON.stringify(expected.deadlines) === JSON.stringify(snapshot.deadlines))
  } catch { throw new SvaraPersistenceError('invalid-snapshot') }
}
