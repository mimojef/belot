/**
 * Expert Bot — pickServerBotPlayCard
 *
 * Стратегии:
 *  - Памет за всички изиграни карти и кой в кои бои е чист (void)
 *  - При водене: помага на партньора да изтегли козове, следва сигнали,
 *    атакува бои в които противниците са чисти
 *  - При следване: ако партньорът печели → сигнализира; ако противник
 *    печели → бие с минимално биещо; ако не може → чисти ниско
 *  - Специален случай: ако партньорът е обявил коза → при първа
 *    възможност играе коз (изтегля противниковите)
 *  - Чете сигнала на партньора (висока изчистена карта = "искам тази боя")
 */

import type { Seat } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerRank,
  ServerSuit,
  ServerTrickPlay,
} from './serverGameTypes.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'

// ─── Seat helpers ────────────────────────────────────────────────────────────

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function getPartnerSeat(seat: Seat): Seat {
  return SEAT_ORDER[(SEAT_ORDER.indexOf(seat) + 2) % 4]!
}

function getOpponentSeats(seat: Seat): [Seat, Seat] {
  const idx = SEAT_ORDER.indexOf(seat)
  return [SEAT_ORDER[(idx + 1) % 4]!, SEAT_ORDER[(idx + 3) % 4]!]
}

// ─── Colour & danger suit helpers ───────────────────────────────────────────

/** Червени бои: купа и каро. Черни: пика и спатия. */
function isRedSuit(suit: ServerSuit): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

/**
 * "Другата" боя от същия цвят.
 *   ♥ ↔ ♦   (двете червени)
 *   ♠ ↔ ♣   (двете черни)
 */
function getColorPartnerSuit(suit: ServerSuit): ServerSuit {
  switch (suit) {
    case 'hearts':   return 'diamonds'
    case 'diamonds': return 'hearts'
    case 'spades':   return 'clubs'
    case 'clubs':    return 'spades'
  }
}

/**
 * Събира всички "опасни" бои — бои в които противниците имат силни карти.
 *
 * Два източника:
 * 1. Бои, ОБЯВЕНИ от противника при наддаването (вероятно имат Вале/9)
 * 2. Бои, с които противникът е ТРЪГВАЛ като водещ в разиграването
 *    (ако е тръгнал с дадена боя, вероятно е имал силни карти там —
 *     Вале, Асо и т.н. Останалите карти от боята може да са властни.)
 */
function getDangerSuits(seat: Seat, state: ServerAuthoritativeGameState): Set<ServerSuit> {
  const [opp1, opp2] = getOpponentSeats(seat)
  const opponents = new Set<Seat>([opp1, opp2])
  const dangerous = new Set<ServerSuit>()

  // Източник 1: обявени бои при наддаването
  for (const entry of state.bidding.entries) {
    if (opponents.has(entry.seat) && entry.action.type === 'suit') {
      dangerous.add(entry.action.suit)
    }
  }

  // Източник 2: бои с които противникът е тръгвал като водещ
  for (const trick of state.playing?.completedTricks ?? []) {
    if (opponents.has(trick.leaderSeat)) {
      const ledSuit = trick.plays[0]?.card.suit
      if (ledSuit) dangerous.add(ledSuit)
    }
  }

  return dangerous
}

// Обратна съвместимост — старото име се пренасочва към новото
function getOpponentBidSuits(seat: Seat, state: ServerAuthoritativeGameState): Set<ServerSuit> {
  return getDangerSuits(seat, state)
}

/**
 * Връща боята с която партньорът е тръгнал в последната взятка,
 * която НИЕ (ботът) сме спечелили.
 *
 * Използва се за правилото "взими с J/A и върни партньорската боя":
 * след като ботът вземе взятката, трябва да върне в боята на партньора
 * (след като изиграе собствените си властни карти).
 */
function getPartnerLastLedSuit(
  seat: Seat,
  state: ServerAuthoritativeGameState,
): ServerSuit | null {
  const partner = getPartnerSeat(seat)
  const completedTricks = state.playing?.completedTricks ?? []

  // Намираме последната взятка спечелена от БОТа (не партньора)
  // в която ПАРТНЬОРЪТ е бил водещ
  for (let i = completedTricks.length - 1; i >= 0; i--) {
    const trick = completedTricks[i]!
    if (trick.winnerSeat === seat && trick.leaderSeat === partner) {
      return trick.plays[0]?.card.suit ?? null
    }
  }
  return null
}

/**
 * Открива боята, в която ПАРТНЬОРЪТ е дал А-сигнал при всичко коз.
 *
 * А-сигнал = партньорът е тръгнал с Асо (не Вале/9) в дадена боя.
 * Смисълът: "Гоня Валето в тази боя — пази карта от нея и ми върни."
 *
 * Засяга само играта на ВСИЧКО КОЗ.
 */
function getPartnerASignaledSuit(
  seat: Seat,
  state: ServerAuthoritativeGameState,
): ServerSuit | null {
  if (state.bidding.winningBid?.contract !== 'all-trumps') return null
  const partner = getPartnerSeat(seat)

  for (const trick of state.playing?.completedTricks ?? []) {
    if (trick.leaderSeat !== partner) continue
    const leadCard = trick.plays[0]?.card
    if (leadCard?.rank === 'A') return leadCard.suit
  }
  return null
}

/**
 * Интерпретира цветната подсказка от изчистена карта на партньора.
 *
 * Нормален сигнал:
 *   Изчистена червена карта → търси в ДРУГАТА червена боя (♥↔♦)
 *   Изчистена черна карта   → търси в ДРУГАТА черна боя  (♠↔♣)
 *
 * Изключение — опасна ЦЕЛЕВА боя:
 *   Ако другата боя от същия цвят (target) е обявена/водена от противника
 *   → там е опасно. Търсим в ДРУГИЯ цвят вместо това.
 *
 * Пример:
 *   Противникът е обявил Пика (♠). Партньорът чисти Спатия (♣).
 *   → Нормално: търси в Пика (♠) — другата черна.
 *   → НО Пика е обявена от противника → опасна!
 *   → Търси в Купа (♥) или Каро (♦) вместо това.
 *
 * Връща предпочитаната боя или null ако няма подходяща.
 */
function resolveColorSignal(
  discardedSuit: ServerSuit,
  seat: Seat,
  state: ServerAuthoritativeGameState,
): ServerSuit | null {
  const dangerSuits = getOpponentBidSuits(seat, state)
  const hand = state.hands[seat] ?? []
  const isBlack = !isRedSuit(discardedSuit)

  // Нормален цветен сигнал: другата боя от СЪЩИЯ цвят
  //   Изчистена ♥ \u2192 търси ♦  |  ♦ \u2192 ♥
  //   Изчистена ♠ \u2192 търси ♣  |  ♣ \u2192 ♠
  const target = getColorPartnerSuit(discardedSuit)

  // Изключение: ако ЦЕЛЕВАТА боя е обявена от противника \u2192 не отивай там.
  // Противникът има силни карти там. Търсим в двата цвята на ДРУГИЯ цвят.
  //   Чистиш ♠ \u2192 нормално ♣. Противникът обявил ♣ \u2192 търси ♥ или ♦
  //   Чистиш ♥ \u2192 нормално ♦. Противникът обявил ♦ \u2192 търси ♠ или ♣
  if (dangerSuits.has(target)) {
    const oppositeSuits: ServerSuit[] = isBlack
      ? ['hearts', 'diamonds']
      : ['spades', 'clubs']
    const withCards = oppositeSuits.filter(s =>
      !dangerSuits.has(s) && bySuit(hand, s).length > 0
    )
    return withCards[0]
      ?? oppositeSuits.find(s => !dangerSuits.has(s))
      ?? null
  }

  return target
}

