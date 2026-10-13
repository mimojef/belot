/**
 * checkDeclarationSquareOverlap.ts
 *
 * Регресия: каре + терца/50/100 с обща карта.
 *
 * Потвърден дефект: бот (вкл. човек, поет от бот) обявява каре при
 * startServerPlayingPhase (createBotOpeningDeclarations). При първия му ход
 * getServerDefaultDeclarationKeysForPlay филтрираше само СЪЩИЯ key, затова
 * терца/50/100, споделяща карта с карето, оставаше като кандидат и се
 * подаваше; validateServerDeclarationKeysForPlay проверяваше застъпване само
 * в рамките на новото подаване -> и двете обяви се записваха като valid и
 * участваха в сравнението/точкуването.
 *
 *  [1] Каре + терца с обща карта  -> само каре (бот start+ход), точки само от карето
 *  [2] Каре + 50 с обща карта     -> само каре
 *  [3] Каре + 100 с обща карта    -> само каре
 *  [4] Каре + терца без общи карти -> и двете
 *  [5] Няколко поредици, една застъпва карето -> застъпващата се отхвърля, другата остава
 *      (в 8-картова ръка е невъзможно; проверено на ниво conflict helpers)
 *  [6] Различни рангове карета (J/9/A/K/10) и договори (all-trumps, suit, no-trumps)
 *  [7] Човешко подаване на застъпваща терца след вече записано каре -> отхвърлено
 *  [8] Паритет клиент/сървър: попапът маркира по подразбиране същите keys,
 *      които сървърът избира
 *
 * Usage: npx tsx scripts/checkDeclarationSquareOverlap.ts
 */

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkDeclarationSquareOverlap ═══')

const { getServerDefaultDeclarationKeysForPlay } = await import('../src/game/advanceExpiredServerPlayingState.js')
const { submitServerPlayCard, validateServerDeclarationKeysForPlay } = await import('../src/game/submitServerPlayCard.js')
const { startServerPlayingPhase } = await import('../src/game/startServerPlayingPhase.js')
const { scoreServerDeclarations } = await import('../src/game/declarations/scoreServerDeclarations.js')
const {
  detectServerDeclarationsInHand,
  excludeCandidatesOverlappingDeclared,
  resolveServerDeclarationConflicts,
} = await import('../src/game/declarations/index.js')
const { createServerDeclarationRecord } = await import('../src/game/serverDeclarationRecordHelpers.js')
const { detectClientDeclarationCandidates } = await import('../../src/app/activeRoom/declarations/detectClientDeclarationCandidates.js')
const { createPendingDeclarationPrompt } = await import('../../src/app/activeRoom/declarations/declarationPromptState.js')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }
type Contract = { contract: 'suit' | 'all-trumps' | 'no-trumps'; trumpSuit: Suit | null }

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const card = (suit: Suit, rank: Rank): Card => ({ id: `${suit}-${rank}`, suit, rank })
const square = (rank: Rank): Card[] => (['clubs', 'diamonds', 'hearts', 'spades'] as Suit[]).map((s) => card(s, rank))
const zero = () => ({ teamA: 0, teamB: 0 })

function makeState(hand: Card[], contract: Contract, opts: { botBottom: boolean; existing?: any[] }): any {
  return {
    phase: 'playing',
    players: Object.fromEntries(SEATS.map((s) => [s, {
      seat: s, team: s === 'bottom' || s === 'top' ? 'A' : 'B',
      mode: s === 'bottom' && !opts.botBottom ? 'human' : 'bot',
      controlledByBot: s === 'bottom' ? opts.botBottom : true,
    }])),
    round: { dealerSeat: 'left', cutterSeat: 'top', firstBidderSeat: 'bottom', firstDealSeat: 'bottom', selectedCutIndex: null },
    deck: [],
    hands: { bottom: hand, right: [card('clubs', '8')], top: [card('diamonds', '7')], left: [card('spades', '7')] },
    bidding: {
      entries: [], currentSeat: null,
      winningBid: { seat: 'bottom', contract: contract.contract, trumpSuit: contract.trumpSuit, doubled: false, redoubled: false },
      hasStarted: true, hasEnded: true, consecutivePasses: 0,
    },
    declarations: opts.existing ?? [],
    matchDeclarationMissionCounts: Object.fromEntries(['announce_tersa', 'announce_50', 'announce_100', 'announce_kare', 'announce_belot'].map((k) => [k, zero()])),
    matchDeclarationMissionCountsBySeat: {},
    playing: null, scoring: null, matchEnded: null,
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    score: { round: {}, match: zero(), carryOver: zero() },
  }
}

