/**
 * checkCampaignRewardCongratulationsWireUp.ts
 *
 * ФАЗА 9 — Real spawned-server, real WebSocket + real HTTP integration test
 * за durable "поздравление за действително предоставени кампанийни награди"
 * delivery/acknowledge пътя: WS bootstrap flush на connect/reconnect
 * (index.ts's connection handler, 'pending_campaign_reward_notifications')
 * + HTTP POST /api/campaign-reward-notifications/:id/ack
 * (handleCampaignRewardNotificationAckRequest). Mirror на
 * checkCampaignMatchCreditWebSocketAuthorization.ts's isolated-server-copy
 * pattern — directно адресира §9 от задачата ("Във Фаза 7 беше открит
 * пропуснат parser case... не допускай аналогичен проблем") чрез реален
 * end-to-end round-trip, не само изолирани store unit тестове.
 *
 * Campaign_reward_notifications редове се seed-ват ДИРЕКТНО (не през
 * реален изигран мач/покупка) — bootstrap/ack handler-ите са чисто
 * read/write върху вече-записани редове, затова "как се е появил редът" е
 * ирелевантно за тая конкретна delivery/ack wiring проверка (realtime push
 * callback wiring самата вече е покрита в
 * checkCampaignRewardCongratulationsStore.ts's [N7]-[N10]).
 *
 * Сървър 1 — CAMPAIGNS_FEATURE_ENABLED=1:
 *   [W1] Connect с pending ред -> bootstrap flush доставя коректен frame.
 *   [W2] Няколко pending reda, различни кампании -> всички доставени в
 *        ЕДНА push, всеки с коректен campaignId/payload.
 *   [W3] Reconnect ПРЕДИ ack -> редът се доставя ПАК (durable, не
 *        "consumed by read").
 *   [W4] POST ack -> 200; следващ connect/reconnect вече НЕ го доставя.
 *   [W5] POST ack от друг профил (опит за чуждо известие) -> 404, без
 *        промяна на статуса; оригиналният owner продължава да го получава.
 *   [W6] POST ack без автентикация -> 401.
 *   [W7] POST ack на несъществуващ notificationId -> 404.
 *   [W8] Повторен ack на СЪЩИЯ вече потвърден ред -> пак 200 (идемпотентно).
 *   [W9] Профил без никакви pending известия -> connect без
 *        'pending_campaign_reward_notifications' frame, без грешка.
 *
 * Сървър 2 — CAMPAIGNS_FEATURE_ENABLED off:
 *   [W10] Pending ред съществува в DB, но connect -> НИКАКЪВ push frame
 *         (campaignCreditStore===null, guard-нато без DB заявка).
 *   [W11] POST ack -> 200 graceful no-op (не 500), без database промяна.
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

const SESSION_COOKIE_NAME = 'belot_session'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      const p = addr.port
      srv.close(() => resolveFree(p))
    })
  })
}

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-congrats-wireup-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams }

function startServer(serverDir: string, port: number, campaignsEnabled: boolean): RunningServer {
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port) }
  if (campaignsEnabled) env.CAMPAIGNS_FEATURE_ENABLED = '1'
  else delete env.CAMPAIGNS_FEATURE_ENABLED
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return { child }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type SeededUser = { cookie: string; profileId: string; accountId: string; tag: string }

function seedUser(databaseFile: string, tag: string): SeededUser {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `CongratsWire ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', 'player', 'active');`)
      .run(accountId, `campaign-congrats-wireup-${tag}-${runId}@example.test`)
    db.prepare(`
      INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title,
        skill_rating, gender, status
      ) VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 1, 'Rank 1', 1000, 'male', 'active');
    `).run(profileId, accountId, displayName, normalized, displayName, normalized)
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000);`).run(profileId)
    db.prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 0, 0, 1);`).run(profileId)
    db.prepare(`INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?);`)
      .run(randomUUID(), accountId, profileId, hashSessionToken(token), new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch { /* keep original */ }
    throw error
  } finally {
    db.close()
  }
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, accountId, tag }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function seedPendingNotification(
  databaseFile: string,
  opts: { profileId: string; campaignName?: string; unitsTotal?: number },
): { notificationId: string; campaignId: string } {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const campaignId = randomUUID()
  const notificationId = randomUUID()
  db.prepare(`
    INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural)
    VALUES (?, ?, 'finished', ?, ?, 'тиква', 'тикви');
  `).run(campaignId, opts.campaignName ?? `WireUp Test Campaign ${campaignId}`, hoursFromNow(-100), hoursFromNow(100))
  db.prepare(`
    INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, status, payload_json)
    VALUES (?, ?, ?, 'pending', ?);
  `).run(
    notificationId,
    campaignId,
    opts.profileId,
    JSON.stringify({
      campaignName: opts.campaignName ?? `WireUp Test Campaign ${campaignId}`,
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      unitsTotal: opts.unitsTotal ?? 500,
      rewards: [{ type: 'yellow_coins', amount: 50_000 }],
    }),
  )
  db.close()
  return { notificationId, campaignId }
}

