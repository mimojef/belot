// Гласов чат — Етап H (H1/H2): чиста логика за медийното здраве.
//
// Без livekit-client и без DOM — адаптерът подава измерванията, а тук се
// вземат решенията (детерминистично, тества се с фалшиви стойности). Влиза в
// lazy chunk-а на гласа (импортира се само от liveKitVoiceAdapter/voiceRuntime).
//
// Принципи (решения на собственика, 2026-11-18):
//   * нормална тишина, DTX, липса на говорещ, ръчно спрян микрофон, локално
//     заглушен участник и липсващ getStats показател НЕ са дефект;
//   * 0 изпратени RTP пакета за известно време е само ПОДОЗРЕНИЕ (DTX на
//     реалните телефони още не е измерен) — H1 само го показва и докладва;
//   * системно прекъснат микрофон (track.muted / спряно от LiveKit изходящо
//     аудио) не се „бори“ — само се показва;
//   * решението изисква свежа статистика (stats timestamp), реално изминало
//     време, същия RTP поток и същия sender/capture; нулиран брояч или пауза в
//     измерването (фон, throttling) започват базата наново.

import type {
  VoiceMediaDurationBucket,
  VoiceMediaInputEvidence,
  VoiceMediaInputState,
  VoiceMicHealth,
} from './voiceAdapter'

// ─── Изходящо аудио (собственият микрофон) ──────────────────────────────

/** Интервал на локалната проверка (само при включен микрофон и видима страница). */
export const VOICE_MEDIA_SAMPLE_INTERVAL_MS = 3_000
/** Поредни измервания без нов RTP пакет, преди да има подозрение. */
export const VOICE_INPUT_STALL_MIN_SAMPLES = 3
/** Минимално време без нов RTP пакет (реално И по stats timestamp). */
export const VOICE_INPUT_STALL_MIN_MS = 9_000
/** По-голяма пауза между две измервания (фон, throttling) -> базата започва наново. */
export const VOICE_MEDIA_MAX_SAMPLE_GAP_MS = 7_500
/** Минимален напредък на stats timestamp, за да е измерването свежо. */
export const VOICE_MEDIA_MIN_STATS_ADVANCE_MS = 1_000

export type VoiceOutboundSample = {
  /** Монотонно време на клиента (ms). */
  at: number
  /** RTCStats.timestamp на outbound-rtp (ms) — null: няма показател. */
  statsTimestamp: number | null
  /** id на outbound-rtp — сменен id = нов RTP поток (броячите започват отначало). */
  rtpStreamId: string | null
  packetsSent: number | null
  /** media-source totalSamplesDuration (s) — само допълнително, не за решение. */
  sourceSamplesDuration: number | null
  /** sender.track е точно нашият capture (не null, не друг track). */
  senderHasCapture: boolean
  captureLive: boolean
  captureEnabled: boolean
  captureMuted: boolean
  /** LiveKit е спрял изходящото аудио (pauseUpstream след системно mute). */
  upstreamPaused: boolean
}

export type VoiceInputChange = { state: VoiceMediaInputState; evidence: VoiceMediaInputEvidence; duration: VoiceMediaDurationBucket }

export type VoiceInputVerdict = {
  health: VoiceMicHealth
  /** Промяна на състоянието (за UI/диагностика) — null: няма. */
  change: VoiceInputChange | null
  decision: 'ok' | 'muted' | 'stall' | 'no_decision'
  /** RTP пакети/s за последния свеж интервал (само за измерване, напр. DTX). */
  packetsPerSecond: number | null
}

export function durationBucket(ms: number | null): VoiceMediaDurationBucket {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'none'
  if (ms < 10_000) return 'lt10s'
  if (ms < 60_000) return '10to60s'
  return 'gt60s'
}

function sourceEvidence(fromSeconds: number | null, toSeconds: number | null, stalledMs: number): VoiceMediaInputEvidence {
  if (fromSeconds === null || toSeconds === null) return 'packets_only'
  const advancedMs = (toSeconds - fromSeconds) * 1000
  if (advancedMs <= 50) return 'capture_stalled'
  if (advancedMs >= stalledMs * 0.5) return 'capture_active'
  return 'packets_only'
}

export type VoiceInputHealthEvaluator = {
  push: (sample: VoiceOutboundSample) => VoiceInputVerdict
  /** Измерването е прекъснато (скрита страница, reconnect, нов capture) — базата започва наново; състоянието се пази. */
  resetBaseline: () => void
  /** Нов/спрян микрофон — всичко отначало, без докладвана промяна. */
  clear: () => void
  /**
   * H3: проверката след замяната не потвърди поток — подозрението продължава
   * (за да може по-късен поток да го изчисти със stall_cleared).
   */
  markSuspected: (at: number) => void
  health: () => VoiceMicHealth
}