/** Реалният бот път: обяви при старта на playing фазата + обяви при първия ход (trick 0). */
function botDeclarationsAfterFirstTrickTurn(hand: Card[], contract: Contract, playCardId: string): any[] {
  const started = startServerPlayingPhase(makeState(hand, contract, { botBottom: true }))
  const playCard = started.hands.bottom.find((c: Card) => c.id === playCardId)
  assert(playCard !== undefined, `play card ${playCardId} not in hand`)
  const keys = getServerDefaultDeclarationKeysForPlay(started, 'bottom', playCard)
  const validation = validateServerDeclarationKeysForPlay(started, 'bottom', playCardId, keys)
  assert(validation.ok, `default keys must validate: ${JSON.stringify(validation)}`)
  const after = submitServerPlayCard(started, 'bottom', playCardId, keys)
  return after.declarations.filter((d: any) => d.seat === 'bottom')
}

const labels = (declarations: any[]) => declarations.map((d) => d.publicLabel).sort()
function assertNoSharedCards(declarations: any[]): void {
  const nonBelote = declarations.filter((d) => d.type !== 'belote')
  const seen = new Set<string>()
  for (const d of nonBelote) for (const id of d.cardIds) {
    assert(!seen.has(id), `card ${id} is used by two recognized declarations: ${JSON.stringify(nonBelote.map((x) => [x.publicLabel, x.cardIds]))}`)
    seen.add(id)
  }
}

const ALL_TRUMPS: Contract = { contract: 'all-trumps', trumpSuit: null }

// ─── [1]–[3] каре + поредица с обща карта ───
const overlapCases: Array<{ label: string; hand: Card[]; play: string; sequenceLabel: string }> = [
  { label: '[1] Каре дами + терца J-Q-K♥ (обща Q♥)', hand: [...square('Q'), card('hearts', 'J'), card('hearts', 'K'), card('clubs', '7'), card('diamonds', '8')], play: 'clubs-7', sequenceLabel: 'Терца' },
  { label: '[2] Каре дами + 50 10-J-Q-K♥ (обща Q♥)', hand: [...square('Q'), card('hearts', '10'), card('hearts', 'J'), card('hearts', 'K'), card('clubs', '7')], play: 'clubs-7', sequenceLabel: '50' },
  { label: '[3] Каре дами + 100 9-10-J-Q-K♥ (обща Q♥)', hand: [...square('Q'), card('hearts', '9'), card('hearts', '10'), card('hearts', 'J'), card('hearts', 'K')], play: 'hearts-9', sequenceLabel: '100' },
]

for (const c of overlapCases) {
  await check(`${c.label}: детекцията намира и двете, но се признава само карето`, () => {
    const detected = detectServerDeclarationsInHand(c.hand as any, ALL_TRUMPS as any)
    assert(detected.some((d) => d.publicLabel === c.sequenceLabel) && detected.some((d) => d.type === 'square'), 'detector must still find both candidates')
    const declared = botDeclarationsAfterFirstTrickTurn(c.hand, ALL_TRUMPS, c.play)
    assert(JSON.stringify(labels(declared)) === JSON.stringify(['Каре']), `expected only Каре, got ${JSON.stringify(labels(declared))}`)
    assertNoSharedCards(declared)
  })

  await check(`${c.label}: точкуването брои само карето (100), без поредицата`, () => {
    const declared = botDeclarationsAfterFirstTrickTurn(c.hand, ALL_TRUMPS, c.play)
    const score = scoreServerDeclarations(declared)
    assert(score.declarationPoints.teamA === 100 && score.declarationPoints.teamB === 0, `expected 100/0, got ${JSON.stringify(score.declarationPoints)}`)
  })
}

