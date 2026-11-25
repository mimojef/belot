// Тихо възстановяване на игровия WS без презареждане на страницата, само
// когато е безопасно. Два контекста:
//
//   'lobby' (Етап 1 — лоби, чакалня на частна маса):
//     прекъсване (beginOutage)    -> компактна лента; цял екран след 15 s
//     отворен WS (handleOpen)     -> чака 'connected'
//     'connected' (noteConnected) -> същият backend процес? иначе reload
//                                 -> синхронизация (паралелно): сесия
//                                    (/api/auth/me) + лоби (членство и пр.)
//
//   'active_room' (Етап 2 — участник в реален Belot мач):
//     прекъсване                  -> масата остава видима със съобщението в
//                                    стаята; БЕЗ цял екран след 15 s (едва
//                                    след SOFT_RECONNECT_MAX_OUTAGE_MS —
//                                    досегашният fallback)
//     'connected'                 -> същият backend процес? иначе reload
//                                 -> ПОСЛЕДОВАТЕЛНО: първо сесията трябва да
//                                    е потвърдено същата; едва тогава
//                                    resume_room (syncActiveRoom) — никакво
//                                    автоматично прикрепяне при сменена или
//                                    невалидна сесия
//
//   успех                         -> onRecovered(context)
//   неуспех/просрочване/>120 s    -> onReload (досегашният безопасен reload)
//
// Ново прекъсване по време на синхронизацията я анулира (generation) —
// закъснели резултати от стария опит се игнорират. Нищо не се изпраща
// повторно; модулът само решава кога е безопасно да се продължи.

import {
  decideSoftReconnectAfterConnected,
  decideSoftReconnectOutcome,
  OFFLINE_FULL_SCREEN_DELAY_MS,
  SOFT_RECONNECT_MAX_OUTAGE_MS,
  SOFT_RECONNECT_SYNC_TIMEOUT_MS,
  type OfflineReloadDetail,
  type OfflineReloadVia,
  type SoftReconnectFailureReason,
} from './socketReconnectPolicy'

export type SoftReconnectSessionCheck = 'same' | 'changed' | 'error'
export type SoftReconnectContext = 'lobby' | 'active_room'
/** Етап 0 (диагностика): защо syncActiveRoom е завършил с неуспех. */
export type SoftReconnectSyncFailure = { reason: 'resume_refused' | 'resume_precondition' | 'resume_failed'; code?: string }

export type LobbySoftReconnectDeps = {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (id: unknown) => void
  /** Сравнява текущата сесия (/api/auth/me) с тази отпреди прекъсването. */
  verifySession: () => Promise<SoftReconnectSessionCheck>
  /** Възстановява лоби абонаментите по новата връзка (чат, теми, ...). */
  onResumeLobby: () => void
  /** Изпраща resync заявките; done(true) след авторитетно потвърдено състояние. */
  syncLobby: (done: (ok: boolean) => void) => void
  /**
   * Активна стая: resume_room (с reconnectOf); done(true) едва след
   * room_resumed + авторитетен room_snapshot за същата стая. Вика се само
   * след потвърдена същата сесия. attempt — номерът на опита в текущото
   * прекъсване (Етап 0, само за диагностика); failure — защо е неуспешен.
   */
  syncActiveRoom?: (done: (ok: boolean, failure?: SoftReconnectSyncFailure) => void, attempt: number) => void
  onShowBanner: () => void
  /** Активна стая: съобщението в стаята (масата остава видима). */
  onShowActiveRoomOutage?: () => void
  onShowFullScreen: () => void
  onRecovered: (context: SoftReconnectContext) => void
  /** detail — Етап 0: причина, номер на опита и продължителност (само диагностика). */
  onReload: (via: OfflineReloadVia, detail?: OfflineReloadDetail) => void
}

export type LobbySoftReconnect = {
  /** WS се затвори в лоби контекст ('lobby') или в активна игра ('active_room'). */
  beginOutage: (context?: SoftReconnectContext) => void
  /** WS се отвори. true = в ход е тихо възстановяване (обичайният onOpen път се пропуска). */
  handleOpen: () => boolean
  /** Всяко 'connected' съобщение (и първото след зареждане). */
  noteConnected: (serverInstanceId: string | undefined) => void
  isOutageActive: () => boolean
  /** Контекстът на текущото прекъсване (null — няма). */
  getOutageContext: () => SoftReconnectContext | null
}

