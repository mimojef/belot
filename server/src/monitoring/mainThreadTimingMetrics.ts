// Phase 0B — bounded, labeled main-thread timing metrics за CPU incident
// forensics. Допълва backgroundJobMetrics (фиксирани job имена) с
// разбивка по фиксирани групи + bounded label-и, за да покаже КОЙ
// main-thread path е изял времето при event-loop stall.
//
// Bounded cardinality:
//   - групата е от фиксиран enum (MAIN_THREAD_TIMING_GROUPS);
//   - label-ите идват САМО от кода (HTTP категория от
//     httpCategoryClassifier, вече parse-нат ClientMessage type, литерални
//     phase/job имена) — никога raw URL, IDs, IP или съдържание;
//   - защитно: label трябва да мине LABEL_PATTERN и всяка група пази най-много
//     MAX_LABELS_PER_GROUP различни label-а за прозорец; останалите отиват в
//     OVERFLOW_LABEL.
//
// DUAL-WINDOW (същата семантика като backgroundJobMetrics/activityCounters):
// всеки record() пише едновременно в oneSecond и tenSecond accumulator-и;
// snapshotOneSecondAndReset() се вика ТОЧНО веднъж на 1s forensic sample tick,
// snapshotTenSecondAndReset() — на 10s bucket tick. Така spike sample-ът
// носи completed 1-секунден прозорец, не cumulative данни (FALSE ATTRIBUTION
// RISK). Операция се записва при приключването си — дълъг stall попада в
// прозореца, в който е завършил, т.е. в spike sample-а, взет веднага след него.
//
// record()/time() никога не хвърлят заради самото измерване и не правят I/O.

// SYNC групи — измерват директно синхронно изпълнение на main thread-а
// (start/end около sync код). Те могат да обяснят event-loop stall.
export const MAIN_THREAD_SYNC_TIMING_GROUPS = [
  // WS inbound съобщение (sync handler), label = parse-нат ClientMessage type
  // или 'invalid'; 'connection'/'close' за lifecycle.
  'ws',
  // Фази на human gameplay действия, label = '<action>.<phase>'.
  'gameplay',
  // commitServerRoomWithSnapshot разбивка.
  'commit',
  // gameRuntimeTick (worker candidate) — САМО sync фазите на main thread.
  'runtime',
  // broadcastRoomSnapshots: build/stringify/send/spectator/total (transport,
  // НЕ persistence stringify — той е roomSnapshotStringify в backgroundJobs).
  'snapshot',
  // Match/hand completion side effects (label = runMatchCompletionSideEffect label).
  'completion',
  // Belot hand journal (sync части).
  'journal',
  // Периодични jobs: синхронната част на callback-а.
  'job',
  // Еднократни/per-entity таймери (expiry, deadline): sync callback.
  'timer',
] as const

// HTTP ACTIVE WALL — wall на HTTP заявката минус tracked body/io waits.
// НЕ е гарантирано exclusive sync CPU време: може да включва event-loop
// scheduling delay (чакане зад друга работа) и untracked async waits.
// Отделна категория — нито sync, нито чист wait. Label = route family
// (httpRouteClassifier), напр. 'POST.tournaments._.join'.
export const MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS = [
  'http',
] as const

// WALL/WAIT групи — wall време до settle на async операция. Включват
// чакане на I/O, мрежа, worker-и; НЕ са main-thread време и НЕ трябва да се
// събират с горните.
export const MAIN_THREAD_WALL_TIMING_GROUPS = [
  // HTTP end-to-end wall (dispatch → handler settled), същият route label.
  'httpWall',
  // HTTP: чакане на request body (до 'end'/'error').
  'httpBodyWait',
  // HTTP: чакане на чисто I/O (файлове, sharp, email, Stripe).
  'httpIoWait',
  // gameRuntimeTick: чакане на worker compute (dispatch → резултат).
  'runtimeWait',
  // Belot hand journal async maintenance/storage check.
  'journalAsync',
  // Периодични async jobs: wall време до settle.
  'jobAsync',
] as const

export const MAIN_THREAD_TIMING_GROUPS = [
  ...MAIN_THREAD_SYNC_TIMING_GROUPS,
  ...MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS,
  ...MAIN_THREAD_WALL_TIMING_GROUPS,
] as const