// ─── [4] каре + поредица без общи карти ───
await check('[4] Каре дами + терца 7-8-9♥ (без общи карти) -> и двете се признават, 100 + 20', () => {
  const hand = [...square('Q'), card('hearts', '7'), card('hearts', '8'), card('hearts', '9'), card('clubs', 'A')]
  const declared = botDeclarationsAfterFirstTrickTurn(hand, ALL_TRUMPS, 'clubs-A')
  assert(JSON.stringify(labels(declared)) === JSON.stringify(['Каре', 'Терца']), `expected Каре + Терца, got ${JSON.stringify(labels(declared))}`)
  assertNoSharedCards(declared)
  const score = scoreServerDeclarations(declared)
  assert(score.declarationPoints.teamA === 120, `expected 120, got ${JSON.stringify(score.declarationPoints)}`)
})

// ─── [5] няколко поредици, една застъпва карето (conflict helper ниво) ───
await check('[5] Няколко поредици, само една застъпва карето -> отхвърля се само тя', () => {
  // 9-картова "ръка" само за да съществуват и двете поредици едновременно с карето.
  const hand = [...square('Q'), card('hearts', 'J'), card('hearts', 'K'), card('clubs', '7'), card('clubs', '8'), card('clubs', '9')]
  const detected = detectServerDeclarationsInHand(hand as any, ALL_TRUMPS as any)
  const resolved = resolveServerDeclarationConflicts(detected)
  const selected = resolved.selectedCandidates.filter((d) => d.type !== 'belote').map((d) => `${d.publicLabel}:${d.privateMetadata.suit ?? ''}`).sort()
  assert(JSON.stringify(selected) === JSON.stringify(['Каре:', 'Терца:clubs']), `single submission: got ${JSON.stringify(selected)}`)
  // Същото, когато карето вече е записано (бот старт), а поредиците идват при хода:
  const squareCandidate = detected.find((d) => d.type === 'square')!
  const sequences = detected.filter((d) => d.type === 'sequence')
  const remaining = excludeCandidatesOverlappingDeclared(sequences, [squareCandidate]).map((d) => d.privateMetadata.suit)
  assert(JSON.stringify(remaining) === JSON.stringify(['clubs']), `after recorded square: got ${JSON.stringify(remaining)}`)
})

// ─── [6] различни рангове и договори ───
const rankCases: Array<{ rank: Rank; points: number; hand: Card[]; play: string }> = [
  { rank: 'J', points: 200, hand: [...square('J'), card('hearts', '10'), card('hearts', 'Q'), card('clubs', '7'), card('diamonds', '8')], play: 'clubs-7' },
  { rank: '9', points: 150, hand: [...square('9'), card('spades', '7'), card('spades', '8'), card('clubs', 'A'), card('diamonds', 'K')], play: 'clubs-A' },
  { rank: 'A', points: 100, hand: [...square('A'), card('diamonds', 'Q'), card('diamonds', 'K'), card('clubs', '7'), card('hearts', '8')], play: 'clubs-7' },
  { rank: '10', points: 100, hand: [...square('10'), card('clubs', '8'), card('clubs', '9'), card('clubs', 'J'), card('hearts', '7')], play: 'hearts-7' },
]
const contracts: Array<{ label: string; contract: Contract }> = [
  { label: 'all-trumps', contract: ALL_TRUMPS },
  { label: 'suit ♥', contract: { contract: 'suit', trumpSuit: 'hearts' } },
  { label: 'suit ♣', contract: { contract: 'suit', trumpSuit: 'clubs' } },
]
for (const rc of rankCases) {
  for (const ct of contracts) {
    await check(`[6] Каре ${rc.rank} (${rc.points}) + застъпваща поредица, ${ct.label} -> само карето`, () => {
      const declared = botDeclarationsAfterFirstTrickTurn(rc.hand, ct.contract, rc.play)
      assert(JSON.stringify(labels(declared)) === JSON.stringify(['Каре']), `expected only Каре, got ${JSON.stringify(labels(declared))}`)
      assertNoSharedCards(declared)
      const score = scoreServerDeclarations(declared)
      assert(score.declarationPoints.teamA === rc.points, `expected ${rc.points}, got ${JSON.stringify(score.declarationPoints)}`)
    })
  }
}
await check('[6] no-trumps -> няма обяви (каре/поредици не се обявяват)', () => {
  const declared = botDeclarationsAfterFirstTrickTurn(overlapCases[0]!.hand, { contract: 'no-trumps', trumpSuit: null }, 'clubs-7')
  assert(declared.length === 0, `expected no declarations, got ${JSON.stringify(labels(declared))}`)
})