export function createInputHealthEvaluator(options: { minSamples?: number; minStallMs?: number; maxGapMs?: number } = {}): VoiceInputHealthEvaluator {
  const minSamples = options.minSamples ?? VOICE_INPUT_STALL_MIN_SAMPLES
  const minStallMs = options.minStallMs ?? VOICE_INPUT_STALL_MIN_MS
  const maxGapMs = options.maxGapMs ?? VOICE_MEDIA_MAX_SAMPLE_GAP_MS
  let health: VoiceMicHealth = 'ok'
  let base: { id: string; packets: number; statsTs: number; at: number } | null = null
  let lastIncrease: { at: number; statsTs: number; source: number | null } | null = null
  let samplesSinceIncrease = 0
  let mutedSince: number | null = null
  let stallSince: number | null = null
  /** Последният видян RTP поток — пази се и през resetBaseline (reconnect, фон). */
  let lastStreamId: string | null = null

  const resetBaseline = (): void => {
    base = null
    lastIncrease = null
    samplesSinceIncrease = 0
  }
  const verdict = (decision: VoiceInputVerdict['decision'], change: VoiceInputChange | null = null, packetsPerSecond: number | null = null): VoiceInputVerdict =>
    ({ health, change, decision, packetsPerSecond })

  return {
    push(sample) {
      if (!sample.captureLive || !sample.captureEnabled) {
        // Спрян/изключен capture: друг механизъм (track ended / ръчно изключване) — без решение.
        resetBaseline()
        return verdict('no_decision')
      }
      if (sample.captureMuted || sample.upstreamPaused) {
        resetBaseline()
        if (health !== 'system_muted') {
          health = 'system_muted'
          mutedSince = sample.at
          stallSince = null
          return verdict('muted', { state: 'system_muted', evidence: 'none', duration: 'none' })
        }
        return verdict('muted')
      }
      let change: VoiceInputChange | null = null
      if (health === 'system_muted') {
        health = 'ok'
        change = { state: 'system_unmuted', evidence: 'none', duration: durationBucket(mutedSince === null ? null : sample.at - mutedSince) }
        mutedSince = null
      }
      if (!sample.senderHasCapture) {
        resetBaseline()
        return verdict('no_decision', change)
      }
      if (sample.packetsSent === null || sample.statsTimestamp === null || sample.rtpStreamId === null) return verdict('no_decision', change)
      const streamChanged = lastStreamId !== null && lastStreamId !== sample.rtpStreamId
      lastStreamId = sample.rtpStreamId
      if (base === null || base.id !== sample.rtpStreamId || sample.packetsSent < base.packets || sample.at - base.at > maxGapMs) {
        // НОВ RTP поток, който вече е изпратил пакети (напр. официален reconnect на
        // LiveKit публикува същия capture наново) -> подозрението отпада веднага.
        if (health === 'stall_suspected' && streamChanged && sample.packetsSent > 0) {
          change = { state: 'stall_cleared', evidence: 'none', duration: durationBucket(stallSince === null ? null : sample.at - stallSince) }
          health = 'ok'
          stallSince = null
        }
        // Нов поток / нулирани броячи / пауза в измерването: нова база (без решение за stall).
        base = { id: sample.rtpStreamId, packets: sample.packetsSent, statsTs: sample.statsTimestamp, at: sample.at }
        lastIncrease = { at: sample.at, statsTs: sample.statsTimestamp, source: sample.sourceSamplesDuration }
        samplesSinceIncrease = 0
        return verdict('no_decision', change)
      }
      const statsAdvance = sample.statsTimestamp - base.statsTs
      if (statsAdvance < VOICE_MEDIA_MIN_STATS_ADVANCE_MS) return verdict('no_decision', change) // остаряла статистика
      const packetsPerSecond = Math.round(((sample.packetsSent - base.packets) / (statsAdvance / 1000)) * 10) / 10
      if (sample.packetsSent > base.packets) {
        if (health === 'stall_suspected') {
          change = { state: 'stall_cleared', evidence: 'none', duration: durationBucket(stallSince === null ? null : sample.at - stallSince) }
          health = 'ok'
          stallSince = null
        }
        lastIncrease = { at: sample.at, statsTs: sample.statsTimestamp, source: sample.sourceSamplesDuration }
        samplesSinceIncrease = 0
        base = { id: sample.rtpStreamId, packets: sample.packetsSent, statsTs: sample.statsTimestamp, at: sample.at }
        return verdict('ok', change, packetsPerSecond)
      }
      samplesSinceIncrease += 1
      base = { id: sample.rtpStreamId, packets: sample.packetsSent, statsTs: sample.statsTimestamp, at: sample.at }
      const since = lastIncrease!
      const stalledMs = Math.min(sample.at - since.at, sample.statsTimestamp - since.statsTs)
      if (health === 'ok' && samplesSinceIncrease >= minSamples && stalledMs >= minStallMs) {
        health = 'stall_suspected'
        stallSince = since.at
        return verdict('stall', { state: 'stall_suspected', evidence: sourceEvidence(since.source, sample.sourceSamplesDuration, stalledMs), duration: 'none' }, packetsPerSecond)
      }
      return verdict(health === 'stall_suspected' ? 'stall' : 'no_decision', change, packetsPerSecond)
    },
    resetBaseline,
    markSuspected(at) {
      resetBaseline()
      health = 'stall_suspected'
      stallSince = at
    },
    clear() {
      resetBaseline()
      lastStreamId = null
      health = 'ok'
      mutedSince = null
      stallSince = null
    },
    health: () => health,
  }
}

