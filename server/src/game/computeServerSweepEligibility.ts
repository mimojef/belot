import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerWinningBid } from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'

export type ServerSweepEligibilityHands = Record<Seat, ServerCard[]>

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

// Keyed by (suit,rank) multiset, NOT card.id — legality (getServerValidPlayCards)
// and trick-winner (getServerTrickWinner) determination only ever consult
// suit/rank, never id, so two states holding the same (suit,rank) multiset
// per seat are truly interchangeable for this search. In a real 32-card deck
// id and (suit,rank) are bijective anyway, so this loses zero precision for
// production play — it only buys back cache hits that an id-keyed map would
// have missed for no reason.
function handsKey(hands: ServerSweepEligibilityHands): string {
  return SEAT_ORDER.map((seat) =>
    hands[seat]
      .map((c) => `${c.suit}${c.rank}`)
      .slice()
      .sort()
      .join(','),
  ).join('|')
}

// Reuses the EXACT production legal-move engine via a minimal fake state —
// only `.hands[seat]`, `.playing.currentTrick.plays`, `.bidding.winningBid`
// are read by getServerValidPlayCards, so this cast is safe and guarantees
// zero rule drift from live gameplay. (Няма ESLint конфигурация в този
// repo, която да забранява такъв cast — проверено преди да се добави тук.)
function legalCardsFor(
  seat: Seat,
  hand: ServerCard[],
  plays: { seat: Seat; card: ServerCard }[],
  winningBid: ServerWinningBid,
): ServerCard[] {
  const fakeState = {
    hands: { bottom: [], right: [], top: [], left: [], [seat]: hand },
    playing: { currentTrick: { plays } },
    bidding: { winningBid },
  } as unknown as ServerAuthoritativeGameState
  return getServerValidPlayCards(fakeState, seat)
}

// "Долу картите" има смисъл само при поне 2 оставащи карти — при 1 карта
// остава само последната взятка и offer/popup е излишен.
export const MIN_SWEEP_REMAINING_CARDS = 2

// Safety guard against pathological branching (see "Performance" note below).
// Guard exhaustion is fail-SAFE (not eligible), never fail-open, per explicit
// product decision. NOTE (incidents 18529/18537): real 5–6-card states with a
// strong claimant DO reach this guard (~200k nodes ≈ 0.2 s locally, ~0.85 s in
// production) — see the root-level optimization below.
export const MAX_SWEEP_SEARCH_NODES = 200000
const MAX_SEARCH_NODES = MAX_SWEEP_SEARCH_NODES

// ─── Monitoring-only observer (bounded, no per-call logging) ────────────────
export type ServerSweepEligibilityObservation = {
  durationMs: number
  nodes: number
  guardHit: boolean
  result: boolean
  // true → a root claimant card can lose the CURRENT trick (cheap precheck),
  // the deep search was skipped.
  rootPrecheckRejected: boolean
}

let eligibilityObserver: ((observation: ServerSweepEligibilityObservation) => void) | null = null

// Per thread (each game worker sets its own). null → no measurement at all.
export function setServerSweepEligibilityObserver(
  observer: ((observation: ServerSweepEligibilityObservation) => void) | null,
): void {
  eligibilityObserver = observer
}

function notifyObserver(observation: ServerSweepEligibilityObservation): void {
  if (eligibilityObserver === null) return
  try {
    eligibilityObserver(observation)
  } catch {
    // monitoring — never affects eligibility
  }
}

// ─── Root-level optimization (Phase S1) — ZERO semantic change ─────────────
//
// 1) Root precheck: if some claimant card can lose the CURRENT trick under at
//    least one legal response combination, the universal definition below is
//    already false for that lead → the whole answer is false. The deep search
//    would also return false (either by finding this same losing branch or by
//    exhausting the guard, which is fail-safe false), so skipping it changes
//    nothing. The precheck does NOT touch the node counter or the memo.
// 2) Root lead ordering (weakest first): for a TRUE answer every root lead and
//    every reachable state is expanded exactly once (memo), so the total node
//    count — and therefore whether the guard trips — does not depend on the
//    order. For a FALSE answer any order returns false. Order only changes how
//    fast a false answer is found.
const TRUMP_ORDER_POWER: Record<ServerCard['rank'], number> = { '7': 0, '8': 1, Q: 2, K: 3, '10': 4, A: 5, '9': 6, J: 7 }
const PLAIN_ORDER_POWER: Record<ServerCard['rank'], number> = { '7': 0, '8': 1, '9': 2, J: 3, Q: 4, K: 5, '10': 6, A: 7 }

