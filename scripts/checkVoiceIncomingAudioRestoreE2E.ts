/**
 * checkVoiceIncomingAudioRestoreE2E.ts — Етап H4 (ЕКСПЕРИМЕНТАЛНО): „Възстанови
 * звука“ с РЕАЛНИЯ LiveKit адаптер.
 *
 * PRODUCTION build (vite build + preview), реален LiveKit 1.13.11, изолиран
 * сървър, реалният интерфейс. Трима с включен микрофон на една маса: H (домакин),
 * R (разрешен профил — в build-а на теста profile_id-то на Divaka655 в
 * voiceIncomingAudioRestoreConfig.ts е заменено с това на R), O (неразрешен).
 * R е заглушил O локално. Чуването се мери с RMS на получения звук (WebAudio).
 *
 *   [E1] бутонът е само при R; натискане (вкл. бързо многократно) -> старите
 *        елементи са откачени/премахнати, нови са закачени и пуснати, R чува H;
 *        локалното заглушаване на O остава; микрофонът на R е същият (без
 *        getUserMedia, без нов track/PeerConnection), H го чува; LiveKit: една
 *        сесия, без resume/leave, една публикация; O не е засегнат; един отчет
 *        media_recovery output/reattach/success/gesture, без element_missing
 *   [E2] напускане ДОКАТО тече възстановяването -> без грешка, без елементи,
 *        без отчет за възстановяване (паузата е прекъсната)
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceIncomingAudioRestoreE2E.ts
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

console.log('\ncheckVoiceIncomingAudioRestoreE2E\n')

const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? 'D:\\tmp\\livekit-1.13.11\\bin\\livekit-server.exe'
if (!existsSync(LIVEKIT_BIN)) {
  console.log(`  SKIP  няма livekit-server (${LIVEKIT_BIN}); задай LIVEKIT_SERVER_BIN`)
  process.exit(0)
}
const DIVAKA = '29925128-167c-408b-9a33-620d2d8f9a95'

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)) })
})

const workDir = await mkdtemp(join(tmpdir(), 'pika-voice-h4-e2e-'))
const lkPort = await freePort()
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const udpStart = 56_000 + Math.floor(Math.random() * 300) * 10
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
process.env.VOICE_ROOM_NAMESPACE = 'e2eh4'
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

// Разрешените профили (R1, R2) трябва да съществуват преди build-а: тестовият
// build заменя profile_id-то на Divaka655 в allowlist-а с тези на R1/R2.
const allowedProfiles = [await makeProfile('h4r1', 'player'), await makeProfile('h4r2', 'player')]

const backendPort = new URL(h.backendOrigin).port
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
await build({
  mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true },
  plugins: [{ name: 'h4-isolated-backend', enforce: 'pre', transform(code, id) {
    const file = id.replaceAll('\\', '/')
    if (!file.includes('/src/')) return null
    let next = code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : code
    if (file.endsWith('/src/app/voice/voiceIncomingAudioRestoreConfig.ts')) {
      next = next.replace(`'${DIVAKA}', //`, `${allowedProfiles.map((p) => `'${p.profileId}'`).join(', ')}, //`)
    }
    return next === code ? null : next
  } }],
})
process.env.NODE_ENV = previousNodeEnv
{
  // Контрола: тестовият allowlist е влязъл в lazy chunk-а, не в основния bundle.
  const assets = await readdir(join(outDir, 'assets'))
  let inVoiceChunk = false
  let inMain = false
  for (const name of assets.filter((n) => n.endsWith('.js'))) {
    const code = await readFile(join(outDir, 'assets', name), 'utf8')
    if (code.includes(allowedProfiles[0]!.profileId)) {
      if (name.startsWith('voice')) inVoiceChunk = true
      else inMain = true
    }
  }
  if (!inVoiceChunk || inMain) throw new Error(`allowlist: voice chunk=${inVoiceChunk}, другаде=${inMain}`)
}
const previewServer: PreviewServer = await preview({ root: process.cwd(), logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
const appOrigin = previewServer.resolvedUrls!.local[0]!.replace(/\/$/, '')
console.log(`production build на ${appOrigin}`)

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 412, height: 915 }
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const STRIP = '[data-voice-waiting-strip="1"]'
const PANEL = '[data-voice-panel-layer="1"]'
const HEARD_RMS = 0.01

type Party = { label: string; profile: TestProfile; browser: Browser; page: Page; reports: Array<Record<string, unknown>>; errors: string[] }
const parties: Party[] = []

/** Броячи на страницата: getUserMedia, спрени/живи аудио tracks, PeerConnection-и. */
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

