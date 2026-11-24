/**
 * Свара — измерване на плавността на истинската маса срещу тестови ботове.
 * Изолиран компилиран backend + Chromium.
 *
 *   --skip-build        без tsc/vite build
 *   --throttle=4        CPU забавяне (симулация на телефон), по подразбиране 1
 *   --seconds=40        продължителност на измерването на масата
 *   --out=FILE          JSON отчет
 *   --screenshots=DIR   снимки по време на раздаване/игра
 *   --reduced-motion    prefers-reduced-motion: reduce (анимациите на Свара остават вкл.)
 *   --only=desktop|portrait|landscape
 *
 * Метрики: rAF интервали (средно FPS, p95, кадри > 25 ms), изтрити DOM
 * възли/сек (пълно преизграждане), брой Animation обекти, дублирани спрайтове.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Page } from 'playwright'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend, startSvaraGateway, waitForHarnessCondition as wait } from './svaraRealIntegrationHarness'
import { decideSvaraTestBotCommand, svaraTestBotHasDecision } from '../server/src/games/svara/testBots/svaraTestBotStrategy'
import type { SvaraMatchSnapshotMessage } from '../server/src/games/svara/protocol/svaraSnapshotProtocol'

const root = process.cwd(), host = 'svara-integration.localhost'
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const throttle = Number(arg('throttle') ?? 1)
const seconds = Number(arg('seconds') ?? 40)
const out = arg('out')
const screenshotDir = arg('screenshots')
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

if (!process.argv.includes('--skip-build')) {
  await runNode(root, ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json'])
  await runNode(root, ['node_modules/vite/bin/vite.js', 'build'])
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 860 },
  { name: 'portrait', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const

// Движещи се елементи: старият dealing overlay (img, пресъздаван при tick) и
// новият слой за движение (постоянни спрайтове). За всеки кадър с поне един
// такъв елемент проверяваме дали позицията му реално се е сменила — така се
// вижда истинската честота на движение, а не само честотата на rAF.
const PAGE_METER = `
  globalThis.__svaraMeter = { frames: [], removed: 0, started: false, motionFrames: 0, motionChanged: 0, longTasks: 0, longTaskMs: 0 };
  (() => {
    const m = globalThis.__svaraMeter; let last = 0; let lastKey = '';
    const loop = (t) => {
      if (m.started && last) {
        m.frames.push(t - last);
        const moving = document.querySelectorAll('[data-svara-sprite][data-moving="1"]');
        if (moving.length) {
          m.motionFrames += 1;
          let key = '';
          for (const el of moving) { const r = el.getBoundingClientRect(); key += Math.round(r.left * 4) + ',' + Math.round(r.top * 4) + ';' }
          if (key !== lastKey) m.motionChanged += 1;
          lastKey = key;
        } else lastKey = '';
      }
      last = t; requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new MutationObserver((records) => { if (!m.started) return; for (const r of records) m.removed += r.removedNodes.length })
      .observe(document, { subtree: true, childList: true });
    try { new PerformanceObserver((list) => { if (!m.started) return; for (const e of list.getEntries()) { m.longTasks += 1; m.longTaskMs += e.duration } }).observe({ entryTypes: ['longtask'] }) } catch {}
  })();
`

async function readMeter(page: Page, durationMs: number) {
  return page.evaluate((ms) => {
    const m = (globalThis as unknown as { __svaraMeter: { frames: number[]; removed: number; motionFrames: number; motionChanged: number; longTasks: number; longTaskMs: number } }).__svaraMeter
    const frames = [...m.frames].sort((a, b) => a - b)
    const total = m.frames.reduce((s, f) => s + f, 0)
    const animations = document.getAnimations().length
    const avgFps = total > 0 ? 1000 * m.frames.length / total : 0
    return {
      frames: m.frames.length,
      avgFps: +avgFps.toFixed(1),
      p95FrameMs: +(frames[Math.floor(frames.length * 0.95)] ?? 0).toFixed(1),
      maxFrameMs: +(frames[frames.length - 1] ?? 0).toFixed(1),
      longFrames: m.frames.filter((f) => f > 25).length,
      /** Реална честота на движение на летящите елементи (Hz) — 60 = всеки кадър. */
      motionHz: m.motionFrames > 0 ? +(avgFps * m.motionChanged / m.motionFrames).toFixed(1) : null,
      motionFrames: m.motionFrames,
      removedNodesPerSec: +(m.removed / (ms / 1000)).toFixed(1),
      longTasks: m.longTasks,
      longTaskMs: Math.round(m.longTaskMs),
      liveAnimations: animations,
    }
  }, durationMs)
}

async function resetMeter(page: Page) {
  await page.evaluate(() => { const m = (globalThis as unknown as { __svaraMeter: { frames: number[]; removed: number; started: boolean; motionFrames: number; motionChanged: number; longTasks: number; longTaskMs: number } }).__svaraMeter; m.frames = []; m.removed = 0; m.motionFrames = 0; m.motionChanged = 0; m.longTasks = 0; m.longTaskMs = 0; m.started = true })
}

const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server'] })
const isolated = await createIsolatedSvaraRoot(root)
let backend: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | undefined
let gateway: Awaited<ReturnType<typeof startSvaraGateway>> | undefined
const reducedMotion = process.argv.includes('--reduced-motion')
const report: Record<string, unknown> = { throttle, seconds, reducedMotion, results: {} }