function rootLeadStrength(card: ServerCard, winningBid: ServerWinningBid): number {
  const isTrump =
    winningBid !== null &&
    (winningBid.contract === 'all-trumps' || (winningBid.contract === 'suit' && card.suit === winningBid.trumpSuit))
  return isTrump ? 100 + TRUMP_ORDER_POWER[card.rank] : PLAIN_ORDER_POWER[card.rank]
}

function orderRootLeads(cards: ServerCard[], winningBid: ServerWinningBid): ServerCard[] {
  // Array.prototype.sort is stable → ties keep the original hand order.
  return [...cards].sort((a, b) => rootLeadStrength(a, winningBid) - rootLeadStrength(b, winningBid))
}

// ============================================================================
// Business invariant (final — supersedes the single-level "flat" check that
// shipped in 0366126 and was found to under-count a real production bug: a
// responder holding exactly ONE card of a suit the claimant leads TWICE
// across two independent hypothetical single-trick checks was treated as a
// "blocker" for BOTH checks, even though in sequential reality that one card
// can only ever be played once — see room 229cf8fc-a259-4bf7-9771-6e6c2e5843b6
// round 1 for the confirmed incident).
//
// Sweep = true iff the claimant is GUARANTEED to win every remaining trick
// under genuinely sequential, shrinking hands — i.e. a true double-dummy
// search, but with a UNIVERSAL (not existential) quantifier over the
// claimant's own lead choice at every single position, not just the first:
//
//   isGuaranteedSweep(hands):
//     if claimant has no cards left -> true
//     for EVERY remaining claimant card (not just "some" winning one):
//       for EVERY legal response combination of the other 3 seats, in real
//       turn order (their legality at each step uses the production
//       getServerValidPlayCards against the plays actually made so far in
//       THIS branch — never a reimplementation):
//         the claimant must win that trick in EVERY such branch, AND
//         isGuaranteedSweep(the hands actually remaining after that branch)
//         must ALSO hold (recursively, same condition)
//       if any lead or any response branch fails this -> isGuaranteedSweep = false
//
// This is deliberately NOT "there exists a safe lead order" (that is the
// old, already-rejected draw-out-permissive invariant) — it must hold no
// matter which of the claimant's own remaining cards gets led, at every
// step, because the offer promises a GUARANTEE, not a best-play recipe the
// claimant must additionally know to execute.
// ============================================================================
export function computeServerSweepEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands // CURRENT remaining hands of all 4 seats, post the just-completed trick
  winningBid: ServerWinningBid
}): boolean {
  const startedAt = eligibilityObserver !== null ? performance.now() : 0

  if (params.hands[params.sweepSeat].length < MIN_SWEEP_REMAINING_CARDS) {
    return false
  }

  const outcome = computeServerSweepEligibilityOutcome(params)

  if (eligibilityObserver !== null) {
    notifyObserver({
      durationMs: performance.now() - startedAt,
      nodes: outcome.nodes,
      guardHit: outcome.guardHit,
      result: outcome.result,
      rootPrecheckRejected: outcome.rootPrecheckRejected,
    })
  }
  return outcome.result
}

export type ServerSweepEligibilitySearchOutcome = {
  result: boolean
  // Same counter and same MAX_SWEEP_SEARCH_NODES guard in both implementations.
  nodes: number
  guardHit: boolean
  rootPrecheckRejected: boolean
  implementation: 'indexed' | 'legacy'
}

// Same decision as computeServerSweepEligibility, with search statistics.
// Used by computeServerSweepEligibility itself and by tests/benchmarks.
// implementation 'legacy' forces the object-based search (verification only).
export function computeServerSweepEligibilityOutcome(
  params: { sweepSeat: Seat; hands: ServerSweepEligibilityHands; winningBid: ServerWinningBid },
  options: { implementation?: 'auto' | 'legacy' } = {},
): ServerSweepEligibilitySearchOutcome {
  const { sweepSeat, hands, winningBid } = params

  if (hands[sweepSeat].length < MIN_SWEEP_REMAINING_CARDS) {
    return { result: false, nodes: 0, guardHit: false, rootPrecheckRejected: false, implementation: 'legacy' }
  }

  const rootLeads = orderRootLeads(hands[sweepSeat], winningBid)

  if (options.implementation !== 'legacy') {
    const indexed = indexSweepHands(hands)
    if (indexed !== null) return searchIndexed(sweepSeat, indexed, rootLeads, winningBid)
  }
  return searchLegacy(sweepSeat, hands, rootLeads, winningBid)
}