export type MainThreadSyncTimingGroup = (typeof MAIN_THREAD_SYNC_TIMING_GROUPS)[number]
export type MainThreadHttpActiveTimingGroup = (typeof MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS)[number]
export type MainThreadWallTimingGroup = (typeof MAIN_THREAD_WALL_TIMING_GROUPS)[number]
export type MainThreadTimingGroup = MainThreadSyncTimingGroup | MainThreadHttpActiveTimingGroup | MainThreadWallTimingGroup

const WALL_GROUP_SET: ReadonlySet<string> = new Set(MAIN_THREAD_WALL_TIMING_GROUPS)

export function isMainThreadWallTimingGroup(group: string): group is MainThreadWallTimingGroup {
  return WALL_GROUP_SET.has(group)
}

export const MAIN_THREAD_SLOW_THRESHOLDS_MS = [50, 100, 250, 500] as const

export type MainThreadTimingStat = {
  count: number
  totalDurationMs: number
  maxDurationMs: number
  // Кумулативни "поне N ms" броячи (slow250 включва и тези >= 500).
  slow50: number
  slow100: number
  slow250: number
  slow500: number
}

// Sparse: само групи/label-и с поне един запис в прозореца.
export type MainThreadTimingSnapshot = Partial<Record<MainThreadTimingGroup, Record<string, MainThreadTimingStat>>>

export const MAX_LABELS_PER_GROUP = 128
export const OVERFLOW_LABEL = 'other'
export const INVALID_LABEL = 'invalid_label'
const LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/
const GROUP_SET: ReadonlySet<string> = new Set(MAIN_THREAD_TIMING_GROUPS)

type WindowState = Map<MainThreadTimingGroup, Map<string, MainThreadTimingStat>>

function zeroStat(): MainThreadTimingStat {
  return { count: 0, totalDurationMs: 0, maxDurationMs: 0, slow50: 0, slow100: 0, slow250: 0, slow500: 0 }
}

function recordInto(window: WindowState, group: MainThreadTimingGroup, label: string, durationMs: number): void {
  let labels = window.get(group)
  if (labels === undefined) {
    labels = new Map()
    window.set(group, labels)
  }
  let stat = labels.get(label)
  if (stat === undefined) {
    // Последният слот е резервиран за OVERFLOW_LABEL → общо <= MAX_LABELS_PER_GROUP.
    if (label !== OVERFLOW_LABEL && labels.size >= MAX_LABELS_PER_GROUP - 1) {
      label = OVERFLOW_LABEL
      stat = labels.get(label)
    }
    if (stat === undefined) {
      stat = zeroStat()
      labels.set(label, stat)
    }
  }
  stat.count += 1
  stat.totalDurationMs += durationMs
  if (durationMs > stat.maxDurationMs) stat.maxDurationMs = durationMs
  if (durationMs >= 50) {
    stat.slow50 += 1
    if (durationMs >= 100) {
      stat.slow100 += 1
      if (durationMs >= 250) {
        stat.slow250 += 1
        if (durationMs >= 500) stat.slow500 += 1
      }
    }
  }
}

function snapshotWindow(window: WindowState): MainThreadTimingSnapshot {
  const result: MainThreadTimingSnapshot = {}
  for (const [group, labels] of window) {
    const out: Record<string, MainThreadTimingStat> = {}
    for (const [label, stat] of labels) out[label] = { ...stat }
    result[group] = out
  }
  return result
}

// Bounded кеш на вече валидирани label-и — спестява regex проверката на
// hot path-а (label-ите идват от фиксиран набор в кода).
const VALID_LABEL_CACHE_LIMIT = 1024
const validLabelCache = new Set<string>()

export function sanitizeMainThreadTimingLabel(label: unknown): string {
  if (typeof label !== 'string') return INVALID_LABEL
  if (validLabelCache.has(label)) return label
  if (!LABEL_PATTERN.test(label)) return INVALID_LABEL
  if (validLabelCache.size < VALID_LABEL_CACHE_LIMIT) validLabelCache.add(label)
  return label
}

