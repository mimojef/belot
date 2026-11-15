/**
 * checkVoiceRealLiveKitE2E.ts — гласов чат с ИСТИНСКИ LiveKit и реален аудиопоток.
 *
 * Изолирана среда: локален livekit-server (официален билд, същата версия
 * като production, отделни тестови ключове, auto_create:false), изолирано
 * копие на игровия сървър, Vite и ЧЕТИРИ отделни Chromium процеса. Всеки
 * „говори“ със собствен пулсиращ тон (450 / 650 / 950 / 1250 Hz) чрез
 * --use-file-for-fake-audio-capture; всеки слушател анализира получения
 * звук (WebAudio, честота по участник) — доказва се, че аудиото действително
 * пристига, а не че индикаторът е зелен. Никакви production стаи.
 *
 *   [E1] чакалня: всеки чува тримата останали;
 *   [E2] чакалня -> игра: без прекъсване (пауза ≤ 1,5 s), без ротация;
 *   [E3] игра -> край -> преиграване: без прекъсване, без ротация;
 *   [E4] презареждане на участник (ротацията при изместване е ЗАПАЗЕНА):
 *        останалите отново се чуват автоматично; презареденият се връща
 *        с изрично включване; старият му токен не дава достъп;
 *   [E5] край на мача, двама напускат: ЕДНА ротация; останалите се чуват
 *        автоматично; старите токени на напусналите не дават достъп.
 *
 *   LIVEKIT_SERVER_BIN=D:\tmp\livekit-1.13.11\bin\livekit-server.exe \
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceRealLiveKitE2E.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page, type WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceRealLiveKitE2E\n')

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
const workDir = await mkdtemp(join(tmpdir(), 'pika-livekit-e2e-'))
const lkPort = await freePort()
const lkTcpPort = await freePort()
const udpStart = 52_000 + Math.floor(Math.random() * 500) * 10
const apiKey = 'e2ekey'
const apiSecret = `${randomUUID()}${randomUUID()}`.replace(/-/g, '')
const lkConfig = [
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
].join('\n')
const lkConfigPath = join(workDir, 'livekit.yaml')
await writeFile(lkConfigPath, lkConfig)
const lkLog: string[] = []
const liveKit: ChildProcess = spawn(LIVEKIT_BIN, ['--config', lkConfigPath], { stdio: ['ignore', 'pipe', 'pipe'] })
liveKit.stdout?.setEncoding('utf8')
liveKit.stderr?.setEncoding('utf8')
const keepLog = (chunk: string) => { lkLog.push(chunk); if (lkLog.length > 400) lkLog.shift() }
liveKit.stdout?.on('data', keepLog)
liveKit.stderr?.on('data', keepLog)
{
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${lkPort}/`)
      if (response.ok) { ready = true; break }
    } catch { /* още стартира */ }
    await sleep(250)
  }
  if (!ready) {
    console.error(lkLog.join('').slice(-3000))
    liveKit.kill()
    throw new Error('livekit-server не стартира')
  }
  console.log(`LiveKit 1.13.11 на 127.0.0.1:${lkPort} (UDP ${udpStart}-${udpStart + 200}).`)
}

// ─── Тонове (пулсиращи — шумопотискането не ги изрязва като постоянен шум) ──
const TONES = [450, 650, 950, 1250] as const
async function writeToneWav(path: string, frequency: number): Promise<void> {
  const sampleRate = 48_000
  const seconds = 4
  const samples = sampleRate * seconds
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate
    const on = (t % 0.4) < 0.3 // 300 ms тон / 100 ms тишина
    const envelope = on ? Math.min(1, ((t % 0.4) / 0.01)) * Math.min(1, ((0.3 - (t % 0.4)) / 0.01)) : 0
    const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * 0.45 * envelope * 32_767)
    data.writeInt16LE(value, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(data.length, 40)
  await writeFile(path, Buffer.concat([header, data]))
}