type Outage = {
  startedAt: number
  context: SoftReconnectContext
  phase: 'down' | 'awaiting_connected' | 'syncing' | 'reloading'
  /** Етап 0: брой стартирани синхронизации в това прекъсване (само диагностика). */
  attempt: number
}

export function createLobbySoftReconnect(deps: LobbySoftReconnectDeps): LobbySoftReconnect {
  let knownServerInstanceId: string | null = null
  let outage: Outage | null = null
  let generation = 0
  let fullScreenTimer: unknown = null
  let syncTimer: unknown = null

  function clearTimers(): void {
    if (fullScreenTimer !== null) deps.clearTimeout(fullScreenTimer)
    if (syncTimer !== null) deps.clearTimeout(syncTimer)
    fullScreenTimer = null
    syncTimer = null
  }

  function reload(via: OfflineReloadVia, reason: SoftReconnectFailureReason, code?: string): void {
    if (outage === null || outage.phase === 'reloading') return
    outage.phase = 'reloading'
    generation += 1
    clearTimers()
    const detail: OfflineReloadDetail = { reason, attempt: outage.attempt, outageMs: deps.now() - outage.startedAt }
    if (code !== undefined) detail.code = code
    deps.onReload(via, detail)
  }

  function recovered(): void {
    if (outage === null) return
    const context = outage.context
    outage = null
    generation += 1
    clearTimers()
    deps.onRecovered(context)
  }

  function startLobbySync(): void {
    if (outage === null) return
    outage.phase = 'syncing'
    outage.attempt += 1
    generation += 1
    const syncGeneration = generation
    const startedAt = outage.startedAt
    let session: SoftReconnectSessionCheck | null = null
    let lobbySynced: boolean | null = null

    const settle = (timedOut: boolean): void => {
      if (syncGeneration !== generation || outage === null || outage.phase !== 'syncing') return
      // Ранен неуспех — без да чакаме другата половина.
      const failedEarly = session === 'changed' || session === 'error' || lobbySynced === false
      if (!timedOut && !failedEarly && (session === null || lobbySynced === null)) return
      const outcome = decideSoftReconnectOutcome({
        outageStartedAt: startedAt,
        now: deps.now(),
        session: session ?? 'error',
        lobbySynced: lobbySynced === true,
      })
      if (outcome.kind === 'reload') {
        // Етап 0: само причината за лога; outcome (via) е непроменен.
        const reason: SoftReconnectFailureReason = outcome.via === 'stale' ? 'stale'
          : session === 'changed' ? 'session_changed'
            : session === 'error' ? 'auth_error'
              : lobbySynced === false ? 'lobby_sync_failed'
                : session === null ? 'auth_timeout'
                  : 'lobby_sync_timeout'
        reload(outcome.via, reason)
        return
      }
      recovered()
    }

    syncTimer = deps.setTimeout(() => {
      syncTimer = null
      settle(true)
    }, SOFT_RECONNECT_SYNC_TIMEOUT_MS)

    deps.onResumeLobby()
    deps.verifySession().then(
      (result) => { session = result; settle(false) },
      () => { session = 'error'; settle(false) },
    )
    deps.syncLobby((ok) => { lobbySynced = ok; settle(false) })
  }

  // Активна стая: сесията ПЪРВО; resume_room само след потвърдена същата сесия.
  function startActiveRoomSync(): void {
    if (outage === null) return
    outage.phase = 'syncing'
    outage.attempt += 1
    generation += 1
    const syncGeneration = generation
    const startedAt = outage.startedAt
    const attempt = outage.attempt
    const isCurrent = (): boolean => syncGeneration === generation && outage !== null && outage.phase === 'syncing'
    // Етап 0: докъде е стигнал опитът — за разграничаване на HTTP timeout
    // (проверката на сесията) от resume timeout. Не влияе на решението.
    let stage: 'auth' | 'resume' = 'auth'

    const finish = (session: SoftReconnectSessionCheck, synced: boolean, failure?: { reason: SoftReconnectFailureReason; code?: string }): void => {
      if (!isCurrent()) return
      const outcome = decideSoftReconnectOutcome({ outageStartedAt: startedAt, now: deps.now(), session, lobbySynced: synced })
      if (outcome.kind === 'reload') {
        const reason: SoftReconnectFailureReason = outcome.via === 'stale' ? 'stale'
          : failure !== undefined ? failure.reason
            : session === 'changed' ? 'session_changed'
              : session === 'error' ? 'auth_error'
                : 'resume_failed'
        reload(outcome.via, reason, outcome.via === 'stale' ? undefined : failure?.code)
        return
      }
      recovered()
    }

    syncTimer = deps.setTimeout(() => {
      syncTimer = null
      finish('error', false, { reason: stage === 'auth' ? 'auth_timeout' : 'resume_timeout' })
    }, SOFT_RECONNECT_SYNC_TIMEOUT_MS)

    deps.verifySession().then(
      (session) => {
        if (!isCurrent()) return
        if (session !== 'same' || deps.syncActiveRoom === undefined) {
          finish(session, false, session === 'same' ? { reason: 'resume_precondition', code: 'no_sync_handler' } : undefined)
          return
        }
        stage = 'resume'
        deps.syncActiveRoom((ok, failure) => finish('same', ok, ok ? undefined : (failure ?? { reason: 'resume_failed' })), attempt)
      },
      () => finish('error', false),
    )
  }

  return {
    beginOutage(context = 'lobby') {
      if (outage === null) {
        outage = { startedAt: deps.now(), context, phase: 'down', attempt: 0 }
        generation += 1
        if (context === 'active_room') {
          deps.onShowActiveRoomOutage?.()
          // Без цял екран след 15 s — масата остава видима; при изтичане на
          // срока за тихо възстановяване — досегашният fallback.
          fullScreenTimer = deps.setTimeout(() => {
            fullScreenTimer = null
            if (outage !== null && outage.phase !== 'reloading') deps.onShowFullScreen()
          }, SOFT_RECONNECT_MAX_OUTAGE_MS)
          return
        }
        deps.onShowBanner()
        fullScreenTimer = deps.setTimeout(() => {
          fullScreenTimer = null
          if (outage !== null && outage.phase !== 'reloading') deps.onShowFullScreen()
        }, OFFLINE_FULL_SCREEN_DELAY_MS)
        return
      }
      if (outage.phase === 'reloading') return
      // Ново прекъсване в същото прекъсване (напр. по време на синхронизацията):
      // началото и контекстът се пазят — 120 s се броят от първото затваряне.
      outage.phase = 'down'
      generation += 1
      if (syncTimer !== null) deps.clearTimeout(syncTimer)
      syncTimer = null
    },
    handleOpen() {
      if (outage === null) return false
      if (outage.phase === 'reloading') return true
      if (deps.now() - outage.startedAt > SOFT_RECONNECT_MAX_OUTAGE_MS) {
        reload('stale', 'stale')
        return true
      }
      outage.phase = 'awaiting_connected'
      return true
    },
    noteConnected(serverInstanceId) {
      if (outage === null) {
        // Обикновено свързване (първо, след login, извън тихото възстановяване):
        // текущият процес става отправна точка.
        if (typeof serverInstanceId === 'string' && serverInstanceId.length > 0) knownServerInstanceId = serverInstanceId
        return
      }
      if (outage.phase !== 'awaiting_connected') return
      const decision = decideSoftReconnectAfterConnected({
        outageStartedAt: outage.startedAt,
        now: deps.now(),
        knownServerInstanceId,
        serverInstanceId,
      })
      if (decision.kind === 'reload') {
        reload(decision.via, decision.via)
        return
      }
      if (outage.context === 'active_room') startActiveRoomSync()
      else startLobbySync()
    },
    isOutageActive() {
      return outage !== null
    },
    getOutageContext() {
      return outage?.context ?? null
    },
  }
}
