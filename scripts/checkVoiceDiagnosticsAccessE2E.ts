/**
 * checkVoiceDiagnosticsAccessE2E.ts — Етап H3: панелът „Диагностика на звука“
 * (?voicediag=1) срещу PRODUCTION build (vite build + preview, PWA), реален
 * LiveKit 1.13.11 и изолирано копие на сървъра.
 *
 *   [D1] реалният сценарий на телефон (Android Chrome, 412×915): директен URL като
 *        гост -> вход през UI (без презареждане) -> лоби -> заключена частна маса с
 *        глас -> микрофон -> панелът е монтиран и видим (elementFromPoint)
 *   [D2] пълен администратор на desktop -> панелът е видим
 *   [D3] играч без VIP, VIP играч, subadmin, chat_admin, top_chat_admin, pika_team,
 *        marketing — всички с ?voicediag=1 и включен глас -> БЕЗ панел
 *
 * Prerender (адресната лента на Chrome) е забранен под DevTools/Playwright —
 * покрит е от scripts/checkVoiceDiagnosticsPrerender.ts (реален Chromium без DevTools).
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceDiagnosticsAccessE2E.ts
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

console.log('\ncheckVoiceDiagnosticsAccessE2E\n')

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

const workDir = await mkdtemp(join(tmpdir(), 'pika-voicediag-e2e-'))
const lkPort = await freePort()
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const udpStart = 55_000 + Math.floor(Math.random() * 300) * 10
await writeFile(join(workDir, 'livekit.yaml'), [
  `port: ${lkPort}`, 'bind_addresses: ["127.0.0.1"]', 'rtc:', `  tcp_port: ${await freePort()}`,
  `  port_range_start: ${udpStart}`, `  port_range_end: ${udpStart + 200}`, '  use_external_ip: false', '  node_ip: 127.0.0.1',
  'keys:', `  ${apiKey}: ${apiSecret}`, 'room:', '  auto_create: false', '',
].join('\n'))
const liveKit: ChildProcess = spawn(LIVEKIT_BIN, ['--config', join(workDir, 'livekit.yaml')], { stdio: 'ignore' })
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
process.env.VOICE_ROOM_NAMESPACE = 'e2evdiag'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness({ databaseFileName: 'belot-v2-tournament-test.sqlite', env: { NODE_ENV: 'development', BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1' } })

// Production build (без import.meta.env.DEV; minified; PWA) — бекендът е изолираният.
const backendPort = new URL(h.backendOrigin).port
const outDir = join(workDir, 'dist')
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'production'
await build({
  mode: 'production', root: process.cwd(), logLevel: 'error', build: { outDir, emptyOutDir: true },
  plugins: [{ name: 'voicediag-isolated-backend', enforce: 'pre', transform(code, id) {
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
const OVERLAY = '[data-voice-diagnostics="1"]'

type Role = 'admin' | 'player' | 'subadmin' | 'chat_admin' | 'top_chat_admin' | 'pika_team' | 'marketing'
type Party = { label: string; role: Role; vip: boolean; profile: TestProfile; browser: Browser; page: Page }
const parties: Party[] = []

async function makeProfile(tag: string, role: Role, vip: boolean): Promise<TestProfile> {
  const profile = await h.register(tag)
  h.setBalance(profile.profileId, 50_000_000)
  h.db.prepare('UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)').run(role, profile.profileId)
  if (vip) {
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    h.db.prepare('INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until').run(profile.profileId, until)
  }
  return profile
}

async function open(label: string, role: Role, vip: boolean, mobile: boolean, options: { loginInPage?: boolean } = {}): Promise<Party> {
  const profile = await makeProfile(`vd${label}`, role, vip)
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext(mobile ? { viewport: MOBILE, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: ANDROID_UA } : { viewport: DESKTOP })
  await context.grantPermissions(['microphone'], { origin: appOrigin })
  if (!options.loginInPage) await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  await page.goto(`${appOrigin}/lobby?voicediag=1`)
  if (options.loginInPage) {
    // Като на телефона: адресът е отворен като гост, входът е в самата страница.
    await sleep(3000)
    const row = h.db.prepare('SELECT a.email AS email FROM accounts a JOIN profiles p ON p.account_id = a.account_id WHERE p.profile_id = ?').get(profile.profileId) as { email: string }
    const opener = page.locator('[data-lobby-auth-login="1"]:visible, [data-lobby-auth-login-button="1"]:visible').first()
    if (await opener.count()) await opener.click()
    else await page.evaluate(`document.querySelector('[data-lobby-auth-login="1"], [data-lobby-auth-login-button="1"]')?.click()`)
    await page.locator('#login-email').waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('#login-email').fill(row.email)
    await page.locator('#login-password').fill('GiftBack1!')
    await page.locator('[data-lobby-auth-form="login"] button[type="submit"]').first().click()
  }
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(600)
  const party = { label, role, vip, profile, browser, page }
  parties.push(party)
  return party
}

async function createTable(host: Party, locked: boolean): Promise<string> {
  const page = host.page
  await page.locator(LOBBY_READY).first().click()
  await page.locator('[data-private-rooms-create-open="1"]').first().click()
  const form = page.locator('[data-private-room-create-form="1"]')
  const voice = form.locator('[data-private-room-voice-checkbox="1"]')
  await voice.waitFor({ state: 'visible', timeout: 15_000 })
  await voice.check()
  if (locked) await form.locator('[name="isLocked"]').first().check()
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

/** Включва гласа (микрофон, ако е позволен; иначе „Само слушай“) — това зарежда гласовия runtime. */
async function joinVoice(party: Party): Promise<'mic' | 'listen'> {
  const layer = party.page.locator('[data-voice-prompt-layer="1"]')
  const any = layer.locator('[data-voice-action="join-mic"]:visible, [data-voice-action="join-listen"]:visible').first()
  await any.waitFor({ state: 'visible', timeout: 25_000 })
  const mic = layer.locator('[data-voice-action="join-mic"]:visible')
  if (await mic.count()) { await mic.first().click(); return 'mic' }
  await layer.locator('[data-voice-action="join-listen"]:visible').first().click()
  return 'listen'
}