// ─── [7] човешко подаване на застъпваща терца след записано каре ───
await check('[7] Човек подава терца, застъпваща вече записано каре -> сървърът я отхвърля', () => {
  const hand = overlapCases[0]!.hand
  const detected = detectServerDeclarationsInHand(hand as any, ALL_TRUMPS as any)
  const squareRecord = createServerDeclarationRecord({ candidate: detected.find((d) => d.type === 'square')!, seat: 'bottom', declaredAtTrickIndex: 0 })
  const started = startServerPlayingPhase(makeState(hand, ALL_TRUMPS, { botBottom: false, existing: [squareRecord] }))
  const terca = detected.find((d) => d.publicLabel === 'Терца')!
  const result = validateServerDeclarationKeysForPlay(started, 'bottom', 'clubs-7', [terca.key])
  assert(!result.ok, `overlapping terca must be rejected, got ${JSON.stringify(result).slice(0, 160)}`)
  // Непокриваща поредица (друг сценарий) остава приемана:
  const hand4 = [...square('Q'), card('hearts', '7'), card('hearts', '8'), card('hearts', '9'), card('clubs', 'A')]
  const detected4 = detectServerDeclarationsInHand(hand4 as any, ALL_TRUMPS as any)
  const squareRecord4 = createServerDeclarationRecord({ candidate: detected4.find((d) => d.type === 'square')!, seat: 'bottom', declaredAtTrickIndex: 0 })
  const started4 = startServerPlayingPhase(makeState(hand4, ALL_TRUMPS, { botBottom: false, existing: [squareRecord4] }))
  const ok = validateServerDeclarationKeysForPlay(started4, 'bottom', 'clubs-A', [detected4.find((d) => d.publicLabel === 'Терца')!.key])
  assert(ok.ok, `non-overlapping terca must stay accepted, got ${JSON.stringify(ok).slice(0, 160)}`)
})

// ─── [8] паритет клиент/сървър ───
await check('[8] Попапът по подразбиране маркира същите keys, които сървърът избира (без застъпване)', () => {
  for (const c of [...overlapCases, { label: 'disjoint', hand: [...square('Q'), card('hearts', '7'), card('hearts', '8'), card('hearts', '9'), card('clubs', 'A')], play: 'clubs-A', sequenceLabel: 'Терца' }]) {
    const serverKeys = resolveServerDeclarationConflicts(
      detectServerDeclarationsInHand(c.hand as any, ALL_TRUMPS as any).filter((d) => d.type !== 'belote'),
    ).selectedCandidates.map((d) => d.key).sort()
    const clientCandidates = detectClientDeclarationCandidates(c.hand as any, ALL_TRUMPS as any).filter((d: any) => d.type !== 'belote')
    const clientKeys = [...createPendingDeclarationPrompt({ cardId: c.play, candidates: clientCandidates }).selectedKeys].sort()
    assert(JSON.stringify(serverKeys) === JSON.stringify(clientKeys), `${c.label}: server ${JSON.stringify(serverKeys)} vs client ${JSON.stringify(clientKeys)}`)
  }
})

// ═══ Връщане на играч, поет от бот ("Върни се") + reconnect ═══════════════
//
// Клиентът научава вече записаните обяви на собственото място от
// game.ownDeclarationKeys (само за собственика) и ги подава като
// submittedDeclarationKeys в resolveClientDeclarationCandidatesForPlay —
// реалния helper на renderPlayingScreen (при reconnect cache е празен, затова
// се ползват САМО ключовете от snapshot-а).

const { createRoomSnapshotMessage, createSpectatorRoomSnapshotMessage } = await import('../src/protocol/createRoomSnapshotMessage.js')
const { resolveClientDeclarationCandidatesForPlay } = await import('../../src/app/activeRoom/declarations/declarationPromptState.js')

