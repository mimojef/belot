import type { Seat } from '../core/serverTypes.js'
import type {
  ServerCard,
  ServerCompletedTrick,
  ServerDeclaration,
  ServerTrickPlay,
  ServerWinningBid,
} from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import {
  computeServerSweepEligibility,
  legalCardsFor,
  MIN_SWEEP_REMAINING_CARDS,
  rootLeadStrength,
  type ServerSweepEligibilityHands,
} from './computeServerSweepEligibility.js'

// ============================================================================
// „Долу картите“ — гаранция от гледна точка на ЗАЯВЯВАЩИЯ (информационно
// множество), допълнение към double-dummy проверката в
// computeServerSweepEligibility.ts.
//
// Проблем (production 23.11.2026 10:01:16): double-dummy търсенето ползва
// РЕАЛНИТЕ скрити карти. Ако при реалното разпределение сваляне е сигурно,
// но заявяващият не може да го докаже от това, което знае, предложението
// само по себе си издава скритото разпределение.
//
// Правило: предложение е разрешено само ако заявяващият печели всички
// оставащи взятки (при ВСЕКИ свой ход и ВСЕКИ законен отговор — същият
// универсален квантор като double-dummy) при ВСЯКО разпределение на
// неизвестните карти, съвместимо с публичната информация:
//   • собствените му карти;
//   • всички изиграни карти и историята на законните ходове (отговаряне на
//     боя, цакане, надцакване) — изведено ЕДИНСТВЕНО чрез production
//     валидатора getServerValidPlayCards (legalCardsFor), без собствена
//     интерпретация на правилата;
//   • броя карти на всяко място;
//   • обявен и валиден Белот, от който вече е изиграна едната карта →
//     другата е задължително у обявилия.
// Публична информация, която НЕ се ползва (терца/50/100/каре само като
// етикет, обявяванията при наддаването), само РАЗШИРЯВА множеството от
// възможни разпределения → проверката става по-строга, никога по-слаба.
//
// Реалните скрити ръце се ползват само за: (1) множеството неизвестни карти
// (то е публично — допълнение на собствената ръка и изиграните карти) и броя
// им на място; (2) самопроверка, че реалното разпределение е съвместимо с
// изведените ограничения (иначе → false, fail-safe срещу rule drift). Никога
// за да се приеме, че дадена карта е у дадено място.
//
// ─── Как ─────────────────────────────────────────────────────────────────
// Вместо да се изброяват всички разпределения ((3n)!/(n!)^3 — 17M при n=6),
// се търси КОНТРАПРИМЕР: разпределение + законна поредица ходове, при която
// заявяващият губи взятка. Разпределението се фиксира мързеливо:
//   • всяко неизвестно място s има маска F_s от карти, които НЕ може да
//     държи (сега): изведени от историята + Белот;
//   • изиграна карта y от s при вече изиграни plays е законна ⇔ останалата
//     ръка на s не съдържа карта z, за която y е незаконна при ръка {y, z}
//     (валидаторът е монотонен: задълженията — отговор на боя, коз,
//     надцакване — се задействат от НАЛИЧИЕТО на конкретна карта) → F_s ∪= X;
//   • съвместимост: съществува разпределение на останалите неизвестни карти
//     по местата с точния им брой карти и без забранените — теорема на Хол за
//     3 места (8 подмножества, битови операции).
// Всеки намерен контрапример е реален (съществува съвместимо разпределение,
// в което всички ходове са законни според валидатора); липсата на
// контрапример след пълно търсене = гаранция.
//
// Бърз път: ако никоя неизвестна карта не бие никоя карта на заявяващия
// (getServerTrickWinner по двойки), гаранцията е безусловна.
//
// Производителност: лимит MAX_PUBLIC_SWEEP_SEARCH_NODES; при изчерпване →
// false (fail-safe — никога несигурно предложение).
// ============================================================================

export const MAX_PUBLIC_SWEEP_SEARCH_NODES = 200000
const MAX_INDEXED_CARDS = 32

export type ServerSweepPublicInfo = {
  // Приключилите взятки в реда на изиграване (вкл. току-що приключилата).
  completedTricks: readonly Pick<ServerCompletedTrick, 'plays'>[]
  // Ходове от текущата взятка — трябва да е празна (заявяващият води).
  currentTrickPlays: readonly ServerTrickPlay[]
  declarations: readonly ServerDeclaration[]
}