// ─── Игрови сървър (изолирано копие; мачът е до 1 т.) ─────────────────────
process.env.LIVEKIT_API_URL = `http://127.0.0.1:${lkPort}`
process.env.LIVEKIT_WS_URL = `ws://127.0.0.1:${lkPort}`
process.env.LIVEKIT_API_KEY = apiKey
process.env.LIVEKIT_API_SECRET = apiSecret
process.env.VOICE_ROOM_NAMESPACE = 'e2ereal'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness({
  patchServerSource: [{
    file: 'index.ts',
    find: 'const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)',
    replace: 'const initializedRoom = initializeRoomAuthoritativeGameState({ ...currentRoom, config: { ...currentRoom.config, targetScore: 1 } })',
  }],
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: {
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
    BELOT_LOCAL_BOT_ACTION_MIN_MS: '60',
    BELOT_LOCAL_BOT_ACTION_MAX_MS: '120',
  },
})

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'

type Frame = { at: number; type: string; data: any }
type Party = {
  label: string
  tone: number
  profile: TestProfile
  browser: Browser
  page: Page
  received: Frame[]
  tokens: Array<{ at: number; status: number; token: string | null; url: string | null }>
  /** Анонимните клиентски отчети (session_end, mic_*, reconnecting…) — за диагностика при провал. */
  reports: Array<{ at: number; body: any }>
  inject: (m: unknown) => void
}

// Анализ на получения звук: по един анализатор на всеки отдалечен audio
// елемент; „чуто“ = силата в честотата на тона над прага. maxGap — най-дългата
// пауза между две чувания на даден тон след последното reset().
const AUDIO_PROBE = `(() => {
  const TONES = ${JSON.stringify(TONES)}
  const THRESHOLD_DB = -62
  const st = { last: {}, maxGap: {} }
  let ctx = null
  const analysers = new Map()
  function tick() {
    try {
      if (ctx === null) ctx = new AudioContext()
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      for (const el of document.querySelectorAll('[data-voice-audio-sink] audio')) {
        if (analysers.has(el) || !el.srcObject) continue
        const source = ctx.createMediaStreamSource(el.srcObject)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0
        source.connect(analyser)
        analysers.set(el, analyser)
      }
      const now = performance.now()
      const heard = new Set()
      for (const [el, analyser] of analysers) {
        if (!el.isConnected) { analysers.delete(el); continue }
        const data = new Float32Array(analyser.frequencyBinCount)
        analyser.getFloatFrequencyData(data)
        const binHz = ctx.sampleRate / analyser.fftSize
        for (const f of TONES) {
          const bin = Math.round(f / binHz)
          let peak = -Infinity
          for (let i = bin - 2; i <= bin + 2; i += 1) peak = Math.max(peak, data[i])
          if (peak > THRESHOLD_DB) heard.add(f)
        }
      }
      for (const f of heard) {
        const prev = st.last[f]
        if (prev !== undefined && now - prev > (st.maxGap[f] ?? 0)) st.maxGap[f] = now - prev
        st.last[f] = now
      }
    } catch (error) { st.error = String(error) }
  }
  setInterval(tick, 40)
  window.__audioProbe = {
    report: () => {
      const now = performance.now()
      return Object.fromEntries(TONES.map((f) => [f, { agoMs: st.last[f] === undefined ? null : Math.round(now - st.last[f]), maxGapMs: Math.round(st.maxGap[f] ?? 0) }]))
    },
    reset: () => { st.maxGap = {} },
    error: () => st.error ?? null,
  }
})()`

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

async function openParty(label: string, profile: TestProfile, tone: number, viewport: { width: number; height: number }): Promise<Party> {
  const wav = join(workDir, `tone-${tone}.wav`)
  await writeToneWav(wav, tone)
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  })
  const context = await browser.newContext(viewport === MOBILE ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport })
  await context.grantPermissions(['microphone'], { origin: h.appOrigin })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(AUDIO_PROBE)
  const received: Frame[] = []
  const tokens: Party['tokens'] = []
  const reports: Party['reports'] = []
  await context.route(`${h.backendOrigin}/api/voice/client-report`, async (route) => {
    try { reports.push({ at: Date.now(), body: JSON.parse(route.request().postData() ?? 'null') }) } catch { /* not JSON */ }
    await route.continue()
  })
  let current: WebSocketRoute | null = null
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      try { const d = JSON.parse(typeof m === 'string' ? m : m.toString('utf8')); received.push({ at: Date.now(), type: String(d?.type ?? ''), data: d }) } catch { /* not JSON */ }
      ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = server
  })
  // Само в тестовата среда: запис на издадените токени (за проверката „стар токен“).
  await context.route(`${h.backendOrigin}/api/voice/token`, async (route) => {
    const response = await route.fetch()
    const text = await response.text()
    let body: any = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    tokens.push({ at: Date.now(), status: response.status(), token: typeof body?.token === 'string' ? body.token : null, url: typeof body?.url === 'string' ? body.url : null })
    await route.fulfill({ response, body: text })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, tone, profile, browser, page, received, tokens, reports, inject: (m) => current?.send(JSON.stringify(m)) }
}

