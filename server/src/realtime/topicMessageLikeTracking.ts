// Ограничен tracking set за like drift-detection poll-а (runTopicMessageLikePoll
// в index.ts). Чист модул (без DB/socket достъп) — извлечен единствено за да е
// unit-тестваем в изолация, по модела на topicMessagePollAdvance.ts.
//
// Предназначение: poll-ът сравнява текущия DB likeCount с последно известния
// и broadcast-ва САМО делтата към ЛОКАЛНИТЕ subscribers на темата. Записът е
// нужен само докато някой локален subscriber гледа темата — broadcast към тема
// без subscribers е no-op (broadcastTopicMessageLikeChangedToLocalSubscribers
// излиза веднага), а REST/catch-up винаги връщат коректния DB count при
// повторно отваряне.
//
// Преди: Map<messageId, likeCount> без нито едно delete — растеше с всяко
// различно харесано съобщение + всеки catch-up seed за целия живот на процеса,
// а poll-ът prepare-ваше нова `IN (?, ?, …)` заявка с N параметъра на всеки
// 4 сек (линейна цена; над SQLITE_MAX_VARIABLE_NUMBER=32766 заявката хвърля
// и live like sync-ът спира изцяло).
//
// Сега три предпазителя:
//   1) Абонаментен: запис на тема без локални subscribers се маха след
//      IDLE_GRACE (покрива reconnect, презареждане, превключване между теми —
//      в този прозорец поведението е идентично със старото).
//   2) Таван MAX_ENTRIES (safety net за непрекъснато гледани теми, напр.
//      Лафче), прилаган в poll tick-а ПРЕДИ заявката, в този приоритет:
//        а) записите на теми без subscribers с изтекъл grace (pruneUnwatched,
//           винаги изцяло, в началото на tick-а);
//        б) записи на съобщения, които вече не съществуват в базата
//           (най-старите първо, само докато размерът падне до тавана;
//           потвърденото „съществува“ важи EXISTENCE_RECHECK_MS);
//        в) едва след това — най-рано добавените останали записи.
//      Целта: максимално да се запази live sync-ът за активно гледаните теми.
//   3) Авариен таван HARD_MAX_ENTRIES при добавяне (ако poll-ът спре да
//      тиктака / хвърля) — изважда най-рано добавените; в нормална работа не
//      се достига, защото tick-ът връща размера до MAX_ENTRIES на всеки 4 сек.
//
// Семантиката за записите, които остават, е НЕПРОМЕНЕНА: същите seed правила
// (seedIfAbsent не презаписва известен count), същото сравнение, същият
// broadcast. Изваденият запис може само да ПРОПУСНЕ бъдещ drift broadcast —
// никога не създава нов/дублиран.

export const TOPIC_MESSAGE_LIKE_TRACKING_IDLE_GRACE_MS = 10 * 60_000
export const TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES = 2_000
export const TOPIC_MESSAGE_LIKE_TRACKING_HARD_MAX_ENTRIES = 2 * TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES

// Колко дълго потвърденото „съобщението съществува“ се счита за актуално при
// прилагане на тавана — пълно DB сканиране най-много веднъж на този период
// (иначе при постоянно пълен таван всеки 4-секунден tick би проверявал ~2000
// реда наново).
export const TOPIC_MESSAGE_LIKE_TRACKING_EXISTENCE_RECHECK_MS = 60_000

type TopicMessageLikeTrackingEntry = {
  topicId: string
  likeCount: number
  lastWatchedAt: number
  existenceCheckedAt: number
}

export type TopicMessageLikeTracker = {
  /** Seed (catch-up / cross-instance poll): НЕ презаписва вече известен count. */
  seedIfAbsent(messageId: string, topicId: string, likeCount: number, now: number): void
  /**
   * Local toggle: авторитетен count от транзакцията. Съществуващ запис се
   * обновява НА МЯСТО (като досегашното Map.set) — редът на обхождане, а
   * оттам и редът на broadcast-ите в един tick, остава идентичен.
   */
  recordLocalCount(messageId: string, topicId: string, likeCount: number, now: number): void
  /**
   * Маха записите на теми без локални subscribers за ≥ idleGraceMs.
   * Темите със subscribers получават lastWatchedAt = now. Връща броя махнати.
   */
  pruneUnwatched(now: number, hasLocalSubscribers: (topicId: string) => boolean): number
  /**
   * Връща размера до maxEntries (вика се в tick-а СЛЕД pruneUnwatched):
   * първо несъществуващи съобщения (най-старите първо), после най-старите
   * останали. Нищо не прави под тавана. Запис, потвърден като съществуващ
   * в последните EXISTENCE_RECHECK_MS, не се проверява наново. Връща броя махнати.
   */
  enforceMaxEntries(now: number, messageExists: (messageId: string) => boolean): number
  messageIds(): string[]
  getKnownCount(messageId: string): number | undefined
  setKnownCount(messageId: string, likeCount: number): void
  forget(messageId: string): void
  has(messageId: string): boolean
  size(): number
}

