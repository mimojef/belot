import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const PASSWORD = 'SocialBlockProfile1!'
const SERVER_READY_TIMEOUT_MS = 45_000

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a free port.')))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

async function createIsolatedServerRoot(): Promise<{
  root: string
  serverDir: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-social-block-profile-'))
  const serverDir = join(root, 'server')

  await mkdir(serverDir, { recursive: true })
  await cp(join(serverRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })

  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(serverRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)

  return {
    root,
    serverDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL')
      resolveStop()
    }, 10_000)
    server.child.once('exit', () => {
      clearTimeout(timeout)
      resolveStop()
    })
  })
}

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited early:\n${server.output()}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // Retry until ready or timeout.
    }
    await sleep(150)
  }
  throw new Error(`Server did not become ready:\n${server.output()}`)
}

type JsonResponse = {
  status: number
  body: {
    [key: string]: unknown
    ok?: boolean
    message?: string
    code?: string
    profile?: unknown
    blocked?: boolean
    session?: { profile: { profileId: string } }
  }
  cookie: string | null
}

function createPair(leftProfileId: string, rightProfileId: string): { lowerProfileId: string; higherProfileId: string } {
  return leftProfileId.localeCompare(rightProfileId, 'en') <= 0
    ? { lowerProfileId: leftProfileId, higherProfileId: rightProfileId }
    : { lowerProfileId: rightProfileId, higherProfileId: leftProfileId }
}

function futureSqlDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
}

function grantVip(databasePath: string, profileId: string): void {
  const database = new DatabaseSync(databasePath, { open: true })
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    database.prepare(`
      INSERT INTO vip_status (profile_id, active_until, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id) DO UPDATE SET
        active_until = excluded.active_until,
        updated_at = CURRENT_TIMESTAMP;
    `).run(profileId, futureSqlDate(30))
  } finally {
    database.close()
  }
}

function getConversationRows(
  databasePath: string,
  leftProfileId: string,
  rightProfileId: string,
): { friendship_id: string; kind: string; status: string }[] {
  const pair = createPair(leftProfileId, rightProfileId)
  const database = new DatabaseSync(databasePath, { open: true })
  try {
    database.exec('PRAGMA busy_timeout = 5000;')
    return database.prepare(`
      SELECT friendship_id, kind, status
      FROM profile_friendships
      WHERE lower_profile_id = ? AND higher_profile_id = ?
      ORDER BY kind, friendship_id;
    `).all(pair.lowerProfileId, pair.higherProfileId) as { friendship_id: string; kind: string; status: string }[]
  } finally {
    database.close()
  }
}

async function requestJson(
  port: number,
  method: 'GET' | 'POST',
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as JsonResponse['body']
  const setCookie = response.headers.get('set-cookie')?.split(';')[0] ?? null
  return { status: response.status, body: payload, cookie: setCookie }
}

async function register(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const response = await requestJson(port, 'POST', '/api/auth/register', null, {
    email,
    password: PASSWORD,
    displayName,
    gender: 'male',
  })
  assert(response.status === 200, `register ${email} status=${response.status} message=${response.body.message ?? ''}`)
  assert(response.body.ok === true && response.body.session !== undefined, 'register payload missing session')
  assert(response.cookie !== null, 'register response missing cookie')
  return { cookie: response.cookie, profileId: response.body.session.profile.profileId }
}