type ToneReport = Record<string, { agoMs: number | null; maxGapMs: number }>
const audioReport = (p: Party) => p.page.evaluate(`window.__audioProbe ? window.__audioProbe.report() : null`) as Promise<ToneReport | null>
const resetGaps = (p: Party) => p.page.evaluate(`window.__audioProbe && window.__audioProbe.reset()`)
const voiceState = (p: Party) => p.page.evaluate(`(() => { const v = window.__pikaVoice; const s = v ? v.getSnapshot() : null; return s ? { status: s.status, microphone: s.microphone } : null })()`) as Promise<{ status: string; microphone: string } | null>

async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}

/** Слушателят чува в последните 1,5 s всеки от говорителите. */
async function hearsAll(listener: Party, speakers: Party[], freshMs = 1_500): Promise<boolean> {
  const report = await audioReport(listener)
  if (report === null) return false
  return speakers.every((speaker) => {
    const entry = report[String(speaker.tone)]
    return entry !== undefined && entry.agoMs !== null && entry.agoMs <= freshMs
  })
}

async function waitMutualAudio(parties: Party[], timeoutMs: number, freshMs = 1_500): Promise<number> {
  const started = Date.now()
  await waitUntil(`взаимно чуване (${parties.map((p) => p.label).join(', ')})`, async () => {
    for (const listener of parties) {
      if (!(await hearsAll(listener, parties.filter((p) => p !== listener), freshMs))) return false
    }
    return true
  }, timeoutMs, 250)
  return Date.now() - started
}

async function describeAudio(parties: Party[]): Promise<string> {
  const lines: string[] = []
  for (const p of parties) {
    const extra = await p.page.evaluate(`(() => { const v = window.__pikaVoice; const s = v ? v.getSnapshot() : null; return { uiError: s && s.uiError ? s.uiError.code : null, wantsToSpeak: s ? s.wantsToSpeak : null, generation: s ? s.generation : null, audioElements: document.querySelectorAll('[data-voice-audio-sink] audio').length, counters: v ? v.debugCounters() : null } })()`)
    const recent = p.reports.filter((r) => r.body?.event !== 'transport').slice(-14).map((r) => `${r.body?.event}${r.body?.reason ? ':' + r.body.reason : ''}${r.body?.result ? ':' + r.body.result : ''}${r.body?.stage && r.body.stage !== 'none' ? ':' + r.body.stage : ''}`)
    lines.push(`${p.label}: ${JSON.stringify(await audioReport(p))} ${JSON.stringify(await voiceState(p))} ${JSON.stringify(extra)} reports=[${recent.join(',')}]`)
  }
  return lines.join(' | ')
}

const lastSnapshot = (p: Party, roomId: string) => [...p.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.roomId === roomId)?.data ?? null

/** Автоматична игра: цепене, домакинът обявява „Без коз“, другите пасуват, допустима карта. */
function startAutopilot(p: Party, roomId: string, bidder: boolean): () => void {
  let stopped = false
  let busy = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    if (!busy) {
      busy = true
      try {
        const snap = lastSnapshot(p, roomId)
        const game = snap?.game
        if (game) {
          if (await p.page.locator('[data-declaration-continue]').count() > 0) {
            await p.page.locator('[data-declaration-continue]').first().click({ timeout: 800 }).catch(() => undefined)
          } else if (game.cutting?.canSubmitCut) {
            await p.page.locator('[data-active-room-cut-index]').first().dispatchEvent('click').catch(() => undefined)
          } else if (game.bidding?.canSubmitBid) {
            const action = bidder && game.bidding.validActions?.noTrumps ? 'no-trumps' : 'pass'
            await p.page.locator(`[data-bid-action="${action}"]`).first().dispatchEvent('click').catch(() => undefined)
          } else if (Array.isArray(game.playing?.validCardIds) && game.playing.validCardIds.length > 0) {
            await p.page.locator(`.play-hand-card--active[data-card-id="${game.playing.validCardIds[0]}"]`).first().dispatchEvent('click').catch(() => undefined)
          }
        }
      } catch { /* страницата е заета */ } finally {
        busy = false
      }
    }
    if (!stopped) setTimeout(() => { void tick() }, 350)
  }
  void tick()
  return () => { stopped = true }
}