// ─── Card power tables ───────────────────────────────────────────────────────

const TRUMP_POWER: Record<ServerRank, number> = {
  '7': 0, '8': 1, Q: 2, K: 3, '10': 4, A: 5, '9': 6, J: 7,
}

const NO_TRUMP_POWER: Record<ServerRank, number> = {
  '7': 0, '8': 1, '9': 2, J: 3, Q: 4, K: 5, '10': 6, A: 7,
}

// ─── Card classification helpers ─────────────────────────────────────────────

type Contract = 'suit' | 'no-trumps' | 'all-trumps'

function isTrump(card: ServerCard, trumpSuit: ServerSuit | null, contract: Contract): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'suit') return card.suit === trumpSuit
  return false
}

function cardPower(card: ServerCard, trumpSuit: ServerSuit | null, contract: Contract): number {
  return isTrump(card, trumpSuit, contract)
    ? TRUMP_POWER[card.rank]
    : NO_TRUMP_POWER[card.rank]
}

function lowestCard(cards: ServerCard[], trumpSuit: ServerSuit | null, contract: Contract): ServerCard {
  return cards.reduce((best, c) =>
    cardPower(c, trumpSuit, contract) < cardPower(best, trumpSuit, contract) ? c : best
  )
}

function highestCard(cards: ServerCard[], trumpSuit: ServerSuit | null, contract: Contract): ServerCard {
  return cards.reduce((best, c) =>
    cardPower(c, trumpSuit, contract) > cardPower(best, trumpSuit, contract) ? c : best
  )
}

function bySuit(cards: ServerCard[], suit: ServerSuit): ServerCard[] {
  return cards.filter(c => c.suit === suit)
}

function trumpCards(cards: ServerCard[], trumpSuit: ServerSuit | null, contract: Contract): ServerCard[] {
  if (contract === 'all-trumps') return [...cards]
  if (contract === 'suit' && trumpSuit) return cards.filter(c => c.suit === trumpSuit)
  return []
}

function nonTrumpCards(cards: ServerCard[], trumpSuit: ServerSuit | null, contract: Contract): ServerCard[] {
  if (contract === 'all-trumps') return []
  if (contract === 'suit' && trumpSuit) return cards.filter(c => c.suit !== trumpSuit)
  return [...cards]
}

const ALL_SUITS: ServerSuit[] = ['clubs', 'diamonds', 'hearts', 'spades']

// ─── ”Не оголвай 9“ ────────────────────────────────────────────────

/**
 * Проверява дали изчистването на `card` би оставило гола 9 в нейния цвят.
 *
 * "Гола 9" = единствената останала карта в цвета е 9.
 * Опасно: ако противникът тръгне с Вале от същия цвят,
 * ботът е принуден да хвърли 9-та (14 точки) без избор.
 *
 * Условие: цветът има точно 2 карти (9 + нещо друго),
 * и ние чистим "нещото друго" → остава гола 9.
 */
function wouldBareNine(card: ServerCard, hand: ServerCard[], played?: ServerCard[]): boolean {
  if (card.rank === '9') return false
  const suitCards = bySuit(hand, card.suit)
  if (suitCards.length !== 2 || !suitCards.some(c => c.rank === '9')) return false
  // Ако J вече е изиграно, 9-та е властна — не е опасно да остане сама
  if (played?.some(c => c.suit === card.suit && c.rank === 'J')) return false
  return true
}

/**
 * Безопасно чистване: най-ниската карта която:
 * 1. НЕ оголва 9 в цвета си
 * 2. НЕ е последната карта от А-сигналната боя (партньорът я очаква обратно)
 *
 * Ако всички опции са защитени → чисти с най-ниска изобщо (няма избор).
 */
function safeDiscard(
  cards: ServerCard[],
  hand: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
  protectedSuit: ServerSuit | null = null,
  played?: ServerCard[],
): ServerCard {
  const safe = cards.filter(c => {
    if (wouldBareNine(c, hand, played)) return false
    if (protectedSuit && c.suit === protectedSuit && bySuit(hand, c.suit).length === 1) return false
    return true
  })
  const pool = safe.length > 0 ? safe : cards
  return lowestCard(pool, trumpSuit, contract)
}

// ─── Game memory ─────────────────────────────────────────────────────────────

function allPlayedCards(state: ServerAuthoritativeGameState): ServerCard[] {
  const result: ServerCard[] = []
  for (const trick of state.playing?.completedTricks ?? []) {
    for (const p of trick.plays) result.push(p.card)
  }
  for (const p of state.playing?.currentTrick?.plays ?? []) {
    result.push(p.card)
  }
  return result
}

/**
 * Returns set of suits that `targetSeat` is void in.
 * Deduced from trick history: if they played a different suit than the led
 * suit they must be void in the led suit.
 */
function voidSuitsOf(
  state: ServerAuthoritativeGameState,
  targetSeat: Seat,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): Set<ServerSuit> {
  const voids = new Set<ServerSuit>()

  for (const trick of state.playing?.completedTricks ?? []) {
    const leadSuit = trick.plays[0]?.card.suit
    if (!leadSuit) continue

    const play = trick.plays.find(p => p.seat === targetSeat)
    if (!play) continue

    // They played a different suit than the led suit → void in led suit
    if (play.card.suit !== leadSuit) {
      voids.add(leadSuit)
    }
  }

  return voids
}

// ─── Trick state helpers ─────────────────────────────────────────────────────

function isPartnerCurrentlyWinning(seat: Seat, state: ServerAuthoritativeGameState): boolean {
  const plays = state.playing?.currentTrick?.plays ?? []
  if (plays.length === 0) return false
  const winner = getServerTrickWinner(plays, state.bidding.winningBid)
  return winner?.seat === getPartnerSeat(seat)
}

function isMyTeamCurrentlyWinning(seat: Seat, state: ServerAuthoritativeGameState): boolean {
  const plays = state.playing?.currentTrick?.plays ?? []
  if (plays.length === 0) return false
  const winner = getServerTrickWinner(plays, state.bidding.winningBid)
  if (!winner) return false
  return winner.seat === seat || winner.seat === getPartnerSeat(seat)
}

function isLastToPlay(seat: Seat, state: ServerAuthoritativeGameState): boolean {
  const plays = state.playing?.currentTrick?.plays ?? []
  return plays.length === 3
}

/** Returns the lowest card that beats the current trick winner, or null. */
function lowestBeatingCard(
  cards: ServerCard[],
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  const plays = state.playing?.currentTrick?.plays ?? []
  const winningBid = state.bidding.winningBid

  const beating = cards.filter(candidate => {
    const testPlays: ServerTrickPlay[] = [
      ...plays,
      { seat: 'bottom' as Seat, card: candidate }, // seat doesn't matter for winner calc
    ]
    const newWinner = getServerTrickWinner(testPlays, winningBid)
    return newWinner?.card.id === candidate.id
  })

  if (beating.length === 0) return null
  return lowestCard(beating, trumpSuit, contract)
}

// ─── Partner signal reading ───────────────────────────────────────────────────

/**
 * Чете подсказката на партньора от неговите изчиствания на НАШИ взятки.
 *
 * Правило зависи от БРОЯ на различните бои, които партньорът е изчистил:
 *
 * 1 различна боя изчистена:
 *   → Цветна подсказка: изчистена червена → търси другата червена; черна → другата черна
 *   → + danger override ако целевата боя е обявена/водена от противника
 *
 * 2 различни бои изчистени:
 *   → Дедукция: ALL_SUITS - (бои водени от бота) - (2 изчистени) = 1 останала боя
 *   → Партньорът е там
 *
 * 3+ различни бои изчистени:
 *   → Директен сигнал: последната изчистена боя е точно там където е партньорът
 *   → (без цветна инверсия — гледаме точно тази боя)
 *
 * Пример: бот играе Купа. Партньорът чисти: Пика → Спатия → Каро
 *   - след 2 изчиствания (Пика + Спатия): ALL_SUITS - Купа - Пика - Спатия = Каро → дедуцира Каро
 *   - след 3+ изчиствания: последната = Каро → директен сигнал за Каро
 */
