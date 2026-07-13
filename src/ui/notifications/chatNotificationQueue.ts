/**
 * Чист (без DOM) state machine, решаващ дали входящо чат съобщение трябва да
 * покаже popup сега, да изчака на опашка, или изобщо да бъде пропуснато.
 *
 * Правила (виж заданието):
 *  - Само ПЪРВОТО непрочетено съобщение от даден friendshipId показва popup.
 *    Сървърът е source of truth за това (shouldNotify флагът в
 *    chat_message_received) — този модул само пази клиентско отражение на
 *    "вече уведомен/чакащ, докато не бъде прочетено", за да устои на
 *    дублирани/забавени доставки без да разчита единствено на сървъра за
 *    всяко решение "покажи ли пак".
 *  - Максимум 1 активен popup + истинска FIFO опашка от УНИКАЛНИ чакащи
 *    изпращачи (без горна граница на дължината ѝ) — нов различен изпращач
 *    никога не измества/губи по-ранен все още чакащ.
 *  - Един friendshipId никога не присъства едновременно като активен И
 *    чакащ, и никога не се появява два пъти в опашката.
 *  - Дедупликация по messageId (ограничена памет — виж createBoundedIdSet) —
 *    повторно доставено събитие за същия messageId никога не предизвиква
 *    ново известие/звук.
 *  - Право за ново известие от даден friendshipId се възстановява само чрез
 *    markRead(friendshipId) (реално отваряне+прочитане, потвърдено от
 *    сървъра), не чрез затваряне или auto-hide на текущия popup.
 */

export type ChatNotificationEvent = {
  friendshipId: string
  messageId: string
  fromDisplayName: string
  shouldNotify: boolean
}

export type ChatNotificationDecision =
  | { action: 'show'; friendshipId: string; fromDisplayName: string }
  | { action: 'queue' }
  | { action: 'skip' }

/**
 * Резултат от markRead — explicit разграничава дали прочетеният
 * friendshipId е бил точно активния (в момента показан) popup, тъй като
 * само тогава UI слоят трябва да прекрати текущия banner/таймер. `next`
 * носи какво (ако нещо) трябва да бъде показано веднага след прекратяването
 * (следващ валиден от опашката, или null ако опашката е празна).
 */
export type ChatNotificationMarkReadResult =
  | { wasActive: true; next: { friendshipId: string; fromDisplayName: string } | null }
  | { wasActive: false }

export type ChatNotificationQueue = {
  /** Обработва входящо събитие. Може да върне 'show' синхронно (нищо не се
   * показва в момента и опашката е празна) или да го опаши/пропусне. */
  handleIncoming: (event: ChatNotificationEvent) => ChatNotificationDecision
  /** Известието, показано в момента (ръчно затворено или изтекло от таймер),
   * приключи — освобождава слота и връща следващия ВАЛИДЕН запис от FIFO
   * опашката (ако има такъв), или 'skip' ако опашката е празна/всички
   * чакащи вече са прочетени междувременно. */
  handleDismissed: () => ChatNotificationDecision
  /** Разговорът е реално отворен и прочетен (потвърдено от сървъра) —
   * възстановява правото за ново известие от този подател за бъдещи
   * съобщения, и премахва евентуален чакащ запис за него от опашката
   * (вече остарял — потребителят вече е видял/прочел).
   *
   * Връща `{ wasActive: true, next }`, когато прочетеният friendshipId е
   * бил точно АКТИВНИЯТ (в момента показан) popup — слотът се освобождава
   * веднага (същата логика като handleDismissed) и `next` носи следващия
   * валиден запис от опашката (или null, ако опашката е празна/изчерпана).
   * Това е единственият сигнал, по който UI слоят разбира, че трябва да
   * прекрати текущия popup/таймер СЕГА (дори next да е null), вместо да
   * чака стар auto-dismiss/fade.
   *
   * Връща `{ wasActive: false }`, когато прочетеният е бил само чакащ (вече
   * тихо премахнат от опашката) или изобщо не е бил notified — в тези
   * случаи UI слоят НЕ трябва да пипа текущо показания popup (той е за друг
   * подател). */
  markRead: (friendshipId: string) => ChatNotificationMarkReadResult
  /** За тестове/диагностика — снимка на текущото състояние. */
  getState: () => {
    activeFriendshipId: string | null
    pendingFriendshipIds: string[]
    notifiedFriendshipIds: string[]
  }
}

/**
 * Ограничена по размер memoization структура — пази последните `limit`
 * добавени id-та, изхвърляйки най-старите при препълване. Чисто клиентска
 * defense-in-depth защита срещу повторна WS доставка в рамките на дълга PWA
 * сесия; никога не е единственият източник на истина за unread state
 * (сървърът винаги е source of truth чрез shouldNotify).
 */
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
    size: (): number => set.size,
  }
}

