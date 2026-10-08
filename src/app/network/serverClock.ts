/**
 * serverClock.ts
 *
 * Оценка на разликата между клиентския и сървърния часовник за countdown
 * лентите ("Време за реакция"). timerDeadlineAt е абсолютен server Date.now()
 * timestamp, затова клиентът трябва да го сравнява със сървърно време, а не
 * със собствения си (възможно разместен) Date.now().
 *
 * Всеки sample = serverNow - receivedAt = истински offset - еднопосочна
 * латентност, т.е. винаги <= истинския offset. Най-големият sample в
 * прозореца е този с най-малка латентност -> най-точната оценка. Така
 * оценката на сървърното "сега" изостава от реалното най-много с минималната
 * латентност: лентата стига 0 малко след server deadline-а, но преди
 * snapshot-ът с хода на бота (който пътува поне толкова) да пристигне.
 */

const MAX_SAMPLES = 8
// Скок на клиентския часовник (ръчна промяна, sleep/resume) — старите
// samples стават невалидни.
const CLOCK_JUMP_RESET_MS = 2000

export type ServerClock = {
  recordServerNowSample: (serverNow: unknown, receivedAt?: number) => void
  getServerNow: (clientNow?: number) => number
  getOffsetMs: () => number
  reset: () => void
}

export function createServerClock(): ServerClock {
  let samples: number[] = []
  let offsetMs = 0

  function recordServerNowSample(serverNow: unknown, receivedAt: number = Date.now()): void {
    if (typeof serverNow !== 'number' || !Number.isFinite(serverNow) || serverNow <= 0) {
      return
    }

    const sample = serverNow - receivedAt

    if (samples.length > 0 && Math.abs(sample - offsetMs) > CLOCK_JUMP_RESET_MS) {
      samples = []
    }

    samples.push(sample)
    if (samples.length > MAX_SAMPLES) {
      samples.shift()
    }

    offsetMs = Math.max(...samples)
  }

  function getServerNow(clientNow: number = Date.now()): number {
    return clientNow + offsetMs
  }

  function reset(): void {
    samples = []
    offsetMs = 0
  }

  return {
    recordServerNowSample,
    getServerNow,
    getOffsetMs: () => offsetMs,
    reset,
  }
}

// Един споделен часовник за целия клиент — попълва се от WebSocket клиента
// при получаване на room/spectator snapshot (виж createGameServerClient.ts).
export const sharedServerClock = createServerClock()
