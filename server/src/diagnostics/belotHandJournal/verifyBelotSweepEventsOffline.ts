// Офлайн независимо преизчисляване на „Долу картите“ гаранцията от
// записаните в журнала ръце (sweep_offered.remainingHands /
// sweep_accepted.handsAtResolution) със същия production алгоритъм
// (computeServerSweepEligibility). Вика се от CLI --verify-sweeps, а не в
// gameplay hot path-а, защото търсенето може да отнеме десетки ms.

import { SERVER_SEAT_ORDER, type Seat } from '../../core/serverTypes.js'
import { computeServerSweepEligibility } from '../../game/computeServerSweepEligibility.js'
import type { ServerCard, ServerRank, ServerSuit } from '../../game/serverGameTypes.js'
import type { BelotHandJournalEvent } from './belotHandJournalTypes.js'

export type BelotSweepOfflineVerification = {
  eventType: 'sweep_offered' | 'sweep_accepted'
  roomId: string
  handId: string | null
  occurredAt: string
  claimantSeat: Seat
  eligible: boolean
  ok: boolean
}

function parseCard(id: string): ServerCard {
  const [suit, rank] = id.split('-') as [ServerSuit, ServerRank]
  return { id, suit, rank }
}

export function verifyBelotSweepEventsOffline(
  events: readonly BelotHandJournalEvent[],
): BelotSweepOfflineVerification[] {
  const results: BelotSweepOfflineVerification[] = []
  for (const event of events) {
    if (event.eventType !== 'sweep_offered' && event.eventType !== 'sweep_accepted') continue
    const payload = event.payload as {
      claimantSeat: Seat
      contract: 'suit' | 'no-trumps' | 'all-trumps' | null
      trumpSuit: ServerSuit | null
      remainingHands?: Record<Seat, string[]>
      handsAtResolution?: Record<Seat, string[]>
    }
    const handIds = event.eventType === 'sweep_offered' ? payload.remainingHands : payload.handsAtResolution
    if (!handIds || payload.contract === null) continue
    const hands = {} as Record<Seat, ServerCard[]>
    for (const seat of SERVER_SEAT_ORDER) {
      hands[seat] = (handIds[seat] ?? []).map(parseCard)
    }
    const eligible = computeServerSweepEligibility({
      sweepSeat: payload.claimantSeat,
      hands,
      winningBid: {
        seat: payload.claimantSeat,
        contract: payload.contract,
        trumpSuit: payload.trumpSuit,
        doubled: false,
        redoubled: false,
      },
    })
    results.push({
      eventType: event.eventType,
      roomId: event.roomId,
      handId: event.handId,
      occurredAt: event.occurredAt,
      claimantSeat: payload.claimantSeat,
      eligible,
      ok: eligible,
    })
  }
  return results
}
