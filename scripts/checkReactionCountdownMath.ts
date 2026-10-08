/**
 * checkReactionCountdownMath.ts
 *
 * Unit-level regression за чистата математика зад countdown лентата
 * (src/app/activeRoom/reactionCountdown.ts) и оценката на сървърния часовник
 * (src/app/network/serverClock.ts). Реалното DOM/CSS поведение се доказва
 * отделно в checkReactionCountdownBrowser.ts.
 */

import {
  BOT_ACTION_DELAY_MS,
  computeCountdownFillAnimation,
  computeSeatCountdownRemainingMs,
  getReactionWarningThresholdMs,
  resolveHumanTurnTimeoutMs,
} from '../src/app/activeRoom/reactionCountdown'
import { createServerClock } from '../src/app/network/serverClock'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n═══ checkReactionCountdownMath ═══')

check('resolveHumanTurnTimeoutMs: whitelist, otherwise 15000', () => {
  for (const ms of [5000, 10000, 15000]) assert(resolveHumanTurnTimeoutMs({ humanTurnTimeoutMs: ms }) === ms, `${ms}`)
  for (const bogus of [undefined, null, 20000, 0, 7000, '5000' as any]) {
    assert(resolveHumanTurnTimeoutMs({ humanTurnTimeoutMs: bogus }) === 15000, `bogus ${String(bogus)}`)
  }
  assert(resolveHumanTurnTimeoutMs(null) === 15000, 'null game')
})

for (const total of [5000, 10000, 15000]) {
  check(`${total / 1000}s: animation-duration = total; delay places the end exactly at the deadline`, () => {
    // Свеж ход.
    let anim = computeCountdownFillAnimation(total, total)
    assert(anim.durationMs === total && anim.delayMs === 0, `fresh ${JSON.stringify(anim)}`)
    // Refresh/закъснял render на 40% -> отрицателен delay, НЕ рестарт от 100%.
    anim = computeCountdownFillAnimation(total * 0.6, total)
    assert(anim.durationMs === total && anim.delayMs === -total * 0.4, `mid ${JSON.stringify(anim)}`)
    // Таймер, стартиращ в бъдещето (след събиране на взятка) -> положителен delay.
    anim = computeCountdownFillAnimation(total + 1325, total)
    assert(anim.delayMs === 1325, `future ${JSON.stringify(anim)}`)
    // Изтекъл -> празна лента.
    anim = computeCountdownFillAnimation(0, total)
    assert(anim.delayMs === -total, `expired ${JSON.stringify(anim)}`)
    // Край = render + duration + delay = render + remaining.
    for (const remaining of [0, 1, 1234, total / 2, total, total + 999]) {
      const a = computeCountdownFillAnimation(remaining, total)
      assert(a.durationMs + a.delayMs === remaining, `end mismatch for remaining=${remaining}`)
    }
  })

  check(`${total / 1000}s: remaining from server deadline; bot seat keeps the 800ms presentation`, () => {
    const serverNow = 1_000_000
    const human = computeSeatCountdownRemainingMs({ deadlineAt: serverNow + 3000, totalMs: total, isBotSeat: false, serverNow })
    assert(human === 3000, `human ${human}`)
    assert(
      computeSeatCountdownRemainingMs({ deadlineAt: serverNow - 50, totalMs: total, isBotSeat: false, serverNow }) === 0,
      'expired must clamp to 0',
    )
    assert(
      computeSeatCountdownRemainingMs({ deadlineAt: null, totalMs: total, isBotSeat: false, serverNow }) === null,
      'no deadline -> null',
    )
    const botFresh = computeSeatCountdownRemainingMs({ deadlineAt: serverNow + BOT_ACTION_DELAY_MS, totalMs: total, isBotSeat: true, serverNow })
    assert(botFresh === total, `bot fresh bar should be full, got ${botFresh}`)
    const botHalf = computeSeatCountdownRemainingMs({ deadlineAt: serverNow + 400, totalMs: total, isBotSeat: true, serverNow })
    assert(botHalf === total - 400, `bot after 400ms ${botHalf}`)
  })
}

check('warning threshold: 7s at 15s, scaled for shorter timers, never the whole turn', () => {
  assert(getReactionWarningThresholdMs(15000) === 7000, '15s')
  assert(getReactionWarningThresholdMs(10000) === 4667, '10s')
  assert(getReactionWarningThresholdMs(5000) === 2333, '5s')
  for (const total of [5000, 10000, 15000]) {
    assert(getReactionWarningThresholdMs(total) < total / 2, `threshold must start after half of ${total}`)
  }
})

check('server clock: max-of-samples estimate (min latency), skew correction, jump reset', () => {
  const clock = createServerClock()
  assert(clock.getServerNow(1000) === 1000, 'no samples -> client time')
  // Сървърът е 37s напред; латентности 120/30/80ms.
  clock.recordServerNowSample(100_000 + 37_000 - 120, 100_000)
  clock.recordServerNowSample(101_000 + 37_000 - 30, 101_000)
  clock.recordServerNowSample(102_000 + 37_000 - 80, 102_000)
  assert(clock.getOffsetMs() === 37_000 - 30, `offset ${clock.getOffsetMs()}`)
  assert(clock.getServerNow(200_000) === 200_000 + 37_000 - 30, 'serverNow uses best sample')
  // Невалидни samples се игнорират.
  clock.recordServerNowSample(undefined)
  clock.recordServerNowSample('x')
  clock.recordServerNowSample(Number.NaN)
  assert(clock.getOffsetMs() === 37_000 - 30, 'invalid samples changed the offset')
  // Клиентският часовник скача 23s напред -> старите samples се изхвърлят.
  clock.recordServerNowSample(103_000 + 37_000 - 40, 103_000 + 23_000)
  assert(Math.abs(clock.getOffsetMs() - (37_000 - 23_000 - 40)) <= 1, `after jump ${clock.getOffsetMs()}`)
  // Скользящ прозорец: само последните 8 samples.
  const windowed = createServerClock()
  windowed.recordServerNowSample(10_000 + 500, 10_000) // стар, много оптимистичен
  for (let i = 1; i <= 8; i += 1) windowed.recordServerNowSample(10_000 + i * 1000 + 450, 10_000 + i * 1000)
  assert(windowed.getOffsetMs() === 450, `window should drop the oldest sample, got ${windowed.getOffsetMs()}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
