/**
 * checkVoiceExperimentalAudioE2E.ts — ограниченото изпитване (Divaka655,
 * Android PWA) + централният kill switch, с РЕАЛНИЯ адаптер и реален LiveKit.
 *
 * PRODUCTION build (vite build + preview), реален LiveKit 1.13.11, изолиран
 * сървър. Тестовият build заменя profile_id-то на Divaka655 в списъците на
 * изпитването и на H4 с това на R (както checkVoiceIncomingAudioRestoreE2E).
 * R е емулиран Android PWA БЕЗ локалния тестов ключ; H е admin (desktop).
 * Kill switch-ът се превключва през ИСТИНСКИЯ admin endpoint
 * (PATCH /api/admin/settings) — без рестарт на сървъра.
 *
 *   [K1] без запис (липсващ kill switch) -> R: стария механизъм; настройката
 *        се вижда (включена); H4 се вижда; без media_context
 *   [K2] admin включва -> следващото включване на R: Web Audio (без рестарт);
 *        media_context start приет; R чува H
 *   [K3] R изключва настройката -> текущата стая непроменена; следващото
 *        включване — стария механизъм; включва -> Web Audio
 *   [K4] admin изключва -> следващото включване: стария механизъм въпреки
 *        включената настройка (абсолютен приоритет; стаята от жеста се сменя)
 *   [K5] H (друг профил, desktop): винаги стария механизъм, без настройка
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceExperimentalAudioE2E.ts
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

console.log('\ncheckVoiceExperimentalAudioE2E\n')

const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? 'D:\\tmp\\livekit-1.13.11\\bin\\livekit-server.exe'
if (!existsSync(LIVEKIT_BIN)) {
  console.log(`  SKIP  няма livekit-server (${LIVEKIT_BIN}); задай LIVEKIT_SERVER_BIN`)
  process.exit(0)
}
const DIVAKA = '29925128-167c-408b-9a33-620d2d8f9a95'

const freePort = () => new Promise<number>((done, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)) })
})
const workDir = await mkdtemp(join(tmpdir(), 'pika-voice-expaudio-e2e-'))

async function toneWav(name: string, freq: number): Promise<string> {
  const rate = 48_000
  const frames = rate * 2
  const data = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate
    const env = 0.15 + 0.85 * Math.sqrt(Math.max(0, Math.sin(2 * Math.PI * 2 * t)))
    data.writeInt16LE(Math.round(0.3 * env * Math.sin(2 * Math.PI * freq * t) * 32_767), i * 2)
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
const TONE_H = await toneWav('h440.wav', 440)

const lkPort = await freePort()
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const udpStart = 58_000 + Math.floor(Math.random() * 300) * 10
await writeFile(join(workDir, 'livekit.yaml'), [
  `port: ${lkPort}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${await freePort()}`,
  `  port_range_start: ${udpStart}`, `  port_range_end: ${udpStart + 200}`, '  use_external_ip: false', '  node_ip: 127.0.0.1',
  'keys:', `  ${apiKey}: ${apiSecret}`, 'room:', '  auto_create: false', '',
].join('\n'))
const liveKit: ChildProcess = spawn(LIVEKIT_BIN, ['--config', join(workDir, 'livekit.yaml')], { stdio: ['ignore', 'ignore', 'ignore'] })
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
process.env.VOICE_ROOM_NAMESPACE = 'e2eexp'
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

// R заема мястото на Divaka655 в тестовия build (и в изпитването, и в H4).
const rProfile = await makeProfile('expr', 'player')
const hProfile = await makeProfile('exph', 'admin')

const backendPort = new URL(h.backendOrigin).port
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
let substitutions = 0
await build({
  mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true },
  plugins: [{ name: 'expaudio-isolated-backend', enforce: 'pre', transform(code, id) {
    const file = id.replaceAll('\\', '/')
    if (!file.includes('/src/')) return null
    let next = code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : code
    if (file.endsWith('/src/app/voice/voiceExperimentalAudioConfig.ts') || file.endsWith('/src/app/voice/voiceIncomingAudioRestoreConfig.ts')) {
      const replaced = next.replace(`'${DIVAKA}', //`, `'${rProfile.profileId}', //`)
      if (replaced !== next) substitutions += 1
      next = replaced
    }
    return next === code ? null : next
  } }],
})
process.env.NODE_ENV = previousNodeEnv
if (substitutions !== 2) throw new Error(`тестовата замяна на profile_id: ${substitutions}/2`)
{
  const assets = await readdir(join(outDir, 'assets'))
  let inVoice = false
  let elsewhere = false
  for (const name of assets.filter((n) => n.endsWith('.js'))) {
    const code = await readFile(join(outDir, 'assets', name), 'utf8')
    if (code.includes('pika-voice-experimental-audio')) { if (name.startsWith('voice')) inVoice = true; else elsewhere = true }
  }
  if (!inVoice || elsewhere) throw new Error(`настройката: voice chunk=${inVoice}, другаде=${elsewhere}`)
}
const previewServer: PreviewServer = await preview({ root: process.cwd(), logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
const appOrigin = previewServer.resolvedUrls!.local[0]!.replace(/\/$/, '')
console.log(`production build на ${appOrigin}`)

const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const STRIP = '[data-voice-waiting-strip="1"]'
const PANEL = '[data-voice-panel-layer="1"]'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

type Party = { label: string; profile: TestProfile; browser: Browser; page: Page; contextReports: Array<{ detail: string; status: number | null }>; errors: string[] }
const parties: Party[] = []

const standalone = String.raw`(() => {
  const orig = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (q) => {
    if (String(q).includes('display-mode: standalone')) return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } };
    return orig(q);
  };
})()`

async function open(profile: TestProfile, label: string, android: boolean, tone: string | null): Promise<Party> {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  if (tone !== null) args.push(`--use-file-for-fake-audio-capture=${tone}`)
  const browser = await chromium.launch({ headless: true, args })
  const context = await browser.newContext(android ? { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: ANDROID_UA } : { viewport: { width: 1280, height: 850 } })
  await context.grantPermissions(['microphone'], { origin: appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  // Без локалния тестов ключ (production поведение); R — емулиран Android PWA.
  await context.addInitScript(`try { localStorage.removeItem('pika-voice-webaudio-mix') } catch {}`)
  if (android) await context.addInitScript(standalone)
  const page = await context.newPage()
  const contextReports: Party['contextReports'] = []
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(error.message); console.error(`    [pageerror ${label}] ${error.message}`) })
  page.on('request', (request) => {
    if (!request.url().includes('/api/voice/client-report')) return
    try {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
      if (body.event !== 'media_context') return
      const entry = { detail: `${String(body.state)}/${String(body.action)}/${String(body.result)}`, status: null as number | null }
      contextReports.push(entry)
      void request.response().then((response) => { entry.status = response?.status() ?? -1 }).catch(() => { entry.status = -1 })
    } catch { /* нищо */ }
  })
  await page.goto(`${appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(600)
  const party = { label, profile, browser, page, contextReports, errors }
  parties.push(party)
  return party
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
async function waitStrip(party: Party, text: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await party.page.locator(STRIP).first().innerText().catch(() => '')).replace(/\s+/g, ' ').includes(text)) return
    await sleep(150)
  }
  throw new Error(`${party.label}: лентата не показа „${text}“`)
}

/** Режимът на текущата стая по входящите елементи: Web Audio ги държи muted/volume 0. */
async function incomingMode(party: Party): Promise<'webaudio' | 'element' | 'none'> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const els = await party.page.evaluate(() => [...document.querySelectorAll('[data-voice-audio-sink] audio')].map((el) => ({ muted: (el as HTMLMediaElement).muted, volume: (el as HTMLMediaElement).volume, src: (el as HTMLMediaElement).srcObject !== null })))
    if (els.length > 0 && els.every((e) => e.src)) return els.every((e) => e.muted && e.volume === 0) ? 'webaudio' : els.every((e) => !e.muted && e.volume === 1) ? 'element' : 'none'
    await sleep(200)
  }
  return 'none'
}

/** Декодиран тон (Hann + Goertzel) от входящите елементи. */
async function heardTone(party: Party, freq: number): Promise<number> {
  return party.page.evaluate(async (freq) => {
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')].filter((el) => (el as HTMLMediaElement).srcObject) as HTMLMediaElement[]
    if (els.length === 0) return 0
    const ctx = new AudioContext(); await ctx.resume()
    const an = els.map((el) => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(el.srcObject as MediaStream).connect(a); return a })
    const buf = new Float32Array(2048); let max = 0; const end = performance.now() + 1_500
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
    return max
  }, freq)
}

type SettingState = { visible: boolean; on: boolean | null; note: string }
async function setting(party: Party): Promise<SettingState> {
  await openPanel(party)
  const toggle = party.page.locator(`${PANEL} [data-voice-experimental-audio]`).first()
  if ((await toggle.count()) === 0) return { visible: false, on: null, note: '' }
  return {
    visible: true,
    on: (await toggle.getAttribute('data-voice-experimental-audio')) === 'on',
    note: ((await party.page.locator(`${PANEL} [data-voice-experimental-audio-note]`).first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' '),
  }
}

async function adminSetKillSwitch(enabled: boolean): Promise<void> {
  const response = await fetch(`${h.backendOrigin}/api/admin/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${hProfile.cookie}` },
    body: JSON.stringify({ voiceWebAudioMixEnabled: enabled }),
  })
  const body = await response.json() as { ok?: boolean; settings?: { voiceWebAudioMixEnabled?: boolean } }
  if (response.status !== 200 || body.settings?.voiceWebAudioMixEnabled !== enabled) throw new Error(`admin PATCH ${enabled}: ${response.status} ${JSON.stringify(body)}`)
}

/** Напускане и ново включване само за слушане (нова гласова стая). */
async function rejoin(party: Party): Promise<void> {
  await panelClick(party, 'leave')
  for (const end = Date.now() + 10_000; Date.now() < end;) {
    if ((await party.page.evaluate('document.querySelectorAll("[data-voice-audio-sink] audio").length')) === 0) break
    await sleep(200)
  }
  await sleep(800)
  await panelClick(party, 'join-listen')
}

h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'public', 'off', NULL, ?)`)
  .run(randomUUID(), new Date().toISOString())

