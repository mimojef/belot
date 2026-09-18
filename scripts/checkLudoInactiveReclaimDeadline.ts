import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const freePort = () => new Promise<number>((done, fail) => {
  const server = createNetServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return fail(new Error('No free port'))
    server.close(() => done(address.port))
  })
})
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 30_000): Promise<void> {
  const expires = Date.now() + timeout
  while (Date.now() < expires) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timeout: ${label}`)
}
async function register(port: number, name: string) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `ludo-deadline-${name}-${Date.now()}@example.test`, password: 'LudoDeadline1!', displayName: `LD ${name}`, gender: 'male' }),
  })
  const body: any = await response.json()
  assert(response.ok, `Registration failed: ${JSON.stringify(body)}`)
  const cookie = (response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
  assert(cookie, 'Missing session cookie')
  return { profileId: body.session.profile.profileId as string, cookie: cookie.split('=')[1]! }
}

const projectRoot = process.cwd()
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-ludo-deadline-'))
const serverDir = join(tempRoot, 'server')
let child: ChildProcessWithoutNullStreams | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null
try {
  await mkdir(serverDir, { recursive: true })
  await cp(resolve(projectRoot, 'server/src'), join(serverDir, 'src'), { recursive: true })
  await cp(resolve(projectRoot, 'server/dist'), join(serverDir, 'dist'), { recursive: true })
  await cp(resolve(projectRoot, 'server/database/migrations'), join(serverDir, 'database/migrations'), { recursive: true })
  await cp(resolve(projectRoot, 'server/package.json'), join(serverDir, 'package.json'))
  await mkdir(join(serverDir, 'database/data'), { recursive: true })
  await symlink(resolve(projectRoot, 'server/node_modules'), join(serverDir, 'node_modules'), 'junction')
  await symlink(resolve(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction')

  const backendPort = await freePort()
  child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env: { ...process.env, PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitFor(() => fetch(`http://127.0.0.1:${backendPort}/health`).then((response) => response.ok).catch(() => false), 'backend')
  const vitePort = await freePort()
  vite = await createViteServer({ root: projectRoot, server: { host: '127.0.0.1', port: vitePort, strictPort: true }, logLevel: 'error' })
  await vite.listen()
  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const wsUrl = `ws://127.0.0.1:${backendPort}/ws`
  const fixtureUrl = `http://127.0.0.1:${vitePort}/scripts/fixtures/privateRoomRealWsHarness.html`

  async function open(profile: Awaited<ReturnType<typeof register>>, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const page = await context.newPage()
    await page.goto(fixtureUrl)
    await page.evaluate(({ profileId, wsUrl }) => {
      const harness = (window as any).__diagHarness
      harness.setLocalProfile(profileId, profileId)
      return harness.connect(wsUrl)
    }, { profileId: profile.profileId, wsUrl })
    return { context, page }
  }
  const frames = (page: Page, type: string) => page.evaluate((kind) => (window as any).__diagHarness.getReceivedFrames().filter((frame: any) => frame.type === kind), type)

  const activeProfile = await register(backendPort, 'Active')
  const inactiveProfile = await register(backendPort, 'Inactive')
  const active = await open(activeProfile, { width: 390, height: 844 })
  let inactive = await open(inactiveProfile, { width: 1280, height: 850 })

  await active.page.evaluate(() => (window as any).__diagHarness.send({ type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: false }))
  await active.page.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((frame: any) => frame.type === 'ludo_room_updated'))
  const roomId = await active.page.evaluate(() => (window as any).__diagHarness.getReceivedFrames().find((frame: any) => frame.type === 'ludo_room_updated').room.id)
  await inactive.page.evaluate((id) => (window as any).__diagHarness.send({ type: 'join_ludo_room', ludoRoomId: id }), roomId)
  await Promise.all([active.page, inactive.page].map((page) => page.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((frame: any) => frame.type === 'ludo_game_started'))))

  const started = (await frames(active.page, 'ludo_game_started')).at(-1).snapshot
  const inactiveColor = started.players.find((player: any) => player.profileId === inactiveProfile.profileId).color
  assert(started.state.activeColor !== inactiveColor, 'test setup requires inactive reclaiming color')
  await inactive.context.close()
  await active.page.waitForFunction((color) => {
    const states = (window as any).__diagHarness.getReceivedFrames().filter((frame: any) => frame.type === 'ludo_game_state')
    return states.some((frame: any) => frame.snapshot.botControlledColors.includes(color))
  }, inactiveColor)

  inactive = await open(inactiveProfile, { width: 1280, height: 850 })
  await inactive.page.evaluate(() => (window as any).__diagHarness.send({ type: 'ludo_game_state_request' }))
  await inactive.page.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((frame: any) => frame.type === 'ludo_game_state'))
  await sleep(2_000)
  const before = (await frames(inactive.page, 'ludo_game_state')).at(-1).snapshot
  const clientRemainingBefore = before.deadlineAt - before.serverNow - 2_000
  await inactive.page.evaluate(({ matchId, revision }) => (window as any).__diagHarness.send({ type: 'ludo_reclaim_request', matchId, expectedRevision: revision }), { matchId: before.matchId, revision: before.revision })
  await inactive.page.waitForFunction((revision) => {
    const states = (window as any).__diagHarness.getReceivedFrames().filter((frame: any) => frame.type === 'ludo_game_state')
    return states.some((frame: any) => frame.snapshot.revision > revision && frame.snapshot.botControlledColors.length === 0)
  }, before.revision)
  const after = (await frames(inactive.page, 'ludo_game_state')).at(-1).snapshot
  const clientRemainingAfter = after.deadlineAt - after.serverNow

  assert(after.state.activeColor === before.state.activeColor, 'active color changed on inactive reclaim')
  assert(after.state.turnPhase === before.state.turnPhase, 'phase changed on inactive reclaim')
  assert(after.deadlineAt === before.deadlineAt, `deadline changed: ${before.deadlineAt} -> ${after.deadlineAt}`)
  assert(Math.abs(clientRemainingAfter - clientRemainingBefore) < 350, `client countdown reset: ${clientRemainingBefore} -> ${clientRemainingAfter}`)

  const actionEventsBefore = (await frames(active.page, 'ludo_game_state')).filter((frame: any) => frame.snapshot.events.some((event: any) => event.type === 'dice_accepted')).length
  const waitMs = Math.max(0, after.deadlineAt - after.serverNow) + 350
  await sleep(waitMs)
  const actionEventsAtDeadline = (await frames(active.page, 'ludo_game_state')).filter((frame: any) => frame.snapshot.events.some((event: any) => event.type === 'dice_accepted')).length
  assert(actionEventsAtDeadline === actionEventsBefore + 1, `expected one action at original deadline, got ${actionEventsAtDeadline - actionEventsBefore}`)
  await sleep(900)
  const actionEventsAfter = (await frames(active.page, 'ludo_game_state')).filter((frame: any) => frame.snapshot.events.some((event: any) => event.type === 'dice_accepted')).length
  assert(actionEventsAfter === actionEventsAtDeadline, 'duplicate deadline callback produced another roll')

  console.log(`PASS inactive reclaim deadline: ${JSON.stringify({
    activeColor: before.state.activeColor,
    phase: before.state.turnPhase,
    revisionBefore: before.revision,
    revisionAfter: after.revision,
    deadlineBefore: before.deadlineAt,
    deadlineAfter: after.deadlineAt,
    clientRemainingBefore,
    clientRemainingAfter,
  })}`)
  await active.context.close()
  await inactive.context.close()
} finally {
  await browser.close()
  if (vite) await vite.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise((done) => child!.once('exit', done)), sleep(3_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
}
