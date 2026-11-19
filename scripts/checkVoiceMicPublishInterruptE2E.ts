/**
 * checkVoiceMicPublishInterruptE2E.ts — първото включване на микрофона, когато
 * публикуването в LiveKit пропада и SDK-то веднага започва reconnect
 * (production: Redmi Note 10 Pro, 19.11.2026 — mic_failed: mic_unavailable +
 * mic_attempt initial/failed/none/publish_failed, после resume ->
 * CLIENT_REQUEST_LEAVE -> пълен reconnect; „Опитай отново“ работи).
 *
 * livekit-client 2.23.0: RTCEngine.negotiate() насрочва reconnect-а
 * (setTimeout) и ЧАК ТОГАВА отхвърля publish-а — адаптерът изчаква до 1 s
 * SDK-то да започне reconnect; потвърден -> capture-ът се връща на контролера
 * и се публикува след Reconnected (висящият sender на опита се маха; за нов
 * cid при оцелял signal — clone() на същия capture, без нов getUserMedia).
 *
 * PRODUCTION build (vite build + preview), реален LiveKit 1.13.11, изолиран
 * сървър, интерфейсът (нова маса -> „Включи микрофона“). Втори участник (само
 * слуша) — ДЕЙСТВИТЕЛНО чуване: RMS на получения звук през WebAudio. Отказите
 * се инжектират в RTCPeerConnection / getUserMedia само на домакина.
 *
 *   [P1] еднократен отказ на createOffer -> успешен resume, микрофонът е
 *        включен и се чува; без пълен reconnect; една публикация, един sender
 *   [P2] отказ на ПЪРВИЯ PeerConnection (вкл. ICE restart) -> пълен reconnect,
 *        микрофонът е включен и се чува; една публикация
 *   [P3] траен отказ на публикуването БЕЗ reconnect -> както досега: „Микрофонът
 *        не е достъпен“, без автоматично повтаряне; втори участник не чува нищо
 *   [P4] отказ на правата (insufficient permissions) въпреки reconnect -> без
 *        повтаряне, capture-ът е спрян
 *   [P5] отказано разрешение (NotAllowedError) -> без публикуване и без повтаряне
 *   [P6] напускане на гласа ДОКАТО адаптерът чака -> веднага спрян capture, без
 *        грешка и без mic_failed
 *   [P7] всяко публикуване пропада (с reconnect) -> най-много 2 връщания:
 *        3 опита, после „Микрофонът не беше включен.“ (под 20 s), без 4-ти опит
 *   [P8] напускане СЛЕД връщането (клонингът чака resume) -> оригиналът и
 *        клонингът са спрени, без публикуване и без грешка
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMicPublishInterruptE2E.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { build, preview, type PreviewServer } from 'vite'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceMicPublishInterruptE2E\n')

const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? 'D:\\tmp\\livekit-1.13.11\\bin\\livekit-server.exe'
if (!existsSync(LIVEKIT_BIN)) {
  console.log(`  SKIP  няма livekit-server (${LIVEKIT_BIN}); задай LIVEKIT_SERVER_BIN`)
  process.exit(0)
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)) })
})

const workDir = await mkdtemp(join(tmpdir(), 'pika-voicepub-e2e-'))
const lkPort = await freePort()
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const udpStart = 55_000 + Math.floor(Math.random() * 300) * 10
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
process.env.VOICE_ROOM_NAMESPACE = 'e2evpub'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness({ databaseFileName: 'belot-v2-tournament-test.sqlite', env: { NODE_ENV: 'development', BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1' } })

const backendPort = new URL(h.backendOrigin).port
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
await build({
  mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true },
  plugins: [{ name: 'voicepub-isolated-backend', enforce: 'pre', transform(code, id) {
    if (!id.replaceAll('\\', '/').includes('/src/')) return null
    return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
  } }],
})
process.env.NODE_ENV = previousNodeEnv
const previewServer: PreviewServer = await preview({ root: process.cwd(), logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } })
const appOrigin = previewServer.resolvedUrls!.local[0]!.replace(/\/$/, '')
console.log(`production build на ${appOrigin}`)

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 412, height: 915 }
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const STRIP = '[data-voice-waiting-strip="1"]'
/** Праг за „чува се“ (RMS на получения звук; фалшивото устройство на Chromium издава тон). */
const HEARD_RMS = 0.01

