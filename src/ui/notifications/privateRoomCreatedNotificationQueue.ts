/**
 * Чист (без DOM) state machine за "нова частна маса е създадена" popup-а.
 *
 * За разлика от chatNotificationQueue.ts (където "правото" за ново известие
 * от даден подател се възстановява чрез markRead), тук всяко създаване на
 * маса е еднократно събитие без "прочетено" състояние — веднъж показан
 * notificationId никога не се показва отново (защита срещу дублирана WS
 * доставка при reconnect), а различни notificationId-та никога не се губят,
 * само чакат на FIFO опашка ако вече има активен popup.
 */

export type PrivateRoomCreatedNotice = {
  notificationId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
  recipientInActiveGame: boolean
}

export type PrivateRoomCreatedDecision =
  | { action: 'show'; notice: PrivateRoomCreatedNotice }
  | { action: 'queue' }
  | { action: 'skip' }

export type PrivateRoomCreatedNotificationQueue = {
  /** Обработва входящо private_room_created_notice събитие. */
  handleIncoming: (notice: PrivateRoomCreatedNotice) => PrivateRoomCreatedDecision
  /** Текущият popup приключи (ръчно затворен или auto-hide) — освобождава
   * слота и връща следващия чакащ от FIFO опашката (ако има такъв). */
  handleDismissed: () => PrivateRoomCreatedDecision
  /** За тестове/диагностика. */
  getState: () => { activeNotificationId: string | null; pendingNotificationIds: string[] }
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

const SEEN_NOTIFICATION_IDS_LIMIT = 200

export function createPrivateRoomCreatedNotificationQueue(): PrivateRoomCreatedNotificationQueue {
  const seenNotificationIds = createBoundedIdSet(SEEN_NOTIFICATION_IDS_LIMIT)

  let activeNotificationId: string | null = null
  const pendingQueue: PrivateRoomCreatedNotice[] = []

  function handleIncoming(notice: PrivateRoomCreatedNotice): PrivateRoomCreatedDecision {
    if (seenNotificationIds.has(notice.notificationId)) {
      return { action: 'skip' }
    }
    seenNotificationIds.add(notice.notificationId)

    if (activeNotificationId === null) {
      activeNotificationId = notice.notificationId
      return { action: 'show', notice }
    }

    pendingQueue.push(notice)
    return { action: 'queue' }
  }

  function handleDismissed(): PrivateRoomCreatedDecision {
    activeNotificationId = null

    const next = pendingQueue.shift()
    if (next === undefined) {
      return { action: 'skip' }
    }

    activeNotificationId = next.notificationId
    return { action: 'show', notice: next }
  }

  function getState(): { activeNotificationId: string | null; pendingNotificationIds: string[] } {
    return {
      activeNotificationId,
      pendingNotificationIds: pendingQueue.map((n) => n.notificationId),
    }
  }

  return { handleIncoming, handleDismissed, getState }
}
