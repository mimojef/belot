// Liveness проверка на WebSocket транспорта по време на активна игра.
//
// Полуотворена TCP връзка (мобилна мрежа, Wi-Fi/4G смяна, събуждане от
// sleep) оставя браузърния WebSocket в readyState OPEN без 'close' събитие:
// send() "успява", но нищо не стига до сървъра и нищо не идва обратно.
// Сървърът продължава играта (ходът изтича -> бот), а клиентът стои на
// последния snapshot, докато потребителят не презареди. Нито сървърът, нито
// клиентът имаха heartbeat, който да го засече.
//
// Тук: ако от сървъра не е дошло нищо idleBeforePingMs, пращаме лек 'ping'
// (сървърът винаги отговаря с 'pong'). Ако и след pongTimeoutMs няма НИКАКВО
// съобщение, връзката се обявява за мъртва (onUnresponsive). Пингът тръгва
// само при тишина — при нормална игра snapshot-ите стигат за доказателство.
// Не разчита на локалния таймер за ход.

export type ConnectionLivenessMonitorOptions = {
  /** Проверката е активна само докато това е true (напр. активна стая). */
  isEnabled: () => boolean
  /** Милисекунди от последното съобщение на текущия OPEN socket; null без такъв. */
  getMsSinceLastServerMessage: () => number | null
  sendPing: () => void
  onUnresponsive: () => void
  idleBeforePingMs?: number
  pongTimeoutMs?: number
  tickMs?: number
  now?: () => number
  setInterval?: (handler: () => void, ms: number) => number
  clearInterval?: (id: number) => void
}

export type ConnectionLivenessMonitor = {
  start: () => void
  stop: () => void
  /** Една проверка веднага (за тестове и за visibilitychange). */
  check: () => void
}

export const LIVENESS_IDLE_BEFORE_PING_MS = 6_000
export const LIVENESS_PONG_TIMEOUT_MS = 5_000
const LIVENESS_TICK_MS = 1_000

export function createConnectionLivenessMonitor(
  options: ConnectionLivenessMonitorOptions,
): ConnectionLivenessMonitor {
  const idleBeforePingMs = options.idleBeforePingMs ?? LIVENESS_IDLE_BEFORE_PING_MS
  const pongTimeoutMs = options.pongTimeoutMs ?? LIVENESS_PONG_TIMEOUT_MS
  const tickMs = options.tickMs ?? LIVENESS_TICK_MS
  const now = options.now ?? (() => Date.now())
  const setIntervalFn = options.setInterval ?? ((handler, ms) => window.setInterval(handler, ms))
  const clearIntervalFn = options.clearInterval ?? ((id) => window.clearInterval(id))

  let intervalId: number | null = null
  let pingSentAt: number | null = null
  let lastCheckAt: number | null = null

  function check(): void {
    if (!options.isEnabled()) {
      pingSentAt = null
      lastCheckAt = null
      return
    }

    const msSinceLastMessage = options.getMsSinceLastServerMessage()
    if (msSinceLastMessage === null) {
      // Няма OPEN socket — close/reconnect пътят вече е отговорен.
      pingSentAt = null
      lastCheckAt = null
      return
    }

    const currentTime = now()
    const previousCheckAt = lastCheckAt
    lastCheckAt = currentTime

    // Проверките са били спрени (sleep, замразен/throttled background таб):
    // pong-ът може да чака в опашката зад нас, а самият ping може изобщо да
    // не е тръгнал. Заключение "мъртва връзка" през такава пауза би било
    // фалшиво — изпращаме нов ping и чакаме пълен pongTimeoutMs.
    if (pingSentAt !== null && previousCheckAt !== null && currentTime - previousCheckAt > tickMs * 3) {
      pingSentAt = currentTime
      options.sendPing()
      return
    }

    if (pingSentAt !== null) {
      const lastMessageAt = currentTime - msSinceLastMessage
      if (lastMessageAt >= pingSentAt) {
        // Каквото и да е съобщение след пинга доказва, че връзката е жива.
        pingSentAt = null
        return
      }
      if (currentTime - pingSentAt >= pongTimeoutMs) {
        pingSentAt = null
        options.onUnresponsive()
      }
      return
    }

    if (msSinceLastMessage >= idleBeforePingMs) {
      pingSentAt = currentTime
      options.sendPing()
    }
  }

  return {
    start: () => {
      if (intervalId !== null) return
      intervalId = setIntervalFn(check, tickMs)
    },
    stop: () => {
      if (intervalId !== null) {
        clearIntervalFn(intervalId)
        intervalId = null
      }
      pingSentAt = null
    },
    check,
  }
}