type FailMode = 'once' | 'pc1' | 'transceiver' | 'forbidden' | 'denied' | 'always'
type Party = { label: string; profile: TestProfile; browser: Browser; page: Page; reports: Array<Record<string, unknown>> }
const parties: Party[] = []

/**
 * Инжектиране на отказите (само домакинът). PC1 = първият PeerConnection.
 *   once        — първият createOffer на PC1 след getUserMedia -> OperationError
 *   pc1         — всеки createOffer на PC1 след getUserMedia (вкл. ICE restart)
 *   transceiver — addTransceiver за аудио пропада веднъж (без договаряне -> без reconnect)
 *   forbidden   — първият createOffer на PC1 -> „insufficient permissions“
 *   denied      — getUserMedia -> NotAllowedError
 *   always      — всеки createOffer на PC с жив аудио sender
 */
const probe = (mode: FailMode | 'none'): string => String.raw`(() => {
  const MODE = ${JSON.stringify(mode)};
  const t0 = performance.now(); const log = (window.__probe = []);
  const add = (k, v) => log.push([Math.round(performance.now() - t0), k, v]);
  window.__probeNow = () => Math.round(performance.now() - t0);
  let firstPc = null, armed = false, fired = 0;
  window.__pcs = [];
  const md = navigator.mediaDevices;
  const origGum = md.getUserMedia.bind(md);
  md.getUserMedia = (c) => {
    add('gum', 'call');
    if (MODE === 'denied') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    return origGum(c).then((s) => { const tr = s.getAudioTracks()[0]; add('gum', 'ok'); armed = true; window.__tracks.push(tr); return s });
  };
  const stop = MediaStreamTrack.prototype.stop;
  window.__tracks = [];
  window.__liveAudio = () => window.__tracks.filter((t) => t.readyState === 'live').length;
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () { const c = clone.call(this); if (this.kind === 'audio') { window.__tracks.push(c); add('track', 'clone') } return c };
  MediaStreamTrack.prototype.stop = function () { if (this.kind === 'audio' && this.readyState === 'live') add('track', 'stop'); return stop.call(this) };
  const OrigPC = window.RTCPeerConnection;
  const liveAudioSender = (pc) => pc.getSenders().some((s) => s.track && s.track.kind === 'audio' && s.track.readyState === 'live');
  window.RTCPeerConnection = function (...a) { const pc = new OrigPC(...a); if (firstPc === null) firstPc = pc; window.__pcs.push(pc); add('pc', 'new ' + (pc === firstPc ? 'PC1' : 'PCn')); return pc };
  window.RTCPeerConnection.prototype = OrigPC.prototype; Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
  const co = OrigPC.prototype.createOffer;
  OrigPC.prototype.createOffer = function (...a) {
    const ice = !!(a[0] && a[0].iceRestart);
    let hit = false;
    if (armed && this === firstPc && MODE === 'once') hit = fired === 0;
    if (armed && this === firstPc && MODE === 'pc1') hit = true;
    if (armed && this === firstPc && MODE === 'forbidden') hit = fired === 0;
    if (armed && MODE === 'always') hit = liveAudioSender(this);
    add('offer', (this === firstPc ? 'PC1' : 'PCn') + (ice ? ' ice' : '') + (hit ? ' REJECT' : ' ok'));
    if (hit) {
      fired += 1;
      window.__failedAt = window.__probeNow();
      return Promise.reject(MODE === 'forbidden' ? new Error('insufficient permissions') : new DOMException('simulated createOffer failure', 'OperationError'));
    }
    return co.apply(this, a);
  };
  const at = OrigPC.prototype.addTransceiver;
  OrigPC.prototype.addTransceiver = function (track, init) {
    const audio = track && typeof track === 'object' && track.kind === 'audio';
    if (audio) add('publish', 'addTransceiver');
    if (audio && MODE === 'transceiver' && fired === 0) { fired += 1; window.__failedAt = window.__probeNow(); add('publish', 'REJECT'); throw new DOMException('simulated addTransceiver failure', 'OperationError') }
    return at.call(this, track, init);
  };
  /** Живи аудио sender-и с track (дублиран sender = 2). */
  window.__audioSenders = () => window.__pcs.filter((pc) => pc.connectionState !== 'closed').reduce((n, pc) => n + pc.getSenders().filter((s) => s.track && s.track.kind === 'audio').length, 0);
  document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('[data-voice-action="leave"]')) window.__leaveAt = window.__probeNow() }, true);
  let last = '';
  setInterval(() => { const el = document.querySelector('${STRIP}'); const txt = el ? el.textContent.replace(/\s+/g, ' ').trim() : '-'; if (txt !== last) { last = txt; add('ui', txt) } }, 50);
})()`