/** Гласовият runtime е зареден и свързан (асинхронният chunk е изпълнен). */
async function waitVoiceConnected(party: Party): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const audio = await party.page.locator('[data-voice-audio-sink]').count()
    const status = await party.page.locator('[data-voice-status], [data-voice-mic-state], [data-voice-panel]').count()
    if (audio > 0 || status > 0) { await sleep(2500); return }
    await sleep(250)
  }
  await sleep(2500)
}

/** Lazy chunk-ът voice-voiceRuntime-* е изтеглен (там е монтирането на панела). */
function runtimeLoaded(party: Party): Promise<boolean> {
  return party.page.evaluate("performance.getEntriesByType('resource').some((e) => /voice-voiceRuntime-/.test(e.name))") as Promise<boolean>
}

async function overlayVisible(party: Party): Promise<boolean> {
  const box = await party.page.locator(OVERLAY).first().boundingBox().catch(() => null)
  if (box === null) return false
  const viewport = party.page.viewportSize()!
  if (box.y < 0 || box.x < 0 || box.y + box.height > viewport.height || box.x + box.width > viewport.width) return false
  return party.page.evaluate(`(() => { const el = document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2}); return !!(el && el.closest('${OVERLAY}')) })()`) as Promise<boolean>
}

// Гласът е публично пуснат (както в production).
h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'public', 'off', NULL, ?)`)
  .run(randomUUID(), new Date().toISOString())

try {
  await check('[D1] Телефон (Android Chrome): директен URL като гост -> вход -> заключена частна маса с глас -> микрофон -> панелът е видим за пълния администратор', async () => {
    const admin = await open('admM', 'admin', true, true, { loginInPage: true })
    assert(await admin.page.evaluate("sessionStorage.getItem('pika.voice.diag')") === '1', 'заявката е записана')
    await createTable(admin, true)
    const mode = await joinVoice(admin)
    assert(mode === 'mic', `микрофон (не ${mode})`)
    await waitVoiceConnected(admin)
    await admin.page.locator(OVERLAY).first().waitFor({ state: 'attached', timeout: 15_000 })
    assert(await overlayVisible(admin), 'панелът е в екрана и не е закрит')
    assert(await runtimeLoaded(admin), 'runtime зареден')
    if (process.env.SHOT_DIR) await admin.page.screenshot({ path: join(process.env.SHOT_DIR, 'd1-mobile-admin.png') })
  })

  await check('[D2] Desktop: пълен администратор с ?voicediag=1 и включен микрофон -> панелът е видим', async () => {
    const admin = await open('admD', 'admin', true, false)
    await createTable(admin, true)
    assert(await joinVoice(admin) === 'mic', 'микрофон')
    await waitVoiceConnected(admin)
    await admin.page.locator(OVERLAY).first().waitFor({ state: 'attached', timeout: 15_000 })
    assert(await overlayVisible(admin), 'панелът е видим')
  })

  await check('[D3] Играч, VIP, subadmin, chat_admin, top_chat_admin, pika_team, marketing (desktop и mobile) с ?voicediag=1 и включен глас -> БЕЗ панел', async () => {
    // Маса 1 (домакин VIP играч): играч без VIP, subadmin, chat_admin. Маса 2 (домакин marketing+VIP): top_chat_admin, pika_team.
    const vip = await open('vip', 'player', true, false)
    const player = await open('ply', 'player', false, true)
    const subadmin = await open('sub', 'subadmin', true, true)
    const chatAdmin = await open('cha', 'chat_admin', true, false)
    const marketing = await open('mkt', 'marketing', true, true)
    const topChat = await open('tca', 'top_chat_admin', true, false)
    const pikaTeam = await open('pkt', 'pika_team', true, true)
    const room1 = await createTable(vip, false)
    await joinVoice(vip)
    for (const p of [player, subadmin, chatAdmin]) { await joinTable(p, room1); await joinVoice(p) }
    const room2 = await createTable(marketing, false)
    await joinVoice(marketing)
    for (const p of [topChat, pikaTeam]) { await joinTable(p, room2); await joinVoice(p) }
    const others = [vip, player, subadmin, chatAdmin, marketing, topChat, pikaTeam]
    for (const p of others) await waitVoiceConnected(p)
    await sleep(2000)
    for (const p of others) {
      assert(await p.page.evaluate("sessionStorage.getItem('pika.voice.diag')") === '1', `${p.label}: заявката е записана (но не дава достъп)`)
      assert(await runtimeLoaded(p), `${p.label}: гласовият runtime е зареден (мястото, където се монтира панелът)`)
      assert(await p.page.locator(OVERLAY).count() === 0, `${p.label} (${p.role}${p.vip ? ', VIP' : ''}) не вижда панела`)
    }
    console.log(`    без панел: ${others.map((p) => `${p.role}${p.vip ? '+VIP' : ''}`).join(', ')}`)
  })
} finally {
  for (const p of parties) await p.browser.close().catch(() => undefined)
  await previewServer.close().catch(() => undefined)
  await h.close().catch(() => undefined)
  liveKit.kill()
  if (process.env.KEEP_WORKDIR !== '1') await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}
finishAndExit()