async function open(profile: TestProfile, label: string, mobile: boolean): Promise<Party> {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext(mobile ? { viewport: MOBILE, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: ANDROID_UA } : { viewport: DESKTOP })
  await context.grantPermissions(['microphone'], { origin: appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(probe)
  const page = await context.newPage()
  const reports: Array<Record<string, unknown>> = []
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(error.message); console.error(`    [pageerror ${label}] ${error.message}`) })
  page.on('request', (request) => {
    if (!request.url().includes('/api/voice/client-report')) return
    try { reports.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>) } catch { /* нищо */ }
  })
  await page.goto(`${appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(600)
  const party = { label, profile, browser, page, reports, errors }
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

async function joinWithMic(party: Party): Promise<void> {
  const button = party.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]:visible').first()
  await button.waitFor({ state: 'visible', timeout: 25_000 })
  await button.click()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const text = (await party.page.locator(STRIP).first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (text.includes('Микрофон включен')) return
    await sleep(150)
  }
  throw new Error(`${party.label}: микрофонът не се включи`)
}

async function openPanel(party: Party): Promise<void> {
  if (await party.page.locator(`${PANEL} [data-voice-panel="1"]`).first().isVisible().catch(() => false)) return
  await party.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click()
  await party.page.locator(`${PANEL} [data-voice-panel="1"]`).first().waitFor({ state: 'visible', timeout: 10_000 })
}

/** Максимален RMS на получения звук за всеки елемент на audio sink-а (WebAudio от srcObject). */
async function heardRms(party: Party, ms = 2_000): Promise<{ elements: number; max: number; perElement: number[] }> {
  return party.page.evaluate(`(async () => {
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')].filter((el) => el.srcObject)
    if (els.length === 0) return { elements: 0, max: 0, perElement: [] }
    const ctx = new AudioContext(); await ctx.resume()
    const analysers = els.map((el) => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(el.srcObject).connect(a); return a })
    const buf = new Float32Array(2048); const per = els.map(() => 0); const end = performance.now() + ${ms}
    while (performance.now() < end) {
      analysers.forEach((a, i) => { a.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; per[i] = Math.max(per[i], Math.sqrt(sum / buf.length)) })
      await new Promise((r) => setTimeout(r, 40))
    }
    await ctx.close()
    const round = (v) => Math.round(v * 10000) / 10000
    return { elements: els.length, max: round(Math.max(...per)), perElement: per.map(round) }
  })()`) as Promise<{ elements: number; max: number; perElement: number[] }>
}

async function waitHeard(party: Party, elements: number): Promise<{ elements: number; max: number; perElement: number[] }> {
  const deadline = Date.now() + 20_000
  let last = { elements: 0, max: 0, perElement: [] as number[] }
  while (Date.now() < deadline) {
    last = await heardRms(party)
    if (last.elements === elements && last.perElement.every((v) => v > HEARD_RMS)) return last
    await sleep(300)
  }
  return last
}

type SinkState = { count: number; playing: number; volumes: number[]; marked: number; markedConnected: number; markedWithSource: number; tracks: string[] }
/** Елементите на audio sink-а; `mark` — маркира текущите (за проверка, че са премахнати). */
async function sink(party: Party, mark = false): Promise<SinkState> {
  return party.page.evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')]
    if (${mark}) window.__marked = els
    const marked = window.__marked ?? []
    return {
      count: els.length,
      playing: els.filter((el) => !el.paused && el.srcObject).length,
      volumes: els.map((el) => el.volume).sort(),
      marked: marked.length,
      markedConnected: marked.filter((el) => el.isConnected).length,
      markedWithSource: marked.filter((el) => el.srcObject !== null).length,
      tracks: els.map((el) => el.getAttribute('data-voice-track')).sort(),
    }
  })()`) as Promise<SinkState>
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
const mediaReports = (party: Party) => party.reports.filter((r) => r.event === 'media_output' || r.event === 'media_recovery').map((r) => r.event === 'media_output' ? `output:${String(r.state)}` : `recovery:${String(r.step)}/${String(r.result)}/${String(r.trigger)}`)
const pageNumber = (party: Party, expr: string) => party.page.evaluate(expr) as Promise<number>