// ─── Входящо аудио: допълнителен сигнал „говори, но не пристига“ ─────────

export type VoiceRemoteSample = {
  at: number
  /** От кога сървърът (ActiveSpeakers) отчита участника като говорещ без прекъсване; null — не говори. */
  speakingSince: number | null
  statsTimestamp: number | null
  rtpStreamId: string | null
  bytesReceived: number | null
}

/**
 * Само диагностика (НЕ доказателство кой компонент е повреден, без действие):
 * сървърът казва, че участникът говори непрекъснато, а към нас не пристигат
 * байтове за неговия track. Едно подозрение на track за cooldownMs.
 */
export function createRemoteStallEvaluator(options: { minSpeakingMs?: number; minStallMs?: number; cooldownMs?: number } = {}): {
  push: (trackSid: string, sample: VoiceRemoteSample) => boolean
  forget: (trackSid: string) => void
  size: () => number
} {
  const minSpeakingMs = options.minSpeakingMs ?? 3_000
  const minStallMs = options.minStallMs ?? 6_000
  const cooldownMs = options.cooldownMs ?? 60_000
  const tracks = new Map<string, { first: { at: number; statsTs: number; id: string; bytes: number } | null; reportedAt: number | null }>()
  return {
    push(trackSid, sample) {
      let entry = tracks.get(trackSid)
      if (entry === undefined) {
        entry = { first: null, reportedAt: null }
        tracks.set(trackSid, entry)
      }
      if (sample.speakingSince === null || sample.at - sample.speakingSince < minSpeakingMs) {
        entry.first = null
        return false
      }
      if (sample.statsTimestamp === null || sample.rtpStreamId === null || sample.bytesReceived === null) return false
      const first = entry.first
      if (first === null || first.id !== sample.rtpStreamId || sample.bytesReceived !== first.bytes || sample.at - first.at > minStallMs * 3) {
        entry.first = { at: sample.at, statsTs: sample.statsTimestamp, id: sample.rtpStreamId, bytes: sample.bytesReceived }
        return false
      }
      // Без нови байтове; участникът говори през ЦЕЛИЯ прозорец (от преди първото измерване).
      if (sample.speakingSince > first.at) return false
      if (sample.at - first.at < minStallMs || sample.statsTimestamp - first.statsTs < minStallMs) return false
      if (entry.reportedAt !== null && sample.at - entry.reportedAt < cooldownMs) return false
      entry.reportedAt = sample.at
      return true
    },
    forget(trackSid) { tracks.delete(trackSid) },
    size: () => tracks.size,
  }
}

// ─── H2: ограничение на автоматичните опити за входящото аудио ───────────

/**
 * Ключът е trackSid на отдалечената публикация (НЕ елементът): повторно
 * прикачване с нов елемент не дава нов бюджет. Плюс общ таван за страницата.
 */