export function createTopicMessageLikeTracker(options: {
  idleGraceMs?: number
  maxEntries?: number
  hardMaxEntries?: number
  existenceRecheckMs?: number
} = {}): TopicMessageLikeTracker {
  const existenceRecheckMs = options.existenceRecheckMs ?? TOPIC_MESSAGE_LIKE_TRACKING_EXISTENCE_RECHECK_MS
  const idleGraceMs = options.idleGraceMs ?? TOPIC_MESSAGE_LIKE_TRACKING_IDLE_GRACE_MS
  const maxEntries = options.maxEntries ?? TOPIC_MESSAGE_LIKE_TRACKING_MAX_ENTRIES
  // По подразбиране 2 × maxEntries (= TOPIC_MESSAGE_LIKE_TRACKING_HARD_MAX_ENTRIES).
  const hardMaxEntries = options.hardMaxEntries ?? 2 * maxEntries
  // Map пази реда на вмъкване → първите ключове са най-старите (за тавана).
  const entries = new Map<string, TopicMessageLikeTrackingEntry>()

  function evictOldestDownTo(limit: number): number {
    let removed = 0
    for (const messageId of entries.keys()) {
      if (entries.size <= limit) break
      entries.delete(messageId)
      removed++
    }
    return removed
  }

  return {
    seedIfAbsent(messageId, topicId, likeCount, now) {
      if (entries.has(messageId)) return
      entries.set(messageId, { topicId, likeCount, lastWatchedAt: now, existenceCheckedAt: Number.NEGATIVE_INFINITY })
      evictOldestDownTo(hardMaxEntries)
    },

    recordLocalCount(messageId, topicId, likeCount, now) {
      const existing = entries.get(messageId)
      if (existing !== undefined) {
        existing.likeCount = likeCount
        existing.lastWatchedAt = now
        return
      }
      entries.set(messageId, { topicId, likeCount, lastWatchedAt: now, existenceCheckedAt: Number.NEGATIVE_INFINITY })
      evictOldestDownTo(hardMaxEntries)
    },

    pruneUnwatched(now, hasLocalSubscribers) {
      let removed = 0
      // Една проверка на тема за tick (много съобщения споделят тема).
      const watchedByTopicId = new Map<string, boolean>()
      for (const [messageId, entry] of entries) {
        let watched = watchedByTopicId.get(entry.topicId)
        if (watched === undefined) {
          watched = hasLocalSubscribers(entry.topicId)
          watchedByTopicId.set(entry.topicId, watched)
        }
        if (watched) {
          entry.lastWatchedAt = now
        } else if (now - entry.lastWatchedAt >= idleGraceMs) {
          entries.delete(messageId)
          removed++
        }
      }
      return removed
    },

    enforceMaxEntries(now, messageExists) {
      if (entries.size <= maxEntries) return 0
      let removed = 0
      // б) Несъществуващи съобщения — най-старите първо (Лафче retention
      // трие най-старите), докато размерът падне до тавана.
      for (const [messageId, entry] of entries) {
        if (entries.size <= maxEntries) return removed
        if (now - entry.existenceCheckedAt < existenceRecheckMs) continue
        if (messageExists(messageId)) {
          entry.existenceCheckedAt = now
        } else {
          entries.delete(messageId)
          removed++
        }
      }
      // в) Едва сега — най-рано добавените останали записи.
      return removed + evictOldestDownTo(maxEntries)
    },

    messageIds() {
      return [...entries.keys()]
    },

    getKnownCount(messageId) {
      return entries.get(messageId)?.likeCount
    },

    setKnownCount(messageId, likeCount) {
      const entry = entries.get(messageId)
      if (entry !== undefined) entry.likeCount = likeCount
    },

    forget(messageId) {
      entries.delete(messageId)
    },

    has(messageId) {
      return entries.has(messageId)
    },

    size() {
      return entries.size
    },
  }
}