try {
  const host = await open(hProfile, 'H', false, TONE_H)
  const r = await open(rProfile, 'R', true, null)
  // Маса: H създава, R сяда; H говори, R само слуша.
  await host.page.locator(LOBBY_READY).first().click()
  await host.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const form = host.page.locator('[data-private-room-create-form="1"]')
  await form.locator('[data-private-room-voice-checkbox="1"]').waitFor({ state: 'visible', timeout: 15_000 })
  await form.locator('[data-private-room-voice-checkbox="1"]').check()
  await form.locator('input[name="manualStart"]').check().catch(() => undefined)
  await form.locator('button[type="submit"]').click()
  await host.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const roomId = (h.db.prepare('SELECT private_room_id FROM voice_tables WHERE status = ? ORDER BY created_at DESC LIMIT 1').get('active') as { private_room_id: string }).private_room_id
  await r.page.locator(LOBBY_READY).first().click()
  await r.page.locator(`[data-private-room-list-slot-join^="${roomId}:"]`).first().click({ timeout: 15_000 })
  await r.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
  await r.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
  await host.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]:visible').first().click({ timeout: 25_000 })
  await waitStrip(host, 'Микрофон включен')

  await check('[K1] липсващ kill switch: R — стария механизъм; настройката се вижда (включена); H4 се вижда; без media_context', async () => {
    await r.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-listen"]:visible').first().click({ timeout: 25_000 })
    const mode = await incomingMode(r)
    const state = await setting(r)
    const h4 = await r.page.locator(`${PANEL} [data-voice-action="restore-audio"]`).count()
    console.log(`    режим ${mode}; настройка ${JSON.stringify(state)}; H4 ${h4}; отчети ${JSON.stringify(r.contextReports)}`)
    assert(mode === 'element', `стария механизъм (${mode})`)
    assert(state.visible && state.on === true && state.note.includes('Сега: стандартният механизъм.'), `настройката (${JSON.stringify(state)})`)
    assert(h4 === 1, 'H4 бутонът е наличен')
    assert(r.contextReports.length === 0, 'без media_context')
  })

  await check('[K2] admin включва (истинският endpoint, без рестарт) -> следващото включване: Web Audio; отчетът е приет; R чува H', async () => {
    await adminSetKillSwitch(true)
    await rejoin(r)
    const mode = await incomingMode(r)
    await sleep(1_500)
    const heard = await heardTone(r, 440)
    const state = await setting(r)
    console.log(`    режим ${mode}; чува ${heard.toFixed(4)}; настройка ${JSON.stringify(state)}; отчети ${JSON.stringify(r.contextReports)}`)
    assert(mode === 'webaudio', `Web Audio (${mode})`)
    assert(heard > 0.005, `R чува H (${heard})`)
    assert(state.note.includes('Сега: експерименталният механизъм.'), 'панелът показва текущия режим')
    assert(r.contextReports.some((x) => x.detail === 'running/start/success' && x.status === 200), 'media_context start приет')
    assert((await r.page.locator(`${PANEL} [data-voice-action="restore-audio"]`).count()) === 1, 'H4 бутонът остава')
  })

  await check('[K3] R изключва настройката: текущата стая непроменена; следващото включване — стария механизъм; включва -> Web Audio', async () => {
    await panelClick(r, 'experimental-audio-off')
    await sleep(300)
    const off = await setting(r)
    const stillWebAudio = await incomingMode(r)
    const stored = await r.page.evaluate(() => localStorage.getItem('pika-voice-experimental-audio'))
    assert(off.on === false && stillWebAudio === 'webaudio' && stored === '0', `изключена, стаята е същата (${JSON.stringify(off)}, ${stillWebAudio}, ${String(stored)})`)
    await rejoin(r)
    const afterOff = await incomingMode(r)
    assert(afterOff === 'element', `следващото включване — стария механизъм (${afterOff})`)
    await panelClick(r, 'experimental-audio-on')
    await sleep(300)
    await rejoin(r)
    const afterOn = await incomingMode(r)
    console.log(`    след изключване ${afterOff}; след включване ${afterOn}`)
    assert(afterOn === 'webaudio', `отново Web Audio (${afterOn})`)
  })

  await check('[K4] admin изключва -> следващото включване: стария механизъм въпреки включената настройка (абсолютен приоритет)', async () => {
    await adminSetKillSwitch(false)
    const before = await setting(r)
    await rejoin(r)
    const mode = await incomingMode(r)
    await sleep(1_000)
    const heard = await heardTone(r, 440)
    console.log(`    настройка ${JSON.stringify(before)}; режим ${mode}; чува ${heard.toFixed(4)}`)
    assert(before.on === true, 'настройката е включена')
    assert(mode === 'element', `стария механизъм (${mode})`)
    assert(heard > 0.005, `R чува H (${heard})`)
    assert((await r.page.locator(`${PANEL} [data-voice-action="restore-audio"]`).count()) === 1, 'H4 бутонът остава')
  })

  await check('[K5] H (друг профил, desktop) — без настройка, без Web Audio и без media_context; без грешки по страниците', async () => {
    const state = await setting(host)
    // R само слуша -> H няма входящи потоци; проверява се, че няма Web Audio (muted/volume 0) елементи и отчети.
    const els = await host.page.evaluate(() => [...document.querySelectorAll('[data-voice-audio-sink] audio')].map((el) => (el as HTMLMediaElement).muted))
    assert(!state.visible, 'H: без настройка')
    assert(els.every((muted) => !muted), `H: без Web Audio елементи (${JSON.stringify(els)})`)
    assert(host.contextReports.length === 0, 'H: без media_context')
    for (const party of parties) assert(party.errors.length === 0, `${party.label}: без грешки (${party.errors.join(' | ')})`)
  })
} finally {
  for (const party of parties) await party.browser.close().catch(() => undefined)
  await previewServer.close().catch(() => undefined)
  await h.close().catch(() => undefined)
  liveKit.kill()
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

finishAndExit()
