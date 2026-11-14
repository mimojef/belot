// Тихо възстановяване на игровия WS в лоби контекст (лоби, чакалня на частна
// маса) — без презареждане на страницата, само когато е безопасно:
//
//   прекъсване (beginOutage)    -> компактна лента; цял екран след 15 s
//   отворен WS (handleOpen)     -> чака 'connected'
//   'connected' (noteConnected) -> същият backend процес? иначе reload
//                                  -> синхронизация: сесия (/api/auth/me) +
//                                     лоби (членство в частна маса и пр.)
//   успех                       -> onRecovered (лентата/екранът се скриват)
//   неуспех/просрочване/>120 s  -> onReload (досегашният безопасен reload)
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
  type OfflineReloadVia,
} from './socketReconnectPolicy'

export type SoftReconnectSessionCheck = 'same' | 'changed' | 'error'

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
  onShowBanner: () => void
  onShowFullScreen: () => void
  onRecovered: () => void
  onReload: (via: OfflineReloadVia) => void
}

export type LobbySoftReconnect = {
  /** WS се затвори в лоби контекст. */
  beginOutage: () => void
  /** WS се отвори. true = в ход е тихо възстановяване (обичайният onOpen път се пропуска). */
  handleOpen: () => boolean
  /** Всяко 'connected' съобщение (и първото след зареждане). */
  noteConnected: (serverInstanceId: string | undefined) => void
  isOutageActive: () => boolean
}

type Outage = {
  startedAt: number
  phase: 'down' | 'awaiting_connected' | 'syncing' | 'reloading'
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

  function reload(via: OfflineReloadVia): void {
    if (outage === null || outage.phase === 'reloading') return
    outage.phase = 'reloading'
    generation += 1
    clearTimers()
    deps.onReload(via)
  }

  function startSync(): void {
    if (outage === null) return
    outage.phase = 'syncing'
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
        reload(outcome.via)
        return
      }
      outage = null
      generation += 1
      clearTimers()
      deps.onRecovered()
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

  return {
    beginOutage() {
      if (outage === null) {
        outage = { startedAt: deps.now(), phase: 'down' }
        generation += 1
        deps.onShowBanner()
        fullScreenTimer = deps.setTimeout(() => {
          fullScreenTimer = null
          if (outage !== null && outage.phase !== 'reloading') deps.onShowFullScreen()
        }, OFFLINE_FULL_SCREEN_DELAY_MS)
        return
      }
      if (outage.phase === 'reloading') return
      // Ново прекъсване в същото прекъсване (напр. по време на синхронизацията):
      // началото се пази — 120 s се броят от първото затваряне.
      outage.phase = 'down'
      generation += 1
      if (syncTimer !== null) deps.clearTimeout(syncTimer)
      syncTimer = null
    },
    handleOpen() {
      if (outage === null) return false
      if (outage.phase === 'reloading') return true
      if (deps.now() - outage.startedAt > SOFT_RECONNECT_MAX_OUTAGE_MS) {
        reload('stale')
        return true
      }
      outage.phase = 'awaiting_connected'
      return true
    },
    noteConnected(serverInstanceId) {
      if (outage === null) {
        // Обикновено свързване (първо, след login, извън лоби контекста):
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
        reload(decision.via)
        return
      }
      startSync()
    },
    isOutageActive() {
      return outage !== null
    },
  }
}