function getNotificationStatus(databaseFile: string, notificationId: string): string | undefined {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    const row = db.prepare(`SELECT status FROM campaign_reward_notifications WHERE notification_id = ?;`).get(notificationId) as { status: string } | undefined
    return row?.status
  } finally {
    db.close()
  }
}

type TestClient = { user: SeededUser; ws: WebSocket; frames: any[]; label: string }

async function connectClient(port: number, user: SeededUser, label: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: user.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push({ ...JSON.parse(data.toString()), __receivedAt: Date.now() }) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { user, ws, frames, label }
}

async function waitForFrame(client: TestClient, predicate: (frame: any) => boolean, timeoutMs = 10_000, label = 'frame', fromIndex = 0): Promise<any> {
  await waitForCondition(`${client.label}: ${label}`, () => client.frames.slice(fromIndex).some(predicate), timeoutMs)
  return client.frames.slice(fromIndex).find(predicate)
}

async function closeClient(client: TestClient): Promise<void> {
  client.ws.close()
  await sleep(50)
}

async function postAck(port: number, cookie: string | null, notificationId: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/campaign-reward-notifications/${encodeURIComponent(notificationId)}/ack`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

console.log('\ncheckCampaignRewardCongratulationsWireUp\n')

const { serverDir, databaseFile, cleanup } = await createIsolatedServerRoot(sourceServerRoot)

// ═══════════════════════════════════════════════════════════════════════
// Сървър 1 — CAMPAIGNS_FEATURE_ENABLED=1
// ═══════════════════════════════════════════════════════════════════════
{
  const port = await findFreePort()
  const server = startServer(serverDir, port, true)
  try {
    await waitForServer(port)

    const userA = seedUser(databaseFile, 'A')
    const userB = seedUser(databaseFile, 'B')
    const userC = seedUser(databaseFile, 'C')

    await check('[W1] Connect с pending ред -> bootstrap flush доставя коректен frame', async () => {
      const { notificationId, campaignId } = seedPendingNotification(databaseFile, { profileId: userA.profileId, campaignName: 'Halloween Test', unitsTotal: 500 })
      const client = await connectClient(port, userA, 'A-W1')
      try {
        const frame = await waitForFrame(client, (f) => f.type === 'pending_campaign_reward_notifications', 10_000, 'bootstrap flush')
        const entry = frame.notifications.find((n: any) => n.notificationId === notificationId)
        assert(entry !== undefined, 'expected the seeded notification in the bootstrap flush')
        assert(entry.campaignId === campaignId, 'expected matching campaignId')
        assert(entry.payload.campaignName === 'Halloween Test', 'expected correct campaignName in payload')
        assert(entry.payload.rewards[0].type === 'yellow_coins' && entry.payload.rewards[0].amount === 50_000, 'expected correct reward in payload')
        await postAck(port, userA.cookie, notificationId) // cleanup for subsequent checks
      } finally {
        await closeClient(client)
      }
    })

    await check('[W2] Няколко pending reda, различни кампании -> всички доставени в ЕДНА push', async () => {
      const n1 = seedPendingNotification(databaseFile, { profileId: userB.profileId, campaignName: 'Campaign One' })
      const n2 = seedPendingNotification(databaseFile, { profileId: userB.profileId, campaignName: 'Campaign Two' })
      const client = await connectClient(port, userB, 'B-W2')
      try {
        const frame = await waitForFrame(client, (f) => f.type === 'pending_campaign_reward_notifications', 10_000, 'multi-campaign bootstrap flush')
        const ids = frame.notifications.map((n: any) => n.notificationId)
        assert(ids.includes(n1.notificationId) && ids.includes(n2.notificationId), 'expected both notifications in one push')
        const campaignIds = new Set(frame.notifications.map((n: any) => n.campaignId))
        assert(campaignIds.has(n1.campaignId) && campaignIds.has(n2.campaignId), 'expected both distinct campaignIds present, never merged server-side')
        await postAck(port, userB.cookie, n1.notificationId)
        await postAck(port, userB.cookie, n2.notificationId)
      } finally {
        await closeClient(client)
      }
    })

    await check('[W3] Reconnect ПРЕДИ ack -> редът се доставя ПАК (durable, не "consumed by read")', async () => {
      const { notificationId } = seedPendingNotification(databaseFile, { profileId: userA.profileId })
      const client1 = await connectClient(port, userA, 'A-W3-first')
      await waitForFrame(client1, (f) => f.type === 'pending_campaign_reward_notifications' && f.notifications.some((n: any) => n.notificationId === notificationId), 10_000, 'first delivery')
      await closeClient(client1)

      const client2 = await connectClient(port, userA, 'A-W3-reconnect')
      try {
        const frame = await waitForFrame(client2, (f) => f.type === 'pending_campaign_reward_notifications' && f.notifications.some((n: any) => n.notificationId === notificationId), 10_000, 'redelivery on reconnect')
        assert(frame.notifications.some((n: any) => n.notificationId === notificationId), 'expected redelivery на reconnect, без ack')
      } finally {
        await closeClient(client2)
        await postAck(port, userA.cookie, notificationId)
      }
    })

    await check('[W4] POST ack -> 200; следващ connect вече НЕ го доставя', async () => {
      const { notificationId } = seedPendingNotification(databaseFile, { profileId: userA.profileId })
      const ackResult = await postAck(port, userA.cookie, notificationId)
      assert(ackResult.status === 200 && ackResult.body.ok === true, `expected ok:true ack, got ${JSON.stringify(ackResult)}`)
      assert(getNotificationStatus(databaseFile, notificationId) === 'acknowledged', 'expected status=acknowledged in DB')

      const client = await connectClient(port, userA, 'A-W4-after-ack')
      try {
        await sleep(1000)
        const found = client.frames.some((f) => f.type === 'pending_campaign_reward_notifications' && f.notifications.some((n: any) => n.notificationId === notificationId))
        assert(!found, 'expected the acknowledged notification to NOT be redelivered')
      } finally {
        await closeClient(client)
      }
    })

    await check('[W5] POST ack от друг профил -> 404, без промяна; оригиналният owner продължава да го получава', async () => {
      const { notificationId } = seedPendingNotification(databaseFile, { profileId: userA.profileId })
      const foreignAck = await postAck(port, userC.cookie, notificationId)
      assert(foreignAck.status === 404, `expected 404 for foreign ack attempt, got ${foreignAck.status}`)
      assert(getNotificationStatus(databaseFile, notificationId) === 'pending', 'expected status to remain pending after a foreign ack attempt')

      const client = await connectClient(port, userA, 'A-W5-owner-still-gets-it')
      try {
        const frame = await waitForFrame(client, (f) => f.type === 'pending_campaign_reward_notifications' && f.notifications.some((n: any) => n.notificationId === notificationId), 10_000, 'owner still receives it')
        assert(frame.notifications.some((n: any) => n.notificationId === notificationId), 'expected the real owner to still receive the notification')
      } finally {
        await closeClient(client)
        await postAck(port, userA.cookie, notificationId)
      }
    })

    await check('[W6] POST ack без автентикация -> 401', async () => {
      const { notificationId } = seedPendingNotification(databaseFile, { profileId: userA.profileId })
      const result = await postAck(port, null, notificationId)
      assert(result.status === 401, `expected 401, got ${result.status}`)
      assert(getNotificationStatus(databaseFile, notificationId) === 'pending', 'expected status unchanged after unauthenticated attempt')
      await postAck(port, userA.cookie, notificationId)
    })

    await check('[W7] POST ack на несъществуващ notificationId -> 404', async () => {
      const result = await postAck(port, userA.cookie, `nonexistent-${randomUUID()}`)
      assert(result.status === 404, `expected 404, got ${result.status}`)
    })

    await check('[W8] Повторен ack на СЪЩИЯ вече потвърден ред -> пак 200 (идемпотентно)', async () => {
      const { notificationId } = seedPendingNotification(databaseFile, { profileId: userA.profileId })
      const first = await postAck(port, userA.cookie, notificationId)
      const second = await postAck(port, userA.cookie, notificationId)
      assert(first.status === 200 && second.status === 200, `expected both acks to return 200, got ${first.status}/${second.status}`)
    })

    await check('[W9] Профил без pending известия -> connect без push frame, без грешка', async () => {
      const freshUser = seedUser(databaseFile, 'NoPending')
      const client = await connectClient(port, freshUser, 'Fresh-W9')
      try {
        await sleep(1000)
        const found = client.frames.some((f) => f.type === 'pending_campaign_reward_notifications')
        assert(!found, 'expected no push frame when there is nothing pending')
      } finally {
        await closeClient(client)
      }
    })
  } finally {
    await stopServer(server)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Сървър 2 — CAMPAIGNS_FEATURE_ENABLED off
// ═══════════════════════════════════════════════════════════════════════
{
  const port = await findFreePort()
  const server = startServer(serverDir, port, false)
  try {
    await waitForServer(port)
    const user = seedUser(databaseFile, 'FlagOff')
    const { notificationId } = seedPendingNotification(databaseFile, { profileId: user.profileId })

    await check('[W10] Флаг OFF: pending ред съществува, но connect -> без push frame', async () => {
      const client = await connectClient(port, user, 'FlagOff-W10')
      try {
        await sleep(1000)
        const found = client.frames.some((f) => f.type === 'pending_campaign_reward_notifications')
        assert(!found, 'expected no push frame when CAMPAIGNS_FEATURE_ENABLED is off')
      } finally {
        await closeClient(client)
      }
    })

    await check('[W11] Флаг OFF: POST ack -> 200 graceful no-op, без DB промяна', async () => {
      const result = await postAck(port, user.cookie, notificationId)
      assert(result.status === 200 && result.body.ok === true, `expected graceful ok:true, got ${JSON.stringify(result)}`)
      assert(getNotificationStatus(databaseFile, notificationId) === 'pending', 'expected status unchanged when flag is off')
    })
  } finally {
    await stopServer(server)
  }
}

await cleanup()

console.log(`\nTotal: ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