// ─── Indexed search (Phase S2) — the production path for real decks ────────
//
// Exactly the same search as searchLegacy below (same root precheck, same
// root order, same non-root lead order, same response order, same node
// counting, same guard), only with a compact representation:
//   • every card of the initial hands gets an index 0..31 in the ORIGINAL
//     hand order; a card's owner never changes during the search, cards are
//     only removed → the whole state is ONE 32-bit mask of remaining cards.
//     With unique (suit,rank) per card that mask is a bijection of the legacy
//     handsKey ((suit,rank) multiset per seat), so memo hits are identical.
//   • iterating a seat's indices in original order and skipping removed bits
//     reproduces the legacy `filter`-ed hand arrays (filter keeps order).
//   • legal moves still come from the production getServerValidPlayCards
//     (zero rule drift), cached by (seat hand mask, cards already played in
//     the trick); the responding seat is implied by the play count because
//     the claimant always leads.
//   • trick winner from the production getServerTrickWinner, cached by the
//     four played indices.
// Inputs with duplicate ids / duplicate (suit,rank) / > 32 cards (fabricated
// fixtures only — never a real deck) fall back to searchLegacy, which keeps
// the legacy multiset key and id-based removal semantics exactly.

type IndexedSweepHands = {
  cards: ServerCard[]
  seatCards: Record<Seat, number[]>
  seatMask: Record<Seat, number>
  idToIndex: Map<string, number>
  fullMask: number
}

const MAX_INDEXED_CARDS = 32
const PLAYS_CODE_SPACE = 2 ** 18 // play count (≤3) + up to 3 card indices (5 bits each)

function indexSweepHands(hands: ServerSweepEligibilityHands): IndexedSweepHands | null {
  const cards: ServerCard[] = []
  const seatCards: Record<Seat, number[]> = { bottom: [], right: [], top: [], left: [] }
  const seatMask: Record<Seat, number> = { bottom: 0, right: 0, top: 0, left: 0 }
  const idToIndex = new Map<string, number>()
  const suitRanks = new Set<string>()
  for (const seat of SEAT_ORDER) {
    for (const card of hands[seat]) {
      const suitRank = `${card.suit}${card.rank}`
      if (cards.length >= MAX_INDEXED_CARDS || idToIndex.has(card.id) || suitRanks.has(suitRank)) return null
      const index = cards.length
      suitRanks.add(suitRank)
      idToIndex.set(card.id, index)
      seatCards[seat].push(index)
      seatMask[seat] = (seatMask[seat] | (1 << index)) >>> 0
      cards.push(card)
    }
  }
  let fullMask = 0
  for (const seat of SEAT_ORDER) fullMask = (fullMask | seatMask[seat]) >>> 0
  return { cards, seatCards, seatMask, idToIndex, fullMask }
}