export type ServerSweepPublicGuaranteeReason =
  | 'unbeatable' // бърз път: нищо неизвестно не бие карта на заявяващия
  | 'proven' // пълно търсене без контрапример
  | 'counterexample'
  | 'guard' // лимит → fail-safe false
  | 'too-few-cards'
  | 'invalid-input'
  | 'inconsistent-history' // реалното разпределение противоречи на изведеното → fail-safe false

export type ServerSweepPublicGuaranteeOutcome = {
  result: boolean
  reason: ServerSweepPublicGuaranteeReason
  nodes: number
  guardHit: boolean
}

function popcount32(value: number): number {
  let v = value >>> 0
  v -= (v >>> 1) & 0x55555555
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function isLegalPlay(
  seat: Seat,
  hand: ServerCard[],
  card: ServerCard,
  plays: ServerTrickPlay[],
  winningBid: ServerWinningBid,
): boolean {
  return legalCardsFor(seat, hand, plays, winningBid).some((c) => c.id === card.id)
}

export function computeServerSweepPublicGuaranteeOutcome(
  params: {
    sweepSeat: Seat
    hands: ServerSweepEligibilityHands
    winningBid: ServerWinningBid
    publicInfo: ServerSweepPublicInfo
  },
  options: { maxNodes?: number } = {},
): ServerSweepPublicGuaranteeOutcome {
  const { sweepSeat, hands, winningBid, publicInfo } = params
  const maxNodes = options.maxNodes ?? MAX_PUBLIC_SWEEP_SEARCH_NODES
  const fail = (reason: ServerSweepPublicGuaranteeReason): ServerSweepPublicGuaranteeOutcome => ({
    result: false,
    reason,
    nodes: 0,
    guardHit: false,
  })

  const claimantHand = hands[sweepSeat]
  if (claimantHand.length < MIN_SWEEP_REMAINING_CARDS) return fail('too-few-cards')
  if (publicInfo.currentTrickPlays.length > 0) return fail('invalid-input')

  // Неизвестните места в реда на отговаряне след заявяващия.
  const responders: Seat[] = [getNextSeat(sweepSeat)]
  responders.push(getNextSeat(responders[0]!))
  responders.push(getNextSeat(responders[1]!))

  // ── Индексиране: собствени карти, после неизвестните в каноничен ред
  // (по id) — редът не зависи от това кой реално какво държи.
  const pool = responders.flatMap((seat) => hands[seat]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const cards: ServerCard[] = [...claimantHand, ...pool]
  if (cards.length > MAX_INDEXED_CARDS) return fail('invalid-input')
  const idToIndex = new Map<string, number>()
  for (let i = 0; i < cards.length; i += 1) {
    if (idToIndex.has(cards[i]!.id)) return fail('invalid-input')
    idToIndex.set(cards[i]!.id, i)
  }
  const bit = (index: number): number => (1 << index) >>> 0
  let claimantMask0 = 0
  for (let i = 0; i < claimantHand.length; i += 1) claimantMask0 = (claimantMask0 | bit(i)) >>> 0
  let poolMask0 = 0
  for (let i = claimantHand.length; i < cards.length; i += 1) poolMask0 = (poolMask0 | bit(i)) >>> 0
  const poolIndices: number[] = []
  for (let i = claimantHand.length; i < cards.length; i += 1) poolIndices.push(i)
  const caps0 = responders.map((seat) => hands[seat].length)

  // ── Ограничения от историята (само чрез валидатора).
  const forbid0 = [0, 0, 0]
  for (const trick of publicInfo.completedTricks) {
    for (let k = 1; k < trick.plays.length; k += 1) {
      const play = trick.plays[k]!
      const r = responders.indexOf(play.seat)
      if (r === -1) continue // заявяващият — ръката му е известна
      const prior = trick.plays.slice(0, k)
      for (const y of poolIndices) {
        if (!isLegalPlay(play.seat, [play.card, cards[y]!], play.card, prior, winningBid)) {
          forbid0[r] = (forbid0[r]! | bit(y)) >>> 0
        }
      }
    }
  }

  // ── Обявен Белот, от който вече е изиграна едната карта: другата е у
  // обявилия (публично — мастта се вижда от изиграната карта).
  for (const declaration of publicInfo.declarations) {
    if (declaration.type !== 'belote' || !declaration.announced || !declaration.valid) continue
    const owner = responders.indexOf(declaration.seat)
    if (owner === -1) continue
    const ids = declaration.cardIds
    const isRevealed = ids.some((id) => !idToIndex.has(id))
    if (!isRevealed) continue
    for (const id of ids) {
      const index = idToIndex.get(id)
      if (index === undefined || ((poolMask0 >>> index) & 1) === 0) continue
      for (let r = 0; r < 3; r += 1) if (r !== owner) forbid0[r] = (forbid0[r]! | bit(index)) >>> 0
    }
  }

  // ── Самопроверка: реалното разпределение трябва да е съвместимо.
  for (let r = 0; r < 3; r += 1) {
    for (const card of hands[responders[r]!]) {
      if (((forbid0[r]! >>> idToIndex.get(card.id)!) & 1) !== 0) return fail('inconsistent-history')
    }
  }

  // ── Кои неизвестни карти бият дадена карта на заявяващия (по двойки).
  const beatenBy: number[] = new Array(cards.length).fill(0)
  for (let c = 0; c < claimantHand.length; c += 1) {
    for (const y of poolIndices) {
      const winner = getServerTrickWinner(
        [
          { seat: sweepSeat, card: cards[c]! },
          { seat: responders[0]!, card: cards[y]! },
        ],
        winningBid,
      )
      if (!winner || winner.seat !== sweepSeat) beatenBy[c] = (beatenBy[c]! | bit(y)) >>> 0
    }
  }
  function isUnbeatable(claimantMask: number, poolMask: number): boolean {
    for (let c = 0; c < claimantHand.length; c += 1) {
      if (((claimantMask >>> c) & 1) !== 0 && (beatenBy[c]! & poolMask) !== 0) return false
    }
    return true
  }

  if (isUnbeatable(claimantMask0, poolMask0)) {
    return { result: true, reason: 'unbeatable', nodes: 0, guardHit: false }
  }

  // ── Съвместимост (Хол, 3 места).
  function isFeasible(poolMask: number, f0: number, f1: number, f2: number, c0: number, c1: number, c2: number): boolean {
    if (popcount32(poolMask) !== c0 + c1 + c2) return false
    // S = подмножество места; картите, които могат да са САМО в S, са
    // забранени за всяко място извън S.
    for (let s = 0; s < 7; s += 1) {
      let restricted = poolMask
      let capacity = 0
      if (s & 1) capacity += c0
      else restricted &= f0
      if (s & 2) capacity += c1
      else restricted &= f1
      if (s & 4) capacity += c2
      else restricted &= f2
      if (popcount32(restricted) > capacity) return false
    }
    return true
  }

  // ── Кои карти НЕ може да държи responder r, щом е изиграл y при plays.
  const playIndex = new Int32Array(4)
  const playSeat: Seat[] = [sweepSeat, responders[0]!, responders[1]!, responders[2]!]
  const forcedCache = new Map<number, number>()
  function forbiddenAfterPlay(r: number, y: number): number {
    // r responders вече са изиграли преди y (+ водещата карта).
    let key = r
    for (let k = 0; k <= r; k += 1) key = key * 32 + playIndex[k]!
    key = key * 32 + y
    const cached = forcedCache.get(key)
    if (cached !== undefined) return cached
    const plays: ServerTrickPlay[] = []
    for (let k = 0; k <= r; k += 1) plays.push({ seat: playSeat[k]!, card: cards[playIndex[k]!]! })
    let mask = 0
    for (const z of poolIndices) {
      if (z === y) continue
      if (!isLegalPlay(responders[r]!, [cards[y]!, cards[z]!], cards[y]!, plays, winningBid)) mask = (mask | bit(z)) >>> 0
    }
    forcedCache.set(key, mask)
    return mask
  }

  // Ред: водене от най-слабата (както в double-dummy), отговори от най-силната
  // — само ускорява намирането на контрапример, не променя резултата.
  const leadOrder = Array.from({ length: claimantHand.length }, (_, i) => i).sort(
    (a, b) => rootLeadStrength(cards[a]!, winningBid) - rootLeadStrength(cards[b]!, winningBid),
  )
  const responseOrder = [...poolIndices].sort(
    (a, b) => rootLeadStrength(cards[b]!, winningBid) - rootLeadStrength(cards[a]!, winningBid),
  )

  let nodes = 0
  let guardHit = false
  const memo = new Map<string, boolean>()
  const tricksAtStart = claimantHand.length

  // true ⇔ съществува контрапример от тази позиция (или лимитът е изчерпан).
  function canLoseFromTrickStart(claimantMask: number, poolMask: number, f0: number, f1: number, f2: number): boolean {
    if (claimantMask === 0) return false
    if (isUnbeatable(claimantMask, poolMask)) return false
    const key = `${claimantMask}:${poolMask}:${(f0 & poolMask) >>> 0}:${(f1 & poolMask) >>> 0}:${(f2 & poolMask) >>> 0}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    if (++nodes > maxNodes) {
      guardHit = true
      return true
    }
    // Всяко място е изиграло по една карта на всяка вече приключила взятка.
    const tricksPlayed = tricksAtStart - popcount32(claimantMask)
    const caps = caps0.map((cap) => cap - tricksPlayed)
    let lose = false
    for (const lead of leadOrder) {
      if (((claimantMask >>> lead) & 1) === 0) continue
      playIndex[0] = lead
      if (canLoseInTrick(0, (claimantMask & ~bit(lead)) >>> 0, poolMask, [f0, f1, f2], caps)) {
        lose = true
        break
      }
    }
    if (!guardHit) memo.set(key, lose)
    return lose
  }

  function canLoseInTrick(r: number, claimantMask: number, poolMask: number, forbid: number[], caps: number[]): boolean {
    if (r === 3) {
      const winner = getServerTrickWinner(
        [0, 1, 2, 3].map((k) => ({ seat: playSeat[k]!, card: cards[playIndex[k]!]! })),
        winningBid,
      )
      if (!winner || winner.seat !== sweepSeat) return true
      // Следващата взятка ползва същия стек → запазване/възстановяване.
      const i0 = playIndex[0]!, i1 = playIndex[1]!, i2 = playIndex[2]!, i3 = playIndex[3]!
      const nested = canLoseFromTrickStart(claimantMask, poolMask, forbid[0]!, forbid[1]!, forbid[2]!)
      playIndex[0] = i0
      playIndex[1] = i1
      playIndex[2] = i2
      playIndex[3] = i3
      return nested
    }
    const own = forbid[r]!
    for (const y of responseOrder) {
      if (((poolMask >>> y) & 1) === 0 || ((own >>> y) & 1) !== 0) continue
      if (++nodes > maxNodes) {
        guardHit = true
        return true
      }
      const nextPool = (poolMask & ~bit(y)) >>> 0
      const nextForbid = [...forbid]
      nextForbid[r] = (own | forbiddenAfterPlay(r, y)) >>> 0
      const nextCaps = [...caps]
      nextCaps[r] = caps[r]! - 1
      if (!isFeasible(nextPool, nextForbid[0]!, nextForbid[1]!, nextForbid[2]!, nextCaps[0]!, nextCaps[1]!, nextCaps[2]!)) continue
      playIndex[r + 1] = y
      if (canLoseInTrick(r + 1, claimantMask, nextPool, nextForbid, nextCaps)) return true
    }
    return false
  }

  if (!isFeasible(poolMask0, forbid0[0]!, forbid0[1]!, forbid0[2]!, caps0[0]!, caps0[1]!, caps0[2]!)) {
    return fail('inconsistent-history')
  }

  const lose = canLoseFromTrickStart(claimantMask0, poolMask0, forbid0[0]!, forbid0[1]!, forbid0[2]!)
  if (guardHit) return { result: false, reason: 'guard', nodes, guardHit }
  return { result: !lose, reason: lose ? 'counterexample' : 'proven', nodes, guardHit }
}

// ============================================================================
// Единствената точка за решение „предлагаме ли / приемаме ли OK“:
// съществуващата double-dummy гаранция (непроменена) И гаранцията от гледна
// точка на заявяващия. Ползва се при генериране на предложението
// (submitServerPlayCard) и при повторната сървърна проверка при OK
// (submitServerSweepDecision) — ръчно изпратена заявка не може да я заобиколи.
// ============================================================================
export function computeServerSweepOfferEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands
  winningBid: ServerWinningBid
  publicInfo: ServerSweepPublicInfo
}): boolean {
  const { sweepSeat, hands, winningBid, publicInfo } = params
  if (!computeServerSweepEligibility({ sweepSeat, hands, winningBid })) return false
  return computeServerSweepPublicGuaranteeOutcome({ sweepSeat, hands, winningBid, publicInfo }).result
}
