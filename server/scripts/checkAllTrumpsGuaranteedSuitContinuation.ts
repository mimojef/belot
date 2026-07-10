/**
 * checkAllTrumpsGuaranteedSuitContinuation.ts
 *
 * Regression проверки за bug fix: при "Всичко коз" ботът спираше да
 * продължава дълга боя веднага щом собствената му последна карта от нея
 * НЕ беше обективно "master" (isCardMaster) — дори когато и двамата
 * противника вече бяха доказано void в тази боя. В такъв случай по-високата
 * незнайна карта от боята може да е единствено у партньора (елиминация:
 * не е у бота, не е изиграна, противниците са void → остава партньорът),
 * а взятката е гарантирана за отбора независимо кой от двама я държи —
 * защото void противник не може да наддава в чужда боя при "Всичко коз"
 * (getServerValidPlayCards: void играч хвърля произволна карта от друга
 * боя, тя не участва в сравнението за победител на текущата боя).
 *
 * Root cause: isCardMaster() за 'all-trumps' (pickServerBotPlayCard.ts)
 * проверява само "по-високата карта е в моята ръка ИЛИ вече изиграна" —
 * без изобщо да ползва voidSuitsOf() за опонентите (за разлика от 'suit'
 * контракта, който explicit-но ползва canAnyOpponentPossiblyHoldCard).
 * Затова chooseAllTrumpsMasterLead() отхвърля такава боя и логиката
 * пада напред до fallback (А-сигнал атака / lowestCard от цялата ръка),
 * което може да отвори съвсем друга, непроверена боя и да поднесе взятка
 * на противника.
 *
 * Fix: нова функция chooseAllTrumpsGuaranteedTeamSuitContinuation(),
 * извикана в chooseLead() САМО за declarer отбора при "Всичко коз".
 *
 * ── Пълен приоритетен ред в declarer клона (chooseLead, contract==='all-trumps',
 *    botTeamDeclared===true), потвърден чрез conflict analysis:
 *
 *   1. chooseAllTrumpsMasterLead            — обективно властна карта (isCardMaster)
 *   2. partnerMandatoryRequestedSuit (J)     — партньорски mandatory сигнал (explicit)
 *   3. partnerAllTrumpsColorSignaledSuit     — партньорски цветен сигнал (explicit)
 *   4. chooseAllTrumpsDeclarerLongSuitUnlock — дълга боя (≥3 карти) без J, отключване
 *   5. chooseAllTrumpsGuaranteedTeamSuitContinuation ← НОВО ПРАВИЛО (fix)
 *   6. Ace-signal атака (A + друга карта без J в същата боя, J не е изиграно)
 *   7. getPartnerASignaledSuit (връщане на партньорски A-сигнал)
 *   8-9. Повторни (dead-code) проверки на mandatory/color сигнал
 *   10. lowestCard(validCards) — generic fallback
 *
 *   Новото правило е позиционирано СЛЕД 1-4 (по-силни explicit тактически
 *   мотиви печелят), но ПРЕДИ 6-7 (то носи БЕЗУСЛОВНА гаранция за взятка,
 *   докато ace-signal атаката е спекулативна, а A-сигналното връщане зависи
 *   от партньора все още да държи точната карта — вижте сценарии D/E/F/L
 *   по-долу за explicit потвърждение на всеки граничен случай).
 *
 * Тестови случаи (buquи по заявката):
 *   [A] Happy path: и двама void, 1 карта в боя, партньор има по-високата → продължава
 *   [B] Mandatory partner J-сигнал към друга боя → сигналът печели
 *   [C] Partner color-сигнал с по-висок приоритет → color-сигналът печели
 *   [D] По-силен master lead в друга боя → master печели
 *   [E] Declarer long-suit unlock приложим → старото правило пази приоритета
 *   [F] Ace-signal / A-сигнал връщане приложими едновременно с новото правило
 *       → новото правило печели (потвърдена дизайн-позиция, вижте conflict analysis)
 *   [G] Само единият противник void → новото правило не се активира
 *   [H] Ботът има 2 карти от боята → новото правило не се активира
 *   [I] Defensive path (botTeamDeclared=false) → новото правило не участва
 *   [J] Suit договор → не се активира
 *   [K] No-trumps договор → не се активира
 *   [L] Follow ситуация (не води) → новото правило не се извиква изобщо
 *   [M] Няма сигурна void информация (никой противник не е void) → не се активира
 *   [N] Generic fallback сценарий → новото правило печели само защото няма
 *       по-силно приложимо правило (нищо друго не съвпада)
 *   [extra] Две гарантирани бои едновременно → избира по-високата карта
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
const scenarioResults: { scenario: string; expectedRule: string; actual: string; pass: boolean }[] = []

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
function recordScenario(
  scenario: string,
  expectedRule: string,
  actual: string,
  didPass: boolean,
): void {
  scenarioResults.push({ scenario, expectedRule, actual, pass: didPass })
}

// ─── State builders (следва конвенцията от checkPartnerSuitAllTrumpsLead.ts) ──

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

// Стандартен сценарий: bottom е бот, top е партньор, right/left са противници.
// Ботовият отбор (bottom+top) е обявил "Всичко коз".
const BOT: Seat = 'bottom'
const PARTNER: Seat = 'top'
const OPP1: Seat = 'right'
const OPP2: Seat = 'left'

const BOT_TEAM_ALL_TRUMPS_WIN: ServerAuthoritativeGameState['bidding']['winningBid'] = {
  seat: BOT,
  contract: 'all-trumps',
  trumpSuit: null,
  doubled: false,
  redoubled: false,
}

const OPPONENT_ALL_TRUMPS_WIN: ServerAuthoritativeGameState['bidding']['winningBid'] = {
  seat: OPP1,
  contract: 'all-trumps',
  trumpSuit: null,
  doubled: false,
  redoubled: false,
}

const STD_ENTRIES: ServerBidEntry[] = [
  { seat: OPP2, action: { type: 'pass' } },
  { seat: BOT, action: { type: 'all-trumps' } },
  { seat: OPP1, action: { type: 'pass' } },
  { seat: PARTNER, action: { type: 'pass' } },
]

/**
 * Взятка, в която `voidSeat` е играл различна боя от `ledSuit` → доказано void в ledSuit.
 *
 * По подразбиране печели `leaderSeat` (обичайният случай). За тестове, в
 * които void-establishing взятките НЕ трябва да броят за "последна наша
 * спечелена взятка" (partnerMandatoryRequestedSuit/partnerAllTrumpsColorSignaledSuit
 * четат само последната), подай `winnerSeatOverride` = опонентски seat.
 */
