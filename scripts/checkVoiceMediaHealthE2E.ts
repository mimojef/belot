/**
 * checkVoiceMediaHealthE2E.ts — Гласов чат, Етап H1/H2 срещу РЕАЛЕН локален
 * livekit-server 1.13.11 (същата версия като production), изолирано копие на
 * игровия сървър + Vite и четири отделни Chromium процеса:
 *   A 450 Hz, B 650 Hz (capture през тестов „gate“ — breakout box), C 950 Hz,
 *   D — тишина (микрофонът е включен, но вход няма -> DTX).
 *
 * „Чуване“ (H2) = тонът е в получения поток И елементът реално свири
 * (не е паузиран/откачен, volume > 0, currentTime напредва). В headless
 * Chromium captureStream()/media-playout/totalSamplesReceived НЕ отразяват
 * пауза на елемента (проверено) — затова пробата гледа самия елемент.
 *
 *   [M0]  взаимно чуване (с пробата, зависеща от възпроизвеждането)
 *   [M1]  75 s нормален разговор + тишина/DTX: 0 подозрения/0 медийни събития;
 *         натоварване (getStats, таймери, без припокриване); DTX честота
 *   [M2]  спрял RTP sender (encodings.active=false; capture дава кадри): capture_active
 *         -> H3 НЕ заменя capture-а, само бутон
 *   [M3]  H3, случаят МЕТЕОРА: спрял capture (без mute/ended; RTCP продължава, LiveKit
 *         логва clock skew) -> потвърждение -> нов capture + replaceTrack в СЪЩАТА
 *         публикация (същият sid); другите отново чуват тона; никога два capture-а
 *   [R1]  отказан getUserMedia -> „failed“ (заглушена публикация, същият sid), без втори
 *         автоматичен опит; „Възстанови микрофона“ -> чуване
 *   [R2]  нов инцидент в 60 s cooldown -> само бутон
 *   [R3]  ръчно изключване по време на възстановяването -> отменено
 *   [R4]  рестарт на LiveKit по време на възстановяването -> отменено, без зависнала операция
 *   [R5]  3 автоматични опита за 10 мин, 4-тият -> само бутон
 *   [M12] (само при E2E_SILENCE_MINUTES>0) продължителна тишина/DTX без фалшиви тревоги
 *   [M4]  неочаквано паузиран елемент -> автоматично пуснат, реално чуване
 *   [M5]  откачен елемент (махнат от DOM) -> НОВ елемент, старият не свири
 *   [M6]  локално заглушен участник + пауза -> пуснат, но остава заглушен
 *   [M7]  скрита страница: пауза не се „поправя“ на фон; visible+focus+
 *         pageshow+devicechange -> едно възстановяване, без конкурентни проверки
 *   [M8]  лимит по track sid: повторно прикачване не дава нов бюджет ->
 *         „Включи звука“ (реален бутон) -> чуване
 *   [M9]  NotAllowedError -> „Включи звука“, без повторни опити до жеста
 *   [M10] хронологията в админ панела: събитията с UTC минута и платформа
 *   [M11] изход от гласа: 0 таймери/слушатели/елементи (без изтичане)
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMediaHealthE2E.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceMediaHealthE2E\n')

const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? 'D:\\tmp\\livekit-1.13.11\\bin\\livekit-server.exe'
if (!existsSync(LIVEKIT_BIN)) {
  console.log(`  SKIP  няма livekit-server (${LIVEKIT_BIN}); задай LIVEKIT_SERVER_BIN`)
  process.exit(0)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

// ─── Локален LiveKit ──────────────────────────────────────────────────────
const workDir = await mkdtemp(join(tmpdir(), 'pika-media-health-e2e-'))
const lkPort = await freePort()
const lkTcpPort = await freePort()
const udpStart = 53_000 + Math.floor(Math.random() * 400) * 10
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
await writeFile(join(workDir, 'livekit.yaml'), [
  `port: ${lkPort}`,
  'bind_addresses: ["127.0.0.1"]',
  'rtc:',
  `  tcp_port: ${lkTcpPort}`,
  `  port_range_start: ${udpStart}`,
  `  port_range_end: ${udpStart + 200}`,
  '  use_external_ip: false',
  '  node_ip: 127.0.0.1',
  'keys:',
  `  ${apiKey}: ${apiSecret}`,
  'room:',
  '  auto_create: false',
  '  empty_timeout: 120',
  '  departure_timeout: 120',
  'logging:',
  '  level: info',
  '',
].join('\n'))
const lkLog: string[] = []
function spawnLiveKit(): ChildProcess {
  const child = spawn(LIVEKIT_BIN, ['--config', join(workDir, 'livekit.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => { lkLog.push(chunk); if (lkLog.length > 300) lkLog.shift() })
  }
  return child
}
let liveKit: ChildProcess = spawnLiveKit()
/** R4: истински рестарт на LiveKit (всички участници губят връзката). */
async function restartLiveKit(): Promise<void> {
  const old = liveKit
  await new Promise<void>((resolve) => { old.once('exit', () => resolve()); old.kill() })
  liveKit = spawnLiveKit()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${lkPort}/`)).ok) return } catch { /* стартира */ }
    await sleep(250)
  }
  throw new Error('LiveKit не стартира след рестарта')
}
{
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline && !ready) {
    try { ready = (await fetch(`http://127.0.0.1:${lkPort}/`)).ok } catch { /* стартира */ }
    if (!ready) await sleep(250)
  }
  if (!ready) {
    console.error(lkLog.join('').slice(-3000))
    liveKit.kill()
    throw new Error('livekit-server не стартира')
  }
  console.log(`LiveKit 1.13.11 на 127.0.0.1:${lkPort}.`)
}

// Пулсиращи тонове (шумопотискането не ги изрязва); честота 0 = тишина.
async function writeToneWav(path: string, frequency: number): Promise<void> {
  const sampleRate = 48_000
  const samples = sampleRate * 4
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate
    const on = (t % 0.4) < 0.3
    const envelope = on ? Math.min(1, ((t % 0.4) / 0.01)) * Math.min(1, ((0.3 - (t % 0.4)) / 0.01)) : 0
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * t) * 0.45 * envelope * 32_767), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  await writeFile(path, Buffer.concat([header, data]))
}

