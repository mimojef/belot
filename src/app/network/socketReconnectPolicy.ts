// Pure решения за WebSocket close/open reconnect политиката (main.ts
// onClose/onOpen + offline overlay). Изнесени тук, за да са unit-testable
// без DOM/socket — main.ts само изпълнява ефектите на върнатото решение.
//
// Активна Svara маса се презаверява чрез нейния read-only протокол.
// Phase 3B.2 (D2): активна Belot spectator сесия е отделно изключение
// от established global политиката "реален disconnect -> forced lobby
// reload": spectator state-ът е ephemeral (няма reconnectToken/resume_room),
// затова reload би го унищожил. Вместо това spectator-ът се reconnect-ва и
// lobby-то re-watch-ва СЪЩАТА маса (Phase 3A 'connected' handler). Всички
// останали клонове (participant, lobby, zombie bid recovery) са byte/
// behavior equivalent на предишния inline код в main.ts.

export type SocketCloseDecision =
  | 'svara-reconnect'
  /** Spectator: reconnect без forced lobby reload; spectator session се пази. */
  | 'belot-spectator-reconnect'
  /**
   * Participant, socket-ът е изоставен от клиента като мъртъв (submit
   * watchdog / liveness): тих reconnect + resume_room в същата стая, БЕЗ
   * offline overlay и forced lobby reload — мрежата не е доказано паднала,
   * само тази TCP връзка. Реален outage пак се хваща от network health
   * монитора.
   */
  | 'active-room-silent-reconnect'
  /** Participant в активна стая: established reload-on-reconnect + resume. */
  | 'active-room-reconnect'
  /** Lobby: established reload-on-reconnect. */
  | 'lobby-reconnect'

export function decideSocketCloseAction(input: {
  isBelotSpectatorSessionActive: boolean
  hasActiveRoom: boolean
  hasActiveSvaraMatch?: boolean
  isZombieBidReconnectInFlight?: boolean
}): SocketCloseDecision {
  if (input.isBelotSpectatorSessionActive) return 'belot-spectator-reconnect'
  if (input.hasActiveRoom && input.isZombieBidReconnectInFlight === true) return 'active-room-silent-reconnect'
  if (input.hasActiveRoom) return 'active-room-reconnect'
  if (input.hasActiveSvaraMatch) return 'svara-reconnect'
  return 'lobby-reconnect'
}

export type SocketOpenDecision =
  | 'svara-resync'
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
  hasActiveSvaraMatch?: boolean
}): SocketOpenDecision {
  if (input.isZombieBidReconnectInFlight && input.hasActiveRoom) return 'zombie-bid-resume'
  if (input.isBelotSpectatorReconnectInFlight) {
    return input.spectatingBelotRoomId !== null ? 'belot-spectator-rewatch' : 'belot-spectator-session-lost'
  }
  if (input.hasActiveSvaraMatch && !input.hasActiveRoom) return 'svara-resync'
  if (input.shouldReloadLobbyOnReconnect) return 'forced-lobby-reload'
  if (input.hasActiveRoom) return 'active-room-resume'
  return 'lobby'
}

/**
 * Offline overlay-ят (offline event / network health monitor) по дизайн
 * насрочва forced lobby reload при възстановяване. За активна spectator
 * сесия — не: overlay-ят може да се покаже, но възстановяването минава през
 * socket reconnect + re-watch. Svara изчаква списък с членство, snapshot и
 * timing; нейният retry възстановява WS. Останалите retry пътища остават
 * user-driven hard reload.
 */
export function shouldOfflineRecoveryForceLobbyReload(isBelotSpectatorSessionActive: boolean, hasActiveSvaraMatch = false): boolean {
  return !isBelotSpectatorSessionActive && !hasActiveSvaraMatch
}

// ─── Тихо възстановяване в лобито/чакалнята (без презареждане) ─────────────
//
// Кратко прекъсване на игровия WS в лоби контекст (не активна игра, не Svara,
// не зрител) се възстановява без reload, САМО ако: прекъсването е под
// SOFT_RECONNECT_MAX_OUTAGE_MS, backend процесът е същият (serverInstanceId),
// сесията е същата и синхронизацията е успешна. Всичко останало -> досегашният
// безопасен reload (forceOfflineLobbyReload).

/** Максимална продължителност на прекъсване за тихо възстановяване. */
export const SOFT_RECONNECT_MAX_OUTAGE_MS = 120_000
/** След толкова продължаващо прекъсване компактната лента става цял екран. */
export const OFFLINE_FULL_SCREEN_DELAY_MS = 15_000
/** Срок за синхронизацията след повторно свързване (сесия + членство). */
export const SOFT_RECONNECT_SYNC_TIMEOUT_MS = 10_000