const db = <T>(fn: (value: DatabaseSync) => T) => { const d = new DatabaseSync(isolated.dbFile); try { return fn(d) } finally { d.close() } }

try {
  backend = await startIsolatedSvaraBackend(isolated, { extraEnv: { SVARA_TEST_BOTS_ENABLED: '1' } })
  gateway = await startSvaraGateway(join(root, 'dist'), () => backend?.port ?? null)
  const origin = `http://${host}:${gateway.port}`
  db((d) => d.prepare("UPDATE admin_settings SET setting_value='direct' WHERE setting_key='registration_verification_mode'").run())

  for (const viewport of VIEWPORTS.filter((v) => !arg("only") || v.name === arg("only"))) {
    for (const capacity of [2, 4] as const) {
      const email = `svara-measure-${randomUUID()}@example.test`
      const response = await fetch(`http://127.0.0.1:${backend.port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'SvaraMeasure1!', displayName: `SM${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() }) })
      assert.equal(response.status, 200)
      const body = await response.json() as { session: { profile: { profileId: string } } }
      const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!, id = body.session.profile.profileId
      db((d) => d.prepare("UPDATE accounts SET role='admin' WHERE email=?").run(email))
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.name !== 'desktop', hasTouch: viewport.name !== 'desktop', reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
      const separator = cookie.indexOf('=')
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }])
      await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      await context.addInitScript(`globalThis.__name = (t) => t; globalThis.__svaraSockets = []; const N = WebSocket;
        globalThis.WebSocket = new Proxy(N, { construct(t, a) { const s = new t(...a); globalThis.__svaraSockets.push(s); return s } }); ${PAGE_METER}`)
      const page = await context.newPage()
      const frames: Record<string, any>[] = []
      const faults: string[] = []
      page.on('pageerror', (e) => faults.push(e.message))
      page.on('websocket', (s) => s.on('framereceived', ({ payload }) => { try { frames.push(JSON.parse(String(payload))) } catch { /* ignore */ } }))
      const cdp = await context.newCDPSession(page)
      if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
      await page.goto(`${origin}/games/svara`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-svara-lobby="1"]')
      await page.getByText('Приеми всички').click({ timeout: 1500 }).catch(() => {})

      const offset = frames.length
      await page.click('[data-svara-create-open]')
      await page.selectOption('[data-svara-create-form] select[name="capacity"]', String(capacity))
      await page.check('[data-svara-create-form] input[name="startMode"][value="auto"]')
      await page.click('[data-svara-create-form] button[type="submit"]')
      await wait('table', () => frames.slice(offset).some((f) => f.type === 'svara_table_updated'), 5_000)
      const matchId = frames.slice(offset).findLast((f) => f.type === 'svara_table_updated')!.table.matchId as string
      await page.click('[data-svara-table-fill-bots]')
      await wait('started', () => frames.some((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId && f.phase === 'in-progress'), 10_000)
      await resetMeter(page)
      let a = capacity * 7919
      const random = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648 }
      const sent = new Set<number>()
      const started = Date.now()
      let shots = 0
      while (Date.now() - started < seconds * 1000) {
        const snapshot = frames.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) as SvaraMatchSnapshotMessage | undefined
        if (snapshot?.phase !== 'in-progress') { console.log("  stop: phase", snapshot?.phase, "snapshots", frames.filter((f) => f.type === "svara_match_snapshot").length); break }
        if (screenshotDir && shots < 3 && snapshot.round && 'dealing' in snapshot.round && snapshot.round.dealing) {
          await pause(1_400 + shots * 900)
          await page.screenshot({ path: join(screenshotDir, `measure-${viewport.name}-${capacity}-${shots++}.png`) })
        }
        if (snapshot && svaraTestBotHasDecision(snapshot) && !sent.has(snapshot.revision)) {
          const command = decideSvaraTestBotCommand(snapshot, random)
          // Не напускаме по време на измерването; „бягам“ само понякога.
          if (command && command.type !== 'exit') {
            sent.add(snapshot.revision)
            await page.evaluate((payload) => {
              const s = (globalThis as unknown as { __svaraSockets: WebSocket[] }).__svaraSockets.findLast((x) => x.readyState === 1 && x.url.endsWith('/ws'))
              s?.send(JSON.stringify(payload))
            }, { type: 'submit_svara_command', matchId, commandId: randomUUID(), expectedRevision: snapshot.revision, command })
          }
        }
        await pause(250)
      }
      const elapsed = Date.now() - started
      const metrics = await readMeter(page, elapsed)
      ;(report.results as Record<string, unknown>)[`${viewport.name}/${capacity}p`] = { ...metrics, measuredMs: elapsed, faults }
      console.log(`${viewport.name} ${capacity}p:`, JSON.stringify(metrics))
      await page.click('[data-svara-table-leave]').catch(() => {})
      await page.click('[data-svara-exit-confirm]', { timeout: 2_000 }).catch(() => {})
      await pause(500)
      await context.close()
    }
  }
  if (out) await writeFile(out, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report.results, null, 1))
} finally {
  await browser.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await backend?.stop().catch(() => {})
  await isolated.cleanup().catch(() => {})
}
