/**
 * checkVoiceWebAudioMixE2E.ts — регресия за W1 (входящо аудио през Web Audio,
 * src/app/voice/voiceWebAudioOutput.ts) срещу сегашния елементен механизъм.
 *
 * PRODUCTION build (vite build + preview), реален LiveKit 1.13.11, изолиран
 * сървър. Режимът се включва с ИСТИНСКИЯ локален тестов ключ
 * (localStorage pika-voice-webaudio-mix = '1') при емулиран Android PWA
 * (Android UA + display-mode: standalone). Тестовият build добавя само
 * наблюдателни куки (window.__voiceTestRooms / __voiceTestConnected) — без
 * промяна на поведението; H2, H4 и игровите звуци са непроменени.
 *
 * Всеки участник „говори“ със свой тон (fake capture от WAV): H 440 Hz,
 * R 700 Hz, O 1000 Hz („срички“ — стабилен тон енкодерът третира като шум).
 * R (тестваният слушател, разрешен за H4) е заглушил O локално. Изходът на R:
 *   - webaudio: РЕАЛНИЯТ вход на AudioContext.destination (сонда върху
 *     връзките към destination), Goertzel с Hann прозорец;
 *   - element: декодираният звук на елемента × ефективната му сила (модел —
 *     изходът на <audio> не може да се измери от страницата).
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   WAM_RESULTS=<път>.json WAM_MODES=element,webaudio \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceWebAudioMixE2E.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { build, preview, type PreviewServer } from 'vite'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceWebAudioMixE2E (W1)\n')

const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? 'D:\\tmp\\livekit-1.13.11\\bin\\livekit-server.exe'
if (!existsSync(LIVEKIT_BIN)) {
  console.log(`  SKIP  няма livekit-server (${LIVEKIT_BIN}); задай LIVEKIT_SERVER_BIN`)
  process.exit(0)
}
type Mode = 'element' | 'webaudio'
const MODES = (process.env.WAM_MODES ?? 'element,webaudio').split(',').map((m) => m.trim()) as Mode[]
const SHORT: Record<Mode, string> = { element: 'el', webaudio: 'wa' }
const RESULTS_FILE = process.env.WAM_RESULTS ?? ''
const DIVAKA = '29925128-167c-408b-9a33-620d2d8f9a95'
const STORAGE_KEY = 'pika-voice-webaudio-mix'
const RESUME_TIMEOUT_MS = 1_500

const freePort = () => new Promise<number>((done, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)) })
})

const workDir = await mkdtemp(join(tmpdir(), 'pika-voice-wam-e2e-'))

/** WAV 48 kHz mono 16-bit, 2 s (цяло число периоди -> безшевен цикъл). */
async function toneWav(name: string, freq: number, syllabic = false): Promise<string> {
  const rate = 48_000
  const frames = rate * 2
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate
    // syllabic: „срички“ 4/s с под (никога нула) — стабилен тон енкодерът (VAD/DTX) третира като шум.
    const env = syllabic ? 0.15 + 0.85 * Math.sqrt(Math.max(0, Math.sin(2 * Math.PI * 2 * t))) : 0.85 + 0.15 * Math.sin(2 * Math.PI * 2.5 * t)
    const v = 0.3 * env * Math.sin(2 * Math.PI * freq * t)
    data.writeInt16LE(Math.round(v * 32_767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  const path = join(workDir, name)
  await writeFile(path, Buffer.concat([header, data]))
  return path
}
const TONE = { h: await toneWav('h440.wav', 440), r: await toneWav('r700.wav', 700), o: await toneWav('o1000.wav', 1000, true) }

const lkPort = await freePort()
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const udpStart = 57_000 + Math.floor(Math.random() * 300) * 10
await writeFile(join(workDir, 'livekit.yaml'), [
  `port: ${lkPort}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${await freePort()}`,
  `  port_range_start: ${udpStart}`, `  port_range_end: ${udpStart + 200}`, '  use_external_ip: false', '  node_ip: 127.0.0.1',
  'keys:', `  ${apiKey}: ${apiSecret}`, 'room:', '  auto_create: false', '',
].join('\n'))
const liveKitLog: string[] = []
const liveKit: ChildProcess = spawn(LIVEKIT_BIN, ['--config', join(workDir, 'livekit.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] })
for (const stream of [liveKit.stdout!, liveKit.stderr!]) stream.on('data', (chunk: Buffer) => { liveKitLog.push(...chunk.toString('utf8').split('\n')) })
{
  let ready = false
  for (let i = 0; i < 80 && !ready; i += 1) {
    try { ready = (await fetch(`http://127.0.0.1:${lkPort}/`)).ok } catch { /* стартира */ }
    if (!ready) await sleep(250)
  }
  if (!ready) { liveKit.kill(); throw new Error('livekit-server не стартира') }
}
process.env.LIVEKIT_API_URL = `http://127.0.0.1:${lkPort}`
process.env.LIVEKIT_WS_URL = `ws://127.0.0.1:${lkPort}`
process.env.LIVEKIT_API_KEY = apiKey
process.env.LIVEKIT_API_SECRET = apiSecret
process.env.VOICE_ROOM_NAMESPACE = 'e2ewam'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness({ databaseFileName: 'belot-v2-tournament-test.sqlite', env: { NODE_ENV: 'development', BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1' } })

async function makeProfile(tag: string, role: 'admin' | 'player'): Promise<TestProfile> {
  const profile = await h.register(tag)
  h.setBalance(profile.profileId, 50_000_000)
  h.db.prepare('UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)').run(role, profile.profileId)
  const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  h.db.prepare('INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until').run(profile.profileId, until)
  return profile
}

// R профилите (по един на режим) — в allowlist-а на H4 само в тестовия build.
const listeners = new Map<Mode, TestProfile>()
for (const mode of MODES) listeners.set(mode, await makeProfile(`wamr${SHORT[mode]}`, 'player'))

const backendPort = new URL(h.backendOrigin).port
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
let hooksInjected = 0
await build({
  mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true },
  plugins: [{ name: 'wam-isolated-backend', enforce: 'pre', transform(code, id) {
    const file = id.replaceAll('\\', '/')
    if (!file.includes('/src/')) return null
    let next = code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : code
    if (file.endsWith('/src/app/voice/voiceIncomingAudioRestoreConfig.ts')) {
      next = next.replace(`'${DIVAKA}', //`, `${[...listeners.values()].map((p) => `'${p.profileId}'`).join(', ')}, //`)
    }
    if (file.endsWith('/src/app/voice/liveKitVoiceAdapter.ts')) {
      // САМО наблюдение (тестов build): стаята и свързаният обект (debugMedia).
      const before = next
      next = next.replace(/activeRoom = room(\r?\n)/, 'activeRoom = room; (window as any).__voiceTestRooms = [...((window as any).__voiceTestRooms ?? []), room]$1')
      next = next.replace(/return connected(\r?\n)/, ';(window as any).__voiceTestConnected = connected; return connected$1')
      hooksInjected = (next.match(/__voiceTestRooms = /g)?.length ?? 0) + (next.match(/__voiceTestConnected = /g)?.length ?? 0)
      if (before === next) hooksInjected = 0
    }
    return next === code ? null : next
  } }],
})
process.env.NODE_ENV = previousNodeEnv
if (hooksInjected !== 2) throw new Error(`тестовите куки не са вмъкнати (${hooksInjected})`)
{
  // Контрола: production кодът съдържа ключа на режима само в гласовия chunk.
  const assets = await readdir(join(outDir, 'assets'))
  let inVoice = false
  let elsewhere = false
  for (const name of assets.filter((n) => n.endsWith('.js'))) {
    const code = await readFile(join(outDir, 'assets', name), 'utf8')
    if (code.includes(STORAGE_KEY)) { if (name.startsWith('voice')) inVoice = true; else elsewhere = true }
  }
  if (!inVoice || elsewhere) throw new Error(`ключ на режима: voice chunk=${inVoice}, другаде=${elsewhere}`)
}
const previewServer: PreviewServer = await preview({ root: process.cwd(), logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
const appOrigin = previewServer.resolvedUrls!.local[0]!.replace(/\/$/, '')
console.log(`тестов production build на ${appOrigin}; режими: ${MODES.join(', ')}`)

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 412, height: 915 }
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const STRIP = '[data-voice-waiting-strip="1"]'
const PANEL = '[data-voice-panel-layer="1"]'

type ClientReport = { body: Record<string, unknown>; status: number | null }
type Party = { label: string; profile: TestProfile; browser: Browser; page: Page; reports: Array<Record<string, unknown>>; clientReports: ClientReport[]; errors: string[] }
const parties: Party[] = []

/** getUserMedia / живи микрофони / PeerConnection-и. */
const probe = String.raw`(() => {
  const md = navigator.mediaDevices;
  const origGum = md.getUserMedia.bind(md);
  window.__gum = 0; window.__tracks = []; window.__pcs = 0;
  md.getUserMedia = (c) => { window.__gum += 1; return origGum(c).then((s) => { window.__tracks.push(...s.getAudioTracks()); return s }) };
  window.__liveMic = () => window.__tracks.filter((t) => t.readyState === 'live').map((t) => t.id);
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { window.__pcs += 1; return new OrigPC(...a) };
  window.RTCPeerConnection.prototype = OrigPC.prototype; Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
})()`

/** Емулиран инсталиран PWA (display-mode: standalone) -> платформа android_pwa. */
const standalone = String.raw`(() => {
  const orig = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (q) => {
    if (String(q).includes('display-mode: standalone')) return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } };
    return orig ? orig(q) : { matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } };
  };
})()`

/**
 * Сонда (само тест): AudioContext-ите на страницата; копие на всяка връзка
 * към destination в AnalyserNode; всеки createGain() и първата му автоматизация
 * (стойност преди нея); семплер на 20 ms (Goertzel 440/700/1000 Hz + елементи).
 */
const audioProbe = String.raw`(() => {
  const Orig = window.AudioContext; window.__OrigAudioContext = Orig;
  const ctxs = []; window.__appCtxs = ctxs;
  class Tracked extends Orig { constructor(o) { super(o); ctxs.push(this) } }
  window.AudioContext = Tracked;
  const gains = new Map(); window.__gainLog = { created: 0, toDestination: 0, unknownToDestination: 0, firstAutomation: [] };
  const origCreateGain = Orig.prototype.createGain;
  Tracked.prototype.createGain = function () { const g = origCreateGain.call(this); gains.set(g, { automated: false }); window.__gainLog.created += 1; return g };
  const origSetTarget = AudioParam.prototype.setTargetAtTime;
  const paramOwner = new WeakMap();
  AudioParam.prototype.setTargetAtTime = function (target, start, tc) {
    const owner = paramOwner.get(this);
    if (owner && !gains.get(owner).automated) { gains.get(owner).automated = true; window.__gainLog.firstAutomation.push({ before: this.value, target }) }
    return origSetTarget.call(this, target, start, tc);
  };
  const origGainGetter = Object.getOwnPropertyDescriptor(GainNode.prototype, 'gain').get;
  Object.defineProperty(GainNode.prototype, 'gain', { configurable: true, get() { const p = origGainGetter.call(this); if (gains.has(this)) paramOwner.set(p, this); return p } });
  const taps = new WeakMap();
  const tapFor = (ctx) => { let t = taps.get(ctx); if (!t) { t = ctx.createAnalyser(); t.fftSize = 2048; taps.set(ctx, t) } return t };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = origConnect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode && ctxs.includes(dest.context)) {
      if (this instanceof GainNode) { window.__gainLog.toDestination += 1; if (!gains.has(this)) window.__gainLog.unknownToDestination += 1 }
      try { origConnect.call(this, tapFor(dest.context)) } catch (e) {}
    }
    return r;
  };
  const hann = new Float32Array(2048).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 2047));
  const goertzel = (buf, sr, f) => { const k = 2 * Math.cos(2 * Math.PI * f / sr); let s1 = 0, s2 = 0; for (let i = 0; i < buf.length; i++) { const s0 = buf[i] * hann[i] + k * s1 - s2; s2 = s1; s1 = s0 } return 4 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - k * s1 * s2, 0)) / buf.length };
  const F = [['h', 440], ['r', 700], ['o', 1000]];
  let measure = null; const dec = new Map(); const buf = new Float32Array(2048);
  window.__roomCtx = () => { const rooms = window.__voiceTestRooms; const room = rooms && rooms.length ? rooms[rooms.length - 1] : null; return room ? (room.audioContext || null) : null };
  function sample() {
    const webaudio = window.__voiceTestConnected && window.__voiceTestConnected.debugMedia && window.__voiceTestConnected.debugMedia().audioMode === 1;
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')];
    const rec = { t: performance.now(), n: els.length, paused: els.filter((e) => e.paused).length };
    const ctx = window.__roomCtx();
    if (ctx) { rec.state = ctx.state; rec.ct = ctx.currentTime }
    if (!measure) { measure = new Orig(); measure.resume() }
    const d = { h: 0, r: 0, o: 0 }; const model = { h: 0, r: 0, o: 0 };
    for (const el of els) {
      if (!(el.srcObject instanceof MediaStream)) continue;
      let e = dec.get(el);
      if (!e || e.stream !== el.srcObject) { const a = measure.createAnalyser(); a.fftSize = 2048; measure.createMediaStreamSource(el.srcObject).connect(a); e = { a, stream: el.srcObject }; dec.set(el, e) }
      e.a.getFloatTimeDomainData(buf);
      const g = el.muted || el.paused ? 0 : el.volume;
      for (const [k, f] of F) { const v = goertzel(buf, measure.sampleRate, f); d[k] = Math.max(d[k], v); model[k] = Math.max(model[k], v * g) }
    }
    rec.dec = d;
    if (!webaudio) { rec.out = model; rec.viol = 0 }
    else {
      const o = { h: 0, r: 0, o: 0 };
      // Спрян/затворен контекст не извежда нищо (анализаторът му пази последния буфер).
      if (ctx && ctx.state === 'running') { const tap = tapFor(ctx); tap.getFloatTimeDomainData(buf); for (const [k, f] of F) o[k] = goertzel(buf, ctx.sampleRate, f) }
      rec.out = o; rec.viol = els.filter((e) => !(e.muted && e.volume === 0)).length;
    }
    window.__samples.push(rec);
  }
  window.__samples = [];
  window.__sampler = {
    timer: null,
    start() { if (!this.timer) this.timer = setInterval(sample, 20) },
    stop() { clearInterval(this.timer); this.timer = null },
    take() { const s = window.__samples; window.__samples = []; return s },
  };
  window.__aliveCtxs = () => ctxs.filter((c) => c.state !== 'closed').length;
})()`

async function open(profile: TestProfile, label: string, mobile: boolean, tone: string, mode: Mode | null): Promise<Party> {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tone}`, '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext(mobile ? { viewport: MOBILE, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: ANDROID_UA } : { viewport: DESKTOP })
  await context.grantPermissions(['microphone'], { origin: appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(probe)
  if (mode !== null) {
    await context.addInitScript(standalone)
    // Истинският локален тестов ключ (само при webaudio); element = android_pwa БЕЗ ключ.
    await context.addInitScript(mode === 'webaudio' ? `try { localStorage.setItem('${STORAGE_KEY}', '1') } catch {}` : `try { localStorage.removeItem('${STORAGE_KEY}') } catch {}`)
    await context.addInitScript(audioProbe)
  }
  const page = await context.newPage()
  const reports: Array<Record<string, unknown>> = []
  const clientReports: ClientReport[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(error.message); console.error(`    [pageerror ${label}] ${error.message}`) })
  page.on('request', (request) => {
    if (!request.url().includes('/api/voice/client-report')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
      reports.push(body)
      const entry: ClientReport = { body, status: null }
      clientReports.push(entry)
      void request.response().then((response) => { entry.status = response?.status() ?? -1 }).catch(() => { entry.status = -1 })
    } catch { /* нищо */ }
  })
  await page.goto(`${appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(600)
  const party = { label, profile, browser, page, reports, clientReports, errors }
  parties.push(party)
  return party
}

async function createTable(host: Party): Promise<string> {
  const page = host.page
  await page.locator(LOBBY_READY).first().click()
  await page.locator('[data-private-rooms-create-open="1"]').first().click()
  const form = page.locator('[data-private-room-create-form="1"]')
  const voice = form.locator('[data-private-room-voice-checkbox="1"]')
  await voice.waitFor({ state: 'visible', timeout: 15_000 })
  await voice.check()
  await form.locator('input[name="manualStart"]').check().catch(() => undefined)
  await form.locator('button[type="submit"]').click()
  await page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const row = h.db.prepare('SELECT private_room_id FROM voice_tables WHERE status = ? ORDER BY created_at DESC LIMIT 1').get('active') as { private_room_id: string }
  return row.private_room_id
}

async function joinTable(party: Party, privateRoomId: string): Promise<void> {
  const page = party.page
  await page.locator(LOBBY_READY).first().click()
  const plus = page.locator(`[data-private-room-list-slot-join^="${privateRoomId}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await plus.click()
  await page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
  await page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
}

async function waitStrip(party: Party, text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = (await party.page.locator(STRIP).first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (value.includes(text)) return
    await sleep(150)
  }
  throw new Error(`${party.label}: лентата не показа „${text}“`)
}

async function joinWithMic(party: Party): Promise<void> {
  const button = party.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]:visible').first()
  await button.waitFor({ state: 'visible', timeout: 25_000 })
  await button.click()
  await waitStrip(party, 'Микрофон включен')
}

async function openPanel(party: Party): Promise<void> {
  if (await party.page.locator(`${PANEL} [data-voice-panel="1"]`).first().isVisible().catch(() => false)) return
  await party.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click()
  await party.page.locator(`${PANEL} [data-voice-panel="1"]`).first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function panelClick(party: Party, action: string): Promise<void> {
  await openPanel(party)
  await party.page.locator(`${PANEL} [data-voice-action="${action}"]`).first().click({ timeout: 10_000 })
}

/** Максимален декодиран тон (Goertzel, Hann) за честота f сред елементите на sink-а. */
async function heardTone(party: Party, freq: number, ms = 1_500): Promise<number> {
  return party.page.evaluate(async ({ freq, ms }) => {
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')].filter((el) => (el as HTMLMediaElement).srcObject) as HTMLMediaElement[]
    if (els.length === 0) return 0
    const Ctx = ((window as unknown as { __OrigAudioContext?: typeof AudioContext }).__OrigAudioContext ?? AudioContext)
    const ctx = new Ctx(); await ctx.resume()
    const an = els.map((el) => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(el.srcObject as MediaStream).connect(a); return a })
    const buf = new Float32Array(2048); let max = 0; const end = performance.now() + ms
    const k = 2 * Math.cos(2 * Math.PI * freq / ctx.sampleRate)
    while (performance.now() < end) {
      for (const a of an) {
        a.getFloatTimeDomainData(buf); let s1 = 0, s2 = 0
        for (let i = 0; i < buf.length; i++) { const s0 = buf[i]! * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 2047)) + k * s1 - s2; s2 = s1; s1 = s0 }
        max = Math.max(max, 4 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - k * s1 * s2, 0)) / buf.length)
      }
      await new Promise((r) => setTimeout(r, 40))
    }
    await ctx.close()
    return Math.round(max * 10_000) / 10_000
  }, { freq, ms })
}

function liveKitFor(profileId: string): { resumes: number; leaves: number; published: number; sessions: number } {
  const lines = liveKitLog.filter((line) => line.includes(profileId))
  return {
    resumes: lines.filter((l) => l.includes('resuming RTC session')).length,
    leaves: lines.filter((l) => l.includes('participant closing')).length,
    published: lines.filter((l) => l.includes('mediaTrack published')).length,
    sessions: lines.filter((l) => l.includes('starting RTC session')).length,
  }
}
const mediaReports = (party: Party, from = 0) => party.reports.slice(from)
  .filter((r) => r.event === 'media_output' || r.event === 'media_recovery' || r.event === 'media_context')
  .map((r) => r.event === 'media_output' ? `output:${String(r.state)}` : r.event === 'media_context' ? `context:${String(r.state)}/${String(r.action)}/${String(r.result)}` : `recovery:${String(r.step)}/${String(r.result)}/${String(r.trigger)}`)

type Sample = { t: number; n: number; paused: number; state?: string; ct?: number; dec: Record<'h' | 'r' | 'o', number>; out: Record<'h' | 'r' | 'o', number>; viol: number }
const take = (party: Party) => party.page.evaluate('window.__sampler.take()') as Promise<Sample[]>
const debugMedia = (party: Party) => party.page.evaluate('window.__voiceTestConnected ? window.__voiceTestConnected.debugMedia() : null') as Promise<Record<string, number> | null>

const median = (values: number[]) => { if (values.length === 0) return 0; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
const r4 = (v: number) => Math.round(v * 10_000) / 10_000

type Baseline = { h: number; o: number }
type EventStats = {
  event: string; samples: number; hMedian: number; hGapMs: number; hLowMs: number
  oLeakMax: number; oLeakRatio: number; oLeakMs: number; violations: number; pausedSamples: number
  states: string; ctFrozenMs: number; reports: string[]; micSame: boolean | null; gum: number; pcs: number
  liveKit: { resumes: number; leaves: number; published: number; sessions: number }; kind: string; extra?: Record<string, unknown>
}

/** Прозорец: най-дълга пауза на H (под 30% от базата), изтичане на O (над 5% от базата на O, мин. 0.001). */
function stats(event: string, samples: Sample[], base: Baseline): Omit<EventStats, 'reports' | 'micSame' | 'gum' | 'pcs' | 'liveKit' | 'kind'> {
  let gap = 0; let maxGap = 0; let low = 0; let leakMs = 0; let leakMax = 0; let frozen = 0; let maxFrozen = 0
  const states = new Set<string>()
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!
    const dt = i === 0 ? 20 : Math.min(200, s.t - samples[i - 1]!.t)
    if (s.out.h < 0.3 * base.h) { gap += dt; low += dt; maxGap = Math.max(maxGap, gap) } else gap = 0
    if (s.out.o > Math.max(0.05 * base.o, 0.001)) leakMs += dt
    leakMax = Math.max(leakMax, s.out.o)
    if (s.state) states.add(s.state)
    if (i > 0 && s.ct !== undefined && s.ct === samples[i - 1]!.ct) { frozen += dt; maxFrozen = Math.max(maxFrozen, frozen) } else frozen = 0
  }
  return {
    event, samples: samples.length, hMedian: r4(median(samples.map((s) => s.out.h))), hGapMs: Math.round(maxGap), hLowMs: Math.round(low),
    oLeakMax: r4(leakMax), oLeakRatio: base.o > 0 ? r4(leakMax / base.o) : 0, oLeakMs: Math.round(leakMs),
    violations: samples.reduce((sum, s) => sum + s.viol, 0), pausedSamples: samples.filter((s) => s.paused > 0).length,
    states: [...states].join('/'), ctFrozenMs: Math.round(maxFrozen),
  }
}

h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'public', 'off', NULL, ?)`)
  .run(randomUUID(), new Date().toISOString())
// Сървърният kill switch (Админ -> Настройки) има абсолютен приоритет — без него и локалният ключ не включва режима.
h.db.prepare("INSERT INTO admin_settings (setting_key, setting_value) VALUES ('voice_webaudio_mix_enabled', '1') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value").run()

const results: Record<string, unknown> = { modes: {} as Record<string, unknown> }

async function runMode(mode: Mode): Promise<void> {
  const tag = `wam${SHORT[mode]}`
  const host = await open(await makeProfile(`${tag}h`, 'admin'), `${mode}:H`, false, TONE.h, null)
  const r = await open(listeners.get(mode)!, `${mode}:R`, true, TONE.r, mode)
  const o = await open(await makeProfile(`${tag}o`, 'player'), `${mode}:O`, false, TONE.o, null)
  const webaudio = mode === 'webaudio'
  const events: EventStats[] = []
  const out: Record<string, unknown> = { events }
  ;(results.modes as Record<string, unknown>)[mode] = out
  try {
    const roomId = await createTable(host)
    await joinTable(r, roomId)
    await joinTable(o, roomId)
    await joinWithMic(host)
    await joinWithMic(r)
    await joinWithMic(o)
    await openPanel(r)
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const levels = [await heardTone(r, 440, 600), await heardTone(r, 1000, 600), await heardTone(host, 700, 600)]
      out.joinLevels = levels
      if (levels.every((v) => v > 0.01)) break
      await sleep(300)
    }
    out.platformMode = await debugMedia(r).then((d) => d?.audioMode ?? null)
    console.log(`    [${mode}] при влизане (R:440, R:1000, H:700) ${JSON.stringify(out.joinLevels)}; audioMode ${String(out.platformMode)}`)
    await r.page.evaluate('window.__sampler.start()')
    const muteToggle = r.page.locator(`${PANEL} [data-voice-mute-toggle="${o.profile.profileId}"]`).first()

    // ─── База: O НЕ е заглушен 2.5 s ───
    await sleep(2_500)
    const unmuted = (await take(r)).slice(10)
    const base: Baseline = { h: median(unmuted.map((s) => s.out.h)), o: median(unmuted.map((s) => s.out.o)) }
    out.baseline = { h: r4(base.h), o: r4(base.o), alive: await r.page.evaluate('window.__aliveCtxs()') }
    console.log(`    [${mode}] база ${JSON.stringify(out.baseline)}`)

    // ─── Локално заглушаване/пускане на O ───
    const t0 = await r.page.evaluate('performance.now()') as number
    await muteToggle.click()
    await sleep(1_500)
    let s = await take(r)
    const muteMs = (() => { const hit = s.find((x) => x.t > t0 && x.out.o <= 0.05 * base.o); return hit ? Math.round(hit.t - t0) : -1 })()
    const t1 = await r.page.evaluate('performance.now()') as number
    await muteToggle.click()
    await sleep(1_500)
    s = await take(r)
    const unmuteMs = (() => { const hit = s.find((x) => x.t > t1 && x.out.o >= 0.5 * base.o); return hit ? Math.round(hit.t - t1) : -1 })()
    await muteToggle.click() // заглушен за останалите стъпки
    await sleep(1_500)
    await take(r)
    out.localVolume = { muteToSilenceMs: muteMs, unmuteToAudibleMs: unmuteMs }
    console.log(`    [${mode}] сила: ${JSON.stringify(out.localVolume)}`)

    let micRef = (await r.page.evaluate('window.__liveMic()') as string[])[0] ?? ''
    async function event(name: string, action: () => Promise<void>, windowMs: number, opts: { kind?: 'normal' | 'micToggle' | 'reconnect'; extra?: () => Promise<Record<string, unknown>> } = {}): Promise<EventStats> {
      await take(r)
      const reportsFrom = r.reports.length
      const gum = await r.page.evaluate('window.__gum') as number
      const pcs = await r.page.evaluate('window.__pcs') as number
      const lk = liveKitFor(r.profile.profileId)
      await action()
      await sleep(windowMs)
      const samples = await take(r)
      const mic = (await r.page.evaluate('window.__liveMic()') as string[])
      const lkAfter = liveKitFor(r.profile.profileId)
      const st: EventStats = {
        ...stats(name, samples, base),
        reports: mediaReports(r, reportsFrom),
        kind: opts.kind ?? 'normal',
        micSame: opts.kind === 'micToggle' ? null : mic.length === 1 && mic[0] === micRef,
        gum: (await r.page.evaluate('window.__gum') as number) - gum,
        pcs: (await r.page.evaluate('window.__pcs') as number) - pcs,
        liveKit: { resumes: lkAfter.resumes - lk.resumes, leaves: lkAfter.leaves - lk.leaves, published: lkAfter.published - lk.published, sessions: lkAfter.sessions - lk.sessions },
        ...(opts.extra ? { extra: await opts.extra() } : {}),
      }
      events.push(st)
      console.log(`    [${mode}] ${name}: H пауза ${st.hGapMs} ms, O изтичане ${st.oLeakMs} ms (×${st.oLeakRatio}), двойно ${st.violations}, ctx ${st.states || '—'}, отчети ${st.reports.join(' | ') || '—'}${st.extra ? ` ${JSON.stringify(st.extra)}` : ''}`)
      return st
    }
    const roomEval = (body: string) => r.page.evaluate(`(async () => { const room = window.__voiceTestRooms.at(-1); ${body} })()`)
    const unlockVisible = async () => (await r.page.locator(`${PANEL} [data-voice-action="unlock-audio"]`).count()) > 0

    await event('покой', async () => {}, 2_000)
    await event('игрови звуци (монети, място, известие, часовник)', async () => {
      await r.page.evaluate(async () => {
        for (const src of ['/audio/game-sounds/coins.mp3', '/audio/ui/player-seat-fill.mp3', '/audio/Notifications/notification-1.mp3']) {
          void new Audio(src).play().catch(() => undefined)
          await new Promise((done) => setTimeout(done, 450))
        }
        const clock = new Audio('/audio/ui/waiting-clock.mp3'); clock.loop = true; void clock.play().catch(() => undefined)
        setTimeout(() => clock.pause(), 2_000)
      })
    }, 3_500)
    await event('H2: пауза на входящите елементи', async () => {
      await r.page.evaluate(() => { for (const el of document.querySelectorAll('[data-voice-audio-sink] audio')) (el as HTMLMediaElement).pause() })
    }, 2_000)
    await event('H2: премахнат елемент (повторно прикачане)', async () => {
      await r.page.evaluate(() => { for (const el of document.querySelectorAll('[data-voice-audio-sink] audio')) el.remove() })
    }, 2_500)
    await event('H4: „Възстанови звука“', async () => {
      await panelClick(r, 'restore-audio')
      await r.page.locator(`${PANEL} [data-voice-audio-restore-result]`).first().waitFor({ state: 'visible', timeout: 10_000 })
    }, 2_000)
    await event('R: микрофон изкл. -> вкл.', async () => {
      await panelClick(r, 'mic-off')
      await sleep(1_500)
      await panelClick(r, 'mic-on')
      await waitStrip(r, 'Микрофон включен')
    }, 2_000, { kind: 'micToggle' })
    micRef = (await r.page.evaluate('window.__liveMic()') as string[])[0] ?? ''
    await event('O публикува наново (нов абонамент при заглушен O)', async () => {
      await panelClick(o, 'mic-off')
      await sleep(1_500)
      await panelClick(o, 'mic-on')
      await waitStrip(o, 'Микрофон включен')
    }, 2_500)

    if (webaudio) {
      await event('suspend() -> W1 statechange -> едно resume()', async () => {
        await roomEval('await room.audioContext.suspend()')
      }, 2_000, { extra: async () => ({ state: await roomEval('return room.audioContext.state'), unlock: await unlockVisible() }) })

      // Неуспешно resume (виси) -> „Включи звука“; H4 по време на операцията чака.
      const blockedRun = await event('resume виси -> „Включи звука“; H4 по време на операцията изчаква', async () => {
        await roomEval(`const ctx = room.audioContext; ctx.__origResume = ctx.resume.bind(ctx); ctx.resume = () => new Promise(() => {}); await ctx.suspend()`)
        await sleep(150)
        const startedAt = Date.now()
        await panelClick(r, 'restore-audio')
        await r.page.locator(`${PANEL} [data-voice-action="restore-audio"][aria-busy="true"]`).first().waitFor({ state: 'attached', timeout: 3_000 }).catch(() => undefined)
        await r.page.locator(`${PANEL} [data-voice-audio-restore-result]`).first().waitFor({ state: 'visible', timeout: 10_000 })
        ;(out as Record<string, unknown>).h4WaitedMs = Date.now() - startedAt
      }, 600, { extra: async () => ({ unlock: await unlockVisible(), debug: await debugMedia(r).then((d) => d && { ctxBlocked: d.ctxBlocked, ctxResumeFailed: d.ctxResumeFailed }) }) })
      out.blockedUnlockShown = (blockedRun.extra as { unlock?: boolean } | undefined)?.unlock ?? false
      await event('„Включи звука“ (жест) след блокиране', async () => {
        await roomEval('const ctx = room.audioContext; ctx.resume = ctx.__origResume')
        await panelClick(r, 'unlock-audio')
      }, 2_000, { extra: async () => ({ state: await roomEval('return room.audioContext.state'), unlock: await unlockVisible() }) })

      // H4, после веднага suspend: възстановяването изчаква H4.
      const deferredBefore = (await debugMedia(r))?.ctxDeferredForRestore ?? 0
      await event('H4, после suspend: възстановяването изчаква H4', async () => {
        await r.page.evaluate(`(async () => {
          document.querySelector('${PANEL} [data-voice-action="restore-audio"]')?.click()
          await new Promise((done) => setTimeout(done, 60))
          await window.__voiceTestRooms.at(-1).audioContext.suspend()
        })()`)
      }, 2_000, { extra: async () => ({ deferred: ((await debugMedia(r))?.ctxDeferredForRestore ?? 0) - deferredBefore, state: await roomEval('return room.audioContext.state') }) })

      // Затворен по време на reconnect -> смяната чака Reconnected (смяна №1).
      await event('пълен reconnect + затворен контекст по време на него', async () => {
        await roomEval(`void room.simulateScenario('full-reconnect'); await new Promise((d) => setTimeout(d, 150)); await room.audioContext.close()`)
        const end = Date.now() + 15_000
        while (Date.now() < end) {
          const st = await roomEval(`return room.state + ':' + document.querySelectorAll('[data-voice-audio-sink] audio').length + ':' + room.audioContext.state`)
          if (st === 'connected:2:running') break
          await sleep(250)
        }
      }, 2_500, { kind: 'reconnect', extra: async () => ({ state: await roomEval('return room.audioContext.state') }) })
      await event('външно close() -> автоматична смяна (№2)', async () => {
        await roomEval('await room.audioContext.close()')
      }, 2_000, { extra: async () => ({ state: await roomEval('return room.audioContext.state'), alive: await r.page.evaluate('window.__aliveCtxs()') }) })
      await event('close() над лимита -> limited -> „Включи звука“ -> смяна с жест', async () => {
        await roomEval('await room.audioContext.close()')
        await sleep(600)
        ;(out as Record<string, unknown>).limitedUnlockShown = await unlockVisible()
        await panelClick(r, 'unlock-audio')
      }, 2_000, { extra: async () => ({ state: await roomEval('return room.audioContext.state'), unlock: await unlockVisible(), alive: await r.page.evaluate('window.__aliveCtxs()') }) })
    } else {
      await event('пълен reconnect', async () => {
        await roomEval(`await room.simulateScenario('full-reconnect')`)
        const end = Date.now() + 15_000
        while (Date.now() < end) {
          const st = await roomEval(`return room.state + ':' + document.querySelectorAll('[data-voice-audio-sink] audio').length`)
          if (st === 'connected:2') break
          await sleep(250)
        }
      }, 2_500, { kind: 'reconnect' })
    }

    out.hostHearsR = await heardTone(host, 700)
    out.debug = await debugMedia(r)
    out.gainLog = await r.page.evaluate('window.__gainLog')

    // ─── Освобождаване: напускане -> повторно влизане (нова стая) -> напускане ───
    const createdBeforeLeave = await r.page.evaluate('window.__appCtxs.length') as number
    await panelClick(r, 'leave')
    await sleep(2_500)
    const afterLeave = { elements: await r.page.evaluate('document.querySelectorAll("[data-voice-audio-sink] audio").length'), alive: await r.page.evaluate('window.__aliveCtxs()'), live: (await r.page.evaluate('window.__liveMic()') as string[]).length, newContexts: (await r.page.evaluate('window.__appCtxs.length') as number) - createdBeforeLeave }
    await take(r)
    await panelClick(r, 'join-listen')
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      if ((await r.page.evaluate('document.querySelectorAll("[data-voice-audio-sink] audio").length')) === 2) break
      await sleep(250)
    }
    const rejoinSubscribe = await take(r)
    await sleep(2_000)
    const rejoinSamples = await take(r)
    const rejoin = {
      alive: await r.page.evaluate('window.__aliveCtxs()'),
      hMedian: r4(median(rejoinSamples.map((x) => x.out.h))),
      oMedian: r4(median(rejoinSamples.map((x) => x.out.o))),
      oMaxAtSubscribe: r4(Math.max(0, ...rejoinSubscribe.map((x) => x.out.o))),
      muteKept: (await r.page.locator(`${PANEL} [data-voice-mute-toggle="${o.profile.profileId}"]`).first().getAttribute('aria-pressed').catch(() => null)) === 'true',
      audioMode: (await debugMedia(r))?.audioMode ?? null,
    }
    await panelClick(r, 'leave')
    await sleep(2_500)
    const afterSecondLeave = { elements: await r.page.evaluate('document.querySelectorAll("[data-voice-audio-sink] audio").length'), alive: await r.page.evaluate('window.__aliveCtxs()'), created: await r.page.evaluate('window.__appCtxs.length') }
    out.resources = { afterLeave, rejoin, afterSecondLeave }
    out.contextReports = r.clientReports.filter((c) => c.body.event === 'media_context').map((c) => ({ detail: `${String(c.body.state)}/${String(c.body.action)}/${String(c.body.result)}`, status: c.status, platform: c.body.platform }))
    console.log(`    [${mode}] ресурси ${JSON.stringify(out.resources)}; H чува R ${String(out.hostHearsR)}`)
    console.log(`    [${mode}] createGain ${JSON.stringify(out.gainLog)}`)
    console.log(`    [${mode}] media_context ${JSON.stringify(out.contextReports)}; h4WaitedMs ${String(out.h4WaitedMs ?? '—')}`)
    out.pageErrors = [...r.errors, ...host.errors, ...o.errors]
  } finally {
    await r.page.evaluate('window.__sampler && window.__sampler.stop()').catch(() => undefined)
    for (const p of [host, r, o]) await p.browser.close().catch(() => undefined)
  }
}

type GainLog = { created: number; toDestination: number; unknownToDestination: number; firstAutomation: Array<{ before: number; target: number }> }
try {
  for (const mode of MODES) {
    await check(`[${mode}] сценариите минават; без двойно възпроизвеждане; микрофонът/стаята непокътнати; ресурсите освободени`, async () => {
      await runMode(mode)
      const m = (results.modes as Record<string, Record<string, unknown>>)[mode]!
      const base = m.baseline as { h: number; o: number }
      const events = m.events as EventStats[]
      assert(m.platformMode === (mode === 'webaudio' ? 1 : 0), `режим (android_pwa ${mode === 'webaudio' ? 'с' : 'без'} ключ) -> audioMode ${String(m.platformMode)}`)
      assert(base.h > 0.005 && base.o > 0.005, `база: H и O се чуват (${JSON.stringify(base)})`)
      const steady = events.find((e) => e.event === 'покой')!
      assert(steady.hGapMs === 0 && steady.oLeakMs === 0, `покой: H непрекъснато, O заглушен (${JSON.stringify(steady)})`)
      assert(events.every((e) => e.violations === 0), 'без двойно възпроизвеждане (webaudio: всички елементи muted/volume 0)')
      for (const e of events) {
        if (e.kind === 'reconnect') assert(e.micSame && e.gum === 0 && e.liveKit.published === 1, `${e.event}: същият микрофон след reconnect (${JSON.stringify({ mic: e.micSame, gum: e.gum, lk: e.liveKit })})`)
        else if (e.micSame !== null) assert(e.micSame && e.gum === 0 && e.pcs === 0 && e.liveKit.leaves === 0 && e.liveKit.resumes === 0, `${e.event}: микрофонът и стаята непокътнати (${JSON.stringify({ mic: e.micSame, gum: e.gum, pcs: e.pcs, lk: e.liveKit })})`)
      }
      const res = m.resources as { afterLeave: { elements: number; alive: number; live: number; newContexts: number }; rejoin: { alive: number; audioMode: number | null }; afterSecondLeave: { elements: number; alive: number } }
      assert(res.afterLeave.elements === 0 && res.afterLeave.alive === 0 && res.afterLeave.live === 0, `след напускане: без елементи, контексти и микрофон (${JSON.stringify(res.afterLeave)})`)
      assert(res.afterLeave.newContexts === 0, `напускането не създава нов контекст (${res.afterLeave.newContexts})`)
      assert(res.rejoin.alive === 1 && res.rejoin.audioMode === (mode === 'webaudio' ? 1 : 0), `повторно влизане: един контекст, същият режим (${JSON.stringify(res.rejoin)})`)
      assert(res.afterSecondLeave.elements === 0 && res.afterSecondLeave.alive === 0, `след второ напускане: чисто (${JSON.stringify(res.afterSecondLeave)})`)
      assert((m.hostHearsR as number) > 0.005, 'H продължава да чува R')
      assert((m.pageErrors as string[]).length === 0, `без грешки на страниците (${(m.pageErrors as string[]).join(' | ')})`)
      const contextReports = m.contextReports as Array<{ detail: string; status: number | null }>
      if (mode === 'element') assert(contextReports.length === 0, 'елементният режим не праща media_context')
    })
  }
  if (MODES.includes('webaudio')) {
    const m = () => (results.modes as Record<string, Record<string, unknown>>).webaudio!
    await check('[webaudio] локалното заглушаване: 0 изтичане при ВСИЧКИ пътища на повторно прикачане/смяна', () => {
      for (const e of m().events as EventStats[]) assert(e.oLeakMs <= 40, `${e.event}: изтичане ${e.oLeakMs} ms (×${e.oLeakRatio})`)
      const rejoin = (m().resources as { rejoin: { muteKept: boolean; oMaxAtSubscribe: number; oMedian: number } }).rejoin
      if (rejoin.muteKept) assert(rejoin.oMaxAtSubscribe <= 0.002 && rejoin.oMedian <= 0.002, `повторно влизане: заглушеният O не се чува (${JSON.stringify(rejoin)})`)
    })
    await check('[webaudio] createGain(): всеки GainNode към destination е от нашия контекст и започва от 0', () => {
      const log = m().gainLog as GainLog
      assert(log.created > 0 && log.toDestination > 0, `има gain-ове (${JSON.stringify(log)})`)
      assert(log.unknownToDestination === 0, `няма GainNode към destination извън createGain (${log.unknownToDestination})`)
      assert(log.firstAutomation.length > 0 && log.firstAutomation.every((a) => a.before === 0), `първата автоматизация винаги от 0 (${JSON.stringify(log.firstAutomation.slice(0, 6))})`)
    })
    await check('[webaudio] възстановяване: resume по събитие, „Включи звука“ при неуспех, смяна (вкл. при reconnect), лимит, H4 без конфликт', () => {
      const events = m().events as EventStats[]
      const byName = (prefix: string) => events.find((e) => e.event.startsWith(prefix))!
      const auto = byName('suspend() -> W1')
      assert(auto.hGapMs <= 120 && (auto.extra as { state: string }).state === 'running', `автоматично resume (${JSON.stringify(auto)})`)
      assert(m().blockedUnlockShown === true, '„Включи звука“ при неуспешно resume')
      assert((m().h4WaitedMs as number) >= RESUME_TIMEOUT_MS - 400, `H4 изчака текущото възстановяване (${String(m().h4WaitedMs)} ms)`)
      const gesture = byName('„Включи звука“ (жест)')
      assert((gesture.extra as { state: string; unlock: boolean }).state === 'running' && !(gesture.extra as { unlock: boolean }).unlock, `жестът възстанови (${JSON.stringify(gesture.extra)})`)
      const deferred = byName('H4, после suspend')
      assert((deferred.extra as { deferred: number; state: string }).deferred >= 1 && (deferred.extra as { state: string }).state === 'running', `изчакване на H4 (${JSON.stringify(deferred.extra)})`)
      const reconnect = byName('пълен reconnect + затворен')
      assert((reconnect.extra as { state: string }).state === 'running' && reconnect.hGapMs < 6_000, `смяна след reconnect (${JSON.stringify(reconnect)})`)
      const replace = byName('външно close()')
      assert((replace.extra as { state: string; alive: number }).state === 'running' && (replace.extra as { alive: number }).alive === 1 && replace.hGapMs <= 200, `автоматична смяна (${JSON.stringify(replace)})`)
      assert(m().limitedUnlockShown === true, '„Включи звука“ над лимита')
      const limited = byName('close() над лимита')
      assert((limited.extra as { state: string; alive: number }).state === 'running' && (limited.extra as { alive: number }).alive === 1, `смяна с жест (${JSON.stringify(limited.extra)})`)
    })
    await check('[webaudio] анонимна диагностика: очакваните media_context отчети, приети от сървъра (200), с платформа', () => {
      const reports = m().contextReports as Array<{ detail: string; status: number | null; platform: unknown }>
      const details = reports.map((x) => x.detail)
      for (const expected of ['running/start/success', 'suspended/resume/success', 'suspended/resume/blocked', 'suspended/gesture/success', 'closed/replace/success', 'closed/replace/limited', 'closed/gesture/success']) {
        assert(details.includes(expected), `${expected} (${details.join(', ')})`)
      }
      assert(reports.every((x) => x.status === 200), `всички приети (${JSON.stringify(reports.map((x) => x.status))})`)
      assert(reports.every((x) => x.platform === 'android_pwa'), 'платформа android_pwa')
    })
  }
} finally {
  if (RESULTS_FILE) await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2))
  for (const party of parties) await party.browser.close().catch(() => undefined)
  await previewServer.close().catch(() => undefined)
  await h.close().catch(() => undefined)
  liveKit.kill()
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

finishAndExit()