export type MainThreadTimingMetrics = {
  // Часовникът на метриките (performance.now() по подразбиране).
  now(): number
  // Записва (now - startedAt) и връща now — за последователни фази без closures.
  recordSince(group: MainThreadTimingGroup, label: string, startedAt: number): number
  // Записва вече измерена продължителност. Невалидна група/продължителност
  // се игнорира; невалиден label → INVALID_LABEL. Никога не хвърля.
  record(group: MainThreadTimingGroup, label: string, durationMs: number): void
  // Измерва синхронен fn (връща/хвърля каквото fn връща/хвърля; записва в
  // finally, т.е. и при exception).
  time<T>(group: MainThreadTimingGroup, label: string, fn: () => T): T
  // Синхронна част на fn → group/label; ако fn върне Promise, wall времето до
  // settle → asyncGroup/label. Връща оригиналния резултат непроменен.
  // Само за promise-и без друг наблюдател (виж коментара в имплементацията).
  timeSyncAndAsync<T>(group: MainThreadTimingGroup, asyncGroup: MainThreadTimingGroup, label: string, fn: () => T): T
  // Wall време до settle на promise, който caller-ът САМ наблюдава (напр.
  // HTTP handler с .catch). Връща ОРИГИНАЛНИЯ promise; страничната верига
  // само записва и не променя rejection semantics на caller-а.
  timeAsync<T>(group: MainThreadTimingGroup, label: string, fn: () => Promise<T>): Promise<T>
  snapshotOneSecondAndReset(): MainThreadTimingSnapshot
  snapshotTenSecondAndReset(): MainThreadTimingSnapshot
  peek(): MainThreadTimingSnapshot
}

export function createMainThreadTimingMetrics(
  nowMs: () => number = () => performance.now(),
): MainThreadTimingMetrics {
  let oneSecond: WindowState = new Map()
  let tenSecond: WindowState = new Map()

  function record(group: MainThreadTimingGroup, label: string, durationMs: number): void {
    try {
      if (!GROUP_SET.has(group) || !Number.isFinite(durationMs) || durationMs < 0) return
      const safeLabel = sanitizeMainThreadTimingLabel(label)
      recordInto(oneSecond, group, safeLabel, durationMs)
      recordInto(tenSecond, group, safeLabel, durationMs)
    } catch {
      // monitoring — никога не влияе на измервания код
    }
  }

  function time<T>(group: MainThreadTimingGroup, label: string, fn: () => T): T {
    const startedAt = nowMs()
    try {
      return fn()
    } finally {
      record(group, label, nowMs() - startedAt)
    }
  }

  function timeSyncAndAsync<T>(group: MainThreadTimingGroup, asyncGroup: MainThreadTimingGroup, label: string, fn: () => T): T {
    const startedAt = nowMs()
    let result: T
    try {
      result = fn()
    } finally {
      record(group, label, nowMs() - startedAt)
    }
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      const settle = () => record(asyncGroup, label, nowMs() - startedAt)
      // Rejection-ът се препредава (derived promise-ът reject-ва със същата
      // причина), за да НЕ скрием unhandled rejection, който без
      // измерването би стигнал до process-а. Ползвай само за promise-и,
      // които иначе не се наблюдават (напр. setInterval callback-и).
      ;(result as unknown as PromiseLike<unknown>).then(settle, (reason: unknown) => {
        settle()
        return Promise.reject(reason)
      })
    }
    return result
  }

  function timeAsync<T>(group: MainThreadTimingGroup, label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = nowMs()
    let promise: Promise<T>
    try {
      promise = fn()
    } catch (error) {
      record(group, label, nowMs() - startedAt)
      throw error
    }
    const settle = () => record(group, label, nowMs() - startedAt)
    promise.then(settle, settle)
    return promise
  }

  function recordSince(group: MainThreadTimingGroup, label: string, startedAt: number): number {
    const now = nowMs()
    record(group, label, now - startedAt)
    return now
  }

  return {
    now: nowMs,
    recordSince,
    record,
    time,
    timeSyncAndAsync,
    timeAsync,
    snapshotOneSecondAndReset() {
      const result = snapshotWindow(oneSecond)
      oneSecond = new Map()
      return result
    },
    snapshotTenSecondAndReset() {
      const result = snapshotWindow(tenSecond)
      tenSecond = new Map()
      return result
    },
    peek() {
      return snapshotWindow(tenSecond)
    },
  }
}

// Явно no-op измерване за модули, които получават timing hook по избор.
export type MainThreadTimingHook = (label: string, durationMs: number) => void

export function safeInvokeTimingHook(hook: MainThreadTimingHook | null | undefined, label: string, durationMs: number): void {
  if (!hook) return
  try {
    hook(label, durationMs)
  } catch {
    // monitoring hook — никога не влияе на измервания код
  }
}

// WS inbound label: само parse-нат (валиден, от фиксирания протокол)
// ClientMessage type; всичко останало е 'invalid'.
export function resolveWsTimingLabel(message: { type: unknown } | null | undefined): string {
  if (message === null || message === undefined || typeof message.type !== 'string') return 'invalid'
  return sanitizeMainThreadTimingLabel(message.type)
}
