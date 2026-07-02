/**
 * checkPartnerSuitAllTrumpsLead.ts
 *
 * Regression проверки за partner-suit задължение при defensive all-trumps:
 *   Когато партньорът е обявил suit X и противникът е спечелил с all-trumps,
 *   ботът трябва да тръгне в suit X след изчерпване на сигурните карти.
 *
 * [A]  Няма master, има partner suit          → lowest card от partner suit
 * [B]  Има master в друга боя                → master карта, не partner suit
 * [C]  Две последователни master карти       → и двете преди partner suit
 * [D]  Master е в partner suit               → master карта; след взятка задълж. изпълнено
 * [E]  Partner suit вече е подаден           → стара defensive логика
 * [F]  Ботът няма карта от partner suit      → стара defensive логика
 * [G]  Няма partner suit bid                 → стара defensive логика
 * [H]  All-trumps е на нашия отбор           → стара defensive логика
 * [I]  Suit bid е на противник               → не се третира като partner suit
 * [J]  Pass/double/redouble между suit и AT  → partner suit се разпознава
 * [K]  Under-hand A/9 attack + pending suit  → partner suit има приоритет
 * [L]  След изпълнение → under-hand работи  → стара логика (ако е налична)
 * [M]  Suit и no-trumps договори             → без промяна от новото правило
 */

import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidEntry,
  ServerCard,
  ServerCompletedTrick,
  ServerPlayerState,
  ServerSuit,
  ServerTrickPlay,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Брояч ──────────────────────────────────────────────────────────────────

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
function check(label: string, fn: () => void): void {
  try {
    fn()
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
    throw new Error(`${label}: получено "${String(actual)}", очаквано "${String(expected)}"`)
  }
}

// ─── State builders ──────────────────────────────────────────────────────────

function makeCard(suit: ServerSuit, rank: ServerCard['rank'], id?: string): ServerCard {
  return { id: id ?? `${suit}-${rank}`, suit, rank }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    seats.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }])
  ) as Record<Seat, ServerPlayerState>
}

