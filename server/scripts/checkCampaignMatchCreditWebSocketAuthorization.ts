/**
 * checkCampaignMatchCreditWebSocketAuthorization.ts
 *
 * ФАЗА 7 — Real spawned-server, real WebSocket integration test за
 * request_campaign_match_credit's sever-side handler (server/src/index.ts),
 * покриващ И двата gameKind клона ('belot' и 'ludo' — Фаза 7 разширението).
 * Mirror на checkBelotSpectatorWebSocket.ts's isolated-server-copy pattern
 * (temp copy на server root + изолирана SQLite DB + директно seed-нати
 * accounts/profiles/sessions — без email verification/реална игра).
 *
 * Campaign_unit_ledger редовете се seed-ват ДИРЕКТНО (не през реален
 * изигран Ludo/Belot мач) — handler-ът е чисто read-only върху тая
 * таблица, затова самото "как се е появил редът" е ирелевантно за тая
 * конкретна security/dispatch проверка (end-to-end match->credit pipeline
 * е вече покрит отделно в checkCampaignGameHooks.ts/
 * checkCampaignBelotReliableReconciliation.ts).
 *
 * Сървър 1 — CAMPAIGNS_FEATURE_ENABLED=1:
 *   [W1] Ludo: автентикиран профил с реален ludo_win ред -> коректен credit.
 *   [W2] Ludo: автентикиран профил A пита за профил B-ия matchId -> null
 *        (НИКОГА чужди данни, независимо какъв roomId подаде клиентът —
 *        profileId се резолюва СЪРВЪРНО от connection-а, не от заявката).
 *   [W3] Ludo: произволен/несъществуващ matchId -> null, без грешка.
 *   [W4] Belot: gameKind:'belot' продължава да работи коректно (regression
 *        на Фаза 6 dispatch-а, непроменен от Фаза 7 разширението).
 *   [W5] Lookup-ът е ЧИСТО read-only — campaign_unit_ledger броят редове
 *        остава непроменен преди/след заявката (без повторно начисляване).
 *   [W6] Невалидно/malformed съобщение (липсващ roomId) -> сървърът не
 *        срива, просто не отговаря с валиден credit.
 *
 * Сървър 2 — CAMPAIGNS_FEATURE_ENABLED не е зададен (OFF):
 *   [W7] И двата gameKind клона -> credit:null, независимо от съществуващ
 *        ledger ред (campaignCreditStore===null на сървъра).
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
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-ws-auth-'))
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

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number, campaignsEnabled: boolean): RunningServer {
  const chunks: string[] = []
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
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
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
  const displayName = `WsAuth ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', 'player', 'active');`)
      .run(accountId, `campaign-ws-auth-${tag}-${runId}@example.test`)
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

// Минимален директен campaign + ledger seed — handler-ът е read-only върху
// campaign_unit_ledger, не изисква реален campaignsStore lifecycle за тая
// конкретна dispatch/authorization проверка.
function seedCampaignAndCredit(
  databaseFile: string,
  opts: { profileId: string; sourceType: 'belot_win' | 'ludo_win'; sourceId: string; eventAtIso: string; unitsAmount: number },
): { campaignId: string } {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const campaignId = randomUUID()
  db.prepare(`
    INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural)
    VALUES (?, ?, 'finished', ?, ?, 'тиква', 'тикви');
  `).run(campaignId, `WsAuth Test Campaign ${campaignId}`, hoursFromNow(-100), hoursFromNow(100))
  db.prepare(`
    INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(campaignId, opts.profileId, opts.sourceType, opts.sourceId, opts.unitsAmount, opts.eventAtIso)
  db.close()
  return { campaignId }
}

function countLedgerRows(databaseFile: string): number {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM campaign_unit_ledger;').get() as { c: number }).c
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

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function waitForFrame(client: TestClient, predicate: (frame: any) => boolean, timeoutMs = 10_000, label = 'frame', fromIndex = 0): Promise<any> {
  await waitForCondition(`${client.label}: ${label}`, () => client.frames.slice(fromIndex).some(predicate), timeoutMs)
  return client.frames.slice(fromIndex).find(predicate)
}

async function closeClient(client: TestClient): Promise<void> {
  client.ws.close()
  await sleep(50)
}

console.log('\ncheckCampaignMatchCreditWebSocketAuthorization\n')

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

    const ludoMatchIdA = `ludo-match-${randomUUID()}`
    const ludoEventAtA = new Date(Date.now() - 60_000)
    seedCampaignAndCredit(databaseFile, {
      profileId: userA.profileId,
      sourceType: 'ludo_win',
      sourceId: ludoMatchIdA,
      eventAtIso: ludoEventAtA.toISOString(),
      unitsAmount: 25,
    })

    const belotRoomScopeA = `belot-room-${randomUUID()}:v1`
    const belotEventAtA = new Date(Date.now() - 30_000)
    seedCampaignAndCredit(databaseFile, {
      profileId: userA.profileId,
      sourceType: 'belot_win',
      sourceId: belotRoomScopeA,
      eventAtIso: belotEventAtA.toISOString(),
      unitsAmount: 10,
    })

    const clientA = await connectClient(port, userA, 'A')
    const clientB = await connectClient(port, userB, 'B')

    await check('[W1] Ludo: автентикиран профил с реален ludo_win ред -> коректен credit', async () => {
      send(clientA, { type: 'request_campaign_match_credit', gameKind: 'ludo', roomId: ludoMatchIdA })
      const frame = await waitForFrame(clientA, (f) => f.type === 'campaign_match_credit_result' && f.roomId === ludoMatchIdA, 10_000, 'ludo credit result')
      assert(frame.credit !== null, `expected non-null credit, got ${JSON.stringify(frame.credit)}`)
      assert(frame.credit.unitsAmount === 25, `expected 25 units, got ${frame.credit.unitsAmount}`)
      assert(frame.credit.unitNameSingular === 'тиква', 'unitNameSingular mismatch')
    })

    await check('[W2] Ludo: профил B пита за профил A-ия matchId -> null (никога чужди данни)', async () => {
      const before = clientB.frames.length
      send(clientB, { type: 'request_campaign_match_credit', gameKind: 'ludo', roomId: ludoMatchIdA })
      const frame = await waitForFrame(clientB, (f) => f.type === 'campaign_match_credit_result' && f.roomId === ludoMatchIdA, 10_000, 'ludo cross-profile result', before)
      assert(frame.credit === null, `expected null (profile B must never see profile A's credit), got ${JSON.stringify(frame.credit)}`)
    })

    await check('[W3] Ludo: произволен/несъществуващ matchId -> null, без грешка', async () => {
      const before = clientA.frames.length
      const fakeMatchId = `ludo-match-${randomUUID()}`
      send(clientA, { type: 'request_campaign_match_credit', gameKind: 'ludo', roomId: fakeMatchId })
      const frame = await waitForFrame(clientA, (f) => f.type === 'campaign_match_credit_result' && f.roomId === fakeMatchId, 10_000, 'ludo nonexistent result', before)
      assert(frame.credit === null, 'expected null for a nonexistent matchId')
    })

    await check('[W4] Belot: gameKind:\'belot\' продължава да работи коректно (Фаза 6 regression)', async () => {
      const before = clientA.frames.length
      send(clientA, {
        type: 'request_campaign_match_credit',
        gameKind: 'belot',
        roomId: belotRoomScopeA.split(':v')[0],
        matchEndedAt: belotEventAtA.getTime(),
      })
      const frame = await waitForFrame(
        clientA,
        (f) => f.type === 'campaign_match_credit_result' && f.roomId === belotRoomScopeA.split(':v')[0],
        10_000,
        'belot credit result',
        before,
      )
      assert(frame.credit !== null, `expected non-null Belot credit, got ${JSON.stringify(frame.credit)}`)
      assert(frame.credit.unitsAmount === 10, `expected 10 units, got ${frame.credit.unitsAmount}`)
    })

    await check('[W5] Lookup-ът е read-only — campaign_unit_ledger броят редове непроменен', async () => {
      const before = countLedgerRows(databaseFile)
      send(clientA, { type: 'request_campaign_match_credit', gameKind: 'ludo', roomId: ludoMatchIdA })
      await waitForFrame(clientA, (f) => f.type === 'campaign_match_credit_result' && f.roomId === ludoMatchIdA, 10_000, 'read-only check result', clientA.frames.length)
      const after = countLedgerRows(databaseFile)
      assert(after === before, `expected no new ledger rows from a read-only lookup, before=${before} after=${after}`)
    })

    await check('[W6] Malformed съобщение (липсващ roomId) -> сървърът не срива', async () => {
      send(clientA, { type: 'request_campaign_match_credit', gameKind: 'ludo' })
      await sleep(500)
      assert(server.child.exitCode === null, 'сървърът не бива да срива на malformed заявка')
    })

    await closeClient(clientA)
    await closeClient(clientB)
  } finally {
    await stopServer(server)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Сървър 2 — CAMPAIGNS_FEATURE_ENABLED OFF
// ═══════════════════════════════════════════════════════════════════════
{
  const port = await findFreePort()
  const server = startServer(serverDir, port, false)
  try {
    await waitForServer(port)
    const userC = seedUser(databaseFile, 'C')
    const ludoMatchIdC = `ludo-match-${randomUUID()}`
    seedCampaignAndCredit(databaseFile, {
      profileId: userC.profileId,
      sourceType: 'ludo_win',
      sourceId: ludoMatchIdC,
      eventAtIso: new Date().toISOString(),
      unitsAmount: 25,
    })
    const clientC = await connectClient(port, userC, 'C')

    await check('[W7] Feature flag OFF -> credit:null за ОБА gameKind клона, независимо от съществуващ ledger ред', async () => {
      send(clientC, { type: 'request_campaign_match_credit', gameKind: 'ludo', roomId: ludoMatchIdC })
      const ludoFrame = await waitForFrame(clientC, (f) => f.type === 'campaign_match_credit_result' && f.roomId === ludoMatchIdC, 10_000, 'flag-off ludo result')
      assert(ludoFrame.credit === null, 'expected null when CAMPAIGNS_FEATURE_ENABLED is off (ludo)')

      const before = clientC.frames.length
      send(clientC, { type: 'request_campaign_match_credit', gameKind: 'belot', roomId: 'irrelevant-room', matchEndedAt: Date.now() })
      const belotFrame = await waitForFrame(clientC, (f) => f.type === 'campaign_match_credit_result' && f.roomId === 'irrelevant-room', 10_000, 'flag-off belot result', before)
      assert(belotFrame.credit === null, 'expected null when CAMPAIGNS_FEATURE_ENABLED is off (belot)')
    })

    await closeClient(clientC)
  } finally {
    await stopServer(server)
  }
}

await cleanup()

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
