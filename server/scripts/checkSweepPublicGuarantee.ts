/**
 * checkSweepPublicGuarantee.ts
 *
 * „Долу картите“ — гаранция от гледна точка на заявяващия
 * (computeServerSweepPublicGuarantee.ts). Допълва checkSweepDownTheCards.ts
 * (той пази старите сценарии: отказ, повторна проверка, белоти, точки, капо).
 *
 *  [P*] production регресия 23.11.2026 10:01:16 (коз ♠)
 *  [S*] сигурни предложения при публично доказуема гаранция
 *  [R*] един коз + силна некозова карта ≠ гаранция при възможно цакане;
 *       всички законни първи ходове, без предположение „първо коз“
 *  [C*] договори: коз / без коз / всичко коз
 *  [G*] лимит → fail-safe false
 *  [X]  кръстосана проверка срещу ДЕФИНИЦИЯТА (изброяване на всички
 *       разпределения + пълна валидация на историята + double-dummy)
 *  [B]  производителност върху случайни законни раздавания
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

console.log('\n═══ checkSweepPublicGuarantee ═══')

const { computeServerSweepEligibility, computeServerSweepEligibilityOutcome, legalCardsFor } = await import(
  '../src/game/computeServerSweepEligibility.js'
)
const { computeServerSweepPublicGuaranteeOutcome, computeServerSweepOfferEligibility } = await import(
  '../src/game/computeServerSweepPublicGuarantee.js'
)
const { getServerTrickWinner } = await import('../src/game/getServerTrickWinner.js')
const { submitServerPlayCard } = await import('../src/game/submitServerPlayCard.js')
const { submitServerSweepDecision } = await import('../src/game/submitServerSweepDecision.js')

type Seat = 'bottom' | 'right' | 'top' | 'left'
type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
type Card = { id: string; suit: Suit; rank: Rank }
type Play = { seat: Seat; card: Card }
type Contract = 'suit' | 'no-trumps' | 'all-trumps'
type Bid = { seat: Seat; contract: Contract; trumpSuit: Suit | null; doubled: boolean; redoubled: boolean }

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANKS: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SUIT_BY_LETTER: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' }

const nextSeat = (seat: Seat): Seat => SEATS[(SEATS.indexOf(seat) + 1) % 4]!
const teamOf = (seat: Seat): 'A' | 'B' => (seat === 'bottom' || seat === 'top' ? 'A' : 'B')

// 'sJ' → ♠J, 'c10' → ♣10 (id като в createServerDeck: `${suit}-${rank}`).
function c(code: string): Card {
  const suit = SUIT_BY_LETTER[code[0]!]!
  const rank = code.slice(1) as Rank
  return { id: `${suit}-${rank}`, suit, rank }
}
const cs = (codes: string): Card[] => codes.split(' ').filter(Boolean).map(c)

function bid(contract: Contract, trumpSuit: Suit | null = null, seat: Seat = 'bottom'): Bid {
  return { seat, contract, trumpSuit: contract === 'suit' ? trumpSuit : null, doubled: false, redoubled: false }
}

// Взятка в компактен запис: водещ + 4 карти по реда на игра.
function trick(leader: Seat, codes: string): Play[] {
  const cards = cs(codes)
  assert(cards.length === 4, `fixture: trick needs 4 cards: ${codes}`)
  let seat = leader
  return cards.map((card) => {
    const play = { seat, card }
    seat = nextSeat(seat)
    return play
  })
}

function toCompleted(tricks: Play[][], winningBid: Bid): any[] {
  return tricks.map((plays, trickIndex) => {
    const winner = getServerTrickWinner(plays as any, winningBid as any)!
    return {
      trickIndex,
      leaderSeat: plays[0]!.seat,
      plays,
      winnerSeat: winner.seat,
      winningTeam: teamOf(winner.seat as Seat),
    }
  })
}

// Историята трябва да е законна по production валидатора при ПЪЛНИТЕ ръце
// (финални + изиграните по-късно) и водещият да е победителят от предишната.
function assertLegalHistory(finalHands: Record<Seat, Card[]>, tricks: Play[][], winningBid: Bid): void {
  const hands: Record<Seat, Card[]> = { bottom: [], right: [], top: [], left: [] }
  for (const seat of SEATS) hands[seat] = [...finalHands[seat]]
  for (const plays of tricks) for (const play of plays) hands[play.seat].push(play.card)
  const all = SEATS.flatMap((seat) => hands[seat].map((card) => card.id))
  assert(new Set(all).size === all.length, 'fixture: duplicate card')
  for (const seat of SEATS) assert(hands[seat].length === 8 || tricks.length === 0, `fixture: ${seat} has ${hands[seat].length} cards`)
  let expectedLeader: Seat | null = null
  for (const plays of tricks) {
    if (expectedLeader !== null) assert(plays[0]!.seat === expectedLeader, `fixture: wrong leader ${plays[0]!.seat}`)
    for (let k = 0; k < 4; k += 1) {
      const play = plays[k]!
      const legal = legalCardsFor(play.seat, hands[play.seat] as any, plays.slice(0, k) as any, winningBid as any)
      assert(legal.some((x: any) => x.id === play.card.id), `fixture: illegal ${play.seat} ${play.card.id}`)
      hands[play.seat] = hands[play.seat].filter((x) => x.id !== play.card.id)
    }
    expectedLeader = getServerTrickWinner(plays as any, winningBid as any)!.seat as Seat
  }
}

function emptyRoundScore() {
  return { teamA: 0, teamB: 0 }
}

function baseState(params: {
  hands: Record<Seat, Card[]>
  winningBid: Bid
  completedTricks: any[]
  currentTrick?: any
  currentTurnSeat?: Seat | null
  sweepOffer?: any
  declarations?: any[]
}): any {
  const { hands, winningBid, completedTricks, sweepOffer = null, declarations = [] } = params
  const currentTrick = params.currentTrick ?? {
    leaderSeat: null,
    currentSeat: null,
    plays: [],
    winnerSeat: null,
    trickIndex: completedTricks.length,
  }
  const wonTricksBySeat: Record<Seat, Card[][]> = { bottom: [], right: [], top: [], left: [] }
  const wonTricksByTeam: Record<'A' | 'B', Card[][]> = { A: [], B: [] }
  for (const t of completedTricks) {
    const trickCards = t.plays.map((p: Play) => p.card)
    wonTricksBySeat[t.winnerSeat as Seat].push(trickCards)
    wonTricksByTeam[t.winningTeam as 'A' | 'B'].push(trickCards)
  }
  const breakdown = { tricks: emptyRoundScore(), declarations: emptyRoundScore(), belote: emptyRoundScore(), total: emptyRoundScore() }
  return {
    phase: 'playing',
    phaseEnteredAt: Date.now(),
    targetScore: 151,
    players: Object.fromEntries(SEATS.map((seat) => [seat, { seat, team: teamOf(seat), mode: 'human', controlledByBot: false }])),
    round: { dealerSeat: 'left', cutterSeat: 'top', firstBidderSeat: 'bottom', firstDealSeat: 'bottom', selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations,
    matchDeclarationMissionCounts: {},
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: params.currentTurnSeat ?? null,
      currentTrick,
      completedTricks,
      lastCompletedTrickWinnerSeat: completedTricks.at(-1)?.winnerSeat ?? null,
      lastCompletedTrickWinnerTeam: completedTricks.at(-1)?.winningTeam ?? null,
      wonTricksBySeat,
      wonTricksByTeam,
      sweepOffer,
      declinedSweepSeats: [],
      sweepResolution: null,
    },
    scoring: null,
    matchEnded: null,
    score: { round: breakdown, match: emptyRoundScore(), carryOver: { teamA: 0, teamB: 0 } },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

type Fixture = { finalHands: Record<Seat, Card[]>; tricks: Play[][]; winningBid: Bid }

function publicOutcome(sweepSeat: Seat, fx: Fixture, options: { maxNodes?: number } = {}) {
  return computeServerSweepPublicGuaranteeOutcome(
    {
      sweepSeat,
      hands: fx.finalHands as any,
      winningBid: fx.winningBid as any,
      publicInfo: { completedTricks: toCompleted(fx.tricks, fx.winningBid), currentTrickPlays: [], declarations: [] },
    },
    options,
  )
}
function doubleDummy(sweepSeat: Seat, hands: Record<Seat, Card[]>, winningBid: Bid): boolean {
  return computeServerSweepEligibility({ sweepSeat, hands: hands as any, winningBid: winningBid as any })
}

// Края на последната взятка през production пътя submitServerPlayCard:
// всички взятки без последния ход са история, последният ход се изпраща.
function completeLastTrickViaEngine(fx: Fixture): any {
  const last = fx.tricks.at(-1)!
  const lastPlay = last[3]!
  const hands: Record<Seat, Card[]> = { bottom: [], right: [], top: [], left: [] }
  for (const seat of SEATS) hands[seat] = [...fx.finalHands[seat]]
  hands[lastPlay.seat].push(lastPlay.card)
  const completedTricks = toCompleted(fx.tricks.slice(0, -1), fx.winningBid)
  const state = baseState({
    hands,
    winningBid: fx.winningBid,
    completedTricks,
    currentTrick: {
      leaderSeat: last[0]!.seat,
      currentSeat: lastPlay.seat,
      plays: last.slice(0, 3),
      winnerSeat: null,
      trickIndex: completedTricks.length,
    },
    currentTurnSeat: lastPlay.seat,
  })
  return submitServerPlayCard(state, lastPlay.seat, lastPlay.card.id)
}

// Състояние с вече съществуващо предложение (или подправено) — за OK пътя.
function stateWithOffer(sweepSeat: Seat, fx: Fixture): any {
  const completedTricks = toCompleted(fx.tricks, fx.winningBid)
  return baseState({
    hands: fx.finalHands,
    winningBid: fx.winningBid,
    completedTricks,
    sweepOffer: { seat: sweepSeat, offeredAtTrickIndex: completedTricks.length, expiresAt: Date.now() + 15000 },
  })
}

// ─── [P] Production 23.11.2026 10:01:16 ──────────────────────────────────
// Коз ♠. SkanDaL (bottom) ♣K ♠J; AGRO (top) ♣8 ♦8; Валентин (right) ♣Q ♠9;
// Пламен (left) ♠Q ♣J. Точната production история на 6-те взятки.
const PROD_BID = bid('suit', 'spades')
const PROD_TRICKS = [
  trick('bottom', 's7 s8 s10 sA'), // 0 → left
  trick('left', 'hJ h8 h10 h9'), // 1 → right
  trick('right', 'hQ d10 hK hA'), // 2 → bottom (top няма ♥)
  trick('bottom', 'dJ dA d9 dK'), // 3 → right
  trick('right', 'h7 dQ d7 sK'), // 4 → bottom цака (left няма ♥, партньорът печели)
  trick('bottom', 'cA c9 c10 c7'), // 5 → bottom (заявяващ)
]
const PROD: Fixture = {
  finalHands: { bottom: cs('cK sJ'), top: cs('c8 d8'), right: cs('cQ s9'), left: cs('sQ cJ') },
  tricks: PROD_TRICKS,
  winningBid: PROD_BID,
}
const PROD_COUNTEREXAMPLE: Fixture = {
  ...PROD,
  finalHands: { bottom: cs('cK sJ'), top: cs('c8 d8'), right: cs('s9 sQ'), left: cs('cQ cJ') },
}

await check('[P0] fixture: точната production история е законна и за реалното, и за контрапримерното разпределение', () => {
  assertLegalHistory(PROD.finalHands, PROD.tricks, PROD_BID)
  assertLegalHistory(PROD_COUNTEREXAMPLE.finalHands, PROD.tricks, PROD_BID)
  const winners = toCompleted(PROD.tricks, PROD_BID).map((t: any) => t.winnerSeat).join(',')
  assert(winners === 'left,right,bottom,right,bottom,bottom', `победители като в production, got ${winners}`)
})

await check('[P1] старият double-dummy при РЕАЛНОТО разпределение = true (възпроизвежда бъга)', () => {
  assert(doubleDummy('bottom', PROD.finalHands, PROD_BID) === true, 'очаквано true')
})

await check('[P2] контрапримерът (Валентин ♠9 ♠Q, Пламен ♣Q ♣J) губи взятка', () => {
  assert(doubleDummy('bottom', PROD_COUNTEREXAMPLE.finalHands, PROD_BID) === false, 'очаквано false')
})

await check('[P3] новата публична проверка = false (контрапример)', () => {
  const outcome = publicOutcome('bottom', PROD)
  assert(outcome.result === false, `result=${outcome.result}`)
  assert(outcome.reason === 'counterexample', `reason=${outcome.reason}`)
})

await check('[P4] комбинираното решение computeServerSweepOfferEligibility = false', () => {
  const eligible = computeServerSweepOfferEligibility({
    sweepSeat: 'bottom',
    hands: PROD.finalHands as any,
    winningBid: PROD_BID as any,
    publicInfo: { completedTricks: toCompleted(PROD.tricks, PROD_BID), currentTrickPlays: [], declarations: [] },
  })
  assert(eligible === false, 'очаквано false')
})

await check('[P5] production път: край на взятка 5 през submitServerPlayCard → НЯМА предложение, играта продължава', () => {
  const next = completeLastTrickViaEngine(PROD)
  assert(next.playing.lastCompletedTrickWinnerSeat === 'bottom', `winner=${next.playing.lastCompletedTrickWinnerSeat}`)
  assert(next.playing.sweepOffer === null, 'не трябва да има sweepOffer')
  assert(next.playing.currentTurnSeat === 'bottom', 'bottom води следващата взятка')
})

await check('[P6] ръчно изпратено OK при подправено предложение → сървърът отказва (state непроменен)', () => {
  const state = stateWithOffer('bottom', PROD)
  const next = submitServerSweepDecision(state, 'bottom', 'accept')
  assert(next === state, 'accept трябва да е no-op')
})

// ─── [S] Сигурни предложения при публично доказуема гаранция ──────────────
// [S1] Същата история, но bottom държи ♠J ♠9 — единственият неизвестен коз
// (♠Q) е по-нисък → бърз път.
const SAFE_TOP_TRUMPS: Fixture = {
  finalHands: { bottom: cs('sJ s9'), top: cs('c8 d8'), right: cs('cK cQ'), left: cs('sQ cJ') },
  tricks: PROD_TRICKS,
  winningBid: PROD_BID,
}

// [S2] Гаранция САМО чрез извод от историята: неизвестният ♠9 бие ♣K по
// двойки, но right/left са показали, че нямат ♠ и ♣ → ♠9 и ♣8 са у top, който
// е длъжен да отговаря на ♣ и не може да надцака ♠J.
const SAFE_BY_INFERENCE: Fixture = {
  finalHands: { bottom: cs('cK sJ'), top: cs('s9 c8'), right: cs('d8 h7'), left: cs('d7 h8') },
  tricks: [
    trick('bottom', 's7 h9 s8 d9'), // right/left: нямат ♠ → top
    trick('top', 'c7 d10 c9 h10'), // right/left: нямат ♣ → bottom
    trick('bottom', 'sQ hJ sK dJ'), // → top
    trick('top', 'c10 dQ cJ hA'), // → top
    trick('top', 's10 dK sA hQ'), // bottom надцака → bottom
    trick('bottom', 'cA hK cQ dA'), // → bottom
  ],
  winningBid: PROD_BID,
}

await check('[S1] публично доказуема гаранция (най-силни козове) → предложение се прави и OK минава', () => {
  assertLegalHistory(SAFE_TOP_TRUMPS.finalHands, SAFE_TOP_TRUMPS.tricks, PROD_BID)
  const outcome = publicOutcome('bottom', SAFE_TOP_TRUMPS)
  assert(outcome.result === true && outcome.reason === 'unbeatable', `outcome=${JSON.stringify(outcome)}`)
  const offered = completeLastTrickViaEngine(SAFE_TOP_TRUMPS)
  assert(offered.playing.sweepOffer?.seat === 'bottom', 'очаквано предложение за bottom')
  const accepted = submitServerSweepDecision(offered, 'bottom', 'accept')
  assert(accepted !== offered && accepted.playing.completedTricks.length === 8, 'OK трябва да приключи раздаването')
})

await check('[S2] гаранция само чрез законните ходове (липса на боя/коз) → true след пълно търсене', () => {
  assertLegalHistory(SAFE_BY_INFERENCE.finalHands, SAFE_BY_INFERENCE.tricks, PROD_BID)
  const outcome = publicOutcome('bottom', SAFE_BY_INFERENCE)
  assert(outcome.result === true && outcome.reason === 'proven', `outcome=${JSON.stringify(outcome)}`)
  const offered = completeLastTrickViaEngine(SAFE_BY_INFERENCE)
  assert(offered.playing.sweepOffer?.seat === 'bottom', 'очаквано предложение за bottom')
  const accepted = submitServerSweepDecision(offered, 'bottom', 'accept')
  assert(accepted.playing.completedTricks.length === 8, 'OK трябва да мине')
})

await check('[S3] същото без извода (без история) → false: ♠9 може да е у място без ♣', () => {
  const outcome = publicOutcome('bottom', { ...SAFE_BY_INFERENCE, tricks: [] })
  assert(outcome.result === false, `outcome=${JSON.stringify(outcome)}`)
})

// ─── [R] Един коз + силна некозова карта; всички първи ходове ───────────
await check('[R1] ♠J + ♥A срещу неизвестен ♠7: реално right има ♥ (double-dummy true), но цакане е възможно → false', () => {
  const fx: Fixture = {
    finalHands: { bottom: cs('sJ hA'), right: cs('s7 h7'), top: cs('d7 d8'), left: cs('c7 c8') },
    tricks: [],
    winningBid: PROD_BID,
  }
  assert(doubleDummy('bottom', fx.finalHands, PROD_BID) === true, 'double-dummy при реалните ръце трябва да е true')
  const outcome = publicOutcome('bottom', fx)
  assert(outcome.result === false && outcome.reason === 'counterexample', `outcome=${JSON.stringify(outcome)}`)
})

await check('[R2] „първо коз“ би изтеглил козовете, но първи ход ♥A е законен → false', () => {
  // bottom ♠J ♠9 ♥A; неизвестни ♠7 ♠8. Водене ♠J, ♠9 изтегля козовете; водене
  // ♥A първо се цака от място без ♥. Реално ♠7/♠8 са у места с ♥ (DD true).
  const fx: Fixture = {
    finalHands: { bottom: cs('sJ s9 hA'), right: cs('s7 h7 h8'), top: cs('s8 h9 h10'), left: cs('c7 c8 c9') },
    tricks: [],
    winningBid: PROD_BID,
  }
  assert(doubleDummy('bottom', fx.finalHands, PROD_BID) === true, 'double-dummy при реалните ръце трябва да е true')
  assert(publicOutcome('bottom', fx).result === false, 'очаквано false')
  // Контрола: без ♥A (само козове) → гаранция.
  const trumpsOnly: Fixture = {
    finalHands: { bottom: cs('sJ s9 sA'), right: cs('s7 h7 h8'), top: cs('s8 h9 h10'), left: cs('c7 c8 c9') },
    tricks: [],
    winningBid: PROD_BID,
  }
  assert(publicOutcome('bottom', trumpsOnly).result === true, 'контрола: само козове → true')
})

// ─── [C] Договори ─────────────────────────────────────────────────────────
await check('[C1] без коз: аса/десетки без по-висока неизвестна карта → true; с неизвестна по-висока → false', () => {
  const nt = bid('no-trumps')
  const safe: Fixture = {
    finalHands: { bottom: cs('cA c10 hA'), right: cs('c7 h7 d7'), top: cs('c8 h8 d8'), left: cs('s7 s8 s9') },
    tricks: [],
    winningBid: nt,
  }
  assert(doubleDummy('bottom', safe.finalHands, nt) === true, 'DD safe')
  assert(publicOutcome('bottom', safe).result === true, 'public safe')
  const unsafe: Fixture = {
    finalHands: { bottom: cs('cA cK hA'), right: cs('c10 h7 d7'), top: cs('c8 h8 d8'), left: cs('s7 s8 s9') },
    tricks: [],
    winningBid: nt,
  }
  assert(doubleDummy('bottom', unsafe.finalHands, nt) === false, 'DD unsafe')
  assert(publicOutcome('bottom', unsafe).result === false, 'public unsafe')
})

await check('[C2] всичко коз: J/9 подредба → true; неизвестна 9 срещу A → false', () => {
  const at = bid('all-trumps')
  const safe: Fixture = {
    finalHands: { bottom: cs('cJ c9 dJ'), right: cs('c7 d7 h7'), top: cs('cA d9 h8'), left: cs('s7 s8 s9') },
    tricks: [],
    winningBid: at,
  }
  assert(doubleDummy('bottom', safe.finalHands, at) === true, 'DD safe')
  assert(publicOutcome('bottom', safe).result === true, 'public safe')
  const unsafe: Fixture = {
    finalHands: { bottom: cs('cJ dA'), right: cs('d9 h7'), top: cs('c7 h8'), left: cs('s7 s8') },
    tricks: [],
    winningBid: at,
  }
  assert(publicOutcome('bottom', unsafe).result === false, 'public unsafe')
})

await check('[C3] коз: обявен Белот (изиграна ♠K) фиксира ♠Q у обявилия — комбинира се с извода от историята', () => {
  // bottom ♣A ♠J; неизвестни ♠Q ♣7 ♦7 ♦8 ♥7 ♥8. Историята показва: top няма
  // ♣ и ♠, left няма ♣ → ♣7 е у right. Белот на right → и ♠Q е у right →
  // right = {♠Q, ♣7}: отговаря на ♣A с ♣7 и на ♠J с ♠Q при всеки ред → true.
  // Без Белот ♠Q може да е у left (без ♣) → цака ♣A → false.
  const fx = {
    finalHands: { bottom: cs('cA sJ'), right: cs('sQ c7'), top: cs('d7 d8'), left: cs('h7 h8') },
    winningBid: PROD_BID,
  }
  const base = (declarations: any[], completedTricks: any[]) =>
    computeServerSweepPublicGuaranteeOutcome({
      sweepSeat: 'bottom',
      hands: fx.finalHands as any,
      winningBid: PROD_BID as any,
      publicInfo: { completedTricks, currentTrickPlays: [], declarations },
    })
  assert(base([], []).result === false, 'без информация → false')
  const belote = {
    key: 'belote-right',
    seat: 'right',
    team: 'B',
    type: 'belote',
    publicLabel: 'Белот',
    points: 20,
    cards: [c('sK'), c('sQ')],
    cardIds: ['spades-K', 'spades-Q'],
    suit: 'spades',
    highRank: 'K',
    declaredAtTrickIndex: 0,
    announced: true,
    valid: true,
  }
  // Само Белот: ♠Q е у right, но ♣7 може да е у друг → right цака ♣A → false.
  assert(base([belote], []).result === false, 'само Белот → още false')
  // top цака/изхвърля на ♣ (противникът печели → длъжен да цака ако има коз →
  // няма ♠ и ♣); left изхвърля при печелещ партньор → само без ♣.
  // (историята е частична — проверява се само изводът)
  const history = toCompleted([trick('right', 'c8 d9 h9 c9'), trick('right', 'cJ d10 h10 cQ')], PROD_BID)
  const withAll = base([belote], history)
  assert(withAll.result === true && withAll.reason === 'proven', `Белот + история → true, got ${JSON.stringify(withAll)}`)
  const withoutBelote = base([], history)
  assert(withoutBelote.result === false, `без Белот ♠Q може да е у left → false, got ${JSON.stringify(withoutBelote)}`)
  // Необявен (announced:false) Белот не е публичен → не се ползва.
  assert(base([{ ...belote, announced: false }], history).result === false, 'необявен Белот не е публична информация')
})

// ─── [G] Лимит ───────────────────────────────────────────────────────────
await check('[G1] изчерпан лимит → false (fail-safe), никога несигурно предложение', () => {
  const outcome = publicOutcome('bottom', SAFE_BY_INFERENCE, { maxNodes: 1 })
  assert(outcome.result === false && outcome.reason === 'guard' && outcome.guardHit, `outcome=${JSON.stringify(outcome)}`)
})

await check('[G2] непразна текуща взятка → false (заявяващият трябва да води)', () => {
  const outcome = computeServerSweepPublicGuaranteeOutcome({
    sweepSeat: 'bottom',
    hands: SAFE_TOP_TRUMPS.finalHands as any,
    winningBid: PROD_BID as any,
    publicInfo: { completedTricks: [], currentTrickPlays: [{ seat: 'right', card: c('h7') }] as any, declarations: [] },
  })
  assert(outcome.result === false && outcome.reason === 'invalid-input', `outcome=${JSON.stringify(outcome)}`)
})

// ─── [X] Кръстосана проверка срещу дефиницията ───────────────────────────
// Случайни законни раздавания (детерминиран seed). При n ≤ 3 оставащи карти
// за ВСЯКО място като заявяващ: изброяваме всички разпределения на
// неизвестните карти с точния брой на място, пазим тези, при които ЦЯЛАТА
// история е законна по production валидатора (пълни ръце, не по двойки), и
// изискваме double-dummy true за всяко. Резултатът трябва да съвпада точно.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomContract(rand: () => number): Bid {
  const roll = rand()
  if (roll < 0.6) return bid('suit', SUITS[Math.floor(rand() * 4)]!)
  if (roll < 0.8) return bid('no-trumps')
  return bid('all-trumps')
}

type SimStep = { tricks: Play[][]; hands: Record<Seat, Card[]>; leader: Seat }

// Пълна законна игра; при biased=true заявяващият (bottom) получава силни карти
// — повече положителни/гранични случаи.
function simulateDeal(rand: () => number, winningBid: Bid, biased: boolean): SimStep[] {
  const deck: Card[] = SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${suit}-${rank}`, suit, rank })))
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
  }
  if (biased) {
    const strength = (card: Card) => {
      const isTrump = winningBid.contract === 'all-trumps' || (winningBid.contract === 'suit' && card.suit === winningBid.trumpSuit)
      const order = isTrump ? ['7', '8', 'Q', 'K', '10', 'A', '9', 'J'] : ['7', '8', '9', 'J', 'Q', 'K', '10', 'A']
      return (isTrump && winningBid.contract === 'suit' ? 10 : 0) + order.indexOf(card.rank) + rand() * 4
    }
    deck.sort((a, b) => strength(b) - strength(a))
  }
  const hands: Record<Seat, Card[]> = { bottom: [], right: [], top: [], left: [] }
  if (biased) {
    hands.bottom = deck.slice(0, 8)
    const rest = deck.slice(8)
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
    }
    hands.right = rest.slice(0, 8)
    hands.top = rest.slice(8, 16)
    hands.left = rest.slice(16, 24)
  } else {
    SEATS.forEach((seat, i) => (hands[seat] = deck.slice(i * 8, i * 8 + 8)))
  }
  const steps: SimStep[] = []
  const tricks: Play[][] = []
  let leader: Seat = SEATS[Math.floor(rand() * 4)]!
  for (let t = 0; t < 8; t += 1) {
    const plays: Play[] = []
    let seat = leader
    for (let k = 0; k < 4; k += 1) {
      const legal = legalCardsFor(seat, hands[seat] as any, plays as any, winningBid as any) as Card[]
      const card = legal[Math.floor(rand() * legal.length)]!
      plays.push({ seat, card })
      hands[seat] = hands[seat].filter((x) => x.id !== card.id)
      seat = nextSeat(seat)
    }
    tricks.push(plays)
    leader = getServerTrickWinner(plays as any, winningBid as any)!.seat as Seat
    if (t < 7) {
      steps.push({
        tricks: tricks.map((p) => [...p]),
        hands: { bottom: [...hands.bottom], right: [...hands.right], top: [...hands.top], left: [...hands.left] },
        leader,
      })
    }
  }
  return steps
}

function* partitions(pool: Card[], sizes: number[], index = 0, acc: Card[][] = sizes.map(() => [])): Generator<Card[][]> {
  if (index === pool.length) {
    yield acc.map((x) => [...x])
    return
  }
  for (let s = 0; s < sizes.length; s += 1) {
    if (acc[s]!.length >= sizes[s]!) continue
    acc[s]!.push(pool[index]!)
    yield* partitions(pool, sizes, index + 1, acc)
    acc[s]!.pop()
  }
}

function isHistoryLegal(finalHands: Record<Seat, Card[]>, tricks: Play[][], winningBid: Bid): boolean {
  const hands: Record<Seat, Card[]> = { bottom: [], right: [], top: [], left: [] }
  for (const seat of SEATS) hands[seat] = [...finalHands[seat]]
  for (const plays of tricks) for (const play of plays) hands[play.seat].push(play.card)
  for (const plays of tricks) {
    for (let k = 0; k < 4; k += 1) {
      const play = plays[k]!
      const legal = legalCardsFor(play.seat, hands[play.seat] as any, plays.slice(0, k) as any, winningBid as any)
      if (!legal.some((x: any) => x.id === play.card.id)) return false
      hands[play.seat] = hands[play.seat].filter((x) => x.id !== play.card.id)
    }
  }
  return true
}

function definitionByEnumeration(claimant: Seat, step: SimStep, winningBid: Bid): boolean {
  const responders = [nextSeat(claimant), nextSeat(nextSeat(claimant)), nextSeat(nextSeat(nextSeat(claimant)))]
  const pool = responders.flatMap((seat) => step.hands[seat])
  const sizes = responders.map((seat) => step.hands[seat].length)
  for (const parts of partitions(pool, sizes)) {
    const world: Record<Seat, Card[]> = { bottom: [], right: [], top: [], left: [] }
    world[claimant] = step.hands[claimant]
    responders.forEach((seat, i) => (world[seat] = parts[i]!))
    if (!isHistoryLegal(world, step.tricks, winningBid)) continue
    if (!doubleDummy(claimant, world, winningBid)) return false
  }
  return true
}

await check('[X] новата проверка == дефиницията (изброяване + пълна валидация на историята + DD), n ≤ 3', () => {
  const rand = mulberry32(20261123)
  let compared = 0
  let positives = 0
  let ddTrueButPublicFalse = 0
  for (let deal = 0; deal < 400; deal += 1) {
    const winningBid = randomContract(rand)
    const steps = simulateDeal(rand, winningBid, deal % 2 === 0)
    for (const step of steps) {
      const n = step.hands.bottom.length
      if (n > 3 || n < 2) continue
      for (const claimant of SEATS) {
        const fx: Fixture = { finalHands: step.hands, tricks: step.tricks, winningBid }
        const outcome = publicOutcome(claimant, fx)
        assert(outcome.reason !== 'guard' && outcome.reason !== 'inconsistent-history', `unexpected ${outcome.reason}`)
        const expected = definitionByEnumeration(claimant, step, winningBid)
        if (outcome.result !== expected) {
          throw new Error(
            `mismatch deal=${deal} claimant=${claimant} n=${n} public=${outcome.result} definition=${expected} ` +
              `bid=${JSON.stringify(winningBid)} hands=${JSON.stringify(step.hands)}`,
          )
        }
        compared += 1
        if (expected) positives += 1
        if (!expected && doubleDummy(claimant, step.hands, winningBid)) ddTrueButPublicFalse += 1
      }
    }
  }
  console.log(`     сравнени=${compared}, гарантирани=${positives}, DD true но публично false=${ddTrueButPublicFalse}`)
  assert(positives > 20, `твърде малко положителни случаи (${positives}) — тестът не покрива true пътя`)
  assert(ddTrueButPublicFalse > 0, 'очаквахме случаи, в които старият алгоритъм издава скрита информация')
})

// ─── [B] Производителност ─────────────────────────────────────────────────
await check('[B] производителност: всички места × всички взятки в случайни раздавания (вкл. силни ръце)', () => {
  const rand = mulberry32(777)
  let calls = 0
  let guardHits = 0
  let ddGuardHits = 0
  let maxMs = 0
  let maxNodes = 0
  let totalMs = 0
  const byN: Record<number, { calls: number; maxMs: number; maxNodes: number; trueCount: number }> = {}
  for (let deal = 0; deal < 600; deal += 1) {
    const winningBid = randomContract(rand)
    const steps = simulateDeal(rand, winningBid, deal % 3 !== 0)
    for (const step of steps) {
      const n = step.hands.bottom.length
      if (n < 2) continue
      for (const claimant of SEATS) {
        const fx: Fixture = { finalHands: step.hands, tricks: step.tricks, winningBid }
        const startedAt = performance.now()
        const outcome = publicOutcome(claimant, fx)
        const ms = performance.now() - startedAt
        calls += 1
        totalMs += ms
        maxMs = Math.max(maxMs, ms)
        maxNodes = Math.max(maxNodes, outcome.nodes)
        if (outcome.guardHit) guardHits += 1
        const bucket = (byN[n] ??= { calls: 0, maxMs: 0, maxNodes: 0, trueCount: 0 })
        bucket.calls += 1
        bucket.maxMs = Math.max(bucket.maxMs, ms)
        bucket.maxNodes = Math.max(bucket.maxNodes, outcome.nodes)
        if (outcome.result) bucket.trueCount += 1
        // Новото ⇒ старото: публична гаранция без DD гаранция е невъзможна
        // (освен ако DD е спрял от собствения си лимит — fail-safe false).
        if (outcome.result && !doubleDummy(claimant, step.hands, winningBid)) {
          const dd = computeServerSweepEligibilityOutcome({ sweepSeat: claimant, hands: step.hands as any, winningBid: winningBid as any })
          if (dd.guardHit) ddGuardHits += 1
          else
            throw new Error(
              `public true, но DD false: n=${n} claimant=${claimant} bid=${JSON.stringify(winningBid)} ` +
                `public=${JSON.stringify(outcome)} dd=${JSON.stringify(dd)} ` +
                `hands=${JSON.stringify(Object.fromEntries(SEATS.map((s) => [s, step.hands[s].map((x) => x.id)])))}`,
            )
        }
      }
    }
  }
  console.log(
    `     calls=${calls} avg=${(totalMs / calls).toFixed(3)}ms max=${maxMs.toFixed(1)}ms maxNodes=${maxNodes} ` +
      `guardHits=${guardHits} (DD лимит при публично true: ${ddGuardHits})`,
  )
  for (const [n, b] of Object.entries(byN)) {
    console.log(`       n=${n}: calls=${b.calls} true=${b.trueCount} max=${b.maxMs.toFixed(1)}ms maxNodes=${b.maxNodes}`)
  }
  assert(maxMs < 2000, `твърде бавно: ${maxMs.toFixed(1)}ms`)
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