/**
 * Причина за принудително презареждане — фиксиран списък, без лични данни.
 * Попада в адреса (/lobby?offlineReload=...&via=...) и така в nginx лога.
 */
export type OfflineReloadVia =
  | 'ws' // досегашният път (активна игра и др.) след прекъсване на WS
  | 'health' // възстановен /health след показан екран (не-лоби контекст)
  | 'online' // събитие online без активно тихо възстановяване
  | 'retry' // бутонът „Опитай отново“
  | 'restart' // друг backend процес (рестарт/deploy) или стар сървър без идентификатор
  | 'stale' // прекъсване над SOFT_RECONNECT_MAX_OUTAGE_MS
  | 'session' // сесията е изтекла/сменена по време на прекъсването
  | 'sync' // неуспешна или просрочена синхронизация
  | 'offline_page' // public/offline.html (SW fallback) — там стойността е записана директно

export function buildOfflineReloadUrl(now: number, via: OfflineReloadVia): string {
  return `/lobby?offlineReload=${now}&via=${via}`
}

export type SoftReconnectAfterConnected =
  | { kind: 'sync' }
  | { kind: 'reload'; via: Extract<OfflineReloadVia, 'restart' | 'stale'> }

/** Решение при пристигане на 'connected' по време на тихо възстановяване. */
export function decideSoftReconnectAfterConnected(input: {
  outageStartedAt: number
  now: number
  knownServerInstanceId: string | null
  serverInstanceId: string | null | undefined
}): SoftReconnectAfterConnected {
  if (input.now - input.outageStartedAt > SOFT_RECONNECT_MAX_OUTAGE_MS) return { kind: 'reload', via: 'stale' }
  if (
    typeof input.serverInstanceId !== 'string' || input.serverInstanceId.length === 0
    || input.knownServerInstanceId === null || input.serverInstanceId !== input.knownServerInstanceId
  ) {
    return { kind: 'reload', via: 'restart' }
  }
  return { kind: 'sync' }
}

export type AuthSessionIdentity = { sessionId: string; profileId: string | null } | null

/** Същата сесия: и двете гостови (null), или същият sessionId и профил. */
export function isSameAuthSessionIdentity(before: AuthSessionIdentity, after: AuthSessionIdentity): boolean {
  if (before === null || after === null) return before === after
  return before.sessionId === after.sessionId && before.profileId === after.profileId
}

/** Резултат от синхронизацията -> възстановено или безопасно презареждане. */
export function decideSoftReconnectOutcome(input: {
  outageStartedAt: number
  now: number
  session: 'same' | 'changed' | 'error'
  lobbySynced: boolean
}): { kind: 'recovered' } | { kind: 'reload'; via: Extract<OfflineReloadVia, 'session' | 'sync' | 'stale'> } {
  if (input.session === 'changed') return { kind: 'reload', via: 'session' }
  if (input.session === 'error' || !input.lobbySynced) return { kind: 'reload', via: 'sync' }
  if (input.now - input.outageStartedAt > SOFT_RECONNECT_MAX_OUTAGE_MS) return { kind: 'reload', via: 'stale' }
  return { kind: 'recovered' }
}

/**
 * Изчакване преди следващия опит за свързване: досегашната линейна стъпка
 * (base * (attempt + 1), до max) с ±25% jitter — клиентите след рестарт не
 * се свързват в една и съща секунда. random() ∈ [0, 1).
 */
export function getReconnectDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const linear = Math.min(baseMs + attempt * baseMs, maxMs)
  const factor = 0.75 + Math.min(Math.max(random(), 0), 1) * 0.5
  return Math.max(250, Math.round(linear * factor))
}

/** Health polling: 30 s при отворен WS, 3 s при прекъснат. */
export const HEALTH_POLL_CONNECTED_MS = 30_000
export const HEALTH_POLL_DISCONNECTED_MS = 3_000
/** Една health заявка се прекъсва след толкова (броене като неуспех). */
export const HEALTH_REQUEST_TIMEOUT_MS = 8_000

export function getHealthPollDelayMs(isSocketOpen: boolean): number {
  return isSocketOpen ? HEALTH_POLL_CONNECTED_MS : HEALTH_POLL_DISCONNECTED_MS
}

/**
 * Вид на целия екран. Само navigator.onLine === false доказва липса на мрежа;
 * мрежова грешка при /health НЕ доказва липса на интернет (може да е
 * сървърът/пътят до него) -> „Връзката със сървъра е прекъсната“.
 */
export type OfflineScreenKind = 'internet' | 'server'

export function classifyOfflineScreen(navigatorOnLine: boolean): OfflineScreenKind {
  return navigatorOnLine === false ? 'internet' : 'server'
}