function partnerSignaledSuit(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
): ServerSuit | null {
  const partner = getPartnerSeat(seat)
  const tricks = state.playing?.completedTricks ?? []

  // Само взятките спечелени от нашия отбор
  const ourWonTricks = tricks.filter(
    t => t.winnerSeat === seat || t.winnerSeat === partner
  )

  // Събираме всички изчиствания на партньора (карти от различна боя от водената)
  const discards: Array<{ suit: ServerSuit; trickIndex: number }> = []
  for (const trick of ourWonTricks) {
    const ledSuit = trick.plays[0]?.card.suit
    if (!ledSuit) continue
    const partnerPlay = trick.plays.find(p => p.seat === partner)
    if (!partnerPlay) continue
    const card = partnerPlay.card
    if (card.suit !== ledSuit && card.suit !== trumpSuit) {
      discards.push({ suit: card.suit, trickIndex: trick.trickIndex })
    }
  }

  if (discards.length === 0) return null

  const distinctSuits = [...new Set(discards.map(d => d.suit))]

  // ── 3+ различни изчистени бои → директен сигнал (последната изчистена)
  if (distinctSuits.length >= 3) {
    const lastSuit = discards[discards.length - 1]!.suit
    const dangerSuits = getDangerSuits(seat, state)
    if (dangerSuits.has(lastSuit)) {
      // Последната е опасна → намираме следваща безопасна
      const hand = state.hands[seat] ?? []
      const safe = ALL_SUITS.filter(s =>
        s !== lastSuit && !dangerSuits.has(s) && bySuit(hand, s).length > 0
      )
      return safe[0] ?? null
    }
    return lastSuit
  }

  // ── 2 различни изчистени бои → дедуцираме оставащата боя
  if (distinctSuits.length === 2) {
    // Бои с които ботът е водил (познати от завършените взятки)
    const botLeadSuits = new Set<ServerSuit>(
      tricks
        .filter(t => t.leaderSeat === seat)
        .map(t => t.plays[0]?.card.suit)
        .filter((s): s is ServerSuit => !!s)
    )
    const remaining = ALL_SUITS.filter(s =>
      !distinctSuits.includes(s) && !botLeadSuits.has(s)
    )
    if (remaining.length === 1) {
      const target = remaining[0]!
      const dangerSuits = getDangerSuits(seat, state)
      if (dangerSuits.has(target)) {
        // Дедуцираната боя е опасна → използваме цветно правило на последната изчистена
        return resolveColorSignal(discards[discards.length - 1]!.suit, seat, state)
      }
      return target
    }
    // Ако не можем да дедуцираме точно → цветно правило на последната изчистена
    return resolveColorSignal(discards[discards.length - 1]!.suit, seat, state)
  }

  // ── 1 изчистена боя → цветна подсказка (с danger override)
  return resolveColorSignal(discards[discards.length - 1]!.suit, seat, state)
}

/**
 * Силен директен сигнал от партньорска изчистена карта.
 *
 * Четем само последната взятка, спечелена от нашия отбор.
 * Рангът, който означава "търси ме в тази боя", зависи от договора:
 *  - Всичко коз: изчистено J е директен сигнал; изчистено A НЕ е.
 *  - Без коз: изчистено A е директен сигнал; изчистено J НЕ е.
 *  - Коз боя: запазваме старото поведение за J/A.
 */
