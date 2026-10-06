// Pure решения за WebSocket close/open reconnect политиката (main.ts
// onClose/onOpen + offline overlay). Изнесени тук, за да са unit-testable
// без DOM/socket — main.ts само изпълнява ефектите на върнатото решение.
//
// Phase 3B.2 (D2): активна Belot spectator сесия е ЕДИНСТВЕНОТО изключение
// от established global политиката "реален disconnect -> forced lobby
// reload": spectator state-ът е ephemeral (няма reconnectToken/resume_room),
// затова reload би го унищожил. Вместо това spectator-ът се reconnect-ва и
// lobby-то re-watch-ва СЪЩАТА маса (Phase 3A 'connected' handler). Всички
// останали клонове (participant, lobby, zombie bid recovery) са byte/
// behavior equivalent на предишния inline код в main.ts.

export type SocketCloseDecision =
  /** Spectator: reconnect без forced lobby reload; spectator session се пази. */
  | 'belot-spectator-reconnect'
  /** Participant в активна стая: established reload-on-reconnect + resume. */
  | 'active-room-reconnect'
  /** Lobby: established reload-on-reconnect. */
  | 'lobby-reconnect'

export function decideSocketCloseAction(input: {
  isBelotSpectatorSessionActive: boolean
  hasActiveRoom: boolean
}): SocketCloseDecision {
  if (input.isBelotSpectatorSessionActive) return 'belot-spectator-reconnect'
  if (input.hasActiveRoom) return 'active-room-reconnect'
  return 'lobby-reconnect'
}

export type SocketOpenDecision =
  /** Explicit bid-recovery reconnect: тих resume_room в същата стая (непроменено). */
  | 'zombie-bid-resume'
  /** Spectator: re-watch на същата маса (watch_belot_room), НИКОГА resume_room/reload. */
  | 'belot-spectator-rewatch'
  /** Spectator reconnect, но сесията междувременно е изчезнала — затвори view-а, продължи като lobby. */
  | 'belot-spectator-session-lost'
  /** Established global политика: forceOfflineLobbyReload(). */
  | 'forced-lobby-reload'
  /** Participant: resume_room с reconnectToken (непроменено). */
  | 'active-room-resume'
  | 'lobby'

export function decideSocketOpenAction(input: {
  isZombieBidReconnectInFlight: boolean
  isBelotSpectatorReconnectInFlight: boolean
  spectatingBelotRoomId: string | null
  shouldReloadLobbyOnReconnect: boolean
  hasActiveRoom: boolean
}): SocketOpenDecision {
  if (input.isZombieBidReconnectInFlight && input.hasActiveRoom) return 'zombie-bid-resume'
  if (input.isBelotSpectatorReconnectInFlight) {
    return input.spectatingBelotRoomId !== null ? 'belot-spectator-rewatch' : 'belot-spectator-session-lost'
  }
  if (input.shouldReloadLobbyOnReconnect) return 'forced-lobby-reload'
  if (input.hasActiveRoom) return 'active-room-resume'
  return 'lobby'
}

/**
 * Offline overlay-ят (offline event / network health monitor) по дизайн
 * насрочва forced lobby reload при възстановяване. За активна spectator
 * сесия — не: overlay-ят може да се покаже, но възстановяването минава през
 * socket reconnect + re-watch. Explicit "Опитай отново" click остава
 * user-driven hard reload.
 */
export function shouldOfflineRecoveryForceLobbyReload(isBelotSpectatorSessionActive: boolean): boolean {
  return !isBelotSpectatorSessionActive
}
