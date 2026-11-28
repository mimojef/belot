/**
 * Общо известие „[Никнейм] създаде маса за [Игра]“ при успешно създадена
 * частна маса — за всички игри (един механизъм, едно WS съобщение
 * 'private_room_created_notice', един попъп в клиента).
 *
 * Нова игра се включва с:
 *   1) запис в `games` при създаването на нотификатора (index.ts) — по желание
 *      с `canReceive` за сървърното право на получателя да вижда масите ѝ;
 *   2) извикване на `notify(...)` веднага след УСПЕШНО създаване на частна маса.
 * Името, цветът и навигацията са в клиентския регистър
 * (src/ui/notifications/privateTableNoticeGames.ts).
 *
 * Без маршрути в събитието: клиентът отваря само навигацията, регистрирана
 * за `gameId` в собствения си регистър. Едно създаване → най-много едно
 * изпращане (notificationId = gameId:tableId; клиентът също дедуплицира).
 */

export type PrivateTableNoticeRecipient = { connectionId: string; profileId: string }

export type PrivateTableNoticeGame = {
  /**
   * Сървърното право на получателя да вижда частните маси на играта (напр.
   * ограничен тестов достъп). Липсва → всеки влязъл потребител. Грешка → не.
   */
  canReceive?: (recipient: PrivateTableNoticeRecipient) => boolean
}

export type PrivateTableCreatedNoticeMessage = {
  type: 'private_room_created_notice'
  notificationId: string
  gameId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
  recipientInActiveGame: boolean
}

export type PrivateTableCreatedInput<G extends string> = {
  gameId: G
  tableId: string
  creatorProfileId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
}

const SENT_IDS_LIMIT = 1_000

export function createPrivateTableCreatedNotifier<G extends string>(deps: {
  games: Record<G, PrivateTableNoticeGame>
  listRecipients: () => PrivateTableNoticeRecipient[]
  isInActiveGame: (profileId: string) => boolean
  send: (connectionId: string, message: PrivateTableCreatedNoticeMessage) => void
  onError?: (cause: unknown) => void
}) {
  const sent = new Set<string>()
  const order: string[] = []
  function remember(id: string): boolean {
    if (sent.has(id)) return false
    sent.add(id)
    order.push(id)
    while (order.length > SENT_IDS_LIMIT) sent.delete(order.shift()!)
    return true
  }

  return {
    /** Вика се САМО след успешно създадена частна маса. Връща броя получатели. */
    notify(input: PrivateTableCreatedInput<G>): number {
      const game = deps.games[input.gameId]
      if (!game || !input.tableId) return 0
      const notificationId = `${input.gameId}:${input.tableId}`
      if (!remember(notificationId)) return 0
      let delivered = 0
      for (const recipient of deps.listRecipients()) {
        if (recipient.profileId === input.creatorProfileId) continue
        try {
          if (game.canReceive && !game.canReceive(recipient)) continue
          deps.send(recipient.connectionId, {
            type: 'private_room_created_notice',
            notificationId,
            gameId: input.gameId,
            creatorDisplayName: input.creatorDisplayName,
            creatorAvatarUrl: input.creatorAvatarUrl,
            recipientInActiveGame: deps.isInActiveGame(recipient.profileId),
          })
          delivered++
        } catch (cause) {
          deps.onError?.(cause)
        }
      }
      return delivered
    },
  }
}