function generations(voiceTableId: string): Array<{ generation: number; retire_reason: string | null; status: string; livekit_room_name: string }> {
  return h.db.prepare('SELECT generation, retire_reason, status, livekit_room_name FROM voice_room_generations WHERE voice_table_id = ? ORDER BY generation').all(voiceTableId) as never
}

/** Директно влизане в LiveKit със стар токен (официален livekit-client, без контролера). */
async function probeToken(token: string, url: string): Promise<{ joined: boolean; error: string | null; audioTracks: number; packets: number }> {
  const probeBrowser = await chromium.launch({ headless: true })
  try {
    const page = await probeBrowser.newPage()
    await page.goto(`${h.appOrigin}/scripts/fixtures/liveKitTokenProbe.html`)
    await page.waitForFunction(() => (window as unknown as { __liveKitProbe?: unknown }).__liveKitProbe !== undefined, undefined, { timeout: 20_000 })
    return await page.evaluate(([u, t]) => (window as any).__liveKitProbe.join(u, t, 3_000), [url, token] as const)
  } finally {
    await probeBrowser.close()
  }
}

const parties: Party[] = []
try {
  const profiles = [await register('lka'), await register('lkb'), await register('lkc'), await register('lkd')]
  const vipUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  for (const p of profiles) {
    h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(p.profileId)
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(p.profileId, vipUntil)
  }
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), profiles[0]!.profileId, new Date().toISOString())

  const A = await openParty('A', profiles[0]!, TONES[0], DESKTOP)
  const B = await openParty('B', profiles[1]!, TONES[1], MOBILE)
  const C = await openParty('C', profiles[2]!, TONES[2], DESKTOP)
  const D = await openParty('D', profiles[3]!, TONES[3], MOBILE)
  parties.push(A, B, C, D)

  // Гласова маса (ръчен старт); всички с микрофон.
  await A.page.locator(LOBBY_READY).first().click()
  await A.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = A.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  await A.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await A.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await A.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const room = [...A.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room
  const privateRoomId = room.id as string
  const voiceTableId = room.voiceTableId as string
  const aTeam = room.slots.find((s: any) => s.occupant?.profileId === A.profile.profileId)?.team === 'B' ? 'B' : 'A'
  const other = aTeam === 'A' ? 'B' : 'A'
  await A.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  for (const [party, team] of [[B, other], [C, other], [D, aTeam]] as const) {
    await party.page.locator(LOBBY_READY).first().click()
    const plus = party.page.locator(`[data-private-room-list-slot-join^="${privateRoomId}:${team}:"]`).first()
    await plus.waitFor({ state: 'visible', timeout: 15_000 })
    await plus.click()
    await party.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
    await party.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
    await party.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  }

  await check('[E1] Чакалня: всеки от четиримата чува тримата останали (реален аудиопоток)', async () => {
    try {
      const ms = await waitMutualAudio(parties, 60_000)
      console.log(`    взаимно чуване след ${ms} ms`)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} :: ${await describeAudio(parties)}`)
    }
  })

  // ─── [E2] чакалня -> игра ─────────────────────────────────────────────
  for (const p of parties) await resetGaps(p)
  const generationsBeforeStart = generations(voiceTableId).length
  await A.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
  const startFrom = A.received.length
  await A.page.locator('[data-private-room-manual-start="1"]').click()
  const gameRoomId = await waitUntil('игра', () => A.received.slice(startFrom).find((f) => f.type === 'private_room_full')?.data.roomId as string | undefined, 20_000)
  await sleep(8_000)
  await check('[E2] Чакалня -> игра: всички продължават да се чуват, най-дългата пауза ≤ 2 s, без ротация', async () => {
    const problems: string[] = []
    let worst = 0
    for (const listener of parties) {
      const report = (await audioReport(listener))!
      for (const speaker of parties.filter((p) => p !== listener)) {
        const entry = report[String(speaker.tone)]!
        worst = Math.max(worst, entry.maxGapMs)
        if (entry.agoMs === null || entry.agoMs > 1_500 || entry.maxGapMs > 2_000) problems.push(`${listener.label}<-${speaker.label} ${JSON.stringify(entry)}`)
      }
    }
    console.log(`    най-дълга пауза между двама участници: ${worst} ms`)
    assert(problems.length === 0, `прекъсвания: ${problems.join('; ')}`)
    assert(generations(voiceTableId).length === generationsBeforeStart, `ротация при старта: ${JSON.stringify(generations(voiceTableId))}`)
  })

  // ─── [E3] игра -> край -> преиграване ─────────────────────────────────
  const stops = parties.map((p) => startAutopilot(p, gameRoomId, p === A))
  await waitUntil('край на мача', () => lastSnapshot(A, gameRoomId)?.roomStatus === 'finished' || lastSnapshot(A, gameRoomId)?.game?.matchEnded != null, 240_000, 500)
  for (const stop of stops) stop()
  await sleep(2_000)
  for (const p of parties) await resetGaps(p)
  const replayFrom = A.received.length
  for (const p of parties) await p.page.locator('[data-match-ended-replay-button="1"]').first().click({ timeout: 15_000 }).catch(() => undefined)
  await waitUntil('преиграване', () => A.received.slice(replayFrom).some((f) => f.type === 'room_snapshot' && f.data.roomId === gameRoomId && f.data.roomStatus !== 'finished' && f.data.game?.matchEnded == null), 40_000)
  await sleep(5_000)
  await check('[E3] Игра -> край -> преиграване: всички се чуват, пауза ≤ 2 s, без ротация', async () => {
    const problems: string[] = []
    let worst = 0
    for (const listener of parties) {
      const report = (await audioReport(listener))!
      for (const speaker of parties.filter((p) => p !== listener)) {
        const entry = report[String(speaker.tone)]!
        worst = Math.max(worst, entry.maxGapMs)
        if (entry.agoMs === null || entry.agoMs > 1_500 || entry.maxGapMs > 2_000) problems.push(`${listener.label}<-${speaker.label} ${JSON.stringify(entry)}`)
      }
    }
    console.log(`    най-дълга пауза между двама участници: ${worst} ms`)
    assert(problems.length === 0, `прекъсвания: ${problems.join('; ')}`)
    assert(generations(voiceTableId).length === generationsBeforeStart, `ротация: ${JSON.stringify(generations(voiceTableId))}`)
  })

  // ─── [E4] презареждане на D (ротацията при изместване е запазена) ─────
  const dOldToken = [...D.tokens].reverse().find((t) => t.token !== null)!
  for (const p of parties) await resetGaps(p)
  const reloadAt = Date.now()
  await D.page.reload()
  // След презареждане по време на игра: изричен избор „Върни ме в играта“ (съществуващо поведение).
  await D.page.locator('[data-session-rejoin="1"]').first().click({ timeout: 30_000 }).catch(() => undefined)
  await waitUntil('гласов контекст на D след връщането', () => D.page.evaluate(`(() => { const v = window.__pikaVoice; const s = v ? v.getSnapshot() : null; return !!s && s.voiceTableId !== null && s.status === 'idle' })()`), 30_000)
  const rejoinAt = Date.now()
  // Етап Б: гласът след презареждане се включва изрично (автоматичното връщане е етап В).
  await D.page.evaluate(`window.__pikaVoice.joinWithMicrophone()`)
  await check('[E4] Презареждане на участник: ротация session_displaced (запазена); останалите отново се чуват автоматично; D се връща с изрично включване; старият токен на D не дава достъп', async () => {
    try {
      // Ротацията (session_replaced) започва, когато новата страница на D включи гласа.
      await sleep(300)
      await waitMutualAudio([A, B, C], 30_000, 400)
      console.log(`    A, B и C отново се чуват ${Date.now() - rejoinAt} ms след включването на D (ротацията); ${Date.now() - reloadAt} ms след презареждането`)
      await waitMutualAudio(parties, 30_000)
      console.log(`    D отново е в разговора ${Date.now() - rejoinAt} ms след изричното включване`)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} :: ${await describeAudio(parties)}`)
    }
    const gens = generations(voiceTableId)
    assert(gens.some((g) => g.retire_reason === 'session_displaced'), `ротация session_displaced: ${JSON.stringify(gens)}`)
    const probe = await probeToken(dOldToken.token!, dOldToken.url!)
    assert(!probe.joined || probe.packets === 0, `старият токен дава достъп: ${JSON.stringify(probe)}`)
    console.log(`    стар токен на D: ${JSON.stringify(probe)}`)
  })

  // ─── [E5] край на мача, C и D напускат ────────────────────────────────
  const stops2 = parties.map((p) => startAutopilot(p, gameRoomId, p === A))
  await waitUntil('край на втория мач', () => {
    const snap = lastSnapshot(A, gameRoomId)
    return snap !== null && (snap.roomStatus === 'finished' || snap.game?.matchEnded != null) && A.received.slice(replayFrom).some((f) => f.type === 'room_snapshot' && f.data.game?.matchEnded != null)
  }, 240_000, 500)
  for (const stop of stops2) stop()
  await sleep(1_500)
  const leaversTokens = [C, D].map((p) => [...p.tokens].reverse().find((t) => t.token !== null)!)
  const gensBeforeLeave = generations(voiceTableId).length
  for (const p of [A, B]) await resetGaps(p)
  const leaveAt = Date.now()
  C.inject({ type: 'leave_active_room', roomId: gameRoomId, acceptPenalty: true })
  await sleep(900)
  D.inject({ type: 'leave_active_room', roomId: gameRoomId, acceptPenalty: true })
  await check('[E5] Край на мача, двама напускат в рамките на 1 s: ЕДНА ротация; A и B отново се чуват сами след прозореца; старите токени на напусналите не дават достъп', async () => {
    try {
      // Първо прекъсването (старата стая е изтрита), после възстановяването.
      await waitUntil('прекъсване при ротацията', async () => {
        const report = await audioReport(A)
        const entry = report?.[String(B.tone)]
        return entry !== undefined && entry.agoMs !== null && entry.agoMs > 1_000
      }, 10_000, 100)
      await waitMutualAudio([A, B], 30_000, 400)
      const gapAB = (await audioReport(A))![String(B.tone)]!.maxGapMs
      const gapBA = (await audioReport(B))![String(A.tone)]!.maxGapMs
      console.log(`    A и B отново се чуват ${Date.now() - leaveAt} ms след първото напускане; най-дълга пауза A<-B ${gapAB} ms, B<-A ${gapBA} ms`)
      const aTokens = A.tokens.filter((t) => t.at >= leaveAt)
      const firstOk = aTokens.find((t) => t.status === 200)
      console.log(`    токени на A след напускането: ${aTokens.map((t) => `${t.status}@${t.at - leaveAt}ms`).join(', ')}`)
      assert(aTokens.some((t) => t.status === 503), 'прозорец: отказ voice_rotation_pending по време на прозореца')
      assert(firstOk !== undefined && firstOk.at - leaveAt >= 1_800, `прозорец: първият нов токен е твърде рано (${firstOk === undefined ? 'няма' : firstOk.at - leaveAt} ms)`)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} :: ${await describeAudio([A, B])}`)
    }
    const added = generations(voiceTableId).slice(gensBeforeLeave)
    assert(added.length === 1, `нови генерации: ${JSON.stringify(generations(voiceTableId))}`)
    for (const old of leaversTokens) {
      const probe = await probeToken(old.token!, old.url!)
      assert(!probe.joined || probe.packets === 0, `стар токен дава достъп: ${JSON.stringify(probe)}`)
      console.log(`    стар токен на напуснал: ${JSON.stringify(probe)}`)
    }
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  await check('без неочаквани грешки', () => { throw error })
  console.error(lkLog.join('').slice(-2500))
} finally {
  for (const p of parties) await p.browser.close().catch(() => undefined)
  await h.close()
  liveKit.kill()
  await sleep(500)
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

finishAndExit()