function makeRoom(authoritativeState: any): any {
  const participant = (seat: Seat) => ({
    kind: 'human', playerId: `player-${seat}`, connectionId: `conn-${seat}`, isConnected: true, joinedAt: 1, lastSeenAt: 1,
    reconnectToken: `token-${seat}`, permanentlyLeftAt: null,
    identity: { accountId: null, profileId: `profile-${seat}`, username: null, displayName: `P ${seat}`, avatarUrl: null, level: 1, rankTitle: null, skillRating: null, gender: 'male' },
  })
  return {
    id: 'room-declaration-return', status: 'playing', createdAt: 1, updatedAt: 1, hostPlayerId: null,
    config: { maxPlayers: 4, allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 5000, targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 60000, isPrivateTableOrigin: true },
    seats: Object.fromEntries(SEATS.map((seat) => [seat, { seat, team: seat === 'bottom' || seat === 'top' ? 'A' : 'B', participant: participant(seat) }])),
    game: { phase: 'playing', stateVersion: 1, startedAt: 1, updatedAt: 1, activeTimerId: null, timerDeadlineAt: Date.now() + 15000, authoritativeState },
    replayVotes: [], leaveVotes: [],
  }
}

/** Бот обявява при старта; после играчът натиска "Върни се" (мястото вече не е бот). */
function returnedAfterBotStart(hand: Card[]): any {
  const started = startServerPlayingPhase(makeState(hand, ALL_TRUMPS, { botBottom: true }))
  return {
    ...started,
    players: { ...started.players, bottom: { ...started.players.bottom, mode: 'human', controlledByBot: false } },
  }
}

/** Точно каквото прави renderPlayingScreen: локален cache + game.ownDeclarationKeys. */
function clientCandidatesFromSnapshot(snapshot: any, cardId: string, localCacheKeys: string[]): any[] {
  const game = snapshot.game
  return resolveClientDeclarationCandidatesForPlay({
    hand: game.ownHand,
    contract: snapshot.game.bidding?.winningBid ?? ALL_TRUMPS,
    cardId,
    completedTricksCount: 0,
    currentTrickPlays: [],
    submittedDeclarationKeys: [...new Set([...localCacheKeys, ...(game.ownDeclarationKeys ?? [])])],
  })
}

const OVERLAP_HAND = overlapCases[0]!.hand // каре дами + терца J-Q-K♥ (обща Q♥)

await check('[9] ownDeclarationKeys: собственикът получава записаното от бота каре; другите места и spectator — []', () => {
  const state = returnedAfterBotStart(OVERLAP_HAND)
  const room = makeRoom(state)
  const squareKey = state.declarations.find((d: any) => d.seat === 'bottom' && d.type === 'square')!.key
  const owner = createRoomSnapshotMessage(room, 'bottom')
  assert(JSON.stringify(owner.game!.ownDeclarationKeys) === JSON.stringify([squareKey]), `owner keys: ${JSON.stringify(owner.game!.ownDeclarationKeys)}`)
  const ownIds = new Set(owner.game!.ownHand.map((c: any) => c.id))
  for (const key of owner.game!.ownDeclarationKeys) {
    for (const id of key.split(':').pop()!.split(',')) assert(ownIds.has(id), `owner key references a card outside ownHand: ${id}`)
  }
  for (const viewer of ['right', 'top', 'left'] as Seat[]) {
    const keys = createRoomSnapshotMessage(room, viewer).game!.ownDeclarationKeys
    assert(Array.isArray(keys) && keys.length === 0, `${viewer} must not receive bottom's keys: ${JSON.stringify(keys)}`)
    assert(!JSON.stringify(createRoomSnapshotMessage(room, viewer)).includes(squareKey), `${viewer}: square key leaked somewhere in payload`)
  }
  const spectator = createSpectatorRoomSnapshotMessage(room)
  assert(Array.isArray(spectator.game!.ownDeclarationKeys) && spectator.game!.ownDeclarationKeys.length === 0, 'spectator ownDeclarationKeys must be []')
  assert(!JSON.stringify(spectator).includes(squareKey), 'spectator: square key leaked')
})

await check('[10] "Върни се" след бот-каре (и reconnect с празен cache): попапът няма нито карето, нито застъпващата терца -> ходът минава', () => {
  const state = returnedAfterBotStart(OVERLAP_HAND)
  const snapshot = createRoomSnapshotMessage(makeRoom(state), 'bottom')
  // reconnect: локалният cache е празен -> разчитаме само на snapshot-а
  const candidates = clientCandidatesFromSnapshot(snapshot, 'clubs-7', [])
  assert(candidates.length === 0, `expected no prompt options, got ${JSON.stringify(candidates.map((c: any) => c.publicLabel))}`)
  // Без попап клиентът подава [] — сървърът приема хода и не дублира/застъпва обяви.
  const validation = validateServerDeclarationKeysForPlay(state, 'bottom', 'clubs-7', [])
  assert(validation.ok, `play must be accepted: ${JSON.stringify(validation)}`)
  const after = submitServerPlayCard(state, 'bottom', 'clubs-7', [])
  assert(JSON.stringify(labels(after.declarations.filter((d: any) => d.seat === 'bottom'))) === JSON.stringify(['Каре']), 'only the bot-recorded Каре must remain')
})

