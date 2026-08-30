/**
 * Чист (без DOM) state machine за server-authoritative известията за
 * плащане/възстановяване на турнирна входна такса (§3-§7 в task spec-а).
 *
 * Огледален модел на privateRoomCreatedNotificationQueue.ts: всяко събитие
 * е еднократно (без "прочетено" състояние) — веднъж показан eventId никога
 * не се показва отново (defense-in-depth срещу дублирана WS доставка), а
 * различни eventId-та никога не се губят, само чакат на FIFO опашка ако
 * вече има активен popup.
 *
 * eventId идва от две различни места, но винаги е уникален per debit/refund
 * операция:
 *  - HTTP-инициирани дебити (join / partner invite create-debit / accept-debit)
 *    и доброволно отписване — клиентът генерира еднократен id при получаване
 *    на authoritative HTTP response;
 *  - server-initiated refund-и (creator cancel / fill expiry) — сървърът
 *    подава eventId в самия WS payload.
 */

export type TournamentEconomyNoticeReason =
  | 'entry_fee_paid'
  | 'participant_withdrawal'
  | 'creator_cancelled'
  | 'fill_expired'
  | 'scheduled_underfilled'
  | 'partner_left'
  | 'force_removed_by_creator'
  | 'force_removed_by_admin'

export type TournamentEconomyNotice = {
  eventId: string
  reason: TournamentEconomyNoticeReason
  amount: number
}

export type TournamentEconomyNoticeDecision =
  | { action: 'show'; notice: TournamentEconomyNotice }
  | { action: 'queue' }
  | { action: 'skip' }

export type TournamentEconomyNotificationQueue = {
  /** Обработва входящо debit/refund известие (HTTP-derived или WS-push). */
  handleIncoming: (notice: TournamentEconomyNotice) => TournamentEconomyNoticeDecision
  /** Текущият popup приключи (ръчно затворен или auto-hide) — освобождава
   * слота и връща следващия чакащ от FIFO опашката (ако има такъв). */
  handleDismissed: () => TournamentEconomyNoticeDecision
  /** За тестове/диагностика. */
  getState: () => { activeEventId: string | null; pendingEventIds: string[] }
}

/** Ограничена по размер memoization структура — виж chatNotificationQueue.ts
 * за същия pattern. Defense-in-depth срещу повторна WS доставка. */
function createBoundedIdSet(limit: number) {
  const set = new Set<string>()
  const order: string[] = []

  return {
    has: (id: string): boolean => set.has(id),
    add: (id: string): void => {
      if (set.has(id)) return
      set.add(id)
      order.push(id)
      while (order.length > limit) {
        const oldest = order.shift()
        if (oldest !== undefined) set.delete(oldest)
      }
    },
  }
}

const SEEN_EVENT_IDS_LIMIT = 200

export function createTournamentEconomyNotificationQueue(): TournamentEconomyNotificationQueue {
  const seenEventIds = createBoundedIdSet(SEEN_EVENT_IDS_LIMIT)

  let activeEventId: string | null = null
  const pendingQueue: TournamentEconomyNotice[] = []

  function handleIncoming(notice: TournamentEconomyNotice): TournamentEconomyNoticeDecision {
    if (seenEventIds.has(notice.eventId)) {
      return { action: 'skip' }
    }
    seenEventIds.add(notice.eventId)

    if (activeEventId === null) {
      activeEventId = notice.eventId
      return { action: 'show', notice }
    }

    pendingQueue.push(notice)
    return { action: 'queue' }
  }

  function handleDismissed(): TournamentEconomyNoticeDecision {
    activeEventId = null

    const next = pendingQueue.shift()
    if (next === undefined) {
      return { action: 'skip' }
    }

    activeEventId = next.eventId
    return { action: 'show', notice: next }
  }

  function getState(): { activeEventId: string | null; pendingEventIds: string[] } {
    return {
      activeEventId,
      pendingEventIds: pendingQueue.map((n) => n.eventId),
    }
  }

  return { handleIncoming, handleDismissed, getState }
}
