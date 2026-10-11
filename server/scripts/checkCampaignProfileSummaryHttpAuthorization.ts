/**
 * checkCampaignProfileSummaryHttpAuthorization.ts
 *
 * Фаза 8 (профилен popup "Кампании") — real spawned-server, real HTTP
 * integration test за handleProfileCampaignSummaryRequest (server/src/index.ts),
 * GET /api/profiles/:profileId/campaign-summary. Mirror на
 * checkCampaignMatchCreditWebSocketAuthorization.ts's isolated-server-copy
 * pattern, но HTTP (fetch), не WebSocket — endpoint-ът е чисто HTTP, виж
 * §9 от Фаза 8 задачата ("отварянето е read-only").
 *
 * Сървър 1 — CAMPAIGNS_FEATURE_ENABLED=1:
 *   [H1] Неавтентикиран viewer -> 401, без данни.
 *   [H2] Автентикиран viewer разглежда СОБСТВЕНИЯ профил -> коректен summary.
 *   [H3] Автентикиран viewer A разглежда профил Б (без block) -> коректните
 *        данни на Б, не на A (без смесване между профили).
 *   [H4] Несъществуващ profileId -> 404.
 *   [H5] Viewer, блокиран от target-а (profile_blocked_viewer) -> summary:null,
 *        без 403/block код да изтече (§9: "данните на различни профили не
 *        се смесват", консистентно с null-конвенцията от Фаза 6/7).
 *   [H6] Viewer, блокирал target-а (profile_blocked_by_viewer) -> summary:null.
 *   [H7] Lookup-ът е ЧИСТО read-only — campaign_unit_ledger/
 *        campaign_profile_totals редовете остават непроменени преди/след.
 *
 * Сървър 2 — CAMPAIGNS_FEATURE_ENABLED не е зададен (OFF):
 *   [H8] Автентикиран viewer -> ok:true, summary:null, без DB грешка.
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-profile-summary-http-'))
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
  const displayName = `HttpAuth ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', 'player', 'active');`)
      .run(accountId, `campaign-http-auth-${tag}-${runId}@example.test`)
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

// Само ЕДНА активна кампания едновременно (partial UNIQUE index, виж
// campaignsStore.ts) — затова тестовите потребители ДЕЛЯТ една и съща
// активна кампания, всеки със собствен campaign_profile_totals ред.
function seedActiveCampaign(databaseFile: string): { campaignId: string } {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const campaignId = randomUUID()
  db.prepare(`
    INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural)
    VALUES (?, ?, 'active', ?, ?, 'тиква', 'тикви');
  `).run(campaignId, `HttpAuth Active Campaign ${campaignId}`, hoursFromNow(-10), hoursFromNow(90))
  db.close()
  return { campaignId }
}

function seedProfileCampaignTotal(databaseFile: string, campaignId: string, profileId: string, unitsTotal: number): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`
    INSERT INTO campaign_profile_totals (campaign_id, profile_id, units_total) VALUES (?, ?, ?);
  `).run(campaignId, profileId, unitsTotal)
  db.close()
}

function blockProfile(databaseFile: string, blockerProfileId: string, blockedProfileId: string): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`INSERT INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?);`).run(blockerProfileId, blockedProfileId)
  db.close()
}

function countCampaignRows(databaseFile: string): { ledger: number; totals: number } {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    return {
      ledger: (db.prepare('SELECT COUNT(*) AS c FROM campaign_unit_ledger;').get() as { c: number }).c,
      totals: (db.prepare('SELECT COUNT(*) AS c FROM campaign_profile_totals;').get() as { c: number }).c,
    }
  } finally {
    db.close()
  }
}

async function fetchSummary(port: number, cookie: string | null, profileId: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/profiles/${encodeURIComponent(profileId)}/campaign-summary`, {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : {},
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

console.log('\ncheckCampaignProfileSummaryHttpAuthorization\n')

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

    const { campaignId } = seedActiveCampaign(databaseFile)
    seedProfileCampaignTotal(databaseFile, campaignId, userA.profileId, 111)
    seedProfileCampaignTotal(databaseFile, campaignId, userB.profileId, 222)

    await check('[H1] Неавтентикиран viewer -> 401', async () => {
      const result = await fetchSummary(port, null, userA.profileId)
      assert(result.status === 401, `expected 401, got ${result.status}`)
    })

    await check('[H2] Автентикиран viewer разглежда собствения профил -> коректен summary', async () => {
      const result = await fetchSummary(port, userA.cookie, userA.profileId)
      assert(result.status === 200 && result.body.ok === true, `expected ok:true, got ${JSON.stringify(result.body)}`)
      assert(result.body.summary?.active?.unitsTotal === 111, `expected 111 units, got ${JSON.stringify(result.body.summary)}`)
    })

    await check('[H3] Viewer A разглежда профил Б -> данните на Б, без смесване', async () => {
      const result = await fetchSummary(port, userA.cookie, userB.profileId)
      assert(result.status === 200 && result.body.ok === true, `expected ok:true, got ${JSON.stringify(result.body)}`)
      assert(result.body.summary?.active?.unitsTotal === 222, `expected 222 units (B-ия, не A-ия), got ${JSON.stringify(result.body.summary)}`)
    })

    await check('[H4] Несъществуващ profileId -> 404', async () => {
      const result = await fetchSummary(port, userA.cookie, `nonexistent-${randomUUID()}`)
      assert(result.status === 404, `expected 404, got ${result.status}`)
    })

    await check('[H5] Viewer, блокиран ОТ target-а -> summary:null, без разкриване на block код', async () => {
      blockProfile(databaseFile, userC.profileId, userA.profileId) // C е блокирал A
      const result = await fetchSummary(port, userA.cookie, userC.profileId) // A гледа C -> C е блокирал A -> denial
      assert(result.status === 200 && result.body.ok === true, `expected ok:true (no leak), got ${JSON.stringify(result.body)}`)
      assert(result.body.summary === null, `expected summary:null, got ${JSON.stringify(result.body.summary)}`)
    })

    await check('[H6] Viewer, блокирал target-а -> summary:null', async () => {
      const result = await fetchSummary(port, userC.cookie, userA.profileId) // C гледа A -> C е блокирал A -> denial
      assert(result.status === 200 && result.body.ok === true, `expected ok:true (no leak), got ${JSON.stringify(result.body)}`)
      assert(result.body.summary === null, `expected summary:null, got ${JSON.stringify(result.body.summary)}`)
    })

    await check('[H7] Read-only — campaign_unit_ledger/campaign_profile_totals непроменени преди/след', async () => {
      const before = countCampaignRows(databaseFile)
      await fetchSummary(port, userA.cookie, userB.profileId)
      await fetchSummary(port, userB.cookie, userA.profileId)
      const after = countCampaignRows(databaseFile)
      assert(before.ledger === after.ledger, `expected unchanged ledger row count, ${before.ledger} -> ${after.ledger}`)
      assert(before.totals === after.totals, `expected unchanged totals row count, ${before.totals} -> ${after.totals}`)
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

    await check('[H8] Флаг OFF -> ok:true, summary:null', async () => {
      const result = await fetchSummary(port, user.cookie, user.profileId)
      assert(result.status === 200 && result.body.ok === true, `expected ok:true, got ${JSON.stringify(result.body)}`)
      assert(result.body.summary === null, `expected summary:null when flag off, got ${JSON.stringify(result.body.summary)}`)
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