export function createRecoveryLimiter(options: { perKeyMax?: number; perKeyWindowMs?: number; globalMax?: number; globalWindowMs?: number } = {}): {
  tryAcquire: (key: string, at: number) => boolean
  reset: () => void
  size: () => number
} {
  const perKeyMax = options.perKeyMax ?? 3
  const perKeyWindowMs = options.perKeyWindowMs ?? 60_000
  const globalMax = options.globalMax ?? 10
  const globalWindowMs = options.globalWindowMs ?? 60_000
  const perKey = new Map<string, number[]>()
  let global: number[] = []
  return {
    tryAcquire(key, at) {
      global = global.filter((t) => at - t < globalWindowMs)
      for (const [k, list] of perKey) {
        const fresh = list.filter((t) => at - t < perKeyWindowMs)
        if (fresh.length === 0) perKey.delete(k)
        else perKey.set(k, fresh)
      }
      const list = perKey.get(key) ?? []
      if (list.length >= perKeyMax || global.length >= globalMax) return false
      list.push(at)
      perKey.set(key, list)
      global.push(at)
      return true
    },
    reset() {
      perKey.clear()
      global = []
    },
    size: () => perKey.size,
  }
}

// ─── H2: обединяване на тригерите (без конкурентни проверки) ─────────────

export type VoiceCoalescerTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
  now?: () => number
}

/**
 * Една проверка наведнъж: заявки преди старта се обединяват в нея (най-ранното
 * закъснение печели); заявки по време на проверката дават ЕДНА следваща.
 */
export function createCoalescedTask<T>(timers: VoiceCoalescerTimers, run: (triggers: ReadonlySet<T>) => Promise<void>): {
  request: (trigger: T, delayMs: number) => void
  cancel: () => void
  pending: () => boolean
  stats: () => { requests: number; runs: number; maxConcurrent: number }
} {
  let timer: unknown = null
  let timerDueAt = Infinity
  let running = false
  let cancelled = false
  let queued = new Set<T>()
  let requests = 0
  let runs = 0
  let concurrent = 0
  let maxConcurrent = 0
  const start = (): void => {
    timer = null
    timerDueAt = Infinity
    if (cancelled) return
    if (running) return
    const triggers = queued
    queued = new Set<T>()
    running = true
    runs += 1
    concurrent += 1
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    void run(triggers).catch(() => {}).finally(() => {
      concurrent -= 1
      running = false
      if (!cancelled && queued.size > 0 && timer === null) {
        timerDueAt = 0
        timer = timers.setTimeout(start, 0)
      }
    })
  }
  return {
    request(trigger, delayMs) {
      if (cancelled) return
      requests += 1
      queued.add(trigger)
      if (running) return // след текущата проверка — една следваща
      const due = (timers.now?.() ?? Date.now()) + delayMs
      if (timer !== null) {
        if (due >= timerDueAt) return
        timers.clearTimeout(timer)
      }
      timerDueAt = due
      timer = timers.setTimeout(start, delayMs)
    },
    cancel() {
      cancelled = true
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
      queued.clear()
    },
    pending: () => timer !== null || running,
    stats: () => ({ requests, runs, maxConcurrent }),
  }
}

// ─── Груба платформа (диагностика; без пълен User-Agent и устройства) ────

export const VOICE_PLATFORMS = [
  'ios_safari', 'ios_pwa', 'ios_other',
  'android_chrome', 'android_samsung', 'android_pwa', 'android_other',
  'desktop_chrome', 'desktop_edge', 'desktop_safari', 'desktop_firefox', 'desktop_other',
  'unknown',
] as const
export type VoicePlatform = (typeof VOICE_PLATFORMS)[number]

export function classifyVoicePlatform(userAgent: string, environment: { standalone: boolean; maxTouchPoints: number }): VoicePlatform {
  const ua = userAgent
  if (ua.trim() === '') return 'unknown'
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && environment.maxTouchPoints > 1)
  if (ios) {
    if (environment.standalone) return 'ios_pwa'
    // Всички браузъри на iOS са WebKit; отделно само Safari.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios_other' : 'ios_safari'
  }
  if (/Android/.test(ua)) {
    if (environment.standalone) return 'android_pwa'
    if (/SamsungBrowser/.test(ua)) return 'android_samsung'
    if (/Chrome\//.test(ua) && !/EdgA|OPR|YaBrowser|Firefox/.test(ua)) return 'android_chrome'
    return 'android_other'
  }
  if (/Edg\//.test(ua)) return 'desktop_edge'
  if (/Firefox\//.test(ua)) return 'desktop_firefox'
  if (/Chrome\//.test(ua) && !/OPR|YaBrowser/.test(ua)) return 'desktop_chrome'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'desktop_safari'
  return 'desktop_other'
}
