// Гласов чат — Етап H3: панел „Диагностика на звука“ за измерване на реални
// телефони (DTX, getStats, наличност на показателите, автоматично
// възстановяване).
//
// * САМО за пълен администратор (account.role === 'admin' от текущата сесия).
//   Адресът ?voicediag=1 е само заявка (запомня се за таба в sessionStorage;
//   ?voicediag=0 или ✕ я премахват) и сам по себе си НЕ дава достъп: правото се
//   проверява при показване и при всяко обновяване — смяна на профила или
//   загуба на правата затварят панела. Играчи, VIP, subadmin и останалите
//   служебни роли не го виждат.
// * Само локални данни от този браузър: броячите на гласовия контролер и
//   адаптера (същите getStats, които наблюдението вече прави) — БЕЗ мрежови
//   заявки, без токени, identity-та, имена, IP или аудио.
// * „Копирай“ слага обобщението в клипборда — тестващият го изпраща ръчно.
// * Превключвателят на автоматичното възстановяване е само в паметта на тази
//   страница и само за този администратор (voiceMicRecoveryConfig.ts) — без
//   трайно активиране след refresh, ново влизане или смяна на профила.
// В lazy chunk-а на гласа (импортира се само от voiceRuntime).

import type { VoiceController } from './createVoiceController'
import type { VoicePlatform } from './voiceMediaHealth'
import {
  isVoiceDiagnosticsAccessGranted,
  isVoiceMicAutoRecoveryEnabled,
  resetVoiceMicAutoRecoveryOverride,
  setVoiceMicAutoRecoveryOverride,
  type VoiceDiagnosticsAccess,
} from './voiceMicRecoveryConfig'
// Заявката (?voicediag=1, вкл. след prerender) — voiceDiagnosticsRequest.ts.
import { isVoiceDiagnosticsRequested, VOICE_DIAGNOSTICS_STORAGE_KEY } from './voiceDiagnosticsRequest'

export { isVoiceDiagnosticsRequested, VOICE_DIAGNOSTICS_STORAGE_KEY }
const HOST_ID = 'voice-diagnostics-overlay'

/** Заявката сама не стига: само пълен администратор с профил. */
export function canShowVoiceDiagnostics(requested: boolean, access: VoiceDiagnosticsAccess | null): boolean {
  return requested && isVoiceDiagnosticsAccessGranted(access)
}

type DtxRun = { startedAt: number; samples: number[]; done: boolean }

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stat(values: number[]): { min: number | null; median: number | null; max: number | null } {
  if (values.length === 0) return { min: null, median: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! }
}

/**
 * Монтира панела (идемпотентно) — само за пълен администратор; връща функция за
 * премахване (null — няма достъп, нищо не е монтирано).
 */