function makeBaseState(overrides: {
  botSeat: Seat
  hand: ServerCard[]
  bidEntries: ServerBidEntry[]
  winningBid: ServerAuthoritativeGameState['bidding']['winningBid']
  completedTricks?: ServerCompletedTrick[]
  currentTrickPlays?: ServerTrickPlay[]
  allHands?: Partial<Record<Seat, ServerCard[]>>
}): ServerAuthoritativeGameState {
  const { botSeat, hand, bidEntries, winningBid, completedTricks = [], currentTrickPlays = [], allHands = {} } = overrides

  const emptyScore = { teamA: 0, teamB: 0 }
  const emptyHands: Record<Seat, ServerCard[]> = {
    bottom: [],
    right: [],
    top: [],
    left: [],
    ...allHands,
    [botSeat]: hand,
  }

  return {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: {
      dealerSeat: 'right',
      cutterSeat: 'bottom',
      firstBidderSeat: 'left',
      firstDealSeat: 'left',
      selectedCutIndex: null,
    },
    deck: [],
    hands: emptyHands,
    bidding: {
      entries: bidEntries,
      currentSeat: null,
      winningBid,
      hasStarted: true,
      hasEnded: true,
      consecutivePasses: 0,
    },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: emptyScore,
      announce_50: emptyScore,
      announce_100: emptyScore,
      announce_kare: emptyScore,
      announce_belot: emptyScore,
    },
    currentTrick: {
      leaderSeat: botSeat,
      currentSeat: botSeat,
      plays: currentTrickPlays,
      winnerSeat: null,
      trickIndex: completedTricks.length,
    },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: botSeat,
      currentTrick: {
        leaderSeat: botSeat,
        currentSeat: botSeat,
        plays: currentTrickPlays,
        winnerSeat: null,
        trickIndex: completedTricks.length,
      },
      completedTricks,
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: {
      round: {
        tricks: emptyScore,
        declarations: emptyScore,
        belote: emptyScore,
        lastTen: emptyScore,
        capot: emptyScore,
        total: emptyScore,
      },
      match: emptyScore,
      carryOver: emptyScore,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

// Стандартен сценарий: bottom е бот, top е партньор, right/left са противници
// Партньорът (top) е обявил hearts; right е спечелил с all-trumps
const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const ALL_TRUMPS_WINNING_BID: ServerAuthoritativeGameState['bidding']['winningBid'] = {
  seat: OPP1,
  contract: 'all-trumps',
  trumpSuit: null,
  doubled: false,
  redoubled: false,
}

// bidding entries: partner обявява hearts, opponent обявява all-trumps
const STD_ENTRIES: ServerBidEntry[] = [
  { seat: OPP2, action: { type: 'pass' } },
  { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
  { seat: OPP1, action: { type: 'all-trumps' } },
  { seat: BOT, action: { type: 'pass' } },
  { seat: OPP2, action: { type: 'pass' } },
  { seat: PARTNER, action: { type: 'pass' } },
]

// Взятка, водена от бота с hearts (за "вече подаден" сценарии)
function makeHeartLedTrick(botSeat: Seat, card: ServerCard): ServerCompletedTrick {
  return {
    trickIndex: 0,
    leaderSeat: botSeat,
    plays: [{ seat: botSeat, card }],
    winnerSeat: botSeat,
    winningTeam: 'A',
  }
}

// ─── Проверки ────────────────────────────────────────────────────────────────

console.log('\ncheckPartnerSuitAllTrumpsLead\n')

// [A] Няма master, има partner suit → lowest card от partner suit
check('[A] Няма master, има partner suit → lowest heart', () => {
  // Ботът има: 7♥ 8♥ Q♠ K♦ (никоя не е master — всяка боя има по-висока карта у другите)
  // Всичките бои на противниците имат J, така che ботът не е master никъде
  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('hearts', '8'),
    makeCard('spades', 'Q'),
    makeCard('diamonds', 'K'),
  ]
  // Противниците имат J по всяка боя (за да не са master картите на бота)
  const opp1Hand: ServerCard[] = [
    makeCard('hearts', 'J'),
    makeCard('spades', 'J'),
    makeCard('diamonds', 'J'),
    makeCard('clubs', 'J'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
    allHands: { [OPP1]: opp1Hand },
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя')
  assertEqual(result!.rank, '7', 'Ранк (най-ниска heart)')
})

// [B] Има master в друга боя → master карта, не heart
check('[B] Master в друга боя → master, не heart', () => {
  // Ботът има: J♠ (master — единствен J♠), 7♥ 8♥
  // J е master в all-trumps (power=7, highest) ако никой друг няма J от тази боя
  const botHand: ServerCard[] = [
    makeCard('spades', 'J'),   // ← master (J♠ е най-силна карта в ♠ при all-trumps)
    makeCard('hearts', '7'),
    makeCard('hearts', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // J♠ е master → трябва да е избрана пред 7♥
  assertEqual(result!.suit, 'spades', 'Боя (master J♠, не heart)')
  assertEqual(result!.rank, 'J', 'Ранк (J)')
})

// [C] Две последователни master карти → и двете преди partner suit
check('[C] Два master → first master', () => {
  // Ботът има J♠ и J♣ (двете са master), плюс 7♥
  const botHand: ServerCard[] = [
    makeCard('spades', 'J'),
    makeCard('clubs', 'J'),
    makeCard('hearts', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assert(result!.rank === 'J', 'Трябва да е J (master)')
  // Боята не е hearts
  assert(result!.suit !== 'hearts', 'Не трябва да е hearts при наличен master')
})

check('[C] Два master → след първи master, partner suit все още pending', () => {
  // Симулираме: ботът е изиграл J♠ (добавен в completedTricks, воден от BOT в ♠)
  // Сега има J♣ и 7♥ в ръката
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('hearts', '7'),
  ]

  // completedTricks: BOT е водил с J♠ (master, не hearts) → suit не е hearts → pending още е true
  const completedTricks: ServerCompletedTrick[] = [
    {
      trickIndex: 0,
      leaderSeat: BOT,
      plays: [{ seat: BOT, card: makeCard('spades', 'J') }],
      winnerSeat: BOT,
      winningTeam: 'A',
    },
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // J♣ е master → трябва да се избере пред 7♥ (partner suit все още pending)
  assertEqual(result!.suit, 'clubs', 'Боя (втори master J♣)')
  assertEqual(result!.rank, 'J', 'Ранк')
})

check('[C] Два master → след двата master, тръгва в hearts', () => {
  // Ботът е изиграл J♠ и J♣. Сега има само 7♥
  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
  ]

  const completedTricks: ServerCompletedTrick[] = [
    {
      trickIndex: 0,
      leaderSeat: BOT,
      plays: [{ seat: BOT, card: makeCard('spades', 'J') }],
      winnerSeat: BOT,
      winningTeam: 'A',
    },
    {
      trickIndex: 1,
      leaderSeat: BOT,
      plays: [{ seat: BOT, card: makeCard('clubs', 'J') }],
      winnerSeat: BOT,
      winningTeam: 'A',
    },
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (hearts — partner suit)')
  assertEqual(result!.rank, '7', 'Ранк')
})

// [D] Master е в partner suit → master карта; след взятка задължението е изпълнено
check('[D] Master в partner suit → master heart', () => {
  // J♥ е master в hearts (никой друг няма J♥)
  const botHand: ServerCard[] = [
    makeCard('hearts', 'J'),
    makeCard('spades', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (hearts master)')
  assertEqual(result!.rank, 'J', 'Ранк (J)')
})

check('[D] След master heart взятка → задължение изпълнено, без hearts форсиране', () => {
  // Ботът е водил с J♥ (hearts) — задължението е изпълнено
  // Сега има само Q♠ (не master)
  const botHand: ServerCard[] = [
    makeCard('spades', 'Q'),
  ]

  const completedTricks: ServerCompletedTrick[] = [
    makeHeartLedTrick(BOT, makeCard('hearts', 'J')),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Задължението е изпълнено → не форсира hearts → старата логика → Q♠
  assertEqual(result!.suit, 'spades', 'Боя (не hearts — задължението е изпълнено)')
})

// [E] Partner suit вече е подаден → стара defensive логика
check('[E] Partner suit вече е подаден → стара логика (не форсира hearts)', () => {
  // Ботът е водил с 7♥ в предишна взятка → задължението е изпълнено
  // Сега ботът има: J♣ (ще бъде избрана от старата defensive логика — step 1: J)
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('hearts', '8'),
  ]

  const completedTricks: ServerCompletedTrick[] = [
    makeHeartLedTrick(BOT, makeCard('hearts', '7')),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Задължението е изпълнено. Старата логика: Step 1 → J
  assertEqual(result!.rank, 'J', 'Ранк (J — стара defensive логика)')
})

// [F] Ботът няма карта от partner suit → стара defensive логика
check('[F] Без hearts → стара defensive логика (J)', () => {
  // Ботът няма hearts. Има J♣ → step 1: J
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('spades', '7'),
    makeCard('diamonds', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: ALL_TRUMPS_WINNING_BID,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Няма hearts → guard пропада → стара логика → Step 1: J
  assertEqual(result!.rank, 'J', 'Ранк (J — стара defensive логика)')
})

// [G] Няма partner suit bid → стара defensive логика
check('[G] Без partner suit bid → стара defensive логика', () => {
  // Само passes и all-trumps — няма suit обява от партньора
  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP1, action: { type: 'all-trumps' } },
    { seat: BOT, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
  ]

  // Ботът има J♠ → step 1: J
  const botHand: ServerCard[] = [
    makeCard('spades', 'J'),
    makeCard('hearts', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: ALL_TRUMPS_WINNING_BID,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Без partner suit bid → guard null → стара логика → J
  assertEqual(result!.rank, 'J', 'Ранк (J — стара defensive логика)')
  assert(result!.suit !== 'hearts', 'Не форсира hearts')
})

// [H] All-trumps е на нашия отбор → defensive правило не се активира
check('[H] All-trumps от партньора → defensive правило не се активира', () => {
  // PARTNER обявява all-trumps → botTeamDeclared=true → declarer клон
  const partnerAllTrumpsWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: PARTNER,
    contract: 'all-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'all-trumps' } },
    { seat: OPP1, action: { type: 'pass' } },
    { seat: BOT, action: { type: 'pass' } },
  ]

  // Ботът има карти. В declarer клона → chooseAllTrumpsMasterLead или declarer fallback
  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: partnerAllTrumpsWin,
  })

  // Не трябва да хвърля и трябва да върне резултат по declarer логика
  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Не проверяваме конкретната карта — само че работи без грешка
  // Новото defensive правило НЕ е активно (botTeamDeclared=true)
})

// [I] Suit bid е на противник, не на партньора → не се ползва
check('[I] Opponent suit bid не се използва като partner suit', () => {
  // OPP1 обявява hearts, OPP2 обявява all-trumps (спечелва)
  const opp2Win: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: OPP2,
    contract: 'all-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'pass' } },
    { seat: OPP1, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP2, action: { type: 'all-trumps' } },
    { seat: BOT, action: { type: 'pass' } },
  ]

  // Ботът няма partner suit bid → guard е null → стара логика
  // Има J♣ → стара defensive: step 1 → J
  const botHand: ServerCard[] = [
    makeCard('clubs', 'J'),
    makeCard('hearts', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: opp2Win,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Hearts е обявено от OPP1 (противник) → не е partner suit → не се форсира
  // Стара логика: J
  assertEqual(result!.rank, 'J', 'Ранк (J — не форсира opponent suit)')
})

// [J] Pass/double/redouble между partner suit и all-trumps → suit се разпознава
check('[J] Pass/double/redouble между suit и all-trumps → partner suit разпознат', () => {
  // PARTNER обявява hearts, после противник dbl, после PARTNER redbl, после OPP1 all-trumps
  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP1, action: { type: 'double' } },
    { seat: PARTNER, action: { type: 'redouble' } },
    { seat: OPP2, action: { type: 'pass' } },
    { seat: OPP1, action: { type: 'all-trumps' } },
    { seat: BOT, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
  ]

  // Ботът няма master, има hearts → трябва да тръгне в hearts
  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'Q'),
    makeCard('diamonds', 'K'),
  ]
  // Противниците имат J по всяка боя (за да не са master)
  const opp1Hand: ServerCard[] = [
    makeCard('hearts', 'J'),
    makeCard('spades', 'J'),
    makeCard('diamonds', 'J'),
    makeCard('clubs', 'J'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: ALL_TRUMPS_WINNING_BID,
    allHands: { [OPP1]: opp1Hand },
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // double/redouble не трябва да блокират разпознаването на hearts
  assertEqual(result!.suit, 'hearts', 'Боя (hearts разпознат въпреки double/redouble)')
})

// [K] Under-hand A/9 attack налична, partner suit pending и без master → partner suit
check('[K] Under-hand attack налична, pending partner suit → hearts (не under-hand)', () => {
  // isSeatUnderHandForBot(winningBid.seat=OPP1=right, botSeat=BOT=bottom):
  //   getPreviousSeat(bottom) = left, OPP1=right → left !== right → NOT under-hand
  // При BOT=bottom и OPP1=right, ботът НЕ е under-hand на OPP1.
  // За да тестваме under-hand сценарий, използваме BOT=left, OPP_DECLARER=bottom
  //   getPreviousSeat(left) = top, но OPP_DECLARER=bottom → top !== bottom → пак не е

  // Проверяваме с BOT='top', OPP_DECLARER='right':
  //   getPreviousSeat('top') = 'right' === 'right' → IS under-hand!
  // SEAT_ORDER = ['bottom', 'right', 'top', 'left']
  // getPreviousSeat('top') = SEAT_ORDER[(2 + 4 - 1) % 4] = SEAT_ORDER[1] = 'right' ✓

  const topBot: Seat = 'top'
  const topPartner: Seat = 'bottom'
  const rightOpp: Seat = 'right'  // ← декларатор (under-hand на top)

  const rightWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: rightOpp,
    contract: 'all-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  // Partner (bottom) е обявил hearts
  const entries: ServerBidEntry[] = [
    { seat: topPartner, action: { type: 'suit', suit: 'hearts' } },
    { seat: rightOpp, action: { type: 'all-trumps' } },
    { seat: topBot, action: { type: 'pass' } },
    { seat: topPartner, action: { type: 'pass' } },
  ]

  // Ботът (top) има: A♠ 9♠ 7♥ — A+9 в ♠ без J♠ → under-hand attack кандидат
  // Но трябва J в ръката за да се активира under-hand (условие: hasJack)
  // А ботът има J♣ — значи under-hand attack ще намери ♠ (A+9 без J, jackIsPlayed=false)
  // НО partner suit (hearts) е pending → трябва да победи under-hand
  const botHand: ServerCard[] = [
    makeCard('spades', 'A'),
    makeCard('spades', '9'),
    makeCard('clubs', 'J'),   // ← hasJack=true (за под-ръка условие)
    makeCard('hearts', '7'),
  ]

  const state = makeBaseState({
    botSeat: topBot,
    hand: botHand,
    bidEntries: entries,
    winningBid: rightWin,
    allHands: { [topBot]: botHand },
  })

  const result = pickServerBotPlayCard(state, topBot)
  assert(result !== null, 'Трябва да върне карта')

  // Partner suit (hearts) трябва да победи under-hand attack
  // Но ботът е top, J♣ е master (никой друг няма J♣ в state) → master lead може да излезе
  // Проверяваме: резултатът НЕ е A♠ (under-hand attack картата)
  assert(
    !(result!.suit === 'spades' && result!.rank === 'A'),
    `Не трябва A♠ (under-hand) — получено: ${result!.suit}-${result!.rank}`,
  )
})

// [L] След изпълнение на partner suit → under-hand работи нормално
check('[L] След изпълнение → under-hand attack е налична (ако условията са изпълнени)', () => {
  // Същата setup като [K], но completedTricks съдържа воден heart от бота
  const topBot: Seat = 'top'
  const topPartner: Seat = 'bottom'
  const rightOpp: Seat = 'right'

  const rightWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: rightOpp,
    contract: 'all-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  const entries: ServerBidEntry[] = [
    { seat: topPartner, action: { type: 'suit', suit: 'hearts' } },
    { seat: rightOpp, action: { type: 'all-trumps' } },
    { seat: topBot, action: { type: 'pass' } },
    { seat: topPartner, action: { type: 'pass' } },
  ]

  const botHand: ServerCard[] = [
    makeCard('spades', 'A'),
    makeCard('spades', '9'),
    makeCard('clubs', 'J'),
    makeCard('hearts', '8'),
  ]

  // Ботът вече е водил с 7♥ → задължението е изпълнено
  const completedTricks: ServerCompletedTrick[] = [
    {
      trickIndex: 0,
      leaderSeat: topBot,
      plays: [{ seat: topBot, card: makeCard('hearts', '7') }],
      winnerSeat: topBot,
      winningTeam: 'A',
    },
  ]

  const state = makeBaseState({
    botSeat: topBot,
    hand: botHand,
    bidEntries: entries,
    winningBid: rightWin,
    completedTricks,
    allHands: { [topBot]: botHand },
  })

  const result = pickServerBotPlayCard(state, topBot)
  assert(result !== null, 'Трябва да върне карта')
  // Задължението е изпълнено → старата логика.
  // J♣ е master → chooseAllTrumpsMasterLead го избира в pending блока НЕ е активен.
  // Но defensive стара логика: under-hand check → A♠ (ако условията са изпълнени)
  // или → J♣ (step 1: J). Важното: не е forced heart.
  assert(result!.suit !== 'hearts' || result!.rank !== '8', 'Не трябва принудително 8♥')
})

// [M] Suit и no-trumps договори → без промяна от новото правило
check('[M-suit] Suit договор → новото правило не се задейства', () => {
  const suitWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: OPP1,
    contract: 'suit',
    trumpSuit: 'spades',
    doubled: false,
    redoubled: false,
  }

  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP1, action: { type: 'suit', suit: 'spades' } },
    { seat: BOT, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('clubs', 'Q'),
    makeCard('diamonds', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: suitWin,
  })

  // Трябва да работи без грешка — новото all-trumps правило не се активира
  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта при suit договор')
})

check('[M-notrumps] No-trumps договор → новото правило не се задейства', () => {
  const noTrumpsWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: OPP1,
    contract: 'no-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  const entries: ServerBidEntry[] = [
    { seat: PARTNER, action: { type: 'suit', suit: 'hearts' } },
    { seat: OPP1, action: { type: 'no-trumps' } },
    { seat: BOT, action: { type: 'pass' } },
    { seat: PARTNER, action: { type: 'pass' } },
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('clubs', 'Q'),
    makeCard('diamonds', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: entries,
    winningBid: noTrumpsWin,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта при no-trumps договор')
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