const SEEN_MESSAGE_IDS_LIMIT = 500

export function createChatNotificationQueue(): ChatNotificationQueue {
  // friendshipId-и, за които вече е показан ИЛИ чака да бъде показан popup,
  // и все още не е потвърдено прочетено от сървъра.
  const notifiedFriendshipIds = new Set<string>()
  // messageId-та, вече обработени (show/queue) — ограничена памет, само
  // защита срещу дублирана WS доставка, не unread source of truth.
  const seenMessageIds = createBoundedIdSet(SEEN_MESSAGE_IDS_LIMIT)

  let activeFriendshipId: string | null = null
  const pendingQueue: Array<{ friendshipId: string; fromDisplayName: string }> = []

  function handleIncoming(event: ChatNotificationEvent): ChatNotificationDecision {
    if (seenMessageIds.has(event.messageId)) {
      return { action: 'skip' }
    }
    seenMessageIds.add(event.messageId)

    // Сървърът вече определи дали това е първото непрочетено; клиентският
    // Set е допълнителна защита (reconnect/remount), не единствен източник.
    if (!event.shouldNotify) {
      return { action: 'skip' }
    }

    if (notifiedFriendshipIds.has(event.friendshipId)) {
      // Вече активен ИЛИ вече чакащ в опашката — не добавяй втори запис.
      return { action: 'skip' }
    }

    notifiedFriendshipIds.add(event.friendshipId)

    if (activeFriendshipId === null) {
      activeFriendshipId = event.friendshipId
      return { action: 'show', friendshipId: event.friendshipId, fromDisplayName: event.fromDisplayName }
    }

    // FIFO — добавя се в края на опашката, никога не измества по-ранен чакащ.
    pendingQueue.push({ friendshipId: event.friendshipId, fromDisplayName: event.fromDisplayName })
    return { action: 'queue' }
  }

  // Освобождава активния слот и предлага следващия ВАЛИДЕН запис от FIFO
  // опашката (пропускайки записи, чийто friendshipId вече не е notified —
  // прочетени междувременно). Споделена от handleDismissed() (popup-ът
  // приключи естествено) и markRead() (popup-ът е принудително прекратен,
  // защото потребителят прочете точно активния разговор).
  function advanceToNextValid(): ChatNotificationDecision {
    activeFriendshipId = null

    while (pendingQueue.length > 0) {
      const next = pendingQueue.shift()
      if (next === undefined) break

      if (!notifiedFriendshipIds.has(next.friendshipId)) {
        continue
      }

      activeFriendshipId = next.friendshipId
      return { action: 'show', friendshipId: next.friendshipId, fromDisplayName: next.fromDisplayName }
    }

    return { action: 'skip' }
  }

  function handleDismissed(): ChatNotificationDecision {
    return advanceToNextValid()
  }

  function markRead(friendshipId: string): ChatNotificationMarkReadResult {
    const wasActive = activeFriendshipId === friendshipId

    notifiedFriendshipIds.delete(friendshipId)

    const idx = pendingQueue.findIndex((item) => item.friendshipId === friendshipId)
    if (idx !== -1) {
      pendingQueue.splice(idx, 1)
    }

    if (!wasActive) {
      // Прочетен беше или чакащ запис (вече премахнат по-горе), или
      // friendshipId, който изобщо не е бил показван — нищо активно за
      // прекратяване, UI слоят не трябва да пипа текущия popup.
      return { wasActive: false }
    }

    // Точно активният popup е бил прочетен директно (не чрез "Виж"/"Затвори")
    // — слотът трябва да се освободи веднага и опашката да напредне, за да
    // може UI слоят да прекрати текущия таймер/DOM СЕГА, вместо да чака
    // стар auto-dismiss. wasActive:true се връща ДОРИ next да е null —
    // UI слоят пак трябва да прекрати текущия popup, просто без замяна.
    const advanceDecision = advanceToNextValid()
    return {
      wasActive: true,
      next: advanceDecision.action === 'show'
        ? { friendshipId: advanceDecision.friendshipId, fromDisplayName: advanceDecision.fromDisplayName }
        : null,
    }
  }

  function getState(): {
    activeFriendshipId: string | null
    pendingFriendshipIds: string[]
    notifiedFriendshipIds: string[]
  } {
    return {
      activeFriendshipId,
      pendingFriendshipIds: pendingQueue.map((item) => item.friendshipId),
      notifiedFriendshipIds: [...notifiedFriendshipIds],
    }
  }

  return { handleIncoming, handleDismissed, markRead, getState }
}