process.env.LIVEKIT_API_URL = `http://127.0.0.1:${lkPort}`
process.env.LIVEKIT_WS_URL = `ws://127.0.0.1:${lkPort}`
process.env.LIVEKIT_API_KEY = apiKey
process.env.LIVEKIT_API_SECRET = apiSecret
process.env.VOICE_ROOM_NAMESPACE = 'e2emedia'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness({
  ...(Number(process.env.E2E_SILENCE_MINUTES ?? '0') > 0
    ? { patchServerSource: [{ file: 'game/privateRoomsStore.ts', find: 'const timeoutMs = input.waitMinutes * 60 * 1000', replace: 'const timeoutMs = input.waitMinutes * 60 * 1000 * 3' }] }
    : {}),
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: { NODE_ENV: 'development', BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1' },
})

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const TONE_A = 450
const TONE_B = 650
const TONE_C = 950

// Проба на ЧУТОТО: тонът в потока на елемента + елементът реално свири.
const AUDIO_PROBE = `(() => {
  const TONES = [${TONE_A}, ${TONE_B}, ${TONE_C}]
  const THRESHOLD_DB = -62
  const st = { last: {}, perSid: {}, bySid: {} }
  let ctx = null
  const analysers = new Map()
  function tick() {
    try {
      if (ctx === null) ctx = new AudioContext()
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      for (const el of document.querySelectorAll('[data-voice-audio-sink] audio')) {
        if (analysers.has(el) || !(el.srcObject instanceof MediaStream)) continue
        const source = ctx.createMediaStreamSource(el.srcObject)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0
        source.connect(analyser)
        analysers.set(el, { analyser, lastTime: el.currentTime, lastAdvanceAt: 0 })
      }
      const now = performance.now()
      for (const [el, rec] of analysers) {
        if (!el.isConnected) { analysers.delete(el); continue }
        if (el.currentTime !== rec.lastTime) { rec.lastTime = el.currentTime; rec.lastAdvanceAt = now }
        const playing = !el.paused && !el.ended && !el.muted && el.volume > 0 && now - rec.lastAdvanceAt < 400
        const data = new Float32Array(rec.analyser.frequencyBinCount)
        rec.analyser.getFloatFrequencyData(data)
        const binHz = ctx.sampleRate / rec.analyser.fftSize
        const sid = el.getAttribute('data-voice-track') || '?'
        for (const f of TONES) {
          const bin = Math.round(f / binHz)
          let peak = -Infinity
          for (let i = bin - 2; i <= bin + 2; i += 1) peak = Math.max(peak, data[i])
          if (peak <= THRESHOLD_DB) continue
          const per = (st.perSid[sid] = st.perSid[sid] || {})
          per[f] = (per[f] || 0) + 1
          if (playing) {
            st.last[f] = now
            const bySid = (st.bySid[sid] = st.bySid[sid] || {})
            bySid[f] = now
          }
        }
      }
    } catch (error) { st.error = String(error) }
  }
  setInterval(tick, 40)
  window.__audioProbe = {
    agoMs: (f) => st.last[f] === undefined ? null : Math.round(performance.now() - st.last[f]),
    /** Тонът f, чут ОТ елемента на sid (AEC на Chromium примесва чужди тонове в потоците — затова по sid). */
    agoMsSid: (sid, f) => { const t = st.bySid[sid] && st.bySid[sid][f]; return t === undefined ? null : Math.round(performance.now() - t) },
    /** sid -> преобладаващ тон в потока (независимо от възпроизвеждането). */
    toneOfSid: () => Object.fromEntries(Object.entries(st.perSid).map(([sid, per]) => [sid, Number(Object.entries(per).sort((a, b) => b[1] - a[1])[0][0])])),
    error: () => st.error ?? null,
  }
})()`

// Само в теста: броячи на getStats (SDK + нашите), достъп до микрофонния sender, отказ на play(), скрита страница.
const INSTRUMENT = `(() => {
  window.__statsCalls = { pc: 0, sender: 0, receiver: 0 }
  const wrap = (proto, key) => { const orig = proto.getStats; proto.getStats = function (...args) { window.__statsCalls[key] += 1; return orig.apply(this, args) } }
  wrap(RTCPeerConnection.prototype, 'pc'); wrap(RTCRtpSender.prototype, 'sender'); wrap(RTCRtpReceiver.prototype, 'receiver')
  // S1 (като Safari): без media-source в sender.getStats и без MediaStreamTrack.stats.
  window.__hideMediaSource = false
  const senderStats = RTCRtpSender.prototype.getStats
  RTCRtpSender.prototype.getStats = function (...args) {
    const result = senderStats.apply(this, args)
    if (!window.__hideMediaSource) return result
    return result.then((report) => { const m = new Map(); report.forEach((v, k) => { if (v.type !== 'media-source') m.set(k, v) }); return m })
  }
  const trackStats = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'stats')
  if (trackStats && trackStats.get) Object.defineProperty(MediaStreamTrack.prototype, 'stats', { configurable: true, get() { return window.__hideMediaSource ? undefined : trackStats.get.call(this) } })
  const Orig = window.RTCPeerConnection
  window.__pcs = []
  class Tracked extends Orig { constructor(...args) { super(...args); window.__pcs.push(this) } }
  window.RTCPeerConnection = Tracked
  window.__micSender = () => {
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue
      for (const s of pc.getSenders()) if (s.track && s.track.kind === 'audio' && s.track.readyState === 'live') return s
    }
    return null
  }
  window.__setSenderActive = async (active) => {
    const s = window.__micSender()
    if (!s) return 'no-sender'
    const p = s.getParameters()
    if (!p.encodings || p.encodings.length === 0) return 'no-encodings'
    p.encodings.forEach((e) => { e.active = active })
    await s.setParameters(p)
    return 'ok:' + s.track.readyState + ':' + s.track.enabled + ':' + s.track.muted
  }
  window.__denyPlay = false
  window.__deniedPlays = 0
  const origPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    if (window.__denyPlay && this.closest && this.closest('[data-voice-audio-sink]')) { window.__deniedPlays += 1; return Promise.reject(new DOMException('denied by test', 'NotAllowedError')) }
    return origPlay.call(this)
  }
  window.__setHidden = (hidden) => {
    if (hidden) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    } else {
      delete document.visibilityState
      delete document.hidden
    }
    document.dispatchEvent(new Event('visibilitychange'))
  }
})()`

// B: capture през breakout box с „gate“ — затворен = кадрите не стигат до sender-а (track остава live/unmuted).
const CAPTURE_GATE = `(() => {
  const md = navigator.mediaDevices
  const orig = md.getUserMedia.bind(md)
  window.__captureGateClosed = false
  window.__gateDropped = 0
  window.__gates = []
  window.__gateSticky = false
  window.__sourceTracks = []
  // H3: спира САМО текущия capture (нов getUserMedia дава работещ); sticky — и новите започват спрени.
  window.__stallCurrentCapture = () => { const g = window.__gates[window.__gates.length - 1]; if (g) g.closed = true; return window.__gates.length }
  window.__resumeCaptures = () => { for (const g of window.__gates) g.closed = false; window.__gateSticky = false }
  md.getUserMedia = async (constraints) => {
    const stream = await orig(constraints)
    const track = stream.getAudioTracks()[0]
    if (!track || typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') { window.__gateUnsupported = true; return stream }
    window.__sourceTracks.push(track)
    const state = { closed: window.__gateSticky === true }
    window.__gates.push(state)
    const processor = new MediaStreamTrackProcessor({ track })
    const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
    const gate = new TransformStream({ transform(frame, controller) { if (state.closed || window.__captureGateClosed) { window.__gateDropped += 1; frame.close(); return } controller.enqueue(frame) } })
    processor.readable.pipeThrough(gate).pipeTo(generator.writable).catch(() => {})
    const stop = generator.stop.bind(generator)
    generator.stop = () => { stop(); track.stop() }
    return new MediaStream([generator])
  }
})()`

// Само в теста: отказ/задържане на СЛЕДВАЩИЯ getUserMedia и брояч на живите capture-и (на 20 ms).
const GUM_CONTROL = `(() => {
  const md = navigator.mediaDevices
  if (!md) return
  const orig = md.getUserMedia.bind(md)
  window.__returnedTracks = []
  window.__maxLiveCaptures = 0
  window.__failNextGum = null
  window.__holdGum = false
  let release = null
  window.__releaseGum = () => { if (release) { const r = release; release = null; r() } }
  window.__gumHeld = () => release !== null
  window.__liveCaptureCount = () => (window.__sourceTracks || window.__returnedTracks).filter((t) => t.readyState === 'live').length
  setInterval(() => { window.__maxLiveCaptures = Math.max(window.__maxLiveCaptures, window.__liveCaptureCount()) }, 20)
  md.getUserMedia = async (constraints) => {
    if (window.__failNextGum) { const name = window.__failNextGum; window.__failNextGum = null; throw new DOMException('denied by test', name) }
    if (window.__holdGum) { window.__holdGum = false; await new Promise((resolve) => { release = resolve }) }
    const stream = await orig(constraints)
    for (const t of stream.getTracks()) window.__returnedTracks.push(t)
    return stream
  }
})()`

type Party = {
  label: string
  tone: number
  profile: TestProfile
  browser: Browser
  context: BrowserContext
  page: Page
  reports: Array<{ at: number; body: any }>
}

async function register(tag: string): Promise<TestProfile> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const p = await h.register(attempt === 0 ? tag : `${tag}${attempt}`)
      h.setBalance(p.profileId, 50_000_000)
      return p
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !error.message.includes('fetch failed')) throw error
      await sleep(500)
    }
  }
}