h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'public', 'off', NULL, ?)`)
  .run(randomUUID(), new Date().toISOString())

/** H (домакин, admin) + R (разрешен, Android) + O (неразрешен); всички с включен микрофон; R заглушава O. */
async function table(tag: string, allowed: TestProfile): Promise<{ host: Party; r: Party; o: Party }> {
  const host = await open(await makeProfile(`${tag}h`, 'admin'), `${tag}H`, false)
  const r = await open(allowed, `${tag}R`, true)
  const o = await open(await makeProfile(`${tag}o`, 'player'), `${tag}O`, false)
  const roomId = await createTable(host)
  await joinTable(r, roomId)
  await joinTable(o, roomId)
  await joinWithMic(host)
  await joinWithMic(r)
  await joinWithMic(o)
  await openPanel(r)
  await r.page.locator(`${PANEL} [data-voice-mute-toggle="${o.profile.profileId}"]`).first().click({ timeout: 10_000 })
  await sleep(500)
  return { host, r, o }
}

try {
  await check('[E1] „Възстанови звука“ (реален LiveKit): нови елементи, R чува; заглушаването, микрофонът, сесията и другите — непокътнати', async () => {
    const { host, r, o } = await table('e1', allowedProfiles[0]!)
    try {
      const heardBefore = await waitHeard(r, 2)
      assert(heardBefore.elements === 2 && heardBefore.perElement.every((v) => v > HEARD_RMS), `R чува двамата преди (${JSON.stringify(heardBefore)})`)
      assert((await heardRms(host)).max > HEARD_RMS, 'H чува преди')
      // Бутонът — само при разрешения профил.
      await openPanel(host)
      await openPanel(o)
      assert(await r.page.locator(`${PANEL} [data-voice-action="restore-audio"]`).count() === 1, 'R: бутон')
      assert(await host.page.locator('[data-voice-action="restore-audio"]').count() === 0, 'H: без бутон')
      assert(await o.page.locator('[data-voice-action="restore-audio"]').count() === 0, 'O: без бутон')

      const before = await sink(r, true)
      const oBefore = await sink(o, true)
      const micBefore = await r.page.evaluate('window.__liveMic()') as string[]
      const gumBefore = await pageNumber(r, 'window.__gum')
      const pcsBefore = await pageNumber(r, 'window.__pcs')
      const lkBefore = liveKitFor(r.profile.profileId)
      const reportsBefore = r.reports.length
      assert(before.count === 2 && before.volumes.join(',') === '0,1', `преди: два елемента, O заглушен (${JSON.stringify(before)})`)
      assert(micBefore.length === 1, 'R: един жив микрофон')

      // Бързо многократно натискане (бутонът се заключва след първото).
      await r.page.evaluate(`(() => { for (let i = 0; i < 3; i += 1) document.querySelector('${PANEL} [data-voice-action="restore-audio"]')?.click() })()`)
      await r.page.locator(`${PANEL} [data-voice-audio-restore-result]`).first().waitFor({ state: 'visible', timeout: 10_000 })
      const outcome = await r.page.locator(`${PANEL} [data-voice-audio-restore-result]`).first().getAttribute('data-voice-audio-restore-result')
      await sleep(700)
      const after = await sink(r)
      const heardAfter = await waitHeard(r, 2)
      const micAfter = await r.page.evaluate('window.__liveMic()') as string[]
      const lkAfter = liveKitFor(r.profile.profileId)
      const restoreReports = mediaReports(r).slice(0).filter((e) => e.startsWith('recovery:reattach/') && e.endsWith('/gesture'))
      const newReports = r.reports.slice(reportsBefore)
      console.log(`    резултат: ${outcome}; преди ${JSON.stringify(before)}; след ${JSON.stringify(after)}; чуване ${JSON.stringify(heardAfter)}; LiveKit ${JSON.stringify(lkAfter)}; отчети ${JSON.stringify(newReports)}`)
      assert(outcome === 'played', `технически резултат played (${outcome})`)
      assert(after.markedConnected === 0 && after.markedWithSource === 0, `старите елементи са премахнати и без srcObject (${JSON.stringify(after)})`)
      assert(after.count === 2 && after.playing === 2, `два нови пуснати елемента (${JSON.stringify(after)})`)
      assert(after.tracks.join(',') === before.tracks.join(','), 'същите абонирани потоци (същите track sid)')
      assert(after.volumes.join(',') === '0,1', `локалното заглушаване на O остава (${after.volumes.join(',')})`)
      assert(heardAfter.elements === 2 && heardAfter.perElement.every((v) => v > HEARD_RMS), `R получава звука и след това (${JSON.stringify(heardAfter)})`)
      assert(micAfter.length === 1 && micAfter[0] === micBefore[0], 'същият жив микрофон')
      assert(await pageNumber(r, 'window.__gum') === gumBefore, 'без нов getUserMedia')
      assert(await pageNumber(r, 'window.__pcs') === pcsBefore, 'без нов PeerConnection')
      assert(lkAfter.sessions === lkBefore.sessions && lkAfter.resumes === lkBefore.resumes && lkAfter.leaves === lkBefore.leaves, `без reconnect/resume/leave (${JSON.stringify(lkBefore)} -> ${JSON.stringify(lkAfter)})`)
      assert(lkAfter.published === 1, `една публикация на R (${lkAfter.published})`)
      assert(restoreReports.length === 1 && restoreReports[0] === 'recovery:reattach/success/gesture', `един отчет на H4 (${restoreReports.join(' | ')})`)
      assert(!newReports.some((rep) => rep.event === 'media_output'), 'без element_missing/element_paused по време на H4')
      assert(!newReports.some((rep) => ['reconnecting', 'connection_lost', 'mic_lost', 'session_end'].includes(String(rep.event))), 'без reconnect/загуба на микрофона')
      const heardByHost = await heardRms(host)
      assert(heardByHost.elements === 2 && heardByHost.perElement.every((v) => v > HEARD_RMS), `H чува R и O (${JSON.stringify(heardByHost)})`)
      const oAfter = await sink(o)
      assert(oAfter.markedConnected === oBefore.count && oAfter.count === oBefore.count, 'O: елементите не са пипнати')
      for (const party of [host, r, o]) assert(party.errors.length === 0, `${party.label}: без грешки`)
    } finally { for (const p of [host, r, o]) await p.browser.close().catch(() => undefined) }
  })

  await check('[E2] Напускане ДОКАТО тече възстановяването: без грешка, без елементи, без отчет за възстановяване', async () => {
    const { host, r, o } = await table('e2', allowedProfiles[1]!)
    try {
      await waitHeard(r, 2)
      const reportsBefore = r.reports.length
      await r.page.evaluate(`(() => {
        document.querySelector('${PANEL} [data-voice-action="restore-audio"]')?.click()
        document.querySelector('${PANEL} [data-voice-action="leave"]')?.click()
      })()`)
      await sleep(2_500)
      const state = await sink(r)
      const newReports = r.reports.slice(reportsBefore)
      console.log(`    след напускане: ${JSON.stringify(state)}; отчети ${JSON.stringify(newReports)}`)
      assert(state.count === 0, 'без audio елементи')
      assert(!newReports.some((rep) => rep.event === 'media_recovery'), 'без отчет за възстановяване (прекъснато)')
      assert(newReports.some((rep) => rep.event === 'session_end' && rep.reason === 'leave_voice'), 'обичайното напускане')
      assert((await r.page.evaluate('window.__liveMic()') as string[]).length === 0, 'микрофонът е освободен от напускането')
      assert(r.errors.length === 0, 'без грешки на страницата')
      const heardByHost = await heardRms(host)
      assert(heardByHost.elements === 1 && heardByHost.max > HEARD_RMS, `H продължава да чува O (${JSON.stringify(heardByHost)})`)
    } finally { for (const p of [host, r, o]) await p.browser.close().catch(() => undefined) }
  })
} finally {
  for (const party of parties) await party.browser.close().catch(() => undefined)
  await previewServer.close().catch(() => undefined)
  await h.close().catch(() => undefined)
  liveKit.kill()
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

finishAndExit()