function searchIndexed(
  sweepSeat: Seat,
  indexed: IndexedSweepHands,
  rootLeadCards: ServerCard[],
  winningBid: ServerWinningBid,
): ServerSweepEligibilitySearchOutcome {
  const { cards, seatCards, seatMask, idToIndex, fullMask } = indexed
  const claimantMask = seatMask[sweepSeat]
  const claimantCards = seatCards[sweepSeat]
  let nodes = 0
  let guardHit = false

  // Plays of the current trick (fixed-size stacks; nested tricks save/restore).
  const playIndex = new Int32Array(4)
  const playSeat: Seat[] = [sweepSeat, sweepSeat, sweepSeat, sweepSeat]
  let playCount = 0

  const legalCache = new Map<number, Int32Array>()
  function legalIndices(seat: Seat, remaining: number): Int32Array {
    const handBits = (remaining & seatMask[seat]) >>> 0
    let playsCode = playCount
    for (let k = 0; k < playCount; k += 1) playsCode = playsCode * 32 + playIndex[k]!
    const key = handBits * PLAYS_CODE_SPACE + playsCode
    const cached = legalCache.get(key)
    if (cached !== undefined) return cached
    const hand: ServerCard[] = []
    for (const index of seatCards[seat]) if ((handBits >>> index) & 1) hand.push(cards[index]!)
    const plays: { seat: Seat; card: ServerCard }[] = []
    for (let k = 0; k < playCount; k += 1) plays.push({ seat: playSeat[k]!, card: cards[playIndex[k]!]! })
    const legal = legalCardsFor(seat, hand, plays, winningBid)
    const result = new Int32Array(legal.length)
    for (let k = 0; k < legal.length; k += 1) result[k] = idToIndex.get(legal[k]!.id)!
    legalCache.set(key, result)
    return result
  }

  const winnerCache = new Map<number, boolean>()
  function claimantWinsTrick(): boolean {
    const key = ((playIndex[0]! * 32 + playIndex[1]!) * 32 + playIndex[2]!) * 32 + playIndex[3]!
    const cached = winnerCache.get(key)
    if (cached !== undefined) return cached
    const winner = getServerTrickWinner(
      [
        { seat: playSeat[0]!, card: cards[playIndex[0]!]! },
        { seat: playSeat[1]!, card: cards[playIndex[1]!]! },
        { seat: playSeat[2]!, card: cards[playIndex[2]!]! },
        { seat: playSeat[3]!, card: cards[playIndex[3]!]! },
      ],
      winningBid,
    )
    const wins = !!winner && winner.seat === sweepSeat
    winnerCache.set(key, wins)
    return wins
  }

  const memo = new Map<number, boolean>()

  function isGuaranteedSweep(remaining: number, leadOrder: readonly number[]): boolean {
    if ((remaining & claimantMask) === 0) return true

    const cached = memo.get(remaining)
    if (cached !== undefined) return cached

    if (++nodes > MAX_SEARCH_NODES) {
      // Fail-safe, never fail-open: guard exhaustion means "not proven safe".
      guardHit = true
      memo.set(remaining, false)
      return false
    }

    let result = true
    for (const lead of leadOrder) {
      if (((remaining >>> lead) & 1) === 0) continue
      playIndex[0] = lead
      playSeat[0] = sweepSeat
      playCount = 1
      const ok = allResponsesWinTrickThenRecurse((remaining & ~(1 << lead)) >>> 0)
      playCount = 0
      if (!ok) {
        result = false
        break
      }
    }

    memo.set(remaining, result)
    return result
  }

  function allResponsesWinTrickThenRecurse(remaining: number): boolean {
    if (playCount === 4) {
      if (!claimantWinsTrick()) return false
      // The next trick reuses the same stacks → save/restore this trick.
      const i0 = playIndex[0]!, i1 = playIndex[1]!, i2 = playIndex[2]!, i3 = playIndex[3]!
      const s0 = playSeat[0]!, s1 = playSeat[1]!, s2 = playSeat[2]!, s3 = playSeat[3]!
      const nested = isGuaranteedSweep(remaining, claimantCards)
      playIndex[0] = i0
      playIndex[1] = i1
      playIndex[2] = i2
      playIndex[3] = i3
      playSeat[0] = s0
      playSeat[1] = s1
      playSeat[2] = s2
      playSeat[3] = s3
      playCount = 4
      return nested
    }

    const depth = playCount
    const nextSeat = getNextSeat(playSeat[depth - 1]!)
    const options = legalIndices(nextSeat, remaining)
    for (let o = 0; o < options.length; o += 1) {
      if (++nodes > MAX_SEARCH_NODES) {
        guardHit = true
        return false // fail safe, not fail open
      }
      const index = options[o]!
      playIndex[depth] = index
      playSeat[depth] = nextSeat
      playCount = depth + 1
      const ok = allResponsesWinTrickThenRecurse((remaining & ~(1 << index)) >>> 0)
      playCount = depth
      if (!ok) return false
    }
    return true
  }

  // Root precheck (S1): one trick deep, no node counting, no memo.
  function canLoseCurrentTrick(remaining: number): boolean {
    if (playCount === 4) return !claimantWinsTrick()
    const depth = playCount
    const nextSeat = getNextSeat(playSeat[depth - 1]!)
    const options = legalIndices(nextSeat, remaining)
    for (let o = 0; o < options.length; o += 1) {
      const index = options[o]!
      playIndex[depth] = index
      playSeat[depth] = nextSeat
      playCount = depth + 1
      const lose = canLoseCurrentTrick((remaining & ~(1 << index)) >>> 0)
      playCount = depth
      if (lose) return true
    }
    return false
  }

  const rootLeads = rootLeadCards.map((card) => idToIndex.get(card.id)!)
  for (const lead of rootLeads) {
    playIndex[0] = lead
    playSeat[0] = sweepSeat
    playCount = 1
    const lose = canLoseCurrentTrick((fullMask & ~(1 << lead)) >>> 0)
    playCount = 0
    if (lose) {
      return { result: false, nodes, guardHit, rootPrecheckRejected: true, implementation: 'indexed' }
    }
  }

  const result = isGuaranteedSweep(fullMask, rootLeads)
  return { result, nodes, guardHit, rootPrecheckRejected: false, implementation: 'indexed' }
}

