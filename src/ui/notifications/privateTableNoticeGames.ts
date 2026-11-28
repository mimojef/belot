/**
 * Регистър на игрите за общото известие „[Никнейм] създаде маса за [Игра].“
 * (сървър: server/src/notifications/privateTableCreatedNotice.ts).
 *
 * Нова игра = нов запис тук (име, цвят, отваряне на списъка с частните ѝ маси)
 * + регистрация и notify(...) на сървъра. Попъпът и обработчикът в main.ts не
 * се променят. Събитието носи само gameId — маршрут от сървъра не се приема;
 * непознат gameId (или изключена игра) → известието не се показва.
 */
import type { LobbyFlowController } from '../../app/lobby/createLobbyFlowController'
import { isLudoFeatureEnabled } from '../../app/games/ludo/ludoFeatureFlag'

export type PrivateTableNoticeGame = {
  /** Същият ключ като gameId в сървърния регистър. */
  id: string
  /** Името на играта в текста на попъпа. */
  name: string
  /** Цвят на името: тъмният изглед и светлият мобилен изглед. */
  color: string
  lightColor: string
  /** „Виж“: списъкът с частните маси на играта — без присъединяване и без старт. */
  openTables: (lobby: LobbyFlowController) => void
  /** Клиентска наличност (напр. build флаг); липсва → налична. */
  isAvailable?: () => boolean
}

export const PRIVATE_TABLE_NOTICE_GAMES: readonly PrivateTableNoticeGame[] = [
  { id: 'belot', name: 'Белот', color: '#f0c040', lightColor: '#B7791F', openTables: (lobby) => lobby.navigateToPrivateRooms() },
  // Достъпът до „Свара“ се проверява и на сървъра (известие само до получатели с право), и при отваряне на страницата.
  { id: 'svara', name: 'Свара', color: '#4ade80', lightColor: '#16A34A', openTables: (lobby) => lobby.navigateToSvaraTables() },
  { id: 'ludo', name: 'Човече', color: '#c084fc', lightColor: '#7C3AED', openTables: (lobby) => lobby.navigateToLudoLobby(), isAvailable: isLudoFeatureEnabled },
]

/** Регистрираната и налична игра за gameId от сървъра; иначе null. */
export function findPrivateTableNoticeGame(gameId: unknown, games: readonly PrivateTableNoticeGame[] = PRIVATE_TABLE_NOTICE_GAMES): PrivateTableNoticeGame | null {
  if (typeof gameId !== 'string') return null
  const game = games.find((entry) => entry.id === gameId)
  if (!game) return null
  return game.isAvailable && !game.isAvailable() ? null : game
}
