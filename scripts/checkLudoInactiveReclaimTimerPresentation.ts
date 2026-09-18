import { createServer as createNetServer } from 'node:net'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createLudoAuthoritativeInitialState } from '../server/src/game/ludoEngine/ludoEngineState.js'

const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('No free port'))
    server.close(() => resolve(address.port))
  })
})

type Metrics = { now: number; remaining: number; scale: number | null; dashOffset: number | null }
const state = createLudoAuthoritativeInitialState(['red', 'blue'])
const base = {
  matchId: 'match-1', ludoRoomId: 'room-1', stake: 100,
  players: [
    { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
    { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
  ],
  state, winnerProfileId: null,
}

const port = await freePort()
const vite = await createViteServer({ server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  async function run(viewport: { width: number; height: number }): Promise<{ before: Metrics; after: Metrics; updates: Metrics[] }> {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/ludoAuthoritativeHarness.html?color=red`)
    await page.waitForFunction(() => Boolean((window as any).__ludoAuthHarness))
    const startedAt = Date.now()
    const deadlineAt = startedAt + 10_000
    const apply = (revision: number, botControlledColors: string[], eventType: 'bot_takeover_started' | 'human_control_resumed') => page.evaluate((snapshot) => {
      (window as any).__ludoAuthHarness.apply(snapshot)
    }, {
      ...base, revision, serverNow: Date.now(), deadlineAt,
      events: [{ type: eventType, color: 'blue' }], botControlledColors,
    })
    const metrics = () => page.evaluate(({ deadlineAt }) => {
      const fill = document.querySelector<HTMLElement>('[data-ludo-seat-countdown-fill="red"]')
      const ring = document.querySelector<SVGPathElement>('[data-ludo-seat-countdown-ring="red"] path')
      let scale: number | null = null
      if (fill) {
        const transform = getComputedStyle(fill).transform
        const match = transform.match(/^matrix\(([^,]+)/)
        scale = match ? Number(match[1]) : transform === 'none' ? 1 : null
      }
      const dashText = ring ? getComputedStyle(ring).strokeDashoffset : ''
      const dashOffset = dashText ? Number.parseFloat(dashText) : null
      return { now: Date.now(), remaining: deadlineAt - Date.now(), scale, dashOffset }
    }, { deadlineAt })

    await apply(1, ['blue'], 'bot_takeover_started')
    await page.waitForTimeout(4_000)
    const before = await metrics()
    await apply(2, [], 'human_control_resumed')
    await page.waitForTimeout(50)
    const after = await metrics()
    const updates: Metrics[] = []
    for (let revision = 3; revision <= 5; revision++) {
      await apply(revision, revision % 2 ? ['blue'] : [], revision % 2 ? 'bot_takeover_started' : 'human_control_resumed')
      await page.waitForTimeout(120)
      updates.push(await metrics())
    }
    await page.close()
    return { before, after, updates }
  }

  const desktop = await run({ width: 1280, height: 850 })
  const mobile = await run({ width: 390, height: 844 })
  assert(desktop.before.scale !== null && desktop.after.scale !== null, 'desktop fill metrics missing')
  assert(Math.abs(desktop.before.scale - desktop.after.scale) < 0.035, `desktop timer jumped: ${desktop.before.scale} -> ${desktop.after.scale}`)
  assert(desktop.updates.every((item, index, list) => index === 0 || (list[index - 1]!.scale ?? 0) >= (item.scale ?? 1)), 'desktop timer moved backwards')
  assert(mobile.before.dashOffset !== null && mobile.after.dashOffset !== null, 'mobile ring metrics missing')
  assert(Math.abs(mobile.before.dashOffset - mobile.after.dashOffset) < 3.5, `mobile timer jumped: ${mobile.before.dashOffset} -> ${mobile.after.dashOffset}`)
  assert(mobile.updates.every((item, index, list) => index === 0 || (list[index - 1]!.dashOffset ?? 100) <= (item.dashOffset ?? 0)), 'mobile timer moved backwards')
  assert(Math.abs(desktop.before.remaining - desktop.after.remaining) < 250, 'desktop remaining time reset')
  assert(Math.abs(mobile.before.remaining - mobile.after.remaining) < 250, 'mobile remaining time reset')
  console.log(`PASS inactive reclaim timer presentation: ${JSON.stringify({ desktop, mobile })}`)
} finally {
  await browser.close()
  await vite.close()
}