async function openParty(label: string, profile: TestProfile, tone: number, viewport: typeof DESKTOP, options: { captureGate?: boolean; query?: string } = {}): Promise<Party> {
  const wav = join(workDir, `tone-${label}.wav`)
  await writeToneWav(wav, tone)
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
  })
  const context = await browser.newContext(viewport === MOBILE ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport })
  await context.grantPermissions(['microphone'], { origin: h.appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(AUDIO_PROBE)
  await context.addInitScript(INSTRUMENT)
  if (options.captureGate) await context.addInitScript(CAPTURE_GATE)
  await context.addInitScript(GUM_CONTROL)
  await context.addInitScript("(() => { const md = navigator.mediaDevices; if (!md) return; const orig = md.getUserMedia.bind(md); window.__gumCalls = 0; md.getUserMedia = (c) => { window.__gumCalls += 1; return orig(c) } })()")
  const reports: Party['reports'] = []
  await context.route(`${h.backendOrigin}/api/voice/client-report`, async (route) => {
    try { reports.push({ at: Date.now(), body: JSON.parse(route.request().postData() ?? 'null') }) } catch { /* not JSON */ }
    await route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  await page.goto(`${h.appOrigin}/lobby${options.query ?? ''}`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, tone, profile, browser, context, page, reports }
}

async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}

let currentVoiceTableId = ''
/** Текущият микрофонен sid на говорителя по сървъра на LiveKit (null — няма/повече от един). */
async function speakerSid(speaker: Party): Promise<string | null> {
  const sids = tracksOf(await serverTracks(currentVoiceTableId), speaker.profile.profileId)
  return sids.length === 1 ? sids[0]! : null
}
const toneOwner = new Map<number, Party>()
/** Колко ms от последното чуване на тона на говорителя ОТ неговия елемент при слушателя. */
async function agoMs(p: Party, tone: number): Promise<number | null> {
  const sid = await speakerSid(toneOwner.get(tone)!)
  if (sid === null) return null
  return p.page.evaluate(`window.__audioProbe.agoMsSid(${JSON.stringify(sid)}, ${tone})`) as Promise<number | null>
}
const hears = async (p: Party, tone: number, freshMs = 1_200) => { const ago = await agoMs(p, tone); return ago !== null && ago <= freshMs }
const notHearing = async (p: Party, tone: number, staleMs = 2_500) => { const ago = await agoMs(p, tone); return ago === null || ago > staleMs }
/** Чуто СЛЕД събитието в момента sinceMs (иначе последното чуване отпреди паузата би минало). */
const hearsAfter = async (p: Party, tone: number, sinceMs: number) => { const ago = await agoMs(p, tone); return ago !== null && ago < Date.now() - sinceMs - 150 }
type Snap = { status: string; microphone: string; microphoneHealth: string; microphoneRecovery: string; playbackBlocked: boolean; wantsToSpeak: boolean }
const snap = (p: Party) => p.page.evaluate(`(() => { const s = window.__pikaVoice?.getSnapshot(); return s ? { status: s.status, microphone: s.microphone, microphoneHealth: s.microphoneHealth, microphoneRecovery: s.microphoneRecovery, playbackBlocked: s.playbackBlocked, wantsToSpeak: s.wantsToSpeak } : null })()`) as Promise<Snap | null>
const counters = (p: Party) => p.page.evaluate('window.__pikaVoice ? window.__pikaVoice.debugCounters() : {}') as Promise<Record<string, number>>
const gumCalls = (p: Party) => p.page.evaluate('window.__gumCalls') as Promise<number>
const mediaReports = (p: Party, since = 0) => p.reports.filter((r) => r.at >= since && typeof r.body?.event === 'string' && r.body.event.startsWith('media_')).map((r) => r.body)
const describe = (body: any) => [body.event, body.state, body.evidence, body.step, body.result, body.trigger].filter((x) => x !== undefined && x !== 'none').join(':')
/** Състоянието на sink-а (диагностика при провал). */
const sinkState = (p: Party) => p.page.evaluate(`[...document.querySelectorAll('[data-voice-audio-sink] audio')].map((el) => (el.getAttribute('data-voice-track') || '?').slice(-6) + (el.paused ? ':paused' : ':playing') + (el.isConnected ? '' : ':detached') + ':v' + el.volume).join(' ')`) as Promise<string>
/** Елементът за даден track sid в sink-а (null — няма). */
const elementExpr = (sid: string) => `document.querySelector('[data-voice-audio-sink] audio[data-voice-track="${sid}"]')`

function generations(voiceTableId: string): Array<{ status: string; retire_reason: string | null; livekit_room_name: string }> {
  return h.db.prepare('SELECT status, retire_reason, livekit_room_name FROM voice_room_generations WHERE voice_table_id = ? ORDER BY generation').all(voiceTableId) as never
}
const { RoomServiceClient } = await import('../server/node_modules/livekit-server-sdk/dist/index.js' as string) as typeof import('livekit-server-sdk')
const roomService = new RoomServiceClient(`http://127.0.0.1:${lkPort}`, apiKey, apiSecret)
/** identity -> sid-ове на публикуваните tracks (сървърът на LiveKit). */
async function serverTracks(voiceTableId: string): Promise<Record<string, string[]>> {
  const live = generations(voiceTableId).filter((g) => g.retire_reason === null).at(-1)
  if (live === undefined) return {}
  const list = await roomService.listParticipants(live.livekit_room_name).catch(() => [])
  return Object.fromEntries(list.map((p) => [p.identity, p.tracks.map((t) => t.sid)]))
}
const tracksOf = (tracks: Record<string, string[]>, profileId: string) => Object.entries(tracks).filter(([identity]) => identity.startsWith(`p_${profileId}_`)).flatMap(([, sids]) => sids)

async function openPanel(p: Party): Promise<void> {
  const open = p.page.locator('[data-voice-action="open-panel"]').first()
  await open.click({ timeout: 10_000 })
  await p.page.locator('[data-voice-panel="1"]').first().waitFor({ state: 'visible', timeout: 10_000 })
}
async function closePanel(p: Party): Promise<void> {
  await p.page.locator('[data-voice-panel="1"] [data-voice-action="close"]').first().click({ timeout: 5_000 }).catch(() => undefined)
}

const parties: Party[] = []
/** E2E_ONLY=M0,M4 — само избраните сценарии (M0 винаги). */
const ONLY = process.env.E2E_ONLY?.split(',').map((x) => x.trim()).filter(Boolean) ?? null
/** M12 (продължителна тишина/DTX) — само при E2E_SILENCE_MINUTES > 0. */
const SILENCE_MINUTES = Number(process.env.E2E_SILENCE_MINUTES ?? '0')
async function scenario(id: string, label: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY !== null && id !== 'M0' && !ONLY.includes(id)) return
  if (id === 'M12' && !(SILENCE_MINUTES > 0)) return
  await check(label, fn)
}
try {
  const profiles = [await register('mha'), await register('mhb'), await register('mhc'), await register('mhd')]
  const vipUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  for (const [index, p] of profiles.entries()) {
    // D — subadmin: участва в гласа на съществуващата маса, но НЕ е пълен администратор (M13).
    h.db.prepare(`UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(index === 3 ? 'subadmin' : 'admin', p.profileId)
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(p.profileId, vipUntil)
  }
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), profiles[0]!.profileId, new Date().toISOString())

  const A = await openParty('A', profiles[0]!, TONE_A, DESKTOP, { captureGate: true })
  const B = await openParty('B', profiles[1]!, TONE_B, MOBILE, { captureGate: true })
  const C = await openParty('C', profiles[2]!, TONE_C, DESKTOP, { query: '?voicediag=1' })
  const D = await openParty('D', profiles[3]!, 0, MOBILE, { query: '?voicediag=1' })
  parties.push(A, B, C, D)
  const speakers = [A, B, C]
  for (const speaker of speakers) toneOwner.set(speaker.tone, speaker)

  // Гласова маса (ръчен старт — остава в чакалнята); всички с микрофон.
  await A.page.locator(LOBBY_READY).first().click()
  await A.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = A.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  await A.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await A.page.locator('[data-private-room-create-form="1"] select[name="waitMinutes"]').selectOption('30').catch(() => undefined)
  await A.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await A.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const created = await waitUntil('стаята на A', async () => {
    const row = h.db.prepare('SELECT private_room_id, voice_table_id FROM voice_tables WHERE status = ? ORDER BY created_at DESC LIMIT 1').get('active') as { private_room_id: string; voice_table_id: string } | undefined
    return row
  }, 15_000)
  const privateRoomId = created.private_room_id
  const voiceTableId = created.voice_table_id
  currentVoiceTableId = voiceTableId
  await A.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  for (const party of [B, C, D]) {
    await party.page.locator(LOBBY_READY).first().click()
    const plus = party.page.locator(`[data-private-room-list-slot-join^="${privateRoomId}:"]`).first()
    await plus.waitFor({ state: 'visible', timeout: 15_000 })
    await plus.click()
    await party.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
    await party.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
    await party.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  }

  // sid на всеки говорител при всеки слушател (за M4–M9).
  const sidAt = new Map<Party, Record<number, string>>()
  /** Текущият sid на говорителя (от сървъра) и изчакване, докато слушателят има елемент за него. */
  async function sidFor(listener: Party, speaker: Party): Promise<string> {
    return waitUntil(`sid на ${speaker.label} при ${listener.label}`, async () => {
      const sids = tracksOf(await serverTracks(voiceTableId), speaker.profile.profileId)
      if (sids.length !== 1) return false
      return (await listener.page.evaluate(`!!${elementExpr(sids[0]!)}`)) && (await hears(listener, speaker.tone)) ? sids[0]! : false
    }, 20_000)
  }

  await scenario('M0', '[M0] Взаимно чуване на тоновете (пробата изисква реално възпроизвеждане); B говори през тестовия capture gate', async () => {
    const gateUnsupported = await B.page.evaluate('window.__gateUnsupported === true')
    assert(!gateUnsupported, 'MediaStreamTrackProcessor/Generator не са налични — M3 не може да се изпълни')
    const started = Date.now()
    await waitUntil('взаимно чуване', async () => {
      for (const listener of parties) {
        for (const speaker of speakers) {
          if (speaker !== listener && !(await hears(listener, speaker.tone))) return false
        }
      }
      for (const p of parties) if ((await snap(p))?.microphone !== 'live') return false
      return true
    }, 60_000)
    // sid-ът на всеки говорител е от сървъра на LiveKit (един микрофонен track на участник) —
    // НЕ от анализа (AEC на Chromium примесва чужди тонове в потоците).
    const tracks = await serverTracks(voiceTableId)
    const sidOf: Record<number, string> = {}
    for (const speaker of speakers) {
      const sids = tracksOf(tracks, speaker.profile.profileId)
      assert(sids.length === 1, `${speaker.label}: ${JSON.stringify(sids)}`)
      sidOf[speaker.tone] = sids[0]!
    }
    for (const listener of parties) sidAt.set(listener, { ...sidOf })
    for (const listener of parties) {
      for (const speaker of speakers) {
        if (speaker === listener) continue
        const present = await listener.page.evaluate(`!!${elementExpr(sidOf[speaker.tone]!)}`)
        assert(present, `${listener.label}: няма елемент за ${speaker.label} (${sidOf[speaker.tone]})`)
      }
    }
    console.log(`    взаимно чуване след ${Date.now() - started} ms; sid-ове: ${JSON.stringify(sidOf)}`)
    for (const listener of parties) for (const speaker of speakers) if (speaker !== listener) assert(sidAt.get(listener)![speaker.tone] !== undefined, `${listener.label} няма sid за ${speaker.label}`)
  })

  await scenario('M1', '[M1] 75 s нормален разговор + тишина (D, DTX): 0 подозрения и 0 медийни събития; натоварване: 1 sender.getStats на 3 s (+ receiver само за говорещ), без припокриване; DTX честота', async () => {
    const startedAt = Date.now()
    const before = await Promise.all(parties.map(async (p) => ({ c: await counters(p), s: await p.page.evaluate('({ ...window.__statsCalls })') as Record<string, number> })))
    const healthSeen = new Set<string>()
    while (Date.now() - startedAt < 75_000) {
      for (const p of parties) {
        const s = await snap(p)
        healthSeen.add(`${p.label}:${s?.microphoneHealth}:${s?.playbackBlocked ? 'blocked' : ''}`)
      }
      await sleep(1_000)
    }
    const seconds = (Date.now() - startedAt) / 1000
    const lines: string[] = []
    for (const [index, p] of parties.entries()) {
      const c = await counters(p)
      const s = await p.page.evaluate('({ ...window.__statsCalls })') as Record<string, number>
      const ours = c['media.getStatsCalls']! - before[index]!.c['media.getStatsCalls']!
      const ticks = c['media.monitorTicks']! - before[index]!.c['media.monitorTicks']!
      const total = (s.pc! + s.sender! + s.receiver!) - (before[index]!.s.pc! + before[index]!.s.sender! + before[index]!.s.receiver!)
      lines.push(`${p.label}: наши getStats ${ours} (${(ours / seconds).toFixed(2)}/s; входни ${c['media.inputSamples']}, отдалечени ${c['media.remoteSamples']}), всички getStats ${total} (${(total / seconds).toFixed(2)}/s), тикове ${ticks}, ср. ${(c['media.getStatsTotalMs']! / Math.max(1, c['media.getStatsCalls']!)).toFixed(2)} ms, макс ${c['media.getStatsMaxMs']!.toFixed(1)} ms, едновременни ${c['media.statsInFlightMax']}, таймер ${c['media.monitorTimerActive']}+${c['media.monitorBusy']}, пакети/s ${c['media.minPacketsPerSecond']}–${c['media.maxPacketsPerSecond']}`)
      assert(c['media.statsInFlightMax']! <= 1, `${p.label}: припокриващи се getStats`)
      assert(c['media.monitorTimerActive']! + c['media.monitorBusy']! <= 1, `${p.label}: повече от един таймер`)
      assert(ticks >= 20 && ticks <= 27, `${p.label}: ${ticks} тика за ${seconds.toFixed(0)} s (очаквано ~25)`)
      assert(c['mediaGlobal.monitorTimers']! <= 1 && c['mediaGlobal.pageListenerSets'] === 1, `${p.label}: глобални ${JSON.stringify(c)}`)
    }
    for (const line of lines) console.log(`    ${line}`)
    const media = parties.flatMap((p) => mediaReports(p, startedAt).map((r) => `${p.label}:${describe(r)}`))
    assert(media.length === 0, `медийни събития при нормална игра: ${media.join(', ')}`)
    const bad = [...healthSeen].filter((entry) => !entry.endsWith(':ok:'))
    assert(bad.length === 0, `подозрения/блокиране: ${bad.join(', ')}`)
    const d = await counters(D)
    console.log(`    D (тишина, DTX): последно ${d['media.lastPacketsPerSecond']} пакета/s, мин ${d['media.minPacketsPerSecond']}, макс ${d['media.maxPacketsPerSecond']}`)
  })

  await scenario('M12', `[M12] ${SILENCE_MINUTES} мин непрекъснат разговор + пълна тишина при D (DTX): 0 подозрения, 0 медийни събития, 0 опити за възстановяване; натоварване и памет`, async () => {
    const startedAt = Date.now()
    const heap = async (p: Party) => p.page.evaluate('performance.memory ? performance.memory.usedJSHeapSize : null') as Promise<number | null>
    const before = await Promise.all(parties.map(async (p) => ({ c: await counters(p), s: await p.page.evaluate('({ ...window.__statsCalls })') as Record<string, number>, heap: await heap(p) })))
    const dPps: number[] = []
    const bad = new Set<string>()
    let ticks = 0
    while (Date.now() - startedAt < SILENCE_MINUTES * 60_000) {
      for (const p of parties) {
        const s = await snap(p)
        if (s?.status !== 'connected_speaking') bad.add(`${p.label}@${Math.round((Date.now() - startedAt) / 1000)}s:не е свързан (${s?.status})`)
        if (s?.microphoneHealth !== 'ok' || s.microphoneRecovery !== 'none' || s.playbackBlocked) bad.add(`${p.label}@${Math.round((Date.now() - startedAt) / 1000)}s:${s?.microphoneHealth}/${s?.microphoneRecovery}`)
      }
      const d = await counters(D)
      if (typeof d['media.lastPacketsPerSecond'] === 'number' && d['media.lastPacketsPerSecond']! >= 0) dPps.push(d['media.lastPacketsPerSecond']!)
      ticks += 1
      if (ticks % 60 === 0) console.log(`    … ${Math.round((Date.now() - startedAt) / 60_000)} мин, проблеми: ${bad.size}; ${(await Promise.all(parties.map(async (p) => `${p.label}:${(await snap(p))?.status}`))).join(' ')}`)
      await sleep(5_000)
    }
    const seconds = (Date.now() - startedAt) / 1000
    const n = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    for (const [index, p] of parties.entries()) {
      const c = await counters(p)
      const s = await p.page.evaluate('({ ...window.__statsCalls })') as Record<string, number>
      const lifecycle = p.reports.filter((r) => r.at >= startedAt && /reconnect|connection_lost|session_end|livekit_disconnect|connected/.test(String(r.body?.event))).map((r) => describe(r.body) + (r.body.reason ? ':' + r.body.reason : ''))
      console.log(`    ${p.label}: статус ${(await snap(p))?.status}; стая ${c['media.getStatsCalls'] === undefined ? 'НЯМА' : 'да'}; събития за връзката: ${lifecycle.join(',') || '—'}`)
      if (c['media.getStatsCalls'] === undefined) continue
      const ours = n(c['media.getStatsCalls']) - n(before[index]!.c['media.getStatsCalls'])
      const total = (s.pc! + s.sender! + s.receiver!) - (before[index]!.s.pc! + before[index]!.s.sender! + before[index]!.s.receiver!)
      const heapAfter = await heap(p)
      console.log(`    ${p.label}: наши getStats ${(ours / seconds).toFixed(2)}/s, всички ${(total / seconds).toFixed(2)}/s, ср. ${(n(c['media.getStatsTotalMs']) / Math.max(1, n(c['media.getStatsCalls']))).toFixed(2)} ms, макс ${n(c['media.getStatsMaxMs']).toFixed(1)} ms, едновременни ${c['media.statsInFlightMax']}, JS heap ${before[index]!.heap === null ? '?' : Math.round(before[index]!.heap! / 1e6)} -> ${heapAfter === null ? '?' : Math.round(heapAfter / 1e6)} MB`)
      assert(c['media.statsInFlightMax']! <= 1, `${p.label}: припокриващи се getStats`)
    }
    const sorted = [...dPps].sort((a, b) => a - b)
    const pct = (q: number) => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    console.log(`    D (тишина): ${sorted.length} измервания; пакети/s мин ${sorted[0]} / p5 ${pct(0.05)} / медиана ${pct(0.5)} / p95 ${pct(0.95)} / макс ${sorted.at(-1)}`)
    const media = parties.flatMap((p) => p.reports.filter((r) => r.at >= startedAt && (String(r.body?.event).startsWith('media_') || r.body?.event === 'mic_recovery')).map((r) => `${p.label}:${describe(r.body)}`))
    assert(media.length === 0, `медийни събития: ${media.slice(0, 10).join(', ')}`)
    assert(bad.size === 0, `подозрения/възстановявания: ${[...bad].slice(0, 10).join(', ')}`)
    assert(sorted.length > 0 && sorted[0]! > 0, 'DTX пакетите никога не спират напълно')
  })

  const CONTROLLER_ACTIONS = ['connectAttempts', 'roomsCreated', 'tokenRequests', 'micEnableAttempts', 'micEnabled', 'micReused', 'rotations'] as const
  const controllerActions = async (p: Party) => { const c = await counters(p); return JSON.stringify(CONTROLLER_ACTIONS.map((k) => c[k] ?? 0)) }
  const liveKitLines = (p: Party, pattern: RegExp, since: number) => lkLog.join('').split(/\r?\n/)
    .filter((l) => pattern.test(l) && l.includes(p.profile.profileId.slice(0, 8)))
    .filter((l) => { const at = Date.parse(l.slice(0, 28).replace(/(\d{2})(\d{2})$/, '$1:$2')); return Number.isNaN(at) || at >= since - 1_000 })
  const micRecoveries = (p: Party, since: number) => p.reports.filter((r) => r.at >= since && r.body?.event === 'mic_recovery').map((r) => `${r.body.mode}:${r.body.outcome}`)
  const liveCaptures = (p: Party) => p.page.evaluate('window.__liveCaptureCount()') as Promise<number>
  const maxLiveCaptures = (p: Party) => p.page.evaluate('window.__maxLiveCaptures') as Promise<number>
  /** Сървърът на LiveKit: sid-ове и muted на микрофона на участника. */
  async function serverMic(p: Party): Promise<{ sids: string[]; muted: boolean[] }> {
    const live = generations(voiceTableId).filter((g) => g.retire_reason === null).at(-1)
    const list = live === undefined ? [] : await roomService.listParticipants(live.livekit_room_name).catch(() => [])
    const tracks = list.filter((x) => x.identity.startsWith(`p_${p.profile.profileId}_`)).flatMap((x) => x.tracks)
    return { sids: tracks.map((t) => t.sid), muted: tracks.map((t) => t.muted) }
  }
  async function clickRecover(p: Party): Promise<void> {
    await openPanel(p)
    await p.page.locator('[data-voice-panel="1"] [data-voice-action="recover-mic"]').first().click({ timeout: 10_000 })
    await closePanel(p)
  }

  await scenario('M2', '[M2] Спрял RTP sender (encodings.active=false; capture дава кадри): H3 НЕ заменя capture-а автоматично (capture_active) — само бутон; без getUserMedia/connect/токен/публикуване от наша страна', async () => {
    const gumBefore = await gumCalls(A)
    const actionsBefore = await controllerActions(A)
    const since = Date.now()
    const set = await A.page.evaluate('window.__setSenderActive(false)') as string
    assert(set.startsWith('ok:live:true:false'), `sender спрян, track live/enabled/unmuted: ${set}`)
    await waitUntil('другите спират да чуват A', async () => (await notHearing(B, TONE_A)) && (await notHearing(C, TONE_A)), 15_000)
    const detected = await waitUntil('подозрение при A', async () => ((await snap(A))?.microphoneHealth === 'stall_suspected' ? Date.now() : false), 25_000)
    console.log(`    подозрение ${detected - since} ms след спирането; отчети: ${mediaReports(A, since).map(describe).join(', ')}`)
    await waitUntil('бутон „Възстанови микрофона“ при A', async () => ((await A.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'manual'), 10_000)
    for (const p of [B, C, D]) assert((await p.page.locator('[data-voice-mic-state="warn"]').count()) === 0, `${p.label} няма „warn“`)
    const until = Date.now() + 25_000
    let sdkReconnected = false
    while (Date.now() < until) {
      sdkReconnected = A.reports.some((r) => r.at >= since && r.body?.event === 'reconnecting')
      if (sdkReconnected) break
      await sleep(1_000)
    }
    assert((await gumCalls(A)) === gumBefore, 'без нов getUserMedia (capture_active не се „поправя“ с нов capture)')
    assert((await controllerActions(A)) === actionsBefore, 'без connect/токен/публикуване от контролера')
    const recoveries = micRecoveries(A, since)
    assert(recoveries.length === 1 && recoveries[0] === 'auto:capture_active', `само capture_active: ${recoveries.join(',')}`)
    if (sdkReconnected) {
      console.log('    наблюдение: SDK-то направи свой reconnect (CLIENT_REQUEST_LEAVE) и публикува същия capture наново — не е H3')
      await waitUntil('чуване на A след reconnect-а на SDK-то', async () => (await hears(B, TONE_A)) && (await hears(C, TONE_A)), 30_000)
    } else {
      await A.page.evaluate('window.__setSenderActive(true)')
      await waitUntil('чуване на A отново', async () => (await hears(B, TONE_A)) && (await hears(C, TONE_A)), 15_000)
    }
    await waitUntil('здравето на A се изчиства', async () => (await snap(A))?.microphoneHealth === 'ok', 20_000)
    assert((await maxLiveCaptures(A)) <= 1, `никога два capture-а при A: ${await maxLiveCaptures(A)}`)
  })

  await scenario('M3', '[M3] H3 — случаят МЕТЕОРА: спрял capture (без mute/ended, RTCP продължава) -> потвърждение -> нов capture + replaceTrack в СЪЩАТА публикация (същият sid); другите отново чуват тона; никога два capture-а', async () => {
    const gumBefore = await gumCalls(B)
    const sidBefore = (await serverMic(B)).sids
    const actionsBefore = await controllerActions(B)
    const since = Date.now()
    await B.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('другите спират да чуват B', async () => (await notHearing(A, TONE_B)) && (await notHearing(C, TONE_B)), 15_000)
    const stalledAt = Date.now()
    const detected = await waitUntil('подозрение при B', async () => ((await snap(B))?.microphoneHealth === 'stall_suspected' ? Date.now() : false), 25_000)
    const heardAt = await waitUntil('A и C отново чуват тона на B', async () => ((await hearsAfter(A, TONE_B, stalledAt)) && (await hearsAfter(C, TONE_B, stalledAt)) ? Date.now() : false), 40_000, 200)
    try {
      await waitUntil('B: възстановяването приключи', async () => { const s = await snap(B); return s?.microphoneRecovery === 'none' && s.microphoneHealth === 'ok' }, 15_000)
    } catch (error) {
      const stats = await B.page.evaluate('(async () => { const s = window.__micSender(); if (!s) return "no sender"; const out = []; (await s.getStats()).forEach((v) => { if (v.type === "outbound-rtp" || v.type === "media-source") out.push({ type: v.type, id: v.id, mediaSourceId: v.mediaSourceId, trackIdentifier: v.trackIdentifier, packetsSent: v.packetsSent, totalSamplesDuration: v.totalSamplesDuration, kind: v.kind }) }); return JSON.stringify({ senderTrack: s.track && s.track.id, out }) })()')
      const c = await counters(B)
      throw new Error(`${error instanceof Error ? error.message : String(error)} :: ${JSON.stringify(await snap(B))} :: ${stats} :: ${JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => /micRecovery|micConfirm|source|captureLive|Packets/.test(k))))} :: ${micRecoveries(B, since).join(',')}`)
    }
    const sidAfter = (await serverMic(B)).sids
    const skew = liveKitLines(B, /clock skew/i, since)
    console.log(`    подозрение ${detected - since} ms; отново се чува ${heardAt - since} ms след спирането; sid ${sidBefore} -> ${sidAfter}; clock skew редове: ${skew.length}; отчети: ${micRecoveries(B, since).join(',')}`)
    assert(JSON.stringify(sidAfter) === JSON.stringify(sidBefore), 'същият track sid (replaceTrack, без unpublish/publish)')
    assert((await gumCalls(B)) === gumBefore + 1, `точно един нов getUserMedia: ${gumBefore} -> ${await gumCalls(B)}`)
    assert((await controllerActions(B)) === actionsBefore, 'без connect/токен/публикуване')
    assert(!B.reports.some((r) => r.at >= since && r.body?.event === 'reconnecting'), 'без reconnect')
    assert(micRecoveries(B, since).join(',') === 'auto:recovered', `auto:recovered: ${micRecoveries(B, since).join(',')}`)
    assert((await maxLiveCaptures(B)) <= 1 && (await liveCaptures(B)) === 1, `никога два capture-а: макс ${await maxLiveCaptures(B)}, сега ${await liveCaptures(B)}`)
    const s = await snap(B)
    assert(s?.microphone === 'live' && s.wantsToSpeak, 'желанието е запазено')
  })

  await scenario('R1', '[R1] H3: отказан getUserMedia -> „failed“: публикацията се пази (същият sid), заглушена; 0 живи capture-а; без втори автоматичен опит; „Възстанови микрофона“ -> чуване', async () => {
    const sidBefore = (await serverMic(B)).sids
    const since = Date.now()
    await B.page.evaluate("window.__failNextGum = 'NotReadableError'")
    await B.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('B: failed', async () => ((await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'failed'), 40_000)
    const mic = await serverMic(B)
    console.log(`    сървър: sid ${JSON.stringify(mic.sids)} muted ${JSON.stringify(mic.muted)}; живи capture-и ${await liveCaptures(B)}; отчети: ${micRecoveries(B, since).join(',')}`)
    assert(JSON.stringify(mic.sids) === JSON.stringify(sidBefore), 'същата публикация (без unpublish)')
    await waitUntil('публикацията е заглушена за останалите', async () => (await serverMic(B)).muted.every(Boolean), 10_000)
    assert((await liveCaptures(B)) === 0, '0 живи capture-а')
    assert(micRecoveries(B, since).join(',') === 'auto:gum_failed', `auto:gum_failed: ${micRecoveries(B, since).join(',')}`)
    const gum = await gumCalls(B)
    await sleep(15_000)
    assert((await gumCalls(B)) === gum, 'без втори автоматичен опит')
    const strip = await B.page.locator('[data-voice-mic-state]').first().getAttribute('data-voice-mic-state').catch(() => null)
    assert(strip === 'warn', `реалното състояние (не зелено): ${strip}`)
    const manualAt = Date.now()
    await clickRecover(B)
    await waitUntil('A и C отново чуват B (ръчно)', async () => (await hearsAfter(A, TONE_B, manualAt)) && (await hearsAfter(C, TONE_B, manualAt)), 25_000)
    await waitUntil('отчет за ръчното', async () => micRecoveries(B, manualAt).length > 0, 15_000).catch(() => undefined)
    const cv = await counters(B)
    console.log(`    ръчно: ${micRecoveries(B, manualAt).join(',') || '…'}; проверка: пакети +${cv['media.verifyPacketsDelta']}, capture +${cv['media.verifySourceDelta']} s, sender ${cv['media.verifySenderOk']}, опити ${cv['media.verifyPolls']}`)
    assert(JSON.stringify((await serverMic(B)).sids) === JSON.stringify(sidBefore), 'същият sid след ръчното')
    assert((await serverMic(B)).muted.every((m) => !m), 'отново незаглушена')
    assert((await maxLiveCaptures(B)) <= 1, 'никога два capture-а')
  })

  await scenario('R2', '[R2] H3: нов инцидент в 60 s cooldown след неуспеха -> без автоматичен опит (cooldown), само бутон; ръчно -> чуване', async () => {
    const since = Date.now()
    const gum = await gumCalls(B)
    await B.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('B: бутон (cooldown)', async () => ((await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'manual'), 30_000)
    await waitUntil('отчет cooldown', async () => micRecoveries(B, since).includes('auto:cooldown'), 5_000).catch(() => undefined)
    assert(micRecoveries(B, since).filter((x) => x.startsWith('auto:')).join(',') === 'auto:cooldown', `cooldown: ${micRecoveries(B, since).join(',')} :: ${B.reports.filter((r) => r.at >= since - 20_000).map((r) => (r.at - since) + 'ms:' + describe(r.body) + (r.body.outcome ? ':' + r.body.mode + ':' + r.body.outcome : '')).join(', ')}`)
    assert((await gumCalls(B)) === gum, 'без автоматичен getUserMedia')
    const manualAt = Date.now()
    await clickRecover(B)
    await waitUntil('чуване на B (ръчно)', async () => (await hearsAfter(A, TONE_B, manualAt)) && (await hearsAfter(C, TONE_B, manualAt)), 25_000)
    await waitUntil('manual:recovered (проверката на потока завършва до 8 s)', async () => micRecoveries(B, since).includes('manual:recovered'), 15_000)
  })

  await scenario('S1', '[S1] H3 като Safari (без media-source и MediaStreamTrack.stats): подозрение само по пакетите -> БЕЗ автоматична замяна (unavailable), бутон; ръчно -> чуване (проверка по RTP)', async () => {
    const since = Date.now()
    try {
      await B.page.evaluate('window.__hideMediaSource = true')
      await sleep(4_000)
      const gum = await gumCalls(B)
      await B.page.evaluate('window.__stallCurrentCapture()')
      await waitUntil('B: бутон', async () => (await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'manual', 30_000)
      await waitUntil('отчет unavailable', async () => micRecoveries(B, since).includes('auto:unavailable'), 5_000)
      const evidence = mediaReports(B, since).find((r) => r.event === 'media_input' && r.state === 'stall_suspected')?.evidence
      assert(evidence === 'packets_only', `доказателство само по пакетите: ${evidence}`)
      await sleep(10_000)
      assert((await gumCalls(B)) === gum, 'без автоматичен getUserMedia')
      const manualAt = Date.now()
      await clickRecover(B)
      await waitUntil('чуване на B (ръчно)', async () => (await hearsAfter(A, TONE_B, manualAt)) && (await hearsAfter(C, TONE_B, manualAt)), 25_000)
      await waitUntil('manual:recovered', async () => micRecoveries(B, since).includes('manual:recovered'), 15_000)
      console.log(`    отчети: ${micRecoveries(B, since).join(',')}; доказателство: ${evidence}`)
      assert((await maxLiveCaptures(B)) <= 1, 'никога два capture-а')
    } finally {
      await B.page.evaluate('window.__hideMediaSource = false').catch(() => undefined)
    }
  })

  await scenario('R3', '[R3] H3: ръчно изключване на микрофона, докато новият getUserMedia чака -> отменено; новият capture се спира веднага; 0 живи; публикацията е премахната; желанието е изключено', async () => {
    const since = Date.now()
    await A.page.evaluate('window.__holdGum = true')
    await A.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('A: getUserMedia чака', async () => A.page.evaluate('window.__gumHeld()'), 40_000)
    assert((await A.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'recovering', 'тече')
    assert((await liveCaptures(A)) === 0, 'старият capture е спрян ПРЕДИ новия')
    await A.page.evaluate('window.__pikaVoice.disableMicrophone()')
    await sleep(500)
    await A.page.evaluate('window.__releaseGum()')
    await sleep(2_000)
    const s = await snap(A)
    assert(s?.microphone === 'off' && !s.wantsToSpeak && (await liveCaptures(A)) === 0, `изключен, 0 живи: ${JSON.stringify(s)} ${await liveCaptures(A)}`)
    assert((await serverMic(A)).sids.length === 0, 'без публикация')
    assert((await maxLiveCaptures(A)) <= 1, 'никога два capture-а')
    console.log(`    отчети: ${micRecoveries(A, since).join(',')}`)
    await A.page.evaluate('window.__pikaVoice.enableMicrophone()')
    await waitUntil('A отново говори (изрично включване)', async () => (await hears(B, TONE_A)) && (await hears(C, TONE_A)), 20_000)
  })

  await scenario('R4', '[R4] H3: рестарт на LiveKit (reconnect/прекъсване), докато новият getUserMedia чака -> възстановяването се отменя; закъснелият capture се спира; никога два; без зависнала операция; гласът се връща (по пътя на А–Г или ръчно)', async () => {
    const since = Date.now()
    try {
      await A.page.evaluate('window.__holdGum = true')
      await A.page.evaluate('window.__stallCurrentCapture()')
      await waitUntil('A: getUserMedia чака', async () => A.page.evaluate('window.__gumHeld()'), 40_000)
      assert((await liveCaptures(A)) === 0, 'старият capture е спрян преди новия')
      await restartLiveKit()
      await waitUntil('A: връзката с LiveKit е прекъсната', async () => { const s = await snap(A); return s !== null && s.status !== 'connected_speaking' && s.status !== 'connected_listening' }, 30_000)
      await A.page.evaluate('window.__releaseGum()')
      await sleep(1_500)
      assert((await liveCaptures(A)) <= 1, 'закъснелият capture не е втори жив')
    } finally {
      await A.page.evaluate('window.__releaseGum()').catch(() => undefined)
    }
    // Всички се връщат (рестартът засяга и останалите) — по пътя на А–Г.
    await waitUntil('A отново е свързан', async () => { const s = await snap(A); return s?.status === 'connected_speaking' || s?.status === 'connected_listening' }, 90_000)
    const s = await snap(A)
    console.log(`    след рестарта: ${JSON.stringify(s)}; живи ${await liveCaptures(A)}; отчети: ${micRecoveries(A, since).join(',') || '—'}`)
    if (s?.microphoneRecovery === 'failed') {
      // SDK-то е възобновило същата стая: публикацията е запазена, заглушена — само ръчно.
      const gum = await gumCalls(A)
      await sleep(5_000)
      assert((await gumCalls(A)) === gum, 'без автоматичен нов capture')
      await clickRecover(A)
    }
    await waitUntil('B и C отново чуват A', async () => (await hears(B, TONE_A)) && (await hears(C, TONE_A)), 60_000)
    assert(micRecoveries(A, since).some((x) => x === 'auto:aborted'), `отменено: ${micRecoveries(A, since).join(',')}`)
    assert((await maxLiveCaptures(A)) <= 1, 'никога два capture-а')
    assert((await counters(A))['mediaGlobal.recoveryOps'] === 0, 'без зависнала операция')
    await waitUntil('всички отново се чуват след рестарта', async () => {
      for (const listener of parties) for (const speaker of speakers) if (speaker !== listener && !(await hears(listener, speaker.tone))) return false
      return true
    }, 60_000)
  })


  await scenario('R5', '[R5] H3: повтарящи се прекъсвания — най-много 3 автоматични опита за 10 мин (вкл. успешните; не се нулират при замяна на track); 4-тият -> само бутон', async () => {
    // B: M3 (успех) и R1 (неуспех) вече са 2 автоматични опита; изчакване на cooldown-а от R1.
    const failureAgo = (await counters(B)).micLastFailureAgoMs!
    if (failureAgo >= 0 && failureAgo < 61_000) await sleep(61_000 - failureAgo)
    const since = Date.now()
    await B.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('3-ти автоматичен — успех', async () => micRecoveries(B, since).includes('auto:recovered'), 40_000)
    await waitUntil('B: здраво', async () => (await snap(B))?.microphoneHealth === 'ok', 15_000)
    const gum = await gumCalls(B)
    await B.page.evaluate('window.__stallCurrentCapture()')
    await waitUntil('4-ти -> limit', async () => micRecoveries(B, since).includes('auto:limit'), 30_000)
    assert((await gumCalls(B)) === gum, 'без 4-ти автоматичен getUserMedia')
    assert((await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'manual', 'само бутон')
    assert((await counters(B)).micAutoAttempts === 3, `3 опита в прозореца: ${(await counters(B)).micAutoAttempts}`)
    const manualAt = Date.now()
    await clickRecover(B)
    await waitUntil('чуване на B (ръчно)', async () => (await hearsAfter(A, TONE_B, manualAt)) && (await hearsAfter(C, TONE_B, manualAt)), 25_000)
    console.log(`    отчети B: ${micRecoveries(B, since).join(',')}`)
    assert((await maxLiveCaptures(B)) <= 1, 'никога два capture-а')
  })


  await scenario('R6', '[R6] H3: getUserMedia не отговаря > 20 s -> срокът изтича (gum_failed, „failed“); ново ръчно възстановяване -> нов capture; закъснелият резултат се спира веднага; никога два capture-а; без зависнала операция', async () => {
    const failureAgo = (await counters(A)).micLastFailureAgoMs!
    if (failureAgo >= 0 && failureAgo < 61_000) await sleep(61_000 - failureAgo)
    const since = Date.now()
    try {
      await A.page.evaluate('window.__holdGum = true')
      await A.page.evaluate('window.__stallCurrentCapture()')
      await waitUntil('A: getUserMedia чака', async () => A.page.evaluate('window.__gumHeld()'), 40_000)
      const heldAt = Date.now()
      await waitUntil('A: failed след срока', async () => (await snap(A))?.microphoneRecovery === 'failed', 35_000)
      console.log(`    срокът изтече ${Date.now() - heldAt} ms след задържането; отчети: ${micRecoveries(A, since).join(',')}`)
      assert(micRecoveries(A, since).includes('auto:gum_failed'), 'gum_failed (срок)')
      assert((await liveCaptures(A)) === 0, '0 живи capture-а')
      assert((await counters(A))['mediaGlobal.recoveryOps'] === 0, 'операцията е приключила (не виси)')
      const manualAt = Date.now()
      await clickRecover(A)
      await waitUntil('чуване на A (ново ръчно)', async () => (await hearsAfter(B, TONE_A, manualAt)) && (await hearsAfter(C, TONE_A, manualAt)), 25_000)
      assert((await liveCaptures(A)) === 1, 'един жив capture')
      // Закъснелият резултат на стария getUserMedia пристига ЧАК СЕГА.
      await A.page.evaluate('window.__releaseGum()')
      await sleep(1_500)
      assert((await liveCaptures(A)) === 1, `закъснелият е спрян веднага: ${await liveCaptures(A)}`)
      assert((await maxLiveCaptures(A)) <= 1, `никога два: ${await maxLiveCaptures(A)}`)
      assert(await hears(B, TONE_A), 'новият capture продължава да се чува')
    } finally {
      await A.page.evaluate('window.__releaseGum()').catch(() => undefined)
    }
  })

  await scenario('M4', '[M4] H2: неочаквано паузиран елемент -> автоматично пуснат същият елемент; реално чуване (не само UI)', async () => {
    const sid = await sidFor(C, A)
    const since = Date.now()
    await C.page.evaluate(`(() => { const el = ${elementExpr(sid)}; el.__m4 = true; el.pause() })()`)
    const ms = await waitUntil('C отново чува A', async () => ((await hearsAfter(C, TONE_A, since)) ? Date.now() - since : false), 10_000, 100)
    const same = await C.page.evaluate(`(() => { const el = ${elementExpr(sid)}; return !!el && el.__m4 === true && !el.paused })()`)
    assert(same, `същият елемент, отново свири: ${JSON.stringify(Object.fromEntries(Object.entries(await counters(C)).filter(([k]) => k.startsWith('media.output') || k === 'media.roomState')))} отчети C: ${C.reports.slice(-12).map((r) => describe(r.body) + (r.body.reason ? ':' + r.body.reason : '')).join(',')} ${await sinkState(C)} sid=${sid.slice(-6)}; отчети: ${mediaReports(C, since).map(describe).join(', ')}`)
    const reports = mediaReports(C, since).map(describe)
    assert(reports.includes('media_output:element_paused') && reports.includes('media_recovery:play:success:pause'), `отчети: ${reports.join(', ')}`)
    console.log(`    чуване отново след ${ms} ms; отчети: ${reports.join(', ')}`)
  })

  await scenario('M5', '[M5] H2: откачен елемент (махнат от DOM) -> НОВ елемент за същия sid; старият не свири и не се преизползва; реално чуване', async () => {
    const sid = await sidFor(C, B)
    const since = Date.now()
    await C.page.evaluate(`(() => { const el = ${elementExpr(sid)}; window.__oldEl = el; el.__m5 = true; el.remove() })()`)
    await waitUntil('C отново чува B', async () => hearsAfter(C, TONE_B, since), 10_000, 100)
    const state = await C.page.evaluate(`(() => { const els = document.querySelectorAll('[data-voice-audio-sink] audio[data-voice-track="${sid}"]'); const old = window.__oldEl; return { count: els.length, isNew: els.length === 1 && els[0] !== old && els[0].__m5 !== true, oldPaused: old.paused, oldConnected: old.isConnected, oldSrc: old.srcObject === null || old.srcObject.getTracks().length === 0 } })()`) as Record<string, unknown>
    assert(state.count === 1 && state.isNew === true, `един НОВ елемент: ${JSON.stringify(state)} ${await sinkState(C)} sid=${sid.slice(-6)}; отчети: ${mediaReports(C, since).map(describe).join(', ')}`)
    assert(state.oldPaused === true && state.oldConnected === false && state.oldSrc === true, `старият е спрян и откачен: ${JSON.stringify(state)}`)
    const reports = mediaReports(C, since).map(describe)
    assert(reports.includes('media_output:element_missing') && reports.some((r) => r.startsWith('media_recovery:reattach:success')), `отчети: ${reports.join(', ')}`)
    console.log(`    отчети: ${reports.join(', ')}`)
  })

  await scenario('M6', '[M6] H2: локално заглушен участник + пауза -> елементът е пуснат, но остава заглушен (volume 0, не се чува); пускане на звука -> чуване', async () => {
    const sid = await sidFor(D, A)
    await D.page.evaluate(`window.__pikaVoice.muteRemoteParticipant(${JSON.stringify(A.profile.profileId)})`)
    await waitUntil('D не чува A (локално заглушен)', async () => notHearing(D, TONE_A, 1_500), 10_000)
    await D.page.evaluate(`${elementExpr(sid)}.pause()`)
    await waitUntil('елементът е пуснат отново', async () => D.page.evaluate(`!${elementExpr(sid)}.paused`), 10_000, 100)
    await sleep(1_500)
    const volume = await D.page.evaluate(`${elementExpr(sid)}.volume`)
    assert(volume === 0, `заглушаването е запазено: volume ${volume}`)
    assert(await notHearing(D, TONE_A, 1_500), 'D все още не чува A')
    await D.page.evaluate(`window.__pikaVoice.unmuteRemoteParticipant(${JSON.stringify(A.profile.profileId)})`)
    await waitUntil('D отново чува A', async () => hears(D, TONE_A), 10_000)
  })

  await scenario('M7', '[M7] H2: на скрита страница паузата не се „поправя“; visible+focus+pageshow+devicechange едновременно -> едно възстановяване, без конкурентни проверки', async () => {
    // При C (обикновен fake микрофон): синтетичното devicechange при тестовия generator track на B
    // би задействало съществуващата проверка за изчезнало устройство (А–Г) — артефакт на теста.
    const sid = await sidFor(C, A)
    const before = await counters(C)
    const since = Date.now()
    await C.page.evaluate('window.__setHidden(true)')
    await C.page.evaluate(`${elementExpr(sid)}.pause()`)
    await sleep(2_500)
    assert(await C.page.evaluate(`${elementExpr(sid)}.paused`), 'на фон елементът остава спрян (без опит)')
    assert(mediaReports(C, since).every((r) => r.event !== 'media_recovery'), 'без опит на фон')
    const resumedAt = Date.now()
    await C.page.evaluate(`(() => { window.__setHidden(false); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); navigator.mediaDevices.dispatchEvent(new Event('devicechange')) })()`)
    await waitUntil('C отново чува A', async () => hearsAfter(C, TONE_A, resumedAt), 10_000, 100)
    await sleep(2_000)
    const after = await counters(C)
    const recoveries = after['media.outputRecoveries']! - before['media.outputRecoveries']!
    const runs = after['media.outputRuns']! - before['media.outputRuns']!
    const requests = after['media.outputRequests']! - before['media.outputRequests']!
    console.log(`    заявки ${requests}, проверки ${runs}, възстановявания ${recoveries}, едновременни ${after['media.outputMaxConcurrent']}; отчети: ${mediaReports(C, since).map(describe).join(', ')}`)
    assert(recoveries === 1, `точно едно възстановяване: ${recoveries}`)
    assert(after['media.outputMaxConcurrent'] === 1, 'никога две проверки едновременно')
    assert(runs <= 3 && requests >= 4, `обединени тригери: ${requests} заявки -> ${runs} проверки`)
  })

  await scenario('M8', '[M8] H2: лимит на track sid — повторното прикачване не дава нов бюджет; изчерпан -> „Включи звука“ (реален бутон, жест) -> чуване', async () => {
    const sid = await sidFor(D, C)
    const before = await counters(D)
    const since = Date.now()
    for (let round = 0; round < 5; round += 1) {
      await D.page.evaluate(`(() => { const el = ${elementExpr(sid)}; if (!el) return; if (${round} % 2 === 0) el.remove(); else el.pause() })()`)
      await sleep(1_500)
    }
    await waitUntil('„Включи звука“ при D', async () => (await snap(D))?.playbackBlocked === true, 10_000)
    const after = await counters(D)
    const recoveries = after['media.outputRecoveries']! - before['media.outputRecoveries']!
    const reports = mediaReports(D, since).map(describe)
    console.log(`    възстановявания ${recoveries}; отчети: ${reports.join(', ')}`)
    assert(recoveries <= 3, `най-много 3 за sid (вкл. повторни прикачвания): ${recoveries}`)
    assert(reports.some((r) => r.endsWith(':limited:pause') || r.includes(':limited:')) && reports.includes('media_output:playback_blocked'), 'лимит + блокиране')
    assert(await notHearing(D, TONE_C), 'D не чува C, докато не натисне')
    await openPanel(D)
    await D.page.locator('[data-voice-panel="1"] [data-voice-action="unlock-audio"]').first().click({ timeout: 5_000 })
    await waitUntil('D отново чува C след жеста', async () => hears(D, TONE_C), 10_000)
    assert((await snap(D))?.playbackBlocked === false, 'бутонът изчезва')
    assert(mediaReports(D, since).some((r) => r.event === 'media_recovery' && r.step === 'start_audio' && r.result === 'success' && r.trigger === 'gesture'), 'start_audio:success:gesture')
    await closePanel(D)
  })

  await scenario('M9', '[M9] H2: NotAllowedError -> „Включи звука“; без повторни опити до жеста (focus/visible не „блъскат“); жест -> чуване', async () => {
    const sid = await sidFor(A, B)
    const since = Date.now()
    await A.page.evaluate('window.__denyPlay = true')
    await A.page.evaluate(`${elementExpr(sid)}.pause()`)
    await waitUntil('„Включи звука“ при A', async () => (await snap(A))?.playbackBlocked === true, 10_000)
    const denied = await A.page.evaluate('window.__deniedPlays') as number
    for (let i = 0; i < 3; i += 1) {
      await A.page.evaluate(`(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })()`)
      await sleep(600)
    }
    const deniedAfter = await A.page.evaluate('window.__deniedPlays') as number
    assert(deniedAfter === denied, `без повторни опити: ${denied} -> ${deniedAfter}`)
    assert(mediaReports(A, since).map(describe).includes('media_recovery:play:gesture_required:pause'), 'gesture_required')
    await A.page.evaluate('window.__denyPlay = false')
    await openPanel(A)
    await A.page.locator('[data-voice-panel="1"] [data-voice-action="unlock-audio"]').first().click({ timeout: 5_000 })
    await waitUntil('A отново чува B', async () => hears(A, TONE_B), 10_000)
    await closePanel(A)
  })

  await scenario('M10', '[M10] Админ панел: хронологията (последните събития) съдържа медийните събития с UTC минута и груба платформа; без профили', async () => {
    const data = await A.page.evaluate(`fetch(${JSON.stringify(`${h.backendOrigin}/api/admin/voice-chat/monitoring`)}, { credentials: 'include', cache: 'no-store' }).then((r) => r.json())`) as any
    const clients = data?.data?.clients ?? data?.clients
    assert(clients !== undefined && Array.isArray(clients.recent), `monitoring: ${JSON.stringify(data).slice(0, 300)}`)
    const media = clients.recent.filter((entry: any) => String(entry.event).startsWith('media_'))
    assert(media.length > 0 && media.every((entry: any) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(entry.at)), 'UTC минута')
    const platforms = new Set(media.map((entry: any) => entry.platform))
    assert([...platforms].every((p) => p === 'desktop_chrome' || p === 'android_chrome' || p === 'unknown'), `платформи: ${[...platforms].join(',')}`)
    const text = JSON.stringify(clients)
    assert(!parties.some((p) => text.includes(p.profile.profileId)), 'без profile ID')
    console.log(`    медийни: ${JSON.stringify(clients.media)}; платформи: ${[...platforms].join(', ')}; последни ${clients.recent.length}/${clients.recentLimit}`)
  })

  await scenario('M13', '[M13] Панел „Диагностика на звука“ (?voicediag=1): само за пълен администратор (C; subadmin D с ?voicediag=1 — не); свит по подразбиране; RTP пакети/s, media-source, разрешение; превключвател за автоматичното само в паметта; ✕ го премахва', async () => {
    for (const p of [A, B, D]) assert((await p.page.locator('[data-voice-diagnostics="1"]').count()) === 0, `${p.label} няма панел`)
    // D е subadmin и е отворил ?voicediag=1: заявката е записана, но достъп няма.
    assert((await D.page.evaluate("sessionStorage.getItem('pika.voice.diag')")) === '1', 'заявката на D е записана (не дава достъп)')
    assert((await D.page.evaluate('window.__pikaVoice.getSnapshot().status')) === 'connected_speaking', 'D е в гласа (subadmin)')
    const panel = C.page.locator('[data-voice-diagnostics="1"]')
    await panel.waitFor({ state: 'attached', timeout: 10_000 })
    assert(!((await panel.textContent()) ?? '').includes('RTP пакети/s'), 'свит по подразбиране')
    const requestsBefore = C.reports.length
    let networkDuringPanel = 0
    const onRequest = (request: { url: () => string }) => { if (request.url().includes('/api/voice/')) networkDuringPanel += 1 }
    C.page.on('request', onRequest)
    await panel.locator('[data-voice-diag-toggle="1"]').click()
    // Пакетите/s се изчисляват от две измервания (~6 s след включването).
    await waitUntil('панелът показва пакети/s', async () => /RTP пакети\/s\s*\d/.test((await panel.textContent()) ?? ''), 20_000)
    const text = ((await panel.textContent()) ?? '').replace(/\s+/g, ' ')
    console.log(`    панел: ${text.slice(0, 600)}`)
    for (const label of ['Платформа', 'Разрешение', 'RTP пакети/s', 'media-source', 'MediaStreamTrack.stats', 'getStats', 'DTX тест']) assert(text.includes(label), `липсва „${label}“`)
    assert(/RTP пакети\/s\s*\d/.test(text), 'числова стойност за пакетите')
    assert(/media-source\s*да/.test(text), 'media-source в Chromium')
    const auto = async () => (await counters(C)).micAutoRecovery
    assert((await auto()) === 1, 'dev по подразбиране: вкл.')
    await panel.locator('[data-voice-diag-auto="1"]').click()
    assert((await auto()) === 0, 'превключвателят изключва')
    await panel.locator('[data-voice-diag-auto="1"]').click()
    assert((await auto()) === 1, 'и включва отново')
    await panel.locator('[data-voice-diag-auto="1"]').click()
    const stored = await C.page.evaluate('JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])') as string
    assert(!stored.includes('micAutoRecovery'), `без трайно записване: ${stored}`)
    C.page.off('request', onRequest)
    // Панелът няма мрежов код (статична проверка в checkVoiceMediaHealth [U19]); тук само за сведение.
    console.log(`    гласови HTTP заявки по време на панела (обичайни отчети, не от панела): ${networkDuringPanel}; нови отчети ${C.reports.length - requestsBefore}`)
    await panel.locator('[data-voice-diag-close="1"]').click()
    assert((await C.page.locator('[data-voice-diagnostics="1"]').count()) === 0, 'премахнат')
    assert((await C.page.evaluate("sessionStorage.getItem('pika.voice.diag')")) === null, 'заявката е изчистена')
    assert((await auto()) === 1, 'тестовото превключване отпада със затварянето (обратно към подразбирането)')
  })

  await scenario('ROT', '[ROT] H3: ротация на стаята (D напуска масата) по време на (ръчно) възстановяване на B -> отменено; закъснелият capture се спира; никога два; без зависнала операция; B се чува в новата генерация', async () => {
    const gensBefore = generations(voiceTableId).length
    const since = Date.now()
    try {
      // B е изчерпал 3-те автоматични опита (M3, R1, R5) -> ръчно; пътят на отмяната е същият.
      await B.page.evaluate('window.__stallCurrentCapture()')
      await waitUntil('B: бутон', async () => (await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'manual', 30_000)
      await B.page.evaluate('window.__holdGum = true')
      await clickRecover(B)
      await waitUntil('B: getUserMedia чака', async () => B.page.evaluate('window.__gumHeld()'), 20_000)
      assert((await B.page.evaluate('window.__pikaVoice.getSnapshot().microphoneRecovery')) === 'recovering', 'тече')
      await D.page.locator('[data-private-room-leave-slot]').first().click({ timeout: 10_000 })
      await D.page.locator('[data-private-room-leave-popup-confirm="1"]').click({ timeout: 5_000 })
      await waitUntil('ротация (нова генерация)', async () => generations(voiceTableId).length > gensBefore, 20_000)
      await sleep(2_000)
      await B.page.evaluate('window.__releaseGum()')
      await sleep(1_500)
      assert((await liveCaptures(B)) <= 1, 'закъснелият capture не е втори жив')
    } finally {
      await B.page.evaluate('window.__releaseGum()').catch(() => undefined)
    }
    await waitUntil('A и C чуват B в новата генерация', async () => (await hears(A, TONE_B)) && (await hears(C, TONE_B)), 60_000)
    const gens = generations(voiceTableId)
    console.log(`    генерации ${gensBefore} -> ${gens.length} (${gens.at(-2)?.retire_reason}); отчети B: ${micRecoveries(B, since).join(',')}; живи ${await liveCaptures(B)}`)
    assert(micRecoveries(B, since).includes('manual:aborted'), 'отменено от ротацията')
    assert((await liveCaptures(B)) === 1 && (await maxLiveCaptures(B)) <= 1, 'никога два capture-а')
    assert((await counters(B))['mediaGlobal.recoveryOps'] === 0, 'без зависнала операция')
    assert((await snap(B))?.microphoneRecovery === 'none', 'новата стая започва без възстановяване')
  })

  await scenario('M11', '[M11] Изход от гласа: 0 медийни таймери, слушатели, операции и audio елементи; 0 живи capture-а; никога два едновременно през целия тест', async () => {
    for (const p of parties) await p.page.evaluate('window.__pikaVoice.leaveVoice()')
    await sleep(2_500)
    for (const p of parties) {
      const c = await counters(p)
      const globals = Object.entries(c).filter(([key]) => key.startsWith('mediaGlobal.'))
      assert(globals.length > 0 && globals.every(([, value]) => value === 0), `${p.label}: ${JSON.stringify(Object.fromEntries(globals))}`)
      const audio = await p.page.evaluate(`document.querySelectorAll('[data-voice-audio-sink] audio').length`)
      assert(audio === 0, `${p.label}: ${audio} audio елемента`)
      assert((await p.page.evaluate('window.__liveCaptureCount()')) === 0, `${p.label}: жив capture след изхода`)
      assert((await p.page.evaluate('window.__maxLiveCaptures')) <= 1, `${p.label}: два живи capture-а в някой момент`)
    }
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  await check('без неочаквани грешки', () => { throw error })
  console.error(lkLog.join('').slice(-2000))
} finally {
  for (const p of parties) await p.browser.close().catch(() => undefined)
  await h.close()
  liveKit.kill()
  await sleep(500)
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

finishAndExit()