async function main(): Promise<void> {
  await check('[1] HTTP profile access denies both block directions without profile DTO and restores after unblock', async () => {
    const isolated = await createIsolatedServerRoot()
    const port = await getFreePort()
    let server: RunningServer | null = null

    try {
      server = startServer(isolated.serverDir, port)
      await waitForServer(port, server)

      const a = await register(port, `block-a-${Date.now()}@example.test`, 'BlockHttpA')
      const b = await register(port, `block-b-${Date.now()}@example.test`, 'BlockHttpB')

      const before = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(before.status === 200 && before.body.ok === true && before.body.profile !== undefined, 'profile did not load before block')

      const block = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(block.status === 200 && block.body.ok === true && block.body.blocked === true, 'block failed')

      const aViewsB = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(aViewsB.status === 403, `A->B expected 403, got ${aViewsB.status}`)
      assert(aViewsB.body.ok === false, 'A->B expected ok=false')
      assert(aViewsB.body.code === 'profile_blocked_by_viewer', `A->B code=${aViewsB.body.code ?? '(missing)'}`)
      assert(aViewsB.body.profile === undefined, 'A->B denial leaked profile DTO')

      const bViewsA = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(a.profileId)}`, b.cookie)
      assert(bViewsA.status === 403, `B->A expected 403, got ${bViewsA.status}`)
      assert(bViewsA.body.ok === false, 'B->A expected ok=false')
      assert(bViewsA.body.code === 'profile_blocked_viewer', `B->A code=${bViewsA.body.code ?? '(missing)'}`)
      assert(bViewsA.body.profile === undefined, 'B->A denial leaked profile DTO')

      const unblock = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(unblock.status === 200 && unblock.body.ok === true && unblock.body.blocked === false, 'unblock failed')

      const after = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(after.status === 200 && after.body.ok === true && after.body.profile !== undefined, 'profile did not load after unblock')
    } finally {
      await stopServer(server)
      await isolated.cleanup()
    }
  })

  await check('[2] WS player_profile path uses the same block authorization helper', () => {
    const source = readFileSync(resolve(serverRoot, 'src/index.ts'), 'utf8')
    const wsGuardIndex = source.indexOf('const accessDenial = getProfileAccessDenial(viewerProfileId, profileId)')
    const wsSendIndex = source.indexOf("type: 'player_profile'", wsGuardIndex)
    assert(wsGuardIndex >= 0, 'WS profile guard not found')
    assert(wsSendIndex > wsGuardIndex, 'WS denial is not sent from guarded branch')
    assert(source.includes('profile: null'), 'WS denial does not send profile:null')
    assert(source.includes('handleProfileByIdRequest') && source.includes('sendJsonResponse(res, 403, accessDenial)'), 'HTTP guard not found')
  })

  // Обновено (архитектурен rename): partner-block проверката при join вече
  // не живее inline в index.ts (старите futurePartnerProfileId/joinRoom
  // имена никога не са съществували в текущата архитектура — тестът
  // проверяваше stale код-shape). Реалната проверка е в
  // privateRoomsStore.ts:joinTeam — вика input.isBlockedWith() в двете
  // посоки (viewer->partner ПРЕДИ partner->viewer, за да различи кой е
  // блокирал кого и върне правилния message/code — виж
  // 'private_room_partner_blocked_by_viewer' vs 'private_room_partner_blocked'),
  // а index.ts подава конкретния blockStore.isBlocked callback към store-а
  // чрез joinTeam({ ..., isBlockedWith: ... }).
  await check('[3] private-room partner joins still fail closed on either block direction', () => {
    const storeSource = readFileSync(resolve(serverRoot, 'src/game/privateRoomsStore.ts'), 'utf8')
    const partnerSlotIndex = storeSource.indexOf('const partnerSlot =')
    const viewerBlocksPartnerIndex = storeSource.indexOf(
      'input.isBlockedWith(input.profileId, partnerProfileId)',
      partnerSlotIndex,
    )
    const partnerBlocksViewerIndex = storeSource.indexOf(
      'input.isBlockedWith(partnerProfileId, input.profileId)',
      partnerSlotIndex,
    )

    assert(partnerSlotIndex >= 0, 'private-room future partner detection not found')
    assert(viewerBlocksPartnerIndex > partnerSlotIndex, 'private-room join does not check joining -> partner block')
    assert(partnerBlocksViewerIndex > viewerBlocksPartnerIndex, 'private-room join does not check partner -> joining block')
    assert(
      storeSource.includes("code: 'private_room_partner_blocked_by_viewer'"),
      'private-room join does not distinguish the viewer-blocked-partner direction',
    )
    assert(
      storeSource.includes("code: 'private_room_partner_blocked'"),
      'private-room join does not report the partner-blocked-viewer direction',
    )

    const wiringSource = readFileSync(resolve(serverRoot, 'src/index.ts'), 'utf8')
    assert(
      /privateRoomsStore\.joinTeam\(\{[\s\S]{0,600}isBlockedWith:\s*\(a,\s*b\)\s*=>\s*blockStore\.isBlocked\(a,\s*b\)/.test(
        wiringSource,
      ),
      'index.ts does not wire isBlockedWith into privateRoomsStore.joinTeam',
    )
  })

  // Забележка (ghost-row prevention fix): POST /api/chat/vip-dm/start вече
  // НЕ създава нов ред без съществуващ разговор (връща 403 message_required)
  // — единственият create path е атомарният POST
  // /api/chat/vip-dm/start-with-message (get-or-create + insert message в
  // 1 транзакция). Тестът долу упражнява concurrent create races върху
  // start-with-message, и отделно проверява, че легacy start НЕ INSERT-ва.
  await check('[4] POST vip-dm/start-with-message concurrent same/reverse directions and friend-accept race converge canonically; legacy start never inserts', async () => {
    const isolated = await createIsolatedServerRoot()
    const port = await getFreePort()
    const databasePath = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
    let server: RunningServer | null = null

    try {
      server = startServer(isolated.serverDir, port)
      await waitForServer(port, server)

      const a = await register(port, `concurrent-a-${Date.now()}@example.test`, 'ConcurrentA')
      const b = await register(port, `concurrent-b-${Date.now()}@example.test`, 'ConcurrentB')
      grantVip(databasePath, a.profileId)
      grantVip(databasePath, b.profileId)

      // Legacy no-op start BEFORE any message exists: must NOT insert (G).
      const legacyBeforeSend = await requestJson(port, 'POST', '/api/chat/vip-dm/start', a.cookie, { recipientProfileId: b.profileId })
      assert(legacyBeforeSend.status === 403, `legacy start before any message must be 403, got ${legacyBeforeSend.status}`)
      assert(legacyBeforeSend.body.code === 'message_required', `legacy start before any message must return message_required, got ${legacyBeforeSend.body.code}`)
      const rowsBeforeSend = getConversationRows(databasePath, a.profileId, b.profileId)
      assert(rowsBeforeSend.length === 0, `legacy start must not insert a ghost row, rows=${JSON.stringify(rowsBeforeSend)}`)

      const [sameOne, sameTwo] = await Promise.all([
        requestJson(port, 'POST', '/api/chat/vip-dm/start-with-message', a.cookie, { recipientProfileId: b.profileId, body: 'same direction one' }),
        requestJson(port, 'POST', '/api/chat/vip-dm/start-with-message', a.cookie, { recipientProfileId: b.profileId, body: 'same direction two' }),
      ])
      assert(sameOne.status === 200 && sameTwo.status === 200, `same-direction start statuses ${sameOne.status}/${sameTwo.status}`)
      assert(sameOne.body.friendshipId === sameTwo.body.friendshipId, 'same-direction concurrent starts returned different friendshipIds')
      const sameRows = getConversationRows(databasePath, a.profileId, b.profileId)
      assert(sameRows.length === 1 && sameRows[0]!.kind === 'vip_dm', `same-direction rows=${JSON.stringify(sameRows)}`)

      // Legacy start AFTER a message exists must now resolve the SAME canonical row (H).
      const legacyAfterSend = await requestJson(port, 'POST', '/api/chat/vip-dm/start', b.cookie, { recipientProfileId: a.profileId })
      assert(legacyAfterSend.status === 200, `legacy start after existing conversation must succeed, got ${legacyAfterSend.status}`)
      assert(legacyAfterSend.body.friendshipId === sameOne.body.friendshipId, 'legacy start after existing conversation must return the same canonical friendshipId')
      const rowsAfterLegacy = getConversationRows(databasePath, a.profileId, b.profileId)
      assert(rowsAfterLegacy.length === 1, `legacy start on existing conversation must not create a duplicate, rows=${JSON.stringify(rowsAfterLegacy)}`)

      const c = await register(port, `concurrent-c-${Date.now()}@example.test`, 'ConcurrentC')
      const d = await register(port, `concurrent-d-${Date.now()}@example.test`, 'ConcurrentD')
      grantVip(databasePath, c.profileId)
      grantVip(databasePath, d.profileId)
      const [reverseOne, reverseTwo] = await Promise.all([
        requestJson(port, 'POST', '/api/chat/vip-dm/start-with-message', c.cookie, { recipientProfileId: d.profileId, body: 'reverse one' }),
        requestJson(port, 'POST', '/api/chat/vip-dm/start-with-message', d.cookie, { recipientProfileId: c.profileId, body: 'reverse two' }),
      ])
      assert(reverseOne.status === 200 && reverseTwo.status === 200, `reverse start statuses ${reverseOne.status}/${reverseTwo.status}`)
      assert(reverseOne.body.friendshipId === reverseTwo.body.friendshipId, 'reverse concurrent starts returned different friendshipIds')
      const reverseRows = getConversationRows(databasePath, c.profileId, d.profileId)
      assert(reverseRows.length === 1 && reverseRows[0]!.kind === 'vip_dm', `reverse rows=${JSON.stringify(reverseRows)}`)

      const e = await register(port, `race-e-${Date.now()}@example.test`, 'RaceE')
      const f = await register(port, `race-f-${Date.now()}@example.test`, 'RaceF')
      grantVip(databasePath, e.profileId)
      grantVip(databasePath, f.profileId)
      const friendRequest = await requestJson(port, 'POST', '/api/friends/request', e.cookie, { profileId: f.profileId })
      assert(friendRequest.status === 200, `friend request status=${friendRequest.status}`)
      const outgoingPending = (friendRequest.body.friendships as { outgoingPending?: { friendshipId?: string }[] } | undefined)?.outgoingPending ?? []
      const pendingFriendshipId = outgoingPending.find((item) => typeof item.friendshipId === 'string')?.friendshipId
      assert(typeof pendingFriendshipId === 'string', 'pending friendshipId missing')

      const [startDuringAccept, acceptDuringStart] = await Promise.all([
        requestJson(port, 'POST', '/api/chat/vip-dm/start-with-message', e.cookie, { recipientProfileId: f.profileId, body: 'race message' }),
        requestJson(port, 'POST', `/api/friends/${encodeURIComponent(pendingFriendshipId!)}/accept`, f.cookie),
      ])
      assert(startDuringAccept.status === 200, `vip_dm start during accept status=${startDuringAccept.status}`)
      assert(acceptDuringStart.status === 200, `friend accept during start status=${acceptDuringStart.status}`)
      const raceRows = getConversationRows(databasePath, e.profileId, f.profileId)
      assert(raceRows.length === 2, `race did not keep separate friend+vip_dm rows=${JSON.stringify(raceRows)}`)
      const raceFriend = raceRows.find((row) => row.kind === 'friend')
      const raceVipDm = raceRows.find((row) => row.kind === 'vip_dm')
      assert(raceFriend !== undefined && raceFriend.status === 'accepted', `race friend row missing/not accepted: ${JSON.stringify(raceRows)}`)
      assert(raceVipDm !== undefined && raceVipDm.status === 'accepted', `race vip_dm row missing/not accepted: ${JSON.stringify(raceRows)}`)
      assert(raceFriend!.friendship_id !== raceVipDm!.friendship_id, 'race friend and vip_dm reused the same friendshipId')
      assert(startDuringAccept.body.friendshipId === raceVipDm!.friendship_id, 'race vip-dm/start-with-message did not return vip_dm row')
      const startAfterFriend = await requestJson(port, 'POST', '/api/chat/vip-dm/start', f.cookie, { recipientProfileId: e.profileId })
      assert(startAfterFriend.status === 200, `legacy start after accepted friend+existing vip_dm status=${startAfterFriend.status}`)
      assert(startAfterFriend.body.friendshipId === raceVipDm!.friendship_id, 'legacy start after accepted friend did not return canonical vip_dm row')
      const raceRowsAfter = getConversationRows(databasePath, e.profileId, f.profileId)
      assert(raceRowsAfter.length === 2, `legacy start after accepted friend changed row count: ${JSON.stringify(raceRowsAfter)}`)
      assert(raceRowsAfter.filter((row) => row.kind === 'friend').length === 1, `legacy start after accepted friend changed friend rows: ${JSON.stringify(raceRowsAfter)}`)
      assert(raceRowsAfter.filter((row) => row.kind === 'vip_dm').length === 1, `legacy start after accepted friend changed vip_dm rows: ${JSON.stringify(raceRowsAfter)}`)
    } finally {
      await stopServer(server)
      await isolated.cleanup()
    }
  })

  // §UX gap fix: "target has blocked viewer" denial popup now offers a
  // "Блокирай" action so the viewer can block back without ever needing
  // profile read access to the target. Exercises the SAME authoritative
  // POST /api/profiles/:id/block endpoint the normal profile-popup block
  // button uses — this is not a separate/local UI-only action.
  await check('[5] viewer can block back from the access-denial state (target blocked viewer), producing a mutual block, without ever gaining profile read access', async () => {
    const isolated = await createIsolatedServerRoot()
    const port = await getFreePort()
    let server: RunningServer | null = null

    try {
      server = startServer(isolated.serverDir, port)
      await waitForServer(port, server)

      const a = await register(port, `denial-block-a-${Date.now()}@example.test`, 'DenialBlockA')
      const b = await register(port, `denial-block-b-${Date.now()}@example.test`, 'DenialBlockB')

      // B blocks A first.
      const bBlocksA = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(a.profileId)}/block`, b.cookie)
      assert(bBlocksA.status === 200 && bBlocksA.body.ok === true && bBlocksA.body.blocked === true, 'B->A block failed')

      // A opens B's profile -> denied specifically as "target blocked viewer".
      const aViewsB = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(aViewsB.status === 403, `A->B view expected 403, got ${aViewsB.status}`)
      assert(aViewsB.body.code === 'profile_blocked_viewer', `A->B view code=${aViewsB.body.code ?? '(missing)'}`)
      assert(aViewsB.body.profile === undefined, 'A->B denial leaked profile DTO before block-back')

      // A blocks back through the exact same authoritative endpoint the
      // popup's new "Блокирай" button calls — no profile read happened, and
      // none is required for this call to succeed.
      const aBlocksB = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(aBlocksB.status === 200, `A->B block-back expected 200, got ${aBlocksB.status} body=${JSON.stringify(aBlocksB.body)}`)
      assert(aBlocksB.body.ok === true && aBlocksB.body.blocked === true, 'A->B block-back did not report blocked=true')

      // Mutual block now exists — confirmed via GET /api/blocks for each side.
      const aBlockedList = await requestJson(port, 'GET', '/api/blocks', a.cookie)
      assert(aBlockedList.status === 200, `A blocks list status=${aBlockedList.status}`)
      const aBlockedIds = (aBlockedList.body.profiles as { profileId: string }[] | undefined)?.map((p) => p.profileId) ?? []
      assert(aBlockedIds.includes(b.profileId), 'A -> B block relation was not recorded')

      const bBlockedList = await requestJson(port, 'GET', '/api/blocks', b.cookie)
      assert(bBlockedList.status === 200, `B blocks list status=${bBlockedList.status}`)
      const bBlockedIds = (bBlockedList.body.profiles as { profileId: string }[] | undefined)?.map((p) => p.profileId) ?? []
      assert(bBlockedIds.includes(a.profileId), 'B -> A block relation (the original one) was lost by the block-back call')

      // Blocking back does NOT unlock access — A still cannot view B's profile.
      const aViewsBAfter = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(aViewsBAfter.status === 403, `A->B view after block-back expected 403, got ${aViewsBAfter.status}`)
      assert(aViewsBAfter.body.profile === undefined, 'A->B view after block-back leaked profile DTO')

      // And B, symmetrically, still cannot view A's profile either (both
      // directions of the now-mutual block independently deny access).
      const bViewsA = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(a.profileId)}`, b.cookie)
      assert(bViewsA.status === 403, `B->A view expected 403, got ${bViewsA.status}`)
      assert(bViewsA.body.profile === undefined, 'B->A view leaked profile DTO')

      // A repeated block-back call while already mutual must not error or
      // flip state unexpectedly — it is the same toggle endpoint, so a
      // second call from A now UNBLOCKS (toggle semantics), which the UI
      // must not expose as an active "Блокирай" action once mutual (client
      // gate, verified separately in the source-shape check below) — but the
      // server itself must still behave predictably, not error.
      const aTogglesAgain = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(aTogglesAgain.status === 200, `A repeated toggle expected 200, got ${aTogglesAgain.status}`)
      assert(aTogglesAgain.body.blocked === false, 'A repeated toggle did not unblock (toggle semantics broken)')

      // Restore the mutual state for cleanliness of the assertions above (not required, but avoids surprising future readers of a shared fixture).
      const aReblocks = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(aReblocks.status === 200 && aReblocks.body.blocked === true, 'A re-block failed')

      // Mutual-block edge case: once BOTH directions exist, the denial the
      // viewer (A) sees when opening B again must come back as
      // 'profile_blocked_by_viewer' (the "Отблокирай" branch), NEVER
      // 'profile_blocked_viewer' — this is what keeps the client from ever
      // rendering an active duplicate "Блокирай" button once mutual (see
      // getProfileAccessDenial in index.ts: it checks viewer->target BEFORE
      // target->viewer, so an existing viewer->target block always wins).
      const aViewsBMutual = await requestJson(port, 'GET', `/api/profiles/${encodeURIComponent(b.profileId)}`, a.cookie)
      assert(aViewsBMutual.status === 403, `A->B view under mutual block expected 403, got ${aViewsBMutual.status}`)
      assert(
        aViewsBMutual.body.code === 'profile_blocked_by_viewer',
        `under mutual block, A's denial code must be profile_blocked_by_viewer (never profile_blocked_viewer, which would re-show an active Блокирай), got ${aViewsBMutual.body.code ?? '(missing)'}`,
      )
    } finally {
      await stopServer(server)
      await isolated.cleanup()
    }
  })

  // The block endpoint must not require the target profile to actually be
  // readable/loadable by the viewer — only that it exists. A nonexistent
  // profileId must be rejected (not silently inserted into player_blocks).
  await check('[6] block endpoint requires the target profile to exist, but not that a profile read/access succeeded first', async () => {
    const isolated = await createIsolatedServerRoot()
    const port = await getFreePort()
    let server: RunningServer | null = null

    try {
      server = startServer(isolated.serverDir, port)
      await waitForServer(port, server)

      const a = await register(port, `block-exist-a-${Date.now()}@example.test`, 'BlockExistA')
      const b = await register(port, `block-exist-b-${Date.now()}@example.test`, 'BlockExistB')

      // B blocks A -> A has zero profile-read access to B, yet blocking B
      // back must still succeed (already covered end-to-end in [5]; here we
      // isolate the "no prior successful read" property with a completely
      // unrelated, never-viewed profile to rule out any hidden caching).
      const neverViewedBlock = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(b.profileId)}/block`, a.cookie)
      assert(neverViewedBlock.status === 200 && neverViewedBlock.body.blocked === true, 'blocking a never-viewed-but-real profile failed')

      // A nonexistent profileId must be rejected with 404, not silently accepted.
      const fakeProfileId = 'profile_does_not_exist_ffffffffffffffffffffffffffffffff'
      const blockNonexistent = await requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(fakeProfileId)}/block`, a.cookie)
      assert(blockNonexistent.status === 404, `blocking a nonexistent profile expected 404, got ${blockNonexistent.status}`)
      assert(blockNonexistent.body.ok === false, 'blocking a nonexistent profile must report ok=false')

      const aBlockedList = await requestJson(port, 'GET', '/api/blocks', a.cookie)
      const aBlockedIds = (aBlockedList.body.profiles as { profileId: string }[] | undefined)?.map((p) => p.profileId) ?? []
      assert(!aBlockedIds.includes(fakeProfileId), 'a nonexistent profileId was inserted into the block store')
    } finally {
      await stopServer(server)
      await isolated.cleanup()
    }
  })

  // Client source-shape checks for the new denial-popup "Блокирай" action —
  // proves it reuses the shared authoritative flow (not a parallel/local-only
  // UI action) and that mutual-block never re-exposes an active duplicate
  // "Блокирай" that would race a duplicate request.
  await check('[7] the denial popup "Блокирай" action reuses the shared authoritative onBlockProfile flow (client source shape)', () => {
    const controllerSource = readFileSync(resolve(serverRoot, '..', 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
    const sharedPopupSource = readFileSync(resolve(serverRoot, '..', 'src', 'ui', 'overlays', 'renderProfileAccessBlockPopup.ts'), 'utf8')
    const activeRoomControllerSource = readFileSync(resolve(serverRoot, '..', 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')

    assert(controllerSource.includes('async function blockFromAccessDenialPopup'), 'blockFromAccessDenialPopup not found')
    const fnBody = controllerSource.slice(
      controllerSource.indexOf('async function blockFromAccessDenialPopup'),
      controllerSource.indexOf('function openGiftModal'),
    )
    assert(fnBody.includes('options.onBlockProfile(profileId)'), 'block-from-denial action does not call the shared options.onBlockProfile endpoint')
    assert(!fnBody.includes('isBlockedByMe: true') || fnBody.includes('updateProfile'), 'block-from-denial action must derive isBlockedByMe from the server result, not set it directly')

    // The render/gating logic lives in ONE shared module
    // (src/ui/overlays/renderProfileAccessBlockPopup.ts) — not
    // re-implemented per screen. Both lobby (renderLobbyScreen.ts) and
    // in-game/private-room seat popup (createActiveRoomFlowController.ts)
    // import and call it, rather than each rendering their own denial UI.
    assert(sharedPopupSource.includes('data-profile-access-block-block='), 'shared renderProfileAccessBlockPopup does not render the new Блокирай action')
    assert(sharedPopupSource.includes('showBlockAction = !viewerIsBlocker'), 'Блокирай action is not gated to the target-blocked-viewer direction only')

    // "Затвори" must remain a pure close with no block side effect: its
    // wiring calls callbacks.onClose directly (no inline handler body that
    // could also fire a block call).
    const closeWiringIndex = sharedPopupSource.indexOf('[data-profile-access-block-close="1"]\').forEach((btn) => {')
    assert(closeWiringIndex >= 0, 'Затвори wiring block not found in shared module')
    const closeWiringBody = sharedPopupSource.slice(closeWiringIndex, closeWiringIndex + 200)
    assert(
      closeWiringBody.includes("btn.addEventListener('click', callbacks.onClose)"),
      'Затвори wiring must call callbacks.onClose directly, with no additional block side effect',
    )

    // In-game/private-room seat popup entry point reuses the SAME shared
    // module (mountStandaloneProfileAccessBlockPopup) instead of a parallel
    // implementation — covers the task brief's "at least one in-game/
    // private-room protected-profile entry path" requirement.
    assert(
      activeRoomControllerSource.includes("from '../../ui/overlays/renderProfileAccessBlockPopup'"),
      'in-game active room controller does not import the shared denial popup module',
    )
    assert(
      activeRoomControllerSource.includes('mountStandaloneProfileAccessBlockPopup'),
      'in-game active room controller does not mount the shared denial popup',
    )
    assert(
      activeRoomControllerSource.includes('deniedProfileId'),
      'in-game active room controller does not read deniedProfileId from the player_profile denial message',
    )
  })

  console.log(`\nSocial block profile authorization checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