// ─── Legacy object-based search (fallback for non-deck inputs) ──────────────
function searchLegacy(
  sweepSeat: Seat,
  hands: ServerSweepEligibilityHands,
  rootLeads: ServerCard[],
  winningBid: ServerWinningBid,
): ServerSweepEligibilitySearchOutcome {
  const memo = new Map<string, boolean>()
  let nodes = 0
  let guardHit = false

  // Pure function of "whose cards remain in which hands" — valid memoization
  // key regardless of the path taken to reach this state, since it is always
  // sweepSeat's turn to lead whenever this is invoked (every call site is
  // either the initial state or a freshly-completed trick that sweepSeat, by
  // the very condition being checked, just won).
  function isGuaranteedSweep(currentHands: ServerSweepEligibilityHands, leadOrder?: ServerCard[]): boolean {
    if (currentHands[sweepSeat].length === 0) return true

    const key = handsKey(currentHands)
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    if (++nodes > MAX_SEARCH_NODES) {
      // Fail-safe, never fail-open: guard exhaustion means "not proven safe".
      guardHit = true
      memo.set(key, false)
      return false
    }

    let result = true
    for (const leadCard of leadOrder ?? currentHands[sweepSeat]) {
      const afterLead: ServerSweepEligibilityHands = {
        ...currentHands,
        [sweepSeat]: currentHands[sweepSeat].filter((c) => c.id !== leadCard.id),
      }
      if (!allResponsesWinTrickThenRecurse([{ seat: sweepSeat, card: leadCard }], afterLead)) {
        result = false
        break
      }
    }

    memo.set(key, result)
    return result
  }

  // Universal over the other 3 seats' legal responses, in real turn order
  // (their legality at each step is computed against the ACTUAL plays made
  // so far in this branch, so follow-suit/overtrump/isPartnerWinning are all
  // evaluated correctly and cannot be "double spent" across branches — each
  // branch independently removes the cards it actually uses). On a completed
  // 4-card trick, the claimant must be the winner, and the resulting
  // (smaller) hands must themselves satisfy isGuaranteedSweep.
  function allResponsesWinTrickThenRecurse(
    plays: { seat: Seat; card: ServerCard }[],
    responderHands: ServerSweepEligibilityHands,
  ): boolean {
    if (plays.length === 4) {
      const winner = getServerTrickWinner(plays, winningBid)
      if (!winner || winner.seat !== sweepSeat) return false
      return isGuaranteedSweep(responderHands)
    }

    const nextSeat = getNextSeat(plays[plays.length - 1]!.seat)
    const legalCards = legalCardsFor(nextSeat, responderHands[nextSeat], plays, winningBid)

    for (const card of legalCards) {
      if (++nodes > MAX_SEARCH_NODES) {
        guardHit = true
        return false // fail safe, not fail open
      }
      const nextHands: ServerSweepEligibilityHands = {
        ...responderHands,
        [nextSeat]: responderHands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (!allResponsesWinTrickThenRecurse([...plays, { seat: nextSeat, card }], nextHands)) {
        return false
      }
    }

    return true
  }

  // Can the claimant lose THIS trick after leading `plays[0]` under at least
  // one legal response combination? Same legality/winner engine as above;
  // one trick deep only; no node counting, no memo.
  function canLoseCurrentTrick(
    plays: { seat: Seat; card: ServerCard }[],
    responderHands: ServerSweepEligibilityHands,
  ): boolean {
    if (plays.length === 4) {
      const winner = getServerTrickWinner(plays, winningBid)
      return !winner || winner.seat !== sweepSeat
    }
    const nextSeat = getNextSeat(plays[plays.length - 1]!.seat)
    for (const card of legalCardsFor(nextSeat, responderHands[nextSeat], plays, winningBid)) {
      const nextHands: ServerSweepEligibilityHands = {
        ...responderHands,
        [nextSeat]: responderHands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (canLoseCurrentTrick([...plays, { seat: nextSeat, card }], nextHands)) return true
    }
    return false
  }

  if (
    rootLeads.some((leadCard) =>
      canLoseCurrentTrick([{ seat: sweepSeat, card: leadCard }], {
        ...hands,
        [sweepSeat]: hands[sweepSeat].filter((c) => c.id !== leadCard.id),
      }),
    )
  ) {
    return { result: false, nodes, guardHit, rootPrecheckRejected: true, implementation: 'legacy' }
  }

  const result = isGuaranteedSweep(hands, rootLeads)
  return { result, nodes, guardHit, rootPrecheckRejected: false, implementation: 'legacy' }
}