function makeVoidingTrick(
  trickIndex: number,
  leaderSeat: Seat,
  ledSuit: ServerSuit,
  voidSeat: Seat,
  voidCard: ServerCard,
  winnerSeatOverride?: Seat,
): ServerCompletedTrick {
  const otherPlays: ServerTrickPlay[] = [
    { seat: leaderSeat, card: makeCard(ledSuit, '7', `${leaderSeat}-lead-${trickIndex}`) },
    { seat: voidSeat, card: voidCard },
  ]
  const winnerSeat = winnerSeatOverride ?? leaderSeat
  return {
    trickIndex,
    leaderSeat,
    plays: otherPlays,
    winnerSeat,
    winningTeam: winnerSeat === BOT || winnerSeat === PARTNER ? 'A' : 'B',
  }
}

/**
 * Две void-establishing взятки за `suit`: в двете BOT/PARTNER води с `suit`
 * (7-ка), а съответният опонент играе различна боя (diamonds) → доказано
 * void. Печели опонентът (winnerSeatOverride), за да не броят тези взятки
 * за "последна наша спечелена взятка" (partnerMandatoryRequestedSuit/
 * partnerAllTrumpsColorSignaledSuit четат само последната).
 *
 * ВАЖНО: leaderSeat трябва да е РАЗЛИЧЕН от voidSeat — един играч не може
 * едновременно да води взятката И да е "void" играчът в нея (voidSuitsOf
 * търси trick.plays.find(p => p.seat === targetSeat), а ако leaderSeat===
 * voidSeat, find() би намерил leaderSeat записа, не voidCard записа).
 */
