import { getConnectionById } from './getConnectionById.js'
import { handleDisconnect } from './handleDisconnect.js'
import { removeServerConnection } from './removeServerConnection.js'
import type {
  ConnectionId,
  ServerConnection,
  ServerRoom,
  ServerState,
} from './serverTypes.js'

export type ReleaseClosedConnectionResult =
  | {
      released: true
      serverState: ServerState
      connection: ServerConnection
      room: ServerRoom | null
    }
  | {
      released: false
      serverState: ServerState
      connection: null
      room: null
    }

/**
 * Финалната стъпка от живота на WebSocket връзка — вика се САМО от socket
 * 'close' handler-а, т.е. когато самият socket вече е затворен и за ТОЗИ
 * connectionId повече няма да пристигнат съобщения.
 *
 * 1. handleDisconnect() — същата логика като досега: статус 'disconnected' и,
 *    ако connection-ът още е закачен за участник в стая, участникът се
 *    маркира disconnected (connectionId: null — reconnect-ът става по
 *    reconnectToken, никога по стария connectionId).
 * 2. Записът се премахва от serverState.connections. Преди тази стъпка
 *    записите оставаха завинаги (по един на всяка WS връзка от старта на
 *    процеса), а всяко обновяване/обхождане на connections ставаше O(всички
 *    връзки от рестарта).
 *
 * Защо само тук, а не в displaceProfileConnections/closeAllProfileConnections:
 * там socket-ът може още да е отворен и да достави съобщения, които
 * stale-connection guard-ът отказва по status !== 'connected' — записът
 * трябва да остане до реалния 'close'.
 *
 * Закъснял close на стара връзка: засяга само собствения си connectionId
 * (UUID, уникален за всеки socket). Новата връзка на същия профил има друг
 * connectionId и не се пипа; участникът в стаята вече сочи новия
 * connectionId, затова handleDisconnect не намира стая за стария.
 *
 * Идемпотентно: ако записът вече липсва, нищо не се променя (вместо
 * handleDisconnect да хвърли "Connection was not found").
 */
export function releaseClosedConnection(
  serverState: ServerState,
  connectionId: ConnectionId,
): ReleaseClosedConnectionResult {
  if (getConnectionById(serverState, connectionId) === null) {
    return { released: false, serverState, connection: null, room: null }
  }

  const result = handleDisconnect(serverState, connectionId)

  return {
    released: true,
    serverState: removeServerConnection(result.serverState, connectionId),
    connection: result.connection,
    room: result.room,
  }
}