function partnerMandatoryRequestedSuit(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerSuit | null {
  const partner = getPartnerSeat(seat)
  const tricks = state.playing?.completedTricks ?? []

  // Четем САМО последната взятка СПЕЧЕЛЕНА от нашия отбор.
  const ourWonTricks = tricks.filter(
    t => t.winnerSeat === seat || t.winnerSeat === partner
  )
  const lastOurTrick = ourWonTricks[ourWonTricks.length - 1]
  if (!lastOurTrick) return null

  const leadSuit = lastOurTrick.plays[0]?.card.suit
  if (!leadSuit) return null

  const partnerPlay = lastOurTrick.plays.find(p => p.seat === partner)
  if (!partnerPlay) return null

  const card = partnerPlay.card
  if (card.suit === leadSuit) return null

  if (contract === 'all-trumps') {
    return card.rank === 'J' ? card.suit : null
  }

  if (contract === 'no-trumps') {
    return card.rank === 'A' ? card.suit : null
  }

  // При коз боя оставяме досегашното J/A правило.
  if (card.rank === 'J' || card.rank === 'A') {
    if (card.suit === trumpSuit) return trumpSuit
    return resolveColorSignal(card.suit, seat, state)
  }

  return null
}

// ─── Suit scoring: how attractive is a suit to lead? ─────────────────────────

/**
 * Score how attractive a suit is to lead into:
 * - +++ if both opponents are void (we make the trick for sure)
 * - ++ if one opponent is void
 * - +  if it's a long suit for us (3+ cards)
 * - -  if partner is void (we'd give them nothing to work with)
 */
function suitAttractiveness(
  suit: ServerSuit,
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): number {
  const [opp1, opp2] = getOpponentSeats(seat)
  const partner = getPartnerSeat(seat)

  const opp1Voids = voidSuitsOf(state, opp1, trumpSuit, contract)
  const opp2Voids = voidSuitsOf(state, opp2, trumpSuit, contract)
  const partnerVoids = voidSuitsOf(state, partner, trumpSuit, contract)

  let score = 0

  if (opp1Voids.has(suit) && opp2Voids.has(suit)) score += 10
  else if (opp1Voids.has(suit) || opp2Voids.has(suit)) score += 4

  if (partnerVoids.has(suit)) score -= 3

  const ourCount = bySuit(state.hands[seat] ?? [], suit).length
  if (ourCount >= 3) score += ourCount

  return score
}

function isUnsafeTenLeadInPlainSuit(
  card: ServerCard,
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): boolean {
  if (contract !== 'suit') return false
  if (card.rank !== '10') return false
  if (card.suit === trumpSuit) return false

  const hand = state.hands[seat] ?? []
  const played = allPlayedCards(state)
  const aceIsKnownSafe =
    hand.some(c => c.suit === card.suit && c.rank === 'A') ||
    played.some(c => c.suit === card.suit && c.rank === 'A')

  return !aceIsKnownSafe
}

function chooseSafePlainSuitLead(
  cards: ServerCard[],
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  const safeCards = cards.filter(c =>
    !isUnsafeTenLeadInPlainSuit(c, seat, state, trumpSuit, contract)
  )

  if (safeCards.length === 0) return null

  return highestCard(safeCards, trumpSuit, contract)
}

function countPartnerTrumpLeads(
  state: ServerAuthoritativeGameState,
  partner: Seat,
  trumpSuit: ServerSuit | null,
): number {
  if (!trumpSuit) return 0

  return (state.playing?.completedTricks ?? []).filter(trick =>
    trick.leaderSeat === partner && trick.plays[0]?.card.suit === trumpSuit
  ).length
}

function getTrumpLeadTricksBySeat(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  trumpSuit: ServerSuit | null,
) {
  if (!trumpSuit) return []

  return (state.playing?.completedTricks ?? []).filter(trick =>
    trick.leaderSeat === seat && trick.plays[0]?.card.suit === trumpSuit
  )
}

function didBothOpponentsVoidOnTrumpLead(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  trumpSuit: ServerSuit | null,
): boolean {
  if (!trumpSuit) return false

  const firstTrumpLead = getTrumpLeadTricksBySeat(state, seat, trumpSuit)[0]
  if (!firstTrumpLead) return false

  const [opp1, opp2] = getOpponentSeats(seat)
  const opponentPlays = firstTrumpLead.plays.filter(play =>
    play.seat === opp1 || play.seat === opp2
  )

  return opponentPlays.length === 2 &&
    opponentPlays.every(play => play.card.suit !== trumpSuit)
}

function chooseOwnSuitBidTrumpDraw(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  if (contract !== 'suit' || !trumpSuit) return null
  if (state.bidding.winningBid?.seat !== seat) return null

  const ourTrumps = trumpCards(validCards, trumpSuit, contract)
  if (ourTrumps.length === 0) return null

  const ownTrumpLeadTricks = getTrumpLeadTricksBySeat(state, seat, trumpSuit)
  if (ownTrumpLeadTricks.length >= 2) return null

  if (
    ownTrumpLeadTricks.length === 1 &&
    didBothOpponentsVoidOnTrumpLead(state, seat, trumpSuit)
  ) {
    return null
  }

  const jack = ourTrumps.find(c => c.rank === 'J') ?? null
  const nine = ourTrumps.find(c => c.rank === '9') ?? null
  const ace = ourTrumps.find(c => c.rank === 'A') ?? null

  if (ownTrumpLeadTricks.length === 0) {
    if (jack && (nine || ourTrumps.length >= 3)) return jack
    if (!jack && nine && ace && ourTrumps.length >= 4) return ace
    return null
  }

  const firstLeadCard = ownTrumpLeadTricks[0]?.plays[0]?.card ?? null
  if (!firstLeadCard) return null

  if (firstLeadCard.rank === 'J') {
    if (nine) return nine

    const remainingTrumps = ourTrumps.filter(c => c.rank !== 'J')
    const masterTrumps = remainingTrumps.filter(c =>
      isCardMaster(c, seat, state, trumpSuit, contract)
    )
    if (masterTrumps.length > 0) {
      return highestCard(masterTrumps, trumpSuit, contract)
    }

    if (remainingTrumps.length > 0) {
      return lowestCard(remainingTrumps, trumpSuit, contract)
    }
  }

  if (
    firstLeadCard.rank === 'A' &&
    nine &&
    allPlayedCards(state).some(c => c.suit === trumpSuit && c.rank === 'J')
  ) {
    return nine
  }

  return null
}

// ─── Leading strategy ─────────────────────────────────────────────────────────

function chooseLead(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard {
  const partner = getPartnerSeat(seat)
  const winningBid = state.bidding.winningBid

  const ownTrumpDraw = chooseOwnSuitBidTrumpDraw(seat, state, validCards, trumpSuit, contract)
  if (ownTrumpDraw) {
    return ownTrumpDraw
  }

  // ── Rule 1: Partner declared the trump → play trump at first opportunity
  //    Играе НАЙ-ВИСОКАТА коза, с едно изключение:
  //    Ако имаме 9-ка И поне още една козова карта → пазим 9-ката (14 точки!)
  //    и играем с другата (най-висока от останалите).
  if (contract === 'suit' && winningBid?.seat === partner) {
    const ourTrumps = trumpCards(validCards, trumpSuit, contract)
    const partnerTrumpLeadCount = countPartnerTrumpLeads(state, partner, trumpSuit)

    if (partnerTrumpLeadCount < 2 && ourTrumps.length > 0) {
      const hasNine = ourTrumps.some(c => c.rank === '9')
      const otherTrumps = ourTrumps.filter(c => c.rank !== '9')

      if (hasNine && otherTrumps.length > 0) {
        // Имаме 9-ка + нещо друго → пазим 9-ката, играем най-висока от останалите
        return highestCard(otherTrumps, trumpSuit, contract)
      }

      // Нямаме 9-ка, или 9-ката е единствената ни коза → играем я
      return highestCard(ourTrumps, trumpSuit, contract)
    }
  }

  // ── Rule 2: Властни некозови карти — ВИНАГИ с приоритет пред сигналите.
  //   Правило: "Първо изиграй властните си карти, след това търси партньора."
  //   Козовите карти пазим за контрол (не ги включваме тук).
  if (contract !== 'all-trumps') {
    const nonTrumpMasters = validCards.filter(c =>
      c.suit !== trumpSuit &&
      !isUnsafeTenLeadInPlainSuit(c, seat, state, trumpSuit, contract) &&
      isCardMaster(c, seat, state, trumpSuit, contract)
    )
    if (nonTrumpMasters.length > 0) {
      // Играем властната карта с НАЙ-ВИСОКА точкова стойност
      return nonTrumpMasters.reduce((best, c) =>
        dumpValue(c, trumpSuit, contract) > dumpValue(best, trumpSuit, contract) ? c : best
      )
    }
  }

  // ── Rule 2б: Връщане в партньорската боя (при всичко коз и безкоз)
  //
  //   Ако в последна взятка: партньорът е бил водещ И ние сме взели с J/A
  //   → вече сме изиграли властните → сега връщаме в неговата боя.
  //
  //   "Последна взятка спечелена от нас, в която партньорът е бил водещ"
  //   = точно ситуацията след Rule А0 в chooseFollow.
  if (contract === 'all-trumps' || contract === 'no-trumps') {
    const partnerLedSuit = getPartnerLastLedSuit(seat, state)
    if (partnerLedSuit) {
      const returnCards = bySuit(validCards, partnerLedSuit)
      if (returnCards.length > 0) {
        return highestCard(returnCards, trumpSuit, contract)
      }
    }
  }

  // ── Rule 3 & 4: Партньорски сигнали — само при боя и безкоз,
  //   и САМО когато нямаме собствени властни карти за играене.
  //   Сигналът се чете единствено от НАШИ спечелени взятки.
  if (contract !== 'all-trumps') {
    // ── Rule 3: Задължителна боя (партньорът е изчистил J или A на наша взятка)
    const mandatorySuit = partnerMandatoryRequestedSuit(seat, state, trumpSuit, contract)
    if (mandatorySuit) {
      const mandatoryCards = bySuit(validCards, mandatorySuit)
      if (mandatoryCards.length > 0) {
        return highestCard(mandatoryCards, trumpSuit, contract)
      }
    }

    // ── Rule 4: Сигнализирана боя (висока карта на партньора на наша взятка)
    const signaled = partnerSignaledSuit(seat, state, trumpSuit)
    if (signaled) {
      const signaledCards = bySuit(validCards, signaled)
      if (signaledCards.length > 0) {
        return highestCard(signaledCards, trumpSuit, contract)
      }
    }
  }

  // ── Rule 5: Избягвай обявените от противника бои при избор на следваща боя
  //   Дори без партньорски сигнал, ако можем да заобиколим опасните бои — правим го.
  if (contract !== 'all-trumps') {
    const dangerSuits = getOpponentBidSuits(seat, state)
    if (dangerSuits.size > 0) {
      const nonTrumps = nonTrumpCards(validCards, trumpSuit, contract)
      const safeNonTrumps = nonTrumps.filter(c => !dangerSuits.has(c.suit))
      if (safeNonTrumps.length > 0) {
        // Водим с най-привлекателната безопасна боя
        const suitScores = ALL_SUITS
          .filter(s => s !== trumpSuit && !dangerSuits.has(s))
          .map(s => ({
            suit: s,
            score: suitAttractiveness(s, seat, state, trumpSuit, contract),
            cards: bySuit(safeNonTrumps, s),
          }))
          .filter(x => x.cards.length > 0)
          .sort((a, b) => b.score - a.score)
        if (suitScores.length > 0) {
          for (const suitScore of suitScores) {
            const leadCard = chooseSafePlainSuitLead(
              suitScore.cards,
              seat,
              state,
              trumpSuit,
              contract,
            )
            if (leadCard) return leadCard
          }
        }
      }
    }
  }

  // ── Rule 4а: Всичко коз — различна стратегия за ОБЯВИТЕЛЕН и ЗАЩИТЕН отбор
  if (contract === 'all-trumps') {
    const partner = getPartnerSeat(seat)
    const winningBid = state.bidding.winningBid
    const botTeamDeclared =
      winningBid?.seat === seat || winningBid?.seat === partner

    if (botTeamDeclared) {
      // ── А-СИГНАЛ: Ако имаме А + нещо друго в боя (без Вале) и противникът има Вале
      //    → Тръгваме с А за да го принудим да изиграе Валето.
      //    Останалите карти от боята стават властни след излизането на Валето.
      //    Сигнал към партньора: "Пази карта от тази боя — ще ти трябва за да ми върнеш."
      for (const suit of ALL_SUITS) {
        const suitCards = bySuit(validCards, suit)
        const hasA = suitCards.some(c => c.rank === 'A')
        const hasOther = suitCards.some(c => c.rank !== 'A')
        const hasJ = suitCards.some(c => c.rank === 'J')
        if (!hasA || !hasOther || hasJ) continue

        // Fair: J не е изиграно и не е в нашата ръка → вероятно е у противника
        const played = allPlayedCards(state)
        const jIsPlayed = played.some(c => c.suit === suit && c.rank === 'J')
        if (!jIsPlayed) {
          return suitCards.find(c => c.rank === 'A')!
        }
      }

      // ── ОБЯВИТЕЛЕН отбор: играй от най-дългия цвят отгоре надолу,
      //    само ако картата е ВЛАСТНА или партньорът покрива с властна.
      //    Пример: J, 9, 7 → J (властна) → 9 (властна) → 7 (само ако властна или партньор покрива)
      const allTrumpsSuitGroups = ALL_SUITS
        .map(s => ({ suit: s, cards: bySuit(validCards, s) }))
        .filter(g => g.cards.length > 0)
        .sort((a, b) => {
          if (b.cards.length !== a.cards.length) return b.cards.length - a.cards.length
          const aTop = cardPower(highestCard(a.cards, trumpSuit, contract), trumpSuit, contract)
          const bTop = cardPower(highestCard(b.cards, trumpSuit, contract), trumpSuit, contract)
          return bTop - aTop
        })

      for (const group of allTrumpsSuitGroups) {
        const top = highestCard(group.cards, trumpSuit, contract)
        const topIsMaster = isCardMaster(top, seat, state, trumpSuit, contract)
        if (topIsMaster) {
          return top
        }
      }

      // ── ВРЪЩАНЕ НА А-СИГНАЛНАТА БОЯ: ако партньорът е дал А-сигнал
      //    и нямаме властни карти → връщаме неговата боя
      const aSignaledSuit = getPartnerASignaledSuit(seat, state)
      if (aSignaledSuit) {
        const aSignaledCards = bySuit(validCards, aSignaledSuit)
        if (aSignaledCards.length > 0) {
          return highestCard(aSignaledCards, trumpSuit, contract)
        }
      }

      const signaledSuit = partnerSignaledSuit(seat, state, trumpSuit)
      if (signaledSuit) {
        const signaledCards = bySuit(validCards, signaledSuit)
        if (signaledCards.length > 0) {
          return highestCard(signaledCards, trumpSuit, contract)
        }
      }

      // Никой цвят не е безопасен → най-ниската карта (не даряваме 9-ки)
      return lowestCard(validCards, trumpSuit, contract)

    } else {
      // ── ЗАЩИТЕН отбор срещу всичко коз:
      //
      //    При всичко коз J е най-силен (power=7), след него 9 (power=6).
      //    Грешката: да водиш с 9 когато противникът има J → той взима взятката.
      //
      //    Правилна стратегия:
      //    1. Ако имаш J в цвят → води с J (сигурна взятка)
      //    2. Ако имаш 9 и тя е ВЛАСТНА (J вече изиграно) → води с 9
      //    3. Ако имаш 9 но J е у противника → води с НАЙ-МАЛКАТА карта от същия цвят
      //       (принуждаваш противника да изиграе J, след което 9-ката става властна)
      //    4. Иначе → най-малка карта изобщо (не даряваме ценни карти)

      // Стъпка 1: имаме ли J? → Задължително J
      const jacksInHand = validCards.filter(c => c.rank === 'J')
      if (jacksInHand.length > 0) {
        // Избираме J от цвят, в който нямаме 9 (запазваме цветовете с J+9 за по-нататък)
        const jackWithoutNine = jacksInHand.find(j => {
          const suitCards = bySuit(validCards, j.suit)
          return !suitCards.some(c => c.rank === '9')
        })
        return jackWithoutNine ?? jacksInHand[0]!
      }

      // Стъпка 2: имаме ли 9, която е ВЛАСТНА (J вече изиграно)?
      const masterNines = validCards.filter(c =>
        c.rank === '9' && isCardMaster(c, seat, state, trumpSuit, contract)
      )
      if (masterNines.length > 0) {
        return masterNines[0]!
      }

      // Стъпка 3: имаме ли 9 без J → водим с НАЙ-МАЛКАТА карта от същия цвят
      //   за да изпием Валето на противника
      const ninesWithoutJ = validCards.filter(c => {
        if (c.rank !== '9') return false
        const suitCards = bySuit(validCards, c.suit)
        return !suitCards.some(sc => sc.rank === 'J')
      })

      if (ninesWithoutJ.length > 0) {
        // Fair: ако J не е изиграно и не е в нашата ръка → вероятно е у противника.
        // Водим с най-малката карта за да принудим J да излезе.
        const played = allPlayedCards(state)
        for (const nine of ninesWithoutJ) {
          const jIsPlayed = played.some(c => c.suit === nine.suit && c.rank === 'J')
          if (!jIsPlayed) {
            const suitCards = bySuit(validCards, nine.suit)
            return lowestCard(suitCards, trumpSuit, contract)
          }
        }
      }

      // Стъпка 4: нямаме нито J, нито атакуваща 9 → играем най-малката карта
      return lowestCard(validCards, trumpSuit, contract)
    }
  }

  // ── Rule 4: Attack best non-trump suit (score by attractiveness)
  const nonTrumps = nonTrumpCards(validCards, trumpSuit, contract)
  if (nonTrumps.length > 0) {
    const suitScores = ALL_SUITS
      .filter(s => s !== trumpSuit)
      .map(s => ({
        suit: s,
        score: suitAttractiveness(s, seat, state, trumpSuit, contract),
        cards: bySuit(nonTrumps, s),
      }))
      .filter(x => x.cards.length > 0)
      .sort((a, b) => b.score - a.score)

    if (suitScores.length > 0) {
      for (const suitScore of suitScores) {
        // Lead with the highest safe card in the best suit. Avoid opening a plain 10
        // while the ace is still unknown.
        const leadCard = chooseSafePlainSuitLead(
          suitScore.cards,
          seat,
          state,
          trumpSuit,
          contract,
        )
        if (leadCard) return leadCard
      }
    }
  }

  // ── Rule 5: Fallback — lowest card
  return lowestCard(validCards, trumpSuit, contract)
}

// ─── Opponent threat check ────────────────────────────────────────────────────

/**
 * Проверява дали НЯКОЙ от оставащите противници в тази взятка
 * може да бие текущо водещата карта.
 *
 * Тъй като сме на сървъра, знаем всички ръце — проверяваме точно!
 * Ако дори ЕДИН противник има карта, която би спечелила → не сме сигурни.
 */
function canAnyRemainingOpponentBeat(
  seat: Seat,
  state: ServerAuthoritativeGameState,
): boolean {
  const plays = state.playing?.currentTrick?.plays ?? []
  const winningBid = state.bidding.winningBid

  // Кои места са изиграли вече в тази взятка (включително текущия бот)
  const playedSeats = new Set([...plays.map((p: ServerTrickPlay) => p.seat), seat])

  // Оставащи противници (не са играли още)
  const [opp1, opp2] = getOpponentSeats(seat)
  const remainingOpponents = ([opp1, opp2] as Seat[]).filter(s => !playedSeats.has(s))

  if (remainingOpponents.length === 0) return false

  // За всеки оставащ противник — има ли карта, която би спечелила взятката?
  for (const oppSeat of remainingOpponents) {
    const oppHand = state.hands[oppSeat] ?? []
    for (const card of oppHand) {
      // Симулираме: ако противникът изиграе тази карта, ще спечели ли?
      const testPlays: ServerTrickPlay[] = [...plays, { seat: oppSeat, card }]
      const testWinner = getServerTrickWinner(testPlays, winningBid)
      if (testWinner?.seat === oppSeat) return true
    }
  }

  return false
}

// ─── Following strategy ───────────────────────────────────────────────────────

/**
 * Точкова стойност на карта за "набиване" — колко точки допринася към взятката.
 * Набиваме картата с НАЙ-ВИСОКА стойност.
 */
function dumpValue(card: ServerCard, trumpSuit: ServerSuit | null, contract: Contract): number {
  if (contract === 'suit' && card.suit === trumpSuit) {
    switch (card.rank) {
      case 'J': return 20
      case '9': return 14
      case 'A': return 11
      case '10': return 10
      case 'K': return 4
      case 'Q': return 3
      default: return 0
    }
  }
  switch (card.rank) {
    case 'A': return 11
    case '10': return 10
    case 'K': return 4
    case 'Q': return 3
    case 'J': return 2
    default: return 0
  }
}

/**
 * "Набиване" — когато партньорът прибира взятката СИГУРНО и ботът е чист на боята,
 * вместо да чисти с ниска карта, хвърля НАЙ-ЦЕННАТА властна карта от своя цвят.
 *
 * Условия:
 * 1. Партньорът ще вземе взятката сигурно
 * 2. Ботът е чист на водената боя (validCards съдържа чужди бои)
 * 3. Ботът има 2+ властни карти в ЕДИН цвят (може да набие едната и да задържи другата)
 *
 * Логика: ако имам A + 10 на купа (и двете властни), набивам A сега (11 точки за партньора),
 * а 10 запазвам — тя пак ще вземе своята взятка по-нататък.
 * При 3-4 властни карти в цвета — пак набиваме най-ценната.
 *
 * Забележка: при козова игра НЕ набиваме козовите J и 9 — те контролират играта.
 */
function tryDumpHighValueMaster(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  const plays = state.playing?.currentTrick?.plays ?? []
  const ledSuit = plays[0]?.card.suit ?? null

  // Ботът е чист на водената боя?
  if (!ledSuit) return null
  const botHasLedSuit = (state.hands[seat] ?? []).some(c => c.suit === ledSuit)
  if (botHasLedSuit) return null

  // При козова игра не набиваме козовия J и 9 (контролни карти)
  const candidateCards = validCards.filter(c => {
    if (c.suit === ledSuit) return false
    if (contract === 'suit' && c.suit === trumpSuit && (c.rank === 'J' || c.rank === '9')) return false
    return true
  })

  // За всеки цвят проверяваме ТОЧНОТО условие за набиване:
  //
  // Условие 1: НАЙ-НИСКАТА карта в цвета е ВЛАСТНА
  //   → целият цвят е изчерпан у противниците, дори 7-цата е гарантирана взятка
  //
  // Условие 2: След като набием кандидата, остава поне още ЕДНА ВЛАСТНА карта в цвета
  //   → не жертваме властна карта без да оставим друга за по-нататък
  //
  // Пример А♥ + 10♥ + 7♥ (всички властни):
  //   - Най-ниска = 7♥ → властна ✓
  //   - Набиваме A♥ → остават 10♥ (властна) + 7♥ (властна) ✓ → НАБИВАМЕ A♥
  //
  // Пример А♥ + 7♥ (и двете властни):
  //   - Най-ниска = 7♥ → властна ✓
  //   - Набиваме А♥ → остава само 7♥ (властна) ✓ → НАБИВАМЕ А♥
  //
  // Пример А♥ + 10♥ + 7♥, но 7♥ НЕ е властна (противник има 8♥):
  //   - Най-ниска = 7♥ → НЕ е властна ✗ → НЕ набиваме (пазим А за защита)

  let bestCard: ServerCard | null = null
  let bestValue = -1

  for (const suit of ALL_SUITS) {
    if (suit === ledSuit) continue

    const suitCards = bySuit(candidateCards, suit)
    if (suitCards.length === 0) continue

    // Всички карти в цвета от ръката (включително некандидати като коз J/9)
    const allSuitCardsInHand = bySuit(state.hands[seat] ?? [], suit)

    // Условие 1: най-ниската карта в цвета е властна
    const lowestInSuit = lowestCard(allSuitCardsInHand, trumpSuit, contract)
    if (!isCardMaster(lowestInSuit, seat, state, trumpSuit, contract)) continue

    // Намираме кандидата за набиване: властната карта с НАЙ-ВИСОКА стойност
    const masters = suitCards.filter(c => isCardMaster(c, seat, state, trumpSuit, contract))
    if (masters.length === 0) continue

    const candidate = masters.reduce((best, c) =>
      dumpValue(c, trumpSuit, contract) > dumpValue(best, trumpSuit, contract) ? c : best
    )

    // Условие 2: след набиването остава поне още 1 властна карта в цвета
    const remainingMasters = masters.filter(c => c.id !== candidate.id)
    if (remainingMasters.length === 0) continue

    // Изборен: набиваме от цвета с най-висока стойност
    const val = dumpValue(candidate, trumpSuit, contract)
    if (val > bestValue) {
      bestValue = val
      bestCard = candidate
    }
  }

  return bestCard
}

function didPartnerWinOurLowLeadWithRank(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  suit: ServerSuit,
  trumpSuit: ServerSuit | null,
  contract: Contract,
  winningRank: ServerRank,
): boolean {
  const partner = getPartnerSeat(seat)

  return (state.playing?.completedTricks ?? []).some(trick => {
    if (trick.leaderSeat !== seat) return false
    if (trick.winnerSeat !== partner) return false

    const leadCard = trick.plays[0]?.card
    if (!leadCard || leadCard.suit !== suit) return false
    if (contract === 'suit' && leadCard.suit === trumpSuit) return false
    if (leadCard.rank === winningRank) return false
    if (winningRank === 'A' && leadCard.rank === '10') return false
    if (winningRank === 'J' && leadCard.rank === '9') return false

    return trick.plays.some(play =>
      play.seat === partner &&
      play.card.suit === suit &&
      play.card.rank === winningRank
    )
  })
}

function areRemainingCardsInSuitAllMasters(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  suit: ServerSuit,
  excludeCard: ServerCard,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): boolean {
  const remainingSuitCards = (state.hands[seat] ?? []).filter(c =>
    c.suit === suit && c.id !== excludeCard.id
  )

  return remainingSuitCards.length > 0 &&
    remainingSuitCards.every(c => isCardMaster(c, seat, state, trumpSuit, contract))
}

function chooseFollowUpCardOnReturnedBaitSuit(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  const plays = state.playing?.currentTrick?.plays ?? []
  const ledSuit = plays[0]?.card.suit ?? null
  if (!ledSuit || ledSuit === trumpSuit) return null
  if (plays[0]?.seat !== getPartnerSeat(seat)) return null

  const winningRank: ServerRank = contract === 'all-trumps' ? 'J' : 'A'
  const followUpRank: ServerRank = contract === 'all-trumps' ? '9' : '10'
  const followUpCard = validCards.find(c =>
    c.suit === ledSuit && c.rank === followUpRank
  ) ?? null
  if (!followUpCard) return null

  if (
    !didPartnerWinOurLowLeadWithRank(
      seat,
      state,
      ledSuit,
      trumpSuit,
      contract,
      winningRank,
    )
  ) {
    return null
  }

  if (areRemainingCardsInSuitAllMasters(seat, state, ledSuit, followUpCard, trumpSuit, contract)) {
    return null
  }

  return followUpCard
}

function chooseNonTrumpDiscardWhenCannotOvertrump(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  if (contract !== 'suit' || !trumpSuit) return null

  const plays = state.playing?.currentTrick?.plays ?? []
  const currentWinner = getServerTrickWinner(plays, state.bidding.winningBid)
  if (!currentWinner) return null
  if (currentWinner.seat === seat || currentWinner.seat === getPartnerSeat(seat)) return null
  if (currentWinner.card.suit !== trumpSuit) return null

  const higherTrumps = validCards.filter(c =>
    c.suit === trumpSuit && TRUMP_POWER[c.rank] > TRUMP_POWER[currentWinner.card.rank]
  )
  if (higherTrumps.length > 0) return null

  const nonTrumps = validCards.filter(c => c.suit !== trumpSuit)
  if (nonTrumps.length === 0) return null

  return safeDiscard(nonTrumps, state.hands[seat] ?? [], trumpSuit, contract)
}

function chooseLowTrumpToProtectNineOnPartnerTrumpLead(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard | null {
  if (contract !== 'suit' || !trumpSuit) return null

  const plays = state.playing?.currentTrick?.plays ?? []
  if (plays[0]?.seat !== getPartnerSeat(seat)) return null

  const currentWinner = getServerTrickWinner(plays, state.bidding.winningBid)
  if (currentWinner?.seat !== getPartnerSeat(seat)) return null
  if (currentWinner.card.suit !== trumpSuit) return null

  const validTrumps = validCards.filter(c => c.suit === trumpSuit)
  const hasNine = validTrumps.some(c => c.rank === '9')
  if (!hasNine) return null

  const lowerTrumps = validTrumps.filter(c => c.rank !== '9')
  if (lowerTrumps.length === 0) return null

  return lowestCard(lowerTrumps, trumpSuit, contract)
}

function chooseFollow(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard {
  const lastToPlay = isLastToPlay(seat, state)
  const hand = state.hands[seat] ?? []

  // При всичко коз: проверяваме дали партньорът е дал А-сигнал
  // → пазим последната карта от тази боя при чистване
  const aSignaledSuit = contract === 'all-trumps'
    ? getPartnerASignaledSuit(seat, state)
    : null

  // ── Case А0: Партньорът е ВОДЕЩ и ние можем да вземем с J/A ─────────────
  //
  //   Правило: ако партньорът е тръгнал пръв в тази взятка и ние можем да
  //   вземем с Вале (всичко коз) или Асо (безкоз) → ВЗИМАМЕ с него.
  //   После: изиграваме собствените властни карти → връщаме в партньорската боя.
  //
  //   Защо: партньорът играе дълъг цвят. Като вземем сега, можем да изиграем
  //   властните си карти (да трупаме точки) и после да му върнем в неговия цвят.
  const plays = state.playing?.currentTrick?.plays ?? []
  const partnerIsLeader = plays.length > 0 && plays[0]!.seat === getPartnerSeat(seat)

  const lowTrumpToProtectNine = chooseLowTrumpToProtectNineOnPartnerTrumpLead(
    seat,
    state,
    validCards,
    trumpSuit,
    contract,
  )
  if (lowTrumpToProtectNine) {
    return lowTrumpToProtectNine
  }

  const returnedBaitFollowUpCard = chooseFollowUpCardOnReturnedBaitSuit(
    seat,
    state,
    validCards,
    trumpSuit,
    contract,
  )
  if (returnedBaitFollowUpCard) {
    return returnedBaitFollowUpCard
  }

  const nonTrumpDiscardWhenCannotOvertrump = chooseNonTrumpDiscardWhenCannotOvertrump(
    seat,
    state,
    validCards,
    trumpSuit,
    contract,
  )
  if (nonTrumpDiscardWhenCannotOvertrump) {
    return nonTrumpDiscardWhenCannotOvertrump
  }

  if (partnerIsLeader && isMyTeamCurrentlyWinning(seat, state)) {
    const ledSuit = plays[0]!.card.suit

    if (contract === 'all-trumps') {
      // Вземаме с Вале ако имаме Вале в тази боя
      const jackInSuit = validCards.find(c => c.suit === ledSuit && c.rank === 'J')
      if (jackInSuit) return jackInSuit
    }

    if (contract === 'no-trumps') {
      // Вземаме с Асо ако имаме Асо в тази боя
      const aceInSuit = validCards.find(c => c.suit === ledSuit && c.rank === 'A')
      if (aceInSuit) return aceInSuit
    }
  }

  // ── Case A: Нашият отбор печели ──────────────────────────────────────────
  if (isMyTeamCurrentlyWinning(seat, state)) {
    // Последен на ход и отборът печели → чистим безопасно (не оголваме 9)
    if (lastToPlay) {
      return safeDiscard(validCards, hand, trumpSuit, contract, aSignaledSuit)
    }

    // Партньорът ще прибере СИГУРНО?
    if (!canAnyRemainingOpponentBeat(seat, state)) {
      // ── Набиване: ако сме чисти и имаме 2+ властни в един цвят → хвърляме най-ценната
      const dumpCard = tryDumpHighValueMaster(seat, state, validCards, trumpSuit, contract)
      if (dumpCard) {
        return dumpCard
      }

      // Иначе → сигнализираме (или чистим ниско в безкоз)
      return discardSignal(seat, state, validCards, trumpSuit, contract)
    } else {
      // Противник може да бие → чистим безопасно (пазим 9-ките и А-сигналната боя)
      return safeDiscard(validCards, hand, trumpSuit, contract, aSignaledSuit)
    }
  }

  // ── Case B: Противник печели — опитваме се да биeм ───────────────────────
  const beating = lowestBeatingCard(validCards, state, trumpSuit, contract)
  if (beating) {
    return beating
  }

  // Не можем да бием → чистим безопасно (не оголваме 9, пазим А-сигналната боя)
  return safeDiscard(validCards, hand, trumpSuit, contract, aSignaledSuit, allPlayedCards(state))
}

// ─── Signal discard ───────────────────────────────────────────────────────────

/**
 * When partner is winning and we're not the last player,
 * we choose what to discard.
 *
 * В безкоз — чистим с НИСКА карта (пазим асовете и десетките).
 * При боя/всичко коз — сигнализираме с висока карта САМО АКО:
 *   1. Партньорът ще прибере СИГУРНО (вече проверено в chooseFollow)
 *   2. Останалите карти в ръката след сигнала са ВСИЧКИ властни (100% сигурни взятки)
 * Иначе чистим ниско.
 */

/**
 * Карта е "властна" (sure winner) ако никой противник не може да я бие:
 * - В безкоз: най-висока останала карта в боята
 * - В боя (коз): ако е коз — най-висок останал коз; ако не е коз — най-висока в боята
 *   И никой противник не е чист на тази боя с налични козове
 * - В всичко коз: най-висока останала карта в боята (по козов ред)
 */
function isNoTrumpsCardMaster(
  card: ServerCard,
  hand: ServerCard[],
  played: ServerCard[],
): boolean {
  // Fair: при безкоз картата е властна само ако всички по-високи карти
  // в същата боя са или в нашата ръка, или вече са изиграни.
  // Не гледаме скритите ръце на противниците.
  for (const rank of Object.keys(NO_TRUMP_POWER) as ServerRank[]) {
    if (NO_TRUMP_POWER[rank] <= NO_TRUMP_POWER[card.rank]) continue
    const inMyHand = hand.some(c => c.suit === card.suit && c.rank === rank)
    const wasPlayed = played.some(c => c.suit === card.suit && c.rank === rank)
    if (!inMyHand && !wasPlayed) return false
  }

  return true
}

function isCardMaster(
  card: ServerCard,
  seat: Seat,
  state: ServerAuthoritativeGameState,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): boolean {
  if (contract === 'no-trumps') {
    return isNoTrumpsCardMaster(card, state.hands[seat] ?? [], allPlayedCards(state))
  }

  if (contract === 'all-trumps') {
    // Fair: властна ако всяка по-висока карта е в нашата ръка или вече изиграна
    const played = allPlayedCards(state)
    const myHand = state.hands[seat] ?? []
    for (const rank of Object.keys(TRUMP_POWER) as ServerRank[]) {
      if (TRUMP_POWER[rank] <= TRUMP_POWER[card.rank]) continue
      const inMyHand = myHand.some(c => c.suit === card.suit && c.rank === rank)
      const wasPlayed = played.some(c => c.suit === card.suit && c.rank === rank)
      if (!inMyHand && !wasPlayed) return false
    }
    return true
  }

  const [opp1, opp2] = getOpponentSeats(seat)
  const opponentHands = [...(state.hands[opp1] ?? []), ...(state.hands[opp2] ?? [])]

  // Козова игра (suit contract)
  if (card.suit === trumpSuit) {
    // Козова карта: властна ако никой противник няма по-висок коз
    return !opponentHands.some(c =>
      c.suit === trumpSuit && TRUMP_POWER[c.rank] > TRUMP_POWER[card.rank]
    )
  }

  // Некозова карта в козова игра:
  // Властна само ако: (1) никой противник няма по-висока в боята
  //                  (2) никой противник не е чист на тази боя И има козове
  const hasHigherSameSuit = opponentHands.some(c =>
    c.suit === card.suit && NO_TRUMP_POWER[c.rank] > NO_TRUMP_POWER[card.rank]
  )
  if (hasHigherSameSuit) return false

  // Проверяваме дали противник може да цака (чист на боята + има коз)
  for (const oppSeat of [opp1, opp2] as Seat[]) {
    const oppHand = state.hands[oppSeat] ?? []
    const voidInSuit = !oppHand.some(c => c.suit === card.suit)
    const hasTrump = trumpSuit ? oppHand.some(c => c.suit === trumpSuit) : false
    if (voidInSuit && hasTrump) return false
  }

  return true
}

/**
 * Проверява дали ВСИЧКИ карти в ръката (без excludeCard) са властни.
 */
function areRemainingCardsAllMasters(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  excludeCard: ServerCard,
  trumpSuit: ServerSuit | null,
  contract: Contract,
): boolean {
  const remaining = (state.hands[seat] ?? []).filter(c => c.id !== excludeCard.id)
  return remaining.every(c => isCardMaster(c, seat, state, trumpSuit, contract))
}

/**
 * Проверява дали дадена боя е "контролирана" при Всичко коз.
 *
 * Контролирана боя = ботът може да вземе взятката когато тя е водена:
 *   - имаме J в боята (J е най-силен → контролираме цялата боя)
 *   - или J е вече изиграно И имаме 9 (9 е сега най-силна → контролираме)
 *
 * Картите в контролиран цвят са "пазени" и не се чистят преди
 * по-опасни карти от неконтролирани цветове.
 */
function isAllTrumpsControlledSuit(
  suit: ServerSuit,
  hand: ServerCard[],
  played: ServerCard[],
): boolean {
  const suitHand = hand.filter(c => c.suit === suit)
  if (suitHand.some(c => c.rank === 'J')) return true
  const jPlayed = played.some(c => c.suit === suit && c.rank === 'J')
  return jPlayed && suitHand.some(c => c.rank === '9')
}

function discardSignal(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  validCards: ServerCard[],
  trumpSuit: ServerSuit | null,
  contract: Contract,
): ServerCard {
  const nonTrumps = nonTrumpCards(validCards, trumpSuit, contract)

  // ── В БЕЗКОЗ: пазим всичко ценно, чистим с най-ниската безполезна карта
  if (contract === 'no-trumps') {
    const hand = state.hands[seat] ?? []
    const useless = validCards.filter(c => NO_TRUMP_POWER[c.rank] <= 2 && !wouldBareNine(c, hand))
    if (useless.length > 0) {
      return lowestCard(useless, trumpSuit, contract)
    }
    return safeDiscard(validCards, hand, trumpSuit, contract)
  }

  // ── ПРИ БОЯ / ВСИЧКО КОЗ:
  // Сигнализираме с висока карта САМО АКО останалите карти са ВСИЧКИ властни.
  // Иначе чистим ниско — не разкриваме ръката си преждевременно.

  if (nonTrumps.length === 0) {
    // Само козове — чистим безопасно
    return safeDiscard(validCards, state.hands[seat] ?? [], trumpSuit, contract)
  }

  // Намираме кандидата за сигнал: най-висока некозова карта (без Асо)
  const suitGroups = ALL_SUITS
    .filter(s => s !== trumpSuit)
    .map(s => ({ suit: s, cards: bySuit(nonTrumps, s) }))
    .filter(g => g.cards.length > 0)
    .sort((a, b) => {
      const aCards = a.cards.filter(c => c.rank !== 'A')
      const bCards = b.cards.filter(c => c.rank !== 'A')
      const aHigh = aCards.length > 0
        ? cardPower(highestCard(aCards, trumpSuit, contract), trumpSuit, contract)
        : -1
      const bHigh = bCards.length > 0
        ? cardPower(highestCard(bCards, trumpSuit, contract), trumpSuit, contract)
        : -1
      return bHigh - aHigh
    })

  if (suitGroups.length > 0) {
    const best = suitGroups[0]!
    const nonAceCards = best.cards.filter(c => c.rank !== 'A')

    if (nonAceCards.length > 0) {
      const signalCandidate = highestCard(nonAceCards, trumpSuit, contract)

      // КЛЮЧОВА ПРОВЕРКА: сигнализираме само ако ВСИЧКИ останали карти са властни
      if (areRemainingCardsAllMasters(seat, state, signalCandidate, trumpSuit, contract)) {
        return signalCandidate
      }
    }
  }

  // Останалите карти не са всички властни → чистим безопасно (не оголваме 9)
  return safeDiscard(validCards, state.hands[seat] ?? [], trumpSuit, contract)
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function pickServerBotPlayCard(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerCard | null {
  const validCards = getServerValidPlayCards(state, seat)

  if (validCards.length === 0) {
    return state.hands[seat]?.[0] ?? null
  }

  if (validCards.length === 1) {
    return validCards[0]!
  }

  const winningBid = state.bidding.winningBid
  const contract: Contract = winningBid?.contract ?? 'no-trumps'
  const trumpSuit: ServerSuit | null =
    contract === 'suit' ? (winningBid?.trumpSuit ?? null) : null

  const plays = state.playing?.currentTrick?.plays ?? []
  const isLeading = plays.length === 0

  if (isLeading) {
    return chooseLead(seat, state, validCards, trumpSuit, contract)
  }

  return chooseFollow(seat, state, validCards, trumpSuit, contract)
}
