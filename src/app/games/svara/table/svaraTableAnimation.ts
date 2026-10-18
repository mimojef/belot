// Свара — анимация на раздаването (Вход + карти), Етап 2Б.3.7.5, задание
// §3/§4/§5. Чиста функция, НУЛЕВА игрова логика: входът е вече потвърденото
// сървърно състояние (round.dealing/round.participants/round.dealerId/
// round.contributions/timing.deadlines) + абсолютно сървърно "сега"
// (sharedServerClock, виж serverClock.ts) — изходът е само презентационни
// прогрес-стойности. НИКОГА локален "старт" timestamp: при всяко извикване
// прогресът се извежда наново от absolute deadlineAt (dealing дедлайна) минус
// действителната продължителност (svaraDealingAnimationMs-еквивалент тук,
// задание §5), точно както computeSvaraRingState прави за turn пръстена —
// затова reconnect/rerender/duplicate snapshot никога не рестартират или
// повтарят анимацията (задание §7/§14).
//
// Продължителности (засега временни, виж server/src/games/svara/runtime/
// svaraDeadlines.ts): 800ms Вход + (брой участници × 3 карти × 350ms). Няма
// отделен клиентски "дублиращ" таймер — ТОВА е единственото място, което
// превежда абсолютния dealing дедлайн в 0..1 прогрес за всяка под-фаза.

import type { SvaraSnapshotRound, SvaraSnapshotSeat } from '../../../network/createGameServerClient'

/** Мирор на server/src/games/svara/runtime/svaraDeadlines.ts — виж коментара там защо е временно. */
export const SVARA_DEAL_ENTRY_ANIMATION_MS = 800
export const SVARA_DEAL_CARD_ANIMATION_MS = 350
export const SVARA_DEAL_CARDS_PER_PLAYER = 3
/** Действителна продължителност на полета на 1 карта (<= stagger интервала, за да не се застъпват визуално). */
const CARD_FLIGHT_MS = 300

export function svaraDealingAnimationMs(participantCount: number): number {
  return SVARA_DEAL_ENTRY_ANIMATION_MS + participantCount * SVARA_DEAL_CARDS_PER_PLAYER * SVARA_DEAL_CARD_ANIMATION_MS
}

export type SvaraDealingChipSprite = { seatIndex: number; progress: number }
export type SvaraDealingCardSprite = { seatIndex: number; progress: number; roundIndex: number }

export type SvaraDealingVisualState = {
  active: boolean
  /** Само докато 'entry' тече — чиповите спрайтове, летящи към банката. */
  entry: { progress: number; chips: SvaraDealingChipSprite[] } | null
  /** Само докато 'cards' тече — текущо летящата карта (ако има такава в момента). */
  flyingCard: SvaraDealingCardSprite | null
  /** Колко карти на всяко място вече са "кацнали" визуално — за override на seat.cardCount по време на анимацията. */
  landedCardCountBySeatIndex: Map<number, number>
}

const NO_ANIMATION: SvaraDealingVisualState = { active: false, entry: null, flyingCard: null, landedCardCountBySeatIndex: new Map() }

/**
 * `dealingDeadlineAt` идва от timing.deadlines (kind:'dealing').deadlineAt;
 * `participants` от round.participants (вече в реда "първият след дилъра …
 * дилърът", виж server startOrdinaryDeal/svaraStart); `seatsByPlayerId` за
 * превод playerId -> seatIndex (визуалните слотове са по seatIndex, виж
 * svaraSeatLayout.ts).
 */
export function computeSvaraDealingVisualState(
  round: SvaraSnapshotRound | null,
  dealingDeadlineAt: number | null,
  serverNow: number,
  seats: readonly SvaraSnapshotSeat[],
): SvaraDealingVisualState {
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara') || !round.dealing || dealingDeadlineAt === null) return NO_ANIMATION
  const participants = round.participants
  const n = participants.length
  if (n <= 0) return NO_ANIMATION
  const totalMs = svaraDealingAnimationMs(n)
  const startedAt = dealingDeadlineAt - totalMs
  const elapsed = Math.min(totalMs, Math.max(0, serverNow - startedAt))
  const seatIndexByPlayerId = new Map(seats.map((s) => [s.playerId, s.seatIndex]))
  // SvaraSnapshotBettingRound не носи per-player round.contributions (само
  // server-internal round-а го има) — roundContribution на SvaraSnapshotSeat
  // (вече включва Входа, виж svaraBettingBadges.ts doc коментара) е
  // единственото публично поле, с което различаваме кой реално е платил.
  const roundContributionByPlayerId = new Map(seats.map((s) => [s.playerId, s.roundContribution]))
  const payingSeatIndexes = participants
    .filter((playerId) => (roundContributionByPlayerId.get(playerId) ?? 0) > 0)
    .map((playerId) => seatIndexByPlayerId.get(playerId))
    .filter((index): index is number => index !== undefined)

  if (elapsed < SVARA_DEAL_ENTRY_ANIMATION_MS) {
    const progress = elapsed / SVARA_DEAL_ENTRY_ANIMATION_MS
    return {
      active: true,
      entry: { progress, chips: payingSeatIndexes.map((seatIndex) => ({ seatIndex, progress })) },
      flyingCard: null,
      landedCardCountBySeatIndex: new Map(),
    }
  }

  const cardsElapsed = elapsed - SVARA_DEAL_ENTRY_ANIMATION_MS
  const totalCards = n * SVARA_DEAL_CARDS_PER_PLAYER
  const landedCardCountBySeatIndex = new Map<number, number>()
  let flyingCard: SvaraDealingCardSprite | null = null
  for (let cardGlobalIndex = 0; cardGlobalIndex < totalCards; cardGlobalIndex += 1) {
    const startMs = cardGlobalIndex * SVARA_DEAL_CARD_ANIMATION_MS
    const roundIndex = Math.floor(cardGlobalIndex / n)
    const playerId = participants[cardGlobalIndex % n]!
    const seatIndex = seatIndexByPlayerId.get(playerId)
    if (seatIndex === undefined) continue
    if (cardsElapsed < startMs) break // по-късните карти в реда винаги чакат по-ранните (delayMs е монотонен)
    const localProgress = Math.min(1, (cardsElapsed - startMs) / CARD_FLIGHT_MS)
    if (localProgress >= 1) {
      landedCardCountBySeatIndex.set(seatIndex, (landedCardCountBySeatIndex.get(seatIndex) ?? 0) + 1)
    } else {
      flyingCard = { seatIndex, progress: localProgress, roundIndex }
    }
  }
  return { active: true, entry: null, flyingCard, landedCardCountBySeatIndex }
}
