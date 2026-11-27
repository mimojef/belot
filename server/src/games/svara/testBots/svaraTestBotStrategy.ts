// ВРЕМЕННО — минимална тестова стратегия за ботовете в Свара.
// Виж docs/svara-test-bots-local.md.
//
// Чиста функция: решава САМО по защитения индивидуален snapshot на бота
// (`runtime.getPlayerSnapshot(botId)` — същото, което получава човек-клиент).
// Там собствените карти са налични едва след „Погледни“, чуждите — никога,
// а позволените действия (`you.betting`) идват от engine само на хода на
// бота. Стратегията не съдържа правила — engine валидира всяко действие.
//
// Целта е разнообразна, правдоподобна игра за тестване, а не сила:
// претеглен случаен избор според силата на собствената ръка, без режим
// „винаги плащай/бягай/ол-ин“.

import type { SvaraBettingOptions } from '../engine/svaraBetting.js'
import { parseSvaraCardCode } from '../engine/svaraCards.js'
import { evaluateSvaraHand } from '../engine/svaraHandEvaluation.js'
import type { SvaraMatchSnapshotMessage } from '../protocol/svaraSnapshotProtocol.js'
import type { SvaraParticipantCommand } from '../runtime/svaraMatchRuntime.js'

export type SvaraTestBotCommand = Extract<SvaraParticipantCommand, {
  type: 'look' | 'act' | 'svara-join' | 'svara-decline' | 'request-return' | 'exit' | 'reveal-cards' | 'hide-cards'
}>

type Strength = 'weak' | 'medium' | 'good' | 'strong'

/** Има ли ботът решение за взимане в това състояние (детерминистично — без случайност). */
export function svaraTestBotHasDecision(snapshot: SvaraMatchSnapshotMessage): boolean {
  if (snapshot.phase !== 'in-progress') return false
  const you = snapshot.you
  if (you.status === 'absent') return !you.returnPending
  if (you.status !== 'active') return false
  if (you.revealChoice?.canDecide) return true
  if (you.svaraDecision === 'undecided') return true
  return snapshot.toActId === you.playerId && you.betting?.canAct === true
}

function handStrength(cards: readonly string[] | null): Strength | null {
  if (!cards || cards.length !== 3) return null
  const points = evaluateSvaraHand(cards.map(parseSvaraCardCode)).points
  if (points >= 29) return 'strong'
  if (points >= 24) return 'good'
  if (points >= 20) return 'medium'
  return 'weak'
}

function pickWeighted<T>(entries: Array<[T, number]>, random: () => number): T | null {
  const usable = entries.filter(([, weight]) => weight > 0)
  const total = usable.reduce((sum, [, weight]) => sum + weight, 0)
  if (total <= 0) return null
  let roll = random() * total
  for (const [value, weight] of usable) {
    roll -= weight
    if (roll < 0) return value
  }
  return usable[usable.length - 1]![0]
}

function raiseTotal(range: { min: number; max: number }, strength: Strength, random: () => number): number {
  const spread = strength === 'strong' ? 1.5 : strength === 'good' ? 0.75 : 0.35
  const total = range.min + Math.floor(random() * range.min * spread)
  return Math.max(range.min, Math.min(range.max, total))
}

function decideBetting(snapshot: SvaraMatchSnapshotMessage, options: SvaraBettingOptions, random: () => number): SvaraTestBotCommand | null {
  const you = snapshot.you
  // Непогледнал: понякога залог на тъмно, обикновено „Погледни“.
  if (!you.looked && options.lookRequired) {
    // 27.11.2026: изравнен двоен тъмен залог — понякога „Оставам на тъмно“.
    if (options.stayBlind && random() < 0.35) return { type: 'act', action: { kind: 'stay-blind' } }
    if (options.blindBet && random() < 0.12) return { type: 'act', action: { kind: 'blind-bet', total: options.blindBet.min } }
    return { type: 'look' }
  }
  // Заключен тъмен играч (без поглеждане) не знае ръката си — средна сила.
  const strength = handStrength(you.cards) ?? 'medium'
  const stack = snapshot.seats.find((seat) => seat.playerId === you.playerId)?.stack ?? 0
  const expensive = options.call !== null && stack > 0 && options.call > stack * 0.5
  // Без друг начин да продължи освен ол-ин (къс стек) — само при прилична ръка.
  const allInOnly = options.allIn !== null && options.call === null && options.bet === null && !options.noBet
  const weights: Record<Strength, { fold: number; noBet: number; call: number; bet: number; allIn: number }> = {
    weak: { fold: 0.45, noBet: 0.4, call: 0.35, bet: 0.07, allIn: 0 },
    medium: { fold: 0.2, noBet: 0.35, call: 0.5, bet: 0.15, allIn: 0.02 },
    good: { fold: 0.07, noBet: 0.15, call: 0.45, bet: 0.4, allIn: 0.05 },
    strong: { fold: 0, noBet: 0.05, call: 0.3, bet: 0.5, allIn: 0.15 },
  }
  const w = weights[strength]
  type Choice = 'fold' | 'noBet' | 'call' | 'bet' | 'allIn'
  const choice = pickWeighted<Choice>([
    // Да бяга, когато може безплатно „без залог“, е безсмислено.
    ['fold', options.fold ? (options.noBet ? 0.02 : w.fold + (expensive && strength !== 'strong' ? 0.2 : 0)) : 0],
    ['noBet', options.noBet ? w.noBet : 0],
    ['call', options.call !== null ? w.call : 0],
    ['bet', options.bet ? w.bet : 0],
    ['allIn', options.allIn !== null ? (allInOnly ? (strength === 'weak' ? 0.1 : 0.45) : w.allIn) : 0],
  ], random)
  switch (choice) {
    case 'fold': return { type: 'act', action: { kind: 'fold' } }
    case 'noBet': return { type: 'act', action: { kind: 'no-bet' } }
    case 'call': return { type: 'act', action: { kind: 'call' } }
    case 'bet': return { type: 'act', action: { kind: 'bet', total: raiseTotal(options.bet!, strength, random) } }
    case 'allIn': return { type: 'act', action: { kind: 'all-in' } }
    default:
      if (options.fold) return { type: 'act', action: { kind: 'fold' } }
      return null
  }
}

/** Конкретното решение. null — нищо за правене (или изчакване). */
export function decideSvaraTestBotCommand(snapshot: SvaraMatchSnapshotMessage, random: () => number = Math.random): SvaraTestBotCommand | null {
  if (!svaraTestBotHasDecision(snapshot)) return null
  const you = snapshot.you
  if (you.status === 'absent') return { type: 'request-return' }
  if (you.revealChoice?.canDecide) return { type: random() < 0.5 ? 'reveal-cards' : 'hide-cards' }
  if (you.svaraDecision === 'undecided') {
    const round = snapshot.round
    const fee = round?.kind === 'svara-joining' ? round.fee : 0
    const stack = snapshot.seats.find((seat) => seat.playerId === you.playerId)?.stack ?? 0
    const joinChance = stack > 0 && fee <= stack * 0.3 ? 0.55 : 0.3
    return { type: random() < joinChance ? 'svara-join' : 'svara-decline' }
  }
  return you.betting ? decideBetting(snapshot, you.betting, random) : null
}