async function makeProfile(tag: string, role: 'admin' | 'player', vip: boolean): Promise<TestProfile> {
  const profile = await h.register(tag)
  h.setBalance(profile.profileId, 50_000_000)
  h.db.prepare('UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)').run(role, profile.profileId)
  if (vip) {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    h.db.prepare('INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until').run(profile.profileId, until)
  }
  return profile
}

async function open(label: string, role: 'admin' | 'player', vip: boolean, mobile: boolean, mode: FailMode | 'none'): Promise<Party> {
  const profile = await makeProfile(`vp${label}`, role, vip)
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext(mobile ? { viewport: MOBILE, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: ANDROID_UA } : { viewport: DESKTOP })
  await context.grantPermissions(['microphone'], { origin: appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(probe(mode))
  const page = await context.newPage()
  const reports: Array<Record<string, unknown>> = []
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  page.on('request', (request) => {
    if (!request.url().includes('/api/voice/client-report')) return
    try { reports.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>) } catch { /* нищо */ }
  })
  await page.goto(`${appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(600)
  const party = { label, profile, browser, page, reports }
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

async function clickPrompt(party: Party, action: 'join-mic' | 'join-listen'): Promise<void> {
  const button = party.page.locator(`[data-voice-prompt-layer="1"] [data-voice-action="${action}"]:visible`).first()
  await button.waitFor({ state: 'visible', timeout: 25_000 })
  await button.click()
}

const stripText = async (party: Party): Promise<string> => (await party.page.locator(STRIP).first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const probeLog = async (party: Party): Promise<Array<[number, string, string]>> => party.page.evaluate('window.__probe') as Promise<Array<[number, string, string]>>
const count = (log: Array<[number, string, string]>, kind: string, value: string): number => log.filter(([, k, v]) => k === kind && v === value).length

async function waitStrip(party: Party, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await stripText(party)).includes(text)) return true
    await sleep(100)
  }
  return false
}

/** До 15 s: абонирането на слушателя за новата публикация отнема малко време. */
async function waitHeard(listener: Party): Promise<{ elements: number; max: number }> {
  const deadline = Date.now() + 15_000
  let last = { elements: 0, max: 0 }
  while (Date.now() < deadline) {
    last = await heardRms(listener, 2_000)
    if (last.elements > 0 && last.max > HEARD_RMS) return last
    await sleep(300)
  }
  return last
}

/** Максимален RMS на получения от другите звук (WebAudio върху елементите на audio sink-а). */
async function heardRms(listener: Party, ms = 3_000): Promise<{ elements: number; max: number }> {
  return listener.page.evaluate(`(async () => {
    const els = [...document.querySelectorAll('[data-voice-audio-sink] audio')].filter((el) => el.srcObject)
    if (els.length === 0) return { elements: 0, max: 0 }
    const ctx = new AudioContext(); await ctx.resume()
    const analysers = els.map((el) => { const a = ctx.createAnalyser(); a.fftSize = 2048; ctx.createMediaStreamSource(el.srcObject).connect(a); return a })
    const buf = new Float32Array(2048); let max = 0; const end = performance.now() + ${ms}
    while (performance.now() < end) {
      for (const a of analysers) { a.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; max = Math.max(max, Math.sqrt(sum / buf.length)) }
      await new Promise((r) => setTimeout(r, 40))
    }
    await ctx.close()
    return { elements: els.length, max: Math.round(max * 10000) / 10000 }
  })()`) as Promise<{ elements: number; max: number }>
}

/** Редовете на LiveKit за участника (identity съдържа profileId-то). */
function liveKitFor(profileId: string): { resumes: number; leaves: number; published: number; sessions: number } {
  const lines = liveKitLog.filter((line) => line.includes(profileId))
  return {
    resumes: lines.filter((l) => l.includes('resuming RTC session')).length,
    leaves: lines.filter((l) => l.includes('participant closing') && l.includes('CLIENT_REQUEST_LEAVE')).length,
    published: lines.filter((l) => l.includes('mediaTrack published')).length,
    sessions: lines.filter((l) => l.includes('starting RTC session')).length,
  }
}

const events = (party: Party): string[] => party.reports.map((r) => (r.event === 'mic_attempt' ? `mic_attempt:${r.source}/${r.result}/${r.interruption}/${r.failure}` : r.event === 'mic_failed' ? `mic_failed:${r.reason}` : String(r.event)))

/** Домакин (Android Chrome) + слушател (desktop, без VIP) на една маса; домакинът натиска „Включи микрофона“. */
async function scenario(tag: string, mode: FailMode): Promise<{ host: Party; listener: Party }> {
  const host = await open(`${tag}h`, 'admin', true, true, mode)
  const listener = await open(`${tag}l`, 'player', false, false, 'none')
  const roomId = await createTable(host)
  await joinTable(listener, roomId)
  await clickPrompt(listener, 'join-listen')
  await waitStrip(listener, 'Микрофон изключен', 15_000)
  await clickPrompt(host, 'join-mic')
  return { host, listener }
}

async function close(...list: Party[]): Promise<void> {
  for (const party of list) await party.browser.close().catch(() => undefined)
}

async function dumpHost(party: Party): Promise<void> {
  if (!dumpAll) return
  const log = await probeLog(party).catch(() => [] as Array<[number, string, string]>)
  console.log(`    [${party.label}] отчети: ${events(party).join(' | ')}`)
  console.log(`    [${party.label}] проба: ${log.map(([t, k, v]) => `${t}:${k} ${v}`).join(', ')}`)
}
const dumpAll = process.env.VERBOSE === '1'

const only = process.env.ONLY?.split(',') ?? null
const run = (id: string): boolean => only === null || only.includes(id)

h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'public', 'off', NULL, ?)`)
  .run(randomUUID(), new Date().toISOString())

try {
  if (run('P1')) await check('[P1] Еднократен отказ на createOffer след getUserMedia -> успешен signal resume (без пълен reconnect), микрофонът е включен и вторият участник го чува; една публикация, един sender', async () => {
    const { host, listener } = await scenario('p1', 'once')
    try {
      assert(await waitStrip(host, 'Микрофон включен', 15_000), `домакин: ${await stripText(host)}`)
      const heard = await waitHeard(listener)
      const log = await probeLog(host)
      const lk = liveKitFor(host.profile.profileId)
      console.log(`    чуване: ${JSON.stringify(heard)}; LiveKit: ${JSON.stringify(lk)}`)
      assert(heard.elements === 1 && heard.max > HEARD_RMS, `вторият участник чува домакина (${JSON.stringify(heard)})`)
      assert(count(log, 'offer', 'PC1 REJECT') === 1, 'точно един отказ')
      assert(count(log, 'gum', 'call') === 1, 'един getUserMedia (същият capture)')
      assert(count(log, 'track', 'clone') === 1 && await host.page.evaluate('window.__liveAudio()') === 1, 'същият capture (клонинг, без getUserMedia): точно един жив аудио track')
      assert(await host.page.evaluate('window.__audioSenders()') === 1, 'един аудио sender (висящият е махнат)')
      assert(lk.resumes >= 1 && lk.leaves === 0 && lk.sessions === 1, `resume без пълен reconnect (${JSON.stringify(lk)})`)
      assert(lk.published === 1, `една публикация в LiveKit (${lk.published})`)
      assert(!events(host).some((e) => e.startsWith('mic_failed')), 'без mic_failed')
      assert(events(host).includes('mic_attempt:initial/recovered/sdk_reconnect/none'), 'mic_attempt initial/recovered/sdk_reconnect')
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P2')) await check('[P2] Отказ на ПЪРВИЯ PeerConnection (и ICE restart) -> resume пропада -> пълен reconnect; микрофонът е включен и се чува; една публикация', async () => {
    const { host, listener } = await scenario('p2', 'pc1')
    try {
      assert(await waitStrip(host, 'Микрофон включен', 20_000), `домакин: ${await stripText(host)}`)
      const heard = await waitHeard(listener)
      const log = await probeLog(host)
      const lk = liveKitFor(host.profile.profileId)
      console.log(`    чуване: ${JSON.stringify(heard)}; LiveKit: ${JSON.stringify(lk)}`)
      assert(heard.elements === 1 && heard.max > HEARD_RMS, `вторият участник чува домакина (${JSON.stringify(heard)})`)
      assert(count(log, 'offer', 'PC1 REJECT') >= 1 && count(log, 'offer', 'PC1 ice REJECT') >= 1, 'публикуването и ICE restart на PC1 са отказани')
      assert(count(log, 'gum', 'call') === 1, 'един getUserMedia')
      assert(count(log, 'track', 'clone') === 1 && await host.page.evaluate('window.__liveAudio()') === 1, 'същият capture (клонинг, без getUserMedia): точно един жив аудио track')
      assert(lk.resumes >= 1 && lk.leaves === 1 && lk.sessions === 2, `resume -> CLIENT_REQUEST_LEAVE -> нова сесия (${JSON.stringify(lk)})`)
      assert(lk.published === 1, `една публикация (${lk.published})`)
      assert(!events(host).some((e) => e.startsWith('mic_failed')), 'без mic_failed')
      assert(events(host).includes('mic_attempt:initial/recovered/sdk_reconnect/none'), 'recovered/sdk_reconnect')
      assert(events(host).filter((e) => e === 'reconnecting').length === 1, 'едно „reconnecting“ (resume + пълен = едно прекъсване)')
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P3')) await check('[P3] Траен отказ на публикуването БЕЗ reconnect -> както досега: „Микрофонът не е достъпен“, без автоматично повтаряне; вторият участник не чува нищо', async () => {
    const { host, listener } = await scenario('p3', 'transceiver')
    try {
      assert(await waitStrip(host, 'Микрофон изключен', 15_000), `домакин: ${await stripText(host)}`)
      await sleep(8_000)
      const heard = await heardRms(listener, 1_500)
      const log = await probeLog(host)
      console.log(`    чуване: ${JSON.stringify(heard)}`)
      assert(count(log, 'publish', 'addTransceiver') === 1, `един опит за публикуване (${count(log, 'publish', 'addTransceiver')})`)
      assert(count(log, 'gum', 'call') === 1 && await host.page.evaluate('window.__liveAudio()') === 0, 'capture-ът е спрян, без нов getUserMedia')
      assert(events(host).includes('mic_failed:mic_unavailable') && events(host).includes('mic_attempt:initial/failed/none/publish_failed'), 'същата диагностика като досега')
      assert(!events(host).includes('reconnecting'), 'без reconnect')
      assert(!(heard.max > HEARD_RMS), 'вторият участник не чува нищо (контрола на измерването)')
      assert(liveKitFor(host.profile.profileId).published === 0, 'няма публикация')
      await host.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click()
      await sleep(600)
      const panel = (await host.page.locator('[data-voice-panel-layer="1"]').innerText()).replace(/\s+/g, ' ')
      assert(panel.includes('Микрофонът не е достъпен') && panel.includes('Опитай отново'), `панел: ${panel.slice(0, 200)}`)
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P4')) await check('[P4] Отказ на правата при публикуване (insufficient permissions), въпреки reconnect на SDK-то -> без повтаряне, capture-ът е спрян', async () => {
    const { host, listener } = await scenario('p4', 'forbidden')
    try {
      await waitStrip(host, 'Микрофон изключен', 15_000)
      await sleep(6_000)
      const log = await probeLog(host)
      assert(count(log, 'publish', 'addTransceiver') === 1, `един опит (${count(log, 'publish', 'addTransceiver')})`)
      assert(count(log, 'gum', 'call') === 1 && await host.page.evaluate('window.__liveAudio()') === 0, 'capture-ът е спрян')
      assert(events(host).includes('mic_attempt:initial/failed/none/not_permitted'), 'not_permitted')
      assert(liveKitFor(host.profile.profileId).published === 0, 'няма публикация')
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P5')) await check('[P5] Отказано разрешение (NotAllowedError) -> „Няма достъп до микрофона“, без публикуване и без повтаряне', async () => {
    const { host, listener } = await scenario('p5', 'denied')
    try {
      await waitStrip(host, 'Микрофон изключен', 15_000)
      await sleep(5_000)
      const log = await probeLog(host)
      assert(count(log, 'gum', 'call') === 1, 'един getUserMedia')
      assert(count(log, 'publish', 'addTransceiver') === 0, 'без публикуване')
      assert(events(host).includes('mic_failed:mic_permission_denied'), 'mic_permission_denied')
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P6')) await check('[P6] Напускане на гласа ДОКАТО адаптерът чака reconnect след неуспешно публикуване -> capture-ът е спрян веднага, без грешка и без mic_failed', async () => {
    const host = await open('p6h', 'admin', true, true, 'transceiver')
    try {
      await createTable(host)
      await clickPrompt(host, 'join-mic')
      await host.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click({ timeout: 10_000 })
      await host.page.waitForFunction('window.__failedAt !== undefined', undefined, { timeout: 15_000, polling: 10 })
      await host.page.locator('[data-voice-panel-layer="1"] [data-voice-action="leave"]').first().click()
      const clickedAt = await host.page.evaluate('window.__leaveAt') as number
      const failedAt = await host.page.evaluate('window.__failedAt') as number
      await sleep(3_000)
      const log = await probeLog(host)
      const stops = log.filter(([, k, v]) => k === 'track' && v === 'stop')
      assert(stops.length === 1, `capture-ът е спрян (${stops.length})`)
      const stoppedAt = stops[0]![0]
      console.log(`    отказ ${failedAt} ms, напускане ${clickedAt} ms, спрян ${stoppedAt} ms`)
      assert(clickedAt - failedAt < 1_000, 'напускането е в прозореца на изчакването')
      assert(stoppedAt - clickedAt < 300 && stoppedAt - failedAt < 1_000, 'спрян веднага (преди края на 1 s изчакване)')
      assert(!events(host).some((e) => e.startsWith('mic_failed')), 'без mic_failed')
      assert(count(log, 'publish', 'addTransceiver') === 1, 'без повторно публикуване')
      const text = await stripText(host)
      assert(!text.includes('Микрофон') || text.includes('Не сте включени'), `извън гласа: ${text}`)
    } finally { await dumpHost(host); await close(host) }
  })

  if (run('P7')) await check('[P7] Всяко публикуване пропада (с reconnect) -> най-много 2 връщания: 3 опита, после „Микрофонът не беше включен.“ (под 20 s), без 4-ти опит', async () => {
    const { host, listener } = await scenario('p7', 'always')
    try {
      const started = Date.now()
      let final = false
      while (Date.now() - started < 25_000 && !final) {
        final = events(host).some((e) => e.startsWith('mic_attempt:initial/lost'))
        await sleep(200)
      }
      const elapsed = Date.now() - started
      await sleep(6_000)
      const log = await probeLog(host)
      assert(final && elapsed < 20_000, `окончателен край под 20 s (${elapsed} ms)`)
      assert(count(log, 'publish', 'addTransceiver') === 3, `3 опита (${count(log, 'publish', 'addTransceiver')})`)
      assert(count(log, 'gum', 'call') === 1 && count(log, 'track', 'clone') === 3 && await host.page.evaluate('window.__liveAudio()') === 0, 'един getUserMedia (клонинг при всяко от 3-те връщания), нищо живо в края')
      assert(events(host).includes('mic_attempt:initial/lost/sdk_reconnect/publish_cancelled'), 'publish_cancelled след лимита')
      assert(liveKitFor(host.profile.profileId).published === 0, 'няма публикация')
      await host.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click()
      await sleep(600)
      const panel = (await host.page.locator('[data-voice-panel-layer="1"]').innerText()).replace(/\s+/g, ' ')
      assert(panel.includes('Микрофонът не беше включен.'), `панел: ${panel.slice(0, 200)}`)
    } finally { await dumpHost(host); await close(host, listener) }
  })

  if (run('P8')) await check('[P8] Напускане СЛЕД връщането (клонингът чака resume) -> и оригиналът, и клонингът са спрени веднага; без публикуване и без грешка', async () => {
    const host = await open('p8h', 'admin', true, true, 'once')
    try {
      await createTable(host)
      await clickPrompt(host, 'join-mic')
      await host.page.locator(`${STRIP} [data-voice-action="open-panel"]`).first().click({ timeout: 10_000 })
      await host.page.waitForFunction("window.__probe.some(([, k, v]) => k === 'track' && v === 'clone')", undefined, { timeout: 15_000, polling: 10 })
      const liveBefore = await host.page.evaluate('window.__liveAudio()') as number
      await host.page.locator('[data-voice-panel-layer="1"] [data-voice-action="leave"]').first().click()
      const clickedAt = await host.page.evaluate('window.__leaveAt') as number
      await sleep(300)
      const liveAfter = await host.page.evaluate('window.__liveAudio()') as number
      await sleep(4_000)
      const log = await probeLog(host)
      const lastStop = log.filter(([, k, v]) => k === 'track' && v === 'stop').at(-1)?.[0] ?? -1
      console.log(`    живи преди напускането ${liveBefore}, 300 ms след ${liveAfter}; напускане ${clickedAt} ms, последно спиране ${lastStop} ms`)
      assert(liveBefore === 1, 'преди напускането: само клонингът е жив (оригиналът е спрян при връщането)')
      assert(liveAfter === 0 && lastStop - clickedAt < 300, 'клонингът е спрян веднага след напускането')
      assert(await host.page.evaluate('window.__liveAudio()') === 0, 'нищо живо и след Reconnected')
      assert(count(log, 'publish', 'addTransceiver') === 1, 'без повторно публикуване')
      assert(!events(host).some((e) => e.startsWith('mic_failed')), 'без mic_failed')
      assert(liveKitFor(host.profile.profileId).published === 0, 'няма публикация')
    } finally { await dumpHost(host); await close(host) }
  })
} finally {
  for (const p of parties) await p.browser.close().catch(() => undefined)
  await previewServer.close().catch(() => undefined)
  await h.close().catch(() => undefined)
  liveKit.kill()
  if (process.env.KEEP_WORKDIR !== '1') await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}
finishAndExit()