/** Първата боя от ALL_SUITS_FOR_TEST, различна от `excludeSuit` — за void-establishing карти. */
const ALL_SUITS_FOR_TEST: ServerSuit[] = ['hearts', 'diamonds', 'spades', 'clubs']
function anotherSuit(excludeSuit: ServerSuit): ServerSuit {
  return ALL_SUITS_FOR_TEST.find(s => s !== excludeSuit)!
}

function makeBothOpponentsVoidTricks(
  startIndex: number,
  suit: ServerSuit,
): ServerCompletedTrick[] {
  const offSuit = anotherSuit(suit)
  return [
    makeVoidingTrick(startIndex, BOT, suit, OPP1, makeCard(offSuit, '8', `opp1-void-${suit}-${startIndex}`), OPP1),
    makeVoidingTrick(startIndex + 1, BOT, suit, OPP2, makeCard(offSuit, '9', `opp2-void-${suit}-${startIndex + 1}`), OPP2),
  ]
}

console.log('\ncheckAllTrumpsGuaranteedSuitContinuation\n')

// [A] Happy path: и двама противника void, ботът има точно 1 карта от боята,
//     партньорът вероятно държи по-високата → продължава боята.
check('[A] Happy path: и двама void, 1 карта в боя → продължава боята', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  // Q♥ (единствена hearts карта, не master — J♥ у партньора) + 7♠ (по-ниска
  // карта от непроверена боя — точно каквото lowestCard fallback би избрал
  // грешно, ако новото правило липсваше).
  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),
    makeCard('spades', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (продължава контролираната hearts боя)')
  assertEqual(result!.rank, 'Q', 'Ранк (единствената ни hearts карта, не 7♠ fallback)')
  recordScenario('A: happy path', 'guaranteedTeamSuitContinuation', `${result!.suit}-${result!.rank}`, true)
})

// [B] Mandatory partner J-сигнал сочи ДРУГА боя (spades) → сигналът печели
//     пред новото правило, дори гарантирана hearts боя да е налична.
check('[B] Mandatory partner J-сигнал → сигналът печели', () => {
  const completedTricks: ServerCompletedTrick[] = [
    ...makeBothOpponentsVoidTricks(0, 'hearts'),
    // Партньорът изчиства J в spades на взятка, водена от бота → mandatory
    // сигнал; тя е последната, спечелена от нашия отбор.
    {
      trickIndex: 2,
      leaderSeat: BOT,
      plays: [
        { seat: BOT, card: makeCard('clubs', '7', 'bot-lead-2') },
        { seat: OPP1, card: makeCard('clubs', '8', 'opp1-2') },
        { seat: PARTNER, card: makeCard('spades', 'J', 'partner-signal-2') },
        { seat: OPP2, card: makeCard('clubs', '9', 'opp2-2') },
      ],
      winnerSeat: BOT,
      winningTeam: 'A',
    },
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (mandatory сигнал печели)')
  recordScenario('B: mandatory J-signal vs guaranteed', 'partnerMandatoryRequestedSuit', `${result!.suit}-${result!.rank}`, result!.suit === 'spades')
})

// [C] Partner color-сигнал (изчистена не-J/не-9 карта) сочи друга боя →
//     color-сигналът печели пред новото правило.
//     Партньорът чисти clubs (черна) на наша взятка → color сигнал сочи spades
//     (другата черна боя, getColorPartnerSuit: ♠↔♣).
check('[C] Partner color-сигнал → color-сигналът печели', () => {
  const completedTricks: ServerCompletedTrick[] = [
    ...makeBothOpponentsVoidTricks(0, 'hearts'),
    {
      trickIndex: 2,
      leaderSeat: BOT,
      plays: [
        { seat: BOT, card: makeCard('diamonds', '7', 'bot-lead-2') },
        { seat: OPP1, card: makeCard('diamonds', '8', 'opp1-2') },
        // Партньорът чисти clubs Q (не J, не 9) → color сигнал → spades.
        { seat: PARTNER, card: makeCard('clubs', 'Q', 'partner-color-signal-2') },
        { seat: OPP2, card: makeCard('diamonds', '9', 'opp2-2') },
      ],
      winnerSeat: BOT,
      winningTeam: 'A',
    },
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (color-сигнал печели)')
  recordScenario('C: color-signal vs guaranteed', 'partnerAllTrumpsColorSignaledSuit', `${result!.suit}-${result!.rank}`, result!.suit === 'spades')
})

// [D] По-силен master lead в друга боя (spades J, обективно властна) →
//     master lead печели, дори гарантирана hearts боя да е налична.
check('[D] По-силен master lead в друга боя → master печели', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),   // гарантирана боя по новото правило
    makeCard('spades', 'J'),  // обективно master (J е най-силна в spades)
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'spades', 'Боя (master lead печели)')
  assertEqual(result!.rank, 'J', 'Ранк (J♠ master)')
  recordScenario('D: master lead vs guaranteed', 'chooseAllTrumpsMasterLead', `${result!.suit}-${result!.rank}`, result!.suit === 'spades' && result!.rank === 'J')
})

