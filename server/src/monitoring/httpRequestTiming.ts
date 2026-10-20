// Phase 0B — HTTP active vs wall timing.
//
// wall   = dispatch → handler promise settled (включва чакане на request body,
//          файлова система, image processing, външни услуги).
// wait   = обединението (union) на интервалите, в които заявката чака
//          I/O: 'body' (четене на request body до 'end') и 'io' (чисто
//          I/O helper-и: файлове, sharp/threadpool, email, Stripe). Паралелни
//          waits не се броят двойно.
// active = wall − wait — "HTTP active wall": включва обработката на заявката
//          (вкл. JSON.parse на body-то след 'end'), но НЕ е гарантирано
//          exclusive sync CPU време — може да съдържа event-loop scheduling
//          delay и untracked async waits. Затова 'http' е отделна категория,
//          не MAIN_THREAD_SYNC_TIMING_GROUPS.
//
// Контекстът се носи през AsyncLocalStorage (Node 24 → AsyncContextFrame,
// без async_hooks), затова helper-ите не получават req. Извън HTTP заявка
// beginHttpWait()/trackHttpWait() са no-op. Никога не хвърлят и не
// променят семантиката на заявката или на изчакваните promise-и.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { MainThreadTimingMetrics } from './mainThreadTimingMetrics.js'

export type HttpWaitKind = 'body' | 'io'

type HttpTimingContext = {
  now: () => number
  closed: boolean
  outstanding: number
  unionStartedAt: number
  unionWaitMs: number
  waitMsByKind: Record<HttpWaitKind, number>
}

export type HttpWaitToken = {
  context: HttpTimingContext
  kind: HttpWaitKind
  startedAt: number
  ended: boolean
}

const storage = new AsyncLocalStorage<HttpTimingContext>()

export function beginHttpWait(kind: HttpWaitKind): HttpWaitToken | null {
  const context = storage.getStore()
  if (context === undefined || context.closed) return null
  const now = context.now()
  if (context.outstanding === 0) context.unionStartedAt = now
  context.outstanding += 1
  return { context, kind, startedAt: now, ended: false }
}

export function endHttpWait(token: HttpWaitToken | null): void {
  if (token === null || token.ended) return
  token.ended = true
  const { context } = token
  if (context.closed) return
  const now = context.now()
  context.waitMsByKind[token.kind] += now - token.startedAt
  context.outstanding -= 1
  if (context.outstanding === 0) context.unionWaitMs += now - context.unionStartedAt
}

// Чисто I/O promise → броене като wait. Връща ОРИГИНАЛНИЯ promise; страничната
// верига само затваря интервала (rejection-ът си остава за caller-а).
export function trackHttpWait<T>(kind: HttpWaitKind, promise: Promise<T>): Promise<T> {
  const token = beginHttpWait(kind)
  if (token === null) return promise
  const end = () => endHttpWait(token)
  promise.then(end, end)
  return promise
}

// Изпълнява handler-а в HTTP timing контекст и при settle записва:
//   http:<route>         — HTTP active wall (wall − union wait), не CPU
//   httpWall:<route>     — wall
//   httpBodyWait:<route> — само ако е имало body wait
//   httpIoWait:<route>   — само ако е имало io wait
// Връща ОРИГИНАЛНИЯ promise на handler-а (caller-ът си пази .catch-а).
export function timeHttpRequest<T>(
  metrics: MainThreadTimingMetrics,
  routeLabel: string,
  run: () => Promise<T>,
): Promise<T> {
  const context: HttpTimingContext = {
    now: metrics.now,
    closed: false,
    outstanding: 0,
    unionStartedAt: 0,
    unionWaitMs: 0,
    waitMsByKind: { body: 0, io: 0 },
  }
  const startedAt = context.now()
  let promise: Promise<T>
  try {
    promise = storage.run(context, run)
  } catch (error) {
    finish()
    throw error
  }
  promise.then(finish, finish)
  return promise

  function finish(): void {
    if (context.closed) return
    const now = context.now()
    // Незатворен wait към момента на settle (напр. fire-and-forget I/O) се
    // брои до settle-а, но не по-нататък.
    if (context.outstanding > 0) context.unionWaitMs += now - context.unionStartedAt
    context.closed = true
    const wallMs = now - startedAt
    metrics.record('http', routeLabel, Math.max(0, wallMs - context.unionWaitMs))
    metrics.record('httpWall', routeLabel, wallMs)
    if (context.waitMsByKind.body > 0) metrics.record('httpBodyWait', routeLabel, context.waitMsByKind.body)
    if (context.waitMsByKind.io > 0) metrics.record('httpIoWait', routeLabel, context.waitMsByKind.io)
  }
}