export function mountVoiceDiagnosticsOverlay(controller: VoiceController, platform: VoicePlatform, access: () => VoiceDiagnosticsAccess | null): (() => void) | null {
  document.getElementById(HOST_ID)?.remove()
  const initial = access()
  if (!canShowVoiceDiagnostics(isVoiceDiagnosticsRequested(), initial)) return null
  const ownerProfileId = initial!.profileId
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-voice-diagnostics', '1')
  host.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:min(92vw,360px);max-height:60vh;overflow:auto;'
    + 'background:rgba(10,12,16,0.94);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:10px;'
    + 'font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);'
  document.body.appendChild(host)

  let collapsed = true
  let disposed = false
  let permission = 'неизвестно'
  let dtx: DtxRun | null = null
  let lastPpsSeen = -2
  let lastCopy = ''
  const ppsHistory: number[] = []

  const refreshPermission = (): void => {
    try {
      void navigator.permissions?.query({ name: 'microphone' as PermissionName })
        .then((status) => { permission = status.state }, () => { permission = 'неподдържано' })
    } catch {
      permission = 'неподдържано'
    }
  }
  refreshPermission()

  function summary(): Record<string, unknown> {
    const snapshot = controller.getSnapshot()
    const c = controller.debugCounters()
    // -1 = още неизмерено (служебна стойност на адаптера) -> „?“.
    const m = (key: string): number | null => {
      const value = c[`media.${key}`]
      return typeof value === 'number' && value !== -1 ? value : null
    }
    const audio = [...document.querySelectorAll<HTMLMediaElement>('[data-voice-audio-sink] audio')]
    return {
      platform,
      permission,
      autoRecovery: isVoiceMicAutoRecoveryEnabled(access()),
      status: snapshot.status,
      microphone: snapshot.microphone,
      health: snapshot.microphoneHealth,
      recovery: snapshot.microphoneRecovery,
      captureLive: m('captureLive'),
      captureMuted: m('captureMuted'),
      upstreamPaused: m('upstreamPaused'),
      packetsPerSecond: { last: m('lastPacketsPerSecond'), min: m('minPacketsPerSecond'), max: m('maxPacketsPerSecond') },
      mediaSource: m('sourceAvailable'),
      captureSecondsPerSecond: m('lastSourceRate'),
      trackStats: m('trackFramesAvailable'),
      getStats: { calls: m('getStatsCalls'), avgMs: m('getStatsCalls') ? Math.round(((m('getStatsTotalMs') ?? 0) / (m('getStatsCalls') ?? 1)) * 100) / 100 : null, maxMs: m('getStatsMaxMs'), concurrentMax: m('statsInFlightMax') },
      recoveries: { attempts: m('micRecoveryAttempts'), recovered: m('micRecoveryRecovered'), autoInWindow: c.micAutoAttempts ?? null },
      output: { elements: audio.length, paused: audio.filter((el) => el.paused).length, blocked: snapshot.playbackBlocked, recoveries: m('outputRecoveries'), pauses: m('outputPauses') },
      dtx60s: dtx === null ? null : { samples: dtx.samples.length, done: dtx.done, ...stat(dtx.samples) },
      recentPps: ppsHistory.slice(-10),
    }
  }

  function render(): void {
    // Правото — при всяко обновяване: друг профил / излизане / без права -> затваряне.
    const current = access()
    if (!isVoiceDiagnosticsAccessGranted(current) || current.profileId !== ownerProfileId) {
      resetVoiceMicAutoRecoveryOverride()
      dispose()
      return
    }
    const data = summary()
    const pps = data.packetsPerSecond as { last: number | null; min: number | null; max: number | null }
    const last = pps.last ?? -1
    if (last !== lastPpsSeen && last >= 0) {
      ppsHistory.push(last)
      if (ppsHistory.length > 40) ppsHistory.shift()
      if (dtx !== null && !dtx.done) dtx.samples.push(last)
    }
    lastPpsSeen = last
    if (dtx !== null && !dtx.done && Date.now() - dtx.startedAt >= 60_000) dtx.done = true
    const yesNo = (v: unknown) => (v === 1 ? 'да' : v === 0 ? 'не' : '?')
    const dtxText = dtx === null ? '—' : `${dtx.done ? 'готово' : `${Math.round((Date.now() - dtx.startedAt) / 1000)} s…`} мин ${stat(dtx.samples).min ?? '?'} / мед. ${stat(dtx.samples).median ?? '?'} / макс ${stat(dtx.samples).max ?? '?'} (${dtx.samples.length})`
    const rows: Array<[string, string]> = collapsed ? [] : [
      ['Платформа', String(data.platform)],
      ['Разрешение', String(data.permission)],
      ['Микрофон', `${data.microphone} · ${data.health} · ${data.recovery}`],
      ['Capture жив / заглушен', `${yesNo(data.captureLive)} / ${yesNo(data.captureMuted)}`],
      ['Спряно изходящо (LiveKit)', yesNo(data.upstreamPaused)],
      ['RTP пакети/s', `${pps.last ?? '?'} (мин ${pps.min ?? '?'}, макс ${pps.max ?? '?'})`],
      ['media-source', `${yesNo(data.mediaSource)} · ${data.captureSecondsPerSecond ?? '?'} s/s`],
      ['MediaStreamTrack.stats', yesNo(data.trackStats)],
      ['getStats', JSON.stringify(data.getStats)],
      ['Възстановявания', JSON.stringify(data.recoveries)],
      ['Входящ звук', JSON.stringify(data.output)],
      ['DTX тест (60 s тишина)', dtxText],
    ]
    host.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;justify-content:space-between;">
        <strong data-voice-diag-toggle="1" style="cursor:pointer;color:#fbbf24;">Диагностика на звука ${collapsed ? '▸' : '▾'}</strong>
        <button type="button" data-voice-diag-close="1" style="background:none;border:0;color:#9ca3af;font:inherit;cursor:pointer;">✕</button>
      </div>
      ${rows.map(([k, v]) => `<div style="display:flex;gap:8px;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.06);padding:2px 0;"><span style="color:#9ca3af;">${escapeHtml(k)}</span><span style="text-align:right;overflow-wrap:anywhere;">${escapeHtml(v)}</span></div>`).join('')}
      ${collapsed ? '' : `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
        <button type="button" data-voice-diag-dtx="1" style="${BUTTON}">DTX тест 60 s</button>
        <button type="button" data-voice-diag-auto="1" style="${BUTTON}">Автоматично: ${data.autoRecovery ? 'вкл.' : 'изкл.'}</button>
        <button type="button" data-voice-diag-copy="1" style="${BUTTON}">Копирай</button>
      </div>${lastCopy ? `<div style="margin-top:4px;color:#86efac;">${escapeHtml(lastCopy)}</div>` : ''}`}
    `
  }

  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-voice-diag-toggle]')) collapsed = !collapsed
    else if (target.closest('[data-voice-diag-close]')) {
      try { window.sessionStorage.removeItem(VOICE_DIAGNOSTICS_STORAGE_KEY) } catch { /* няма */ }
      resetVoiceMicAutoRecoveryOverride()
      dispose()
      return
    } else if (target.closest('[data-voice-diag-dtx]')) {
      dtx = { startedAt: Date.now(), samples: [], done: false }
    } else if (target.closest('[data-voice-diag-auto]')) {
      setVoiceMicAutoRecoveryOverride(!isVoiceMicAutoRecoveryEnabled(access()), access())
    } else if (target.closest('[data-voice-diag-copy]')) {
      const text = JSON.stringify({ at: new Date().toISOString(), ...summary() }, null, 1)
      void navigator.clipboard?.writeText(text).then(() => { lastCopy = 'Копирано.' }, () => { lastCopy = 'Клипбордът е недостъпен — направете снимка на екрана.' })
    }
    render()
  })

  const timer = window.setInterval(() => {
    render()
  }, 1_000)
  const permissionTimer = window.setInterval(refreshPermission, 5_000)
  render()

  function dispose(): void {
    if (disposed) return
    disposed = true
    window.clearInterval(timer)
    window.clearInterval(permissionTimer)
    host.remove()
  }
  return dispose
}

const BUTTON = 'background:#1f2937;color:#e5e7eb;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:4px 8px;font:inherit;cursor:pointer;'