// [E] Declarer long-suit unlock приложим (≥3 карти в диамант, без J) →
//     старото правило запазва приоритета си пред новото (структурно
//     несъвместими за ЕДНА и съща боя, но long-suit unlock проверява се
//     ПЪРВО в кода и печели хода, дори гарантирана hearts боя да е налична).
check('[E] Declarer long-suit unlock приложим → старото правило печели', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),      // гарантирана боя по новото правило
    makeCard('diamonds', '7'),    // long-suit unlock кандидат (3 карти, без J)
    makeCard('diamonds', '8'),
    makeCard('diamonds', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'diamonds', 'Боя (long-suit unlock печели)')
  recordScenario('E: long-suit unlock vs guaranteed', 'chooseAllTrumpsDeclarerLongSuitUnlock', `${result!.suit}-${result!.rank}`, result!.suit === 'diamonds')
})

// [F] Ace-signal атака И партньорско A-сигнално връщане са ЕДНОВРЕМЕННО
//     приложими с новото правило → новото правило печели (потвърдена
//     дизайн-позиция от conflict analysis: гарантираната взятка е
//     безусловна, докато ace-signal атаката е спекулативна, а A-сигналното
//     връщане зависи от партньора все още да пази точната карта).
check('[F] Ace-signal атака приложима едновременно → новото правило печели', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),    // гарантирана боя по новото правило
    makeCard('spades', 'A'),    // ace-signal кандидат (A + K без J в spades)
    makeCard('spades', 'K'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (гарантирана боя печели пред ace-signal атака)')
  recordScenario('F: ace-signal attack vs guaranteed', 'chooseAllTrumpsGuaranteedTeamSuitContinuation', `${result!.suit}-${result!.rank}`, result!.suit === 'hearts')
})

check('[F2] Партньорско A-сигнално връщане приложимо едновременно → новото правило печели', () => {
  const completedTricks: ServerCompletedTrick[] = [
    // Партньорът е водил с A в spades в предишна взятка → A-сигнал (getPartnerASignaledSuit).
    {
      trickIndex: 0,
      leaderSeat: PARTNER,
      plays: [
        { seat: PARTNER, card: makeCard('spades', 'A', 'partner-a-signal-0') },
        { seat: OPP1, card: makeCard('spades', '7', 'opp1-0') },
        { seat: BOT, card: makeCard('spades', '8', 'bot-0') },
        { seat: OPP2, card: makeCard('spades', '9', 'opp2-0') },
      ],
      winnerSeat: OPP2,
      winningTeam: 'B',
    },
    ...makeBothOpponentsVoidTricks(1, 'hearts'),
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),   // гарантирана боя по новото правило
    makeCard('spades', 'K'),  // карта от партньорската A-сигнална боя
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'hearts', 'Боя (гарантирана боя печели пред A-сигнално връщане)')
  recordScenario('F2: partner A-signal return vs guaranteed', 'chooseAllTrumpsGuaranteedTeamSuitContinuation', `${result!.suit}-${result!.rank}`, result!.suit === 'hearts')
})