await check('[11] Без поправката клиентът би предложил отново карето -> сървърът отказва хода (доказва нуждата от ownDeclarationKeys)', () => {
  const state = returnedAfterBotStart(OVERLAP_HAND)
  const snapshot = createRoomSnapshotMessage(makeRoom(state), 'bottom')
  const legacy = resolveClientDeclarationCandidatesForPlay({
    hand: snapshot.game!.ownHand as any, contract: ALL_TRUMPS as any, cardId: 'clubs-7', completedTricksCount: 0, currentTrickPlays: [], submittedDeclarationKeys: [],
  })
  const legacyDefault = createPendingDeclarationPrompt({ cardId: 'clubs-7', candidates: legacy }).selectedKeys
  const result = validateServerDeclarationKeysForPlay(state, 'bottom', 'clubs-7', legacyDefault)
  assert(!result.ok, `the old client default (re-submitting the square) must be rejected by the server, got ${JSON.stringify(result).slice(0, 120)}`)
})

await check('[12] "Върни се" след бот-каре + НЕзастъпваща терца в ръката -> терцата е вече записана от бота, нищо не се предлага', () => {
  const hand = [...square('Q'), card('hearts', '7'), card('hearts', '8'), card('hearts', '9'), card('clubs', 'A')]
  const state = returnedAfterBotStart(hand)
  assert(JSON.stringify(labels(state.declarations.filter((d: any) => d.seat === 'bottom'))) === JSON.stringify(['Каре', 'Терца']), 'bot records both at start')
  const candidates = clientCandidatesFromSnapshot(createRoomSnapshotMessage(makeRoom(state), 'bottom'), 'clubs-A', [])
  assert(candidates.length === 0, `already recorded declarations must not be offered again: ${JSON.stringify(candidates.map((c: any) => c.publicLabel))}`)
})

await check('[13] Нормален човек (без бот): попапът маркира карето, терцата не е маркирана; Белот по-късно остава достъпен', () => {
  const state = startServerPlayingPhase(makeState(OVERLAP_HAND, ALL_TRUMPS, { botBottom: false }))
  const snapshot = createRoomSnapshotMessage(makeRoom(state), 'bottom')
  assert(snapshot.game!.ownDeclarationKeys.length === 0, 'nothing recorded yet for a human seat')
  const candidates = clientCandidatesFromSnapshot(snapshot, 'clubs-7', [])
  const prompt = createPendingDeclarationPrompt({ cardId: 'clubs-7', candidates })
  const selectedLabels = candidates.filter((c: any) => prompt.selectedKeys.includes(c.key)).map((c: any) => c.publicLabel)
  assert(JSON.stringify(selectedLabels) === JSON.stringify(['Каре']), `default selection: ${JSON.stringify(selectedLabels)}`)
  assert(candidates.some((c: any) => c.publicLabel === 'Терца'), 'terca is still visible as an (unchecked, disabled) option')
  const validation = validateServerDeclarationKeysForPlay(state, 'bottom', 'clubs-7', prompt.selectedKeys)
  assert(validation.ok, `human default submission must validate: ${JSON.stringify(validation).slice(0, 120)}`)
  // По-късно: Белот Q♥+K♥ споделя Q♥ с карето — изключението за Белот е запазено.
  const squareKey = prompt.selectedKeys[0]!
  const later = resolveClientDeclarationCandidatesForPlay({
    hand: OVERLAP_HAND as any, contract: ALL_TRUMPS as any, cardId: 'hearts-K', completedTricksCount: 1, currentTrickPlays: [], submittedDeclarationKeys: [squareKey],
  })
  assert(later.some((c: any) => c.type === 'belote'), `belote must stay available after the square: ${JSON.stringify(later.map((c: any) => c.publicLabel))}`)
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