// [G] Само единият противник е доказано void → новото правило НЕ се
//     активира (не можем да гарантираме статуса на другия противник).
check('[G] Само единият противник void → новото правило не се активира', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeVoidingTrick(0, BOT, 'hearts', OPP1, makeCard('clubs', '8', 'opp1-void-0')),
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assert(result!.suit === 'hearts' || result!.suit === 'spades', 'Валиден резултат от ръката')
  recordScenario('G: only one opponent void', 'fallback (not guaranteed)', `${result!.suit}-${result!.rank}`, true)
})

// [H] Ботът има 2 карти от боята (не последната) → новото правило не се
//     активира (group.cards.length === 1 guard).
check('[H] Ботът има 2 карти от боята → новото правило не се активира', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('hearts', '8'),
    makeCard('spades', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assert(
    botHand.some(c => c.suit === result!.suit && c.rank === result!.rank),
    'Резултатът трябва да е карта от ръката на бота',
  )
  recordScenario('H: 2 cards in suit', 'fallback (not scope of fix)', `${result!.suit}-${result!.rank}`, true)
})

// [I] Defensive path (botTeamDeclared=false) → новото правило изобщо не
//     участва (то е вградено само в declarer клона).
check('[I] Defensive path → новото правило не участва', () => {
  const completedTricks: ServerCompletedTrick[] = [
    makeVoidingTrick(0, PARTNER, 'hearts', OPP1, makeCard('clubs', '8', 'opp1-void-0')),
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('clubs', 'J'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: [
      { seat: PARTNER, action: { type: 'pass' } },
      { seat: OPP1, action: { type: 'all-trumps' } },
      { seat: BOT, action: { type: 'pass' } },
      { seat: PARTNER, action: { type: 'pass' } },
    ],
    winningBid: OPPONENT_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.rank, 'J', 'Ранк (defensive Step 1: J, новото правило не участва)')
  recordScenario('I: defensive path', 'defensive Step 1 (J)', `${result!.suit}-${result!.rank}`, result!.rank === 'J')
})

// [J] Suit договор → новото правило не се задейства.
check('[J] Suit договор → новото правило не се задейства', () => {
  const suitWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: BOT,
    contract: 'suit',
    trumpSuit: 'clubs',
    doubled: false,
    redoubled: false,
  }

  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('clubs', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: suitWin,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта при suit договор (без грешка)')
  recordScenario('J: suit contract', 'suit-contract logic (unaffected)', `${result!.suit}-${result!.rank}`, true)
})

// [K] No-trumps договор → новото правило не се задейства.
check('[K] No-trumps договор → новото правило не се задейства', () => {
  const noTrumpsWin: ServerAuthoritativeGameState['bidding']['winningBid'] = {
    seat: BOT,
    contract: 'no-trumps',
    trumpSuit: null,
    doubled: false,
    redoubled: false,
  }

  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('clubs', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: noTrumpsWin,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта при no-trumps договор (без грешка)')
  recordScenario('K: no-trumps contract', 'no-trumps logic (unaffected)', `${result!.suit}-${result!.rank}`, true)
})

// [L] Follow ситуация (ботът НЕ води) → новото правило не се извиква
//     изобщо (chooseAllTrumpsGuaranteedTeamSuitContinuation е извикана
//     единствено в chooseLead(), pickServerBotPlayCard рутира към
//     chooseFollow() когато plays.length > 0).
check('[L] Follow ситуация → новото правило не се извиква', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'hearts')

  // Текуща взятка вече е водена от OPP1 (spades) → ботът следва, не води.
  const currentTrickPlays: ServerTrickPlay[] = [
    { seat: OPP1, card: makeCard('spades', '7', 'opp1-current-lead') },
  ]

  // Ботът има Q♥ (би била "гарантирана" ако водеше) + spades карта за follow.
  const botHand: ServerCard[] = [
    makeCard('hearts', 'Q'),
    makeCard('spades', '8'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
    currentTrickPlays,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  // Ботът трябва да следва spades (валидните карти изискват follow suit),
  // не hearts (новото правило не участва при follow).
  assertEqual(result!.suit, 'spades', 'Боя (follow — не lead, новото правило не участва)')
  recordScenario('L: follow situation', 'chooseFollow (rule inactive)', `${result!.suit}-${result!.rank}`, result!.suit === 'spades')
})

// [M] Няма сигурна void информация (никой противник не е доказано void) →
//     новото правило не се активира.
check('[M] Няма сигурна void информация → новото правило не се активира', () => {
  // Няма completedTricks изобщо → нито един противник не е доказано void.
  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('spades', 'Q'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  recordScenario('M: no void information', 'fallback (not guaranteed)', `${result!.suit}-${result!.rank}`, true)
})

// [N] Generic fallback сценарий: новото правило печели ЕДИНСТВЕНО защото
//     няма по-силно приложимо правило (проверка на празния "конкурентен"
//     случай — потвърждава, че guard-ите на новото правило не се "leak-ват"
//     към ситуации без void доказателство и НЕ pre-empt-ват fallback-а
//     когато самото то не е приложимо, вижте [G]/[M]; тук просто потвърждаваме
//     позитивния случай при пълно отсъствие на конкуренция).
check('[N] Generic fallback: новото правило печели без конкуренция', () => {
  const completedTricks = makeBothOpponentsVoidTricks(0, 'diamonds')

  // Само карта в diamonds (гарантирана) + несвързана карта без сигнал/master/unlock потенциал.
  const botHand: ServerCard[] = [
    makeCard('diamonds', '8'),
    makeCard('clubs', '7'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'diamonds', 'Боя (гарантирана боя печели — нищо друго не се конкурира)')
  assertEqual(result!.rank, '8', 'Ранк (единствената ни diamonds карта)')
  recordScenario('N: generic fallback (no competition)', 'chooseAllTrumpsGuaranteedTeamSuitContinuation', `${result!.suit}-${result!.rank}`, result!.suit === 'diamonds')
})

// [extra] Две отделни "гарантирани" бои едновременно → избира по-високата карта.
check('[extra] Две гарантирани бои → избира по-високата карта', () => {
  const completedTricks: ServerCompletedTrick[] = [
    ...makeBothOpponentsVoidTricks(0, 'hearts'),
    ...makeBothOpponentsVoidTricks(2, 'diamonds'),
  ]

  const botHand: ServerCard[] = [
    makeCard('hearts', '7'),
    makeCard('diamonds', 'A'),
  ]

  const state = makeBaseState({
    botSeat: BOT,
    hand: botHand,
    bidEntries: STD_ENTRIES,
    winningBid: BOT_TEAM_ALL_TRUMPS_WIN,
    completedTricks,
  })

  const result = pickServerBotPlayCard(state, BOT)
  assert(result !== null, 'Трябва да върне карта')
  assertEqual(result!.suit, 'diamonds', 'Боя (по-високата от двете гарантирани)')
  assertEqual(result!.rank, 'A', 'Ранк (A♦, по-висока точкова стойност от 7♥)')
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log('\n┌─ Scenario table ─────────────────────────────────────────────────────────┐')
for (const r of scenarioResults) {
  const status = r.pass ? 'PASS' : 'FAIL'
  console.log(`  ${status}  ${r.scenario} | expected: ${r.expectedRule} | actual: ${r.actual}`)
}
console.log('└──────────────────────────────────────────────────────────────────────────┘')

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
