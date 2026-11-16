/**
 * checkCoPlayPrivateRoomsE2E.ts — „Забрана за съвместна игра“, Етап 3:
 * частни маси и повторни мачове. Реален изолиран сървър (giftBackTestHarness),
 * реални WS връзки със сесийни бисквитки, реално административно API.
 *
 * Сървър 1 (реалният код; частният мач е до 1 точка, за да стигне до края):
 *   [R1]  директно сядане: забранен партньор и забранен противник -> отказ, масата непроменена;
 *   [R2]  двустранност + друг профил на акаунта;
 *   [R3]  покана към забранен -> отказ (без име); неограничен поканен — нормално;
 *   [R4]  промяна на състава след поканата -> отказ при приемане, поканата остава;
 *   [R5]  покана за партньор: отказ при изпращане; промяна на състава -> отказ при приемане;
 *   [R6]  налагане при обща незапочнала маса: по-късно седналият излиза; защита на
 *         създателя; отменени несъвместими покани; без удържан залог; одит;
 *   [R7]  изключен флаг (без отказ и без премахване) -> включване: конфликтът се разрешава;
 *   [R8]  започнат мач: не се прекъсва; reconnect работи; повторният мач се отказва;
 *   [R9]  отменена и изтекла забрана; [R10] неограничени потребители.
 * Сървър 2 (изключена САМО входната проверка на store-а — само така се стига
 * до финалната проверка):
 *   [R11] ръчен старт; [R12] автоматичен старт.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayPrivateRoomsE2E.ts
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckCoPlayPrivateRoomsE2E\n')

const STAKE = 5000
const BALANCE = 50_000_000
const ROOM_TEXT = 'На тази маса има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'

type Frame = { at: number; type: string; data: any }
type Client = { label: string; profile: TestProfile; frames: Frame[]; send: (m: unknown) => void; close: () => Promise<void> }

const SHORT_PRIVATE_MATCH: ServerSourcePatch = {
  file: 'index.ts',
  find: 'const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)',
  replace: 'const initializedRoom = initializeRoomAuthoritativeGameState({ ...currentRoom, config: { ...currentRoom.config, targetScore: 1 } })',
}
const BYPASS_STORE_ENTRY_CHECK: ServerSourcePatch = {
  file: 'index.ts',
  find: 'isCoPlayRestrictedWithRoom: (room, joining) => isCoPlayRestrictedWithPrivateRoom(room, joining),',
  replace: 'isCoPlayRestrictedWithRoom: () => false,',
}

const isRestricted = (f: Frame) => f.type === 'error' && f.data.code === 'co_play_restricted'

function makeEnv(h: GiftBackHarness) {
  const wsOrigin = h.backendOrigin.replace(/^http/, 'ws')
  const opened: Client[] = []

  async function connect(label: string, profile: TestProfile): Promise<Client> {
    const socket = new WebSocket(`${wsOrigin}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}` } })
    const frames: Frame[] = []
    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw))
        frames.push({ at: Date.now(), type: String(data?.type ?? ''), data })
      } catch { /* not JSON */ }
    })
    await new Promise<void>((done, reject) => { socket.once('open', () => done()); socket.once('error', reject) })
    await sleep(300)
    const client: Client = {
      label,
      profile,
      frames,
      send: (m) => socket.send(JSON.stringify(m)),
      close: () => new Promise<void>((done) => {
        if (socket.readyState === WebSocket.CLOSED) { done(); return }
        socket.once('close', () => done())
        socket.close()
      }),
    }
    opened.push(client)
    return client
  }
  async function waitFrame(c: Client, predicate: (f: Frame) => boolean, from: number, timeoutMs = 5000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const f = c.frames.slice(from).find(predicate)
      if (f) return f
      await sleep(100)
    }
    return null
  }
  async function act(c: Client, message: unknown, ms = 700): Promise<Frame[]> {
    const from = c.frames.length
    c.send(message)
    await sleep(ms)
    return c.frames.slice(from)
  }
  async function register(tag: string): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    const p = await h.register(tag)
    h.setBalance(p.profileId, BALANCE)
    return p
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  function addSecondProfile(profileId: string, name: string): string {
    const id = randomUUID()
    h.db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human')`)
      .run(id, accountOf(profileId), name, `${name.toLowerCase()}-${id.slice(0, 8)}`)
    return id
  }
  function befriend(a: string, b: string): void {
    const [low, high] = a < b ? [a, b] : [b, a]
    h.db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)`)
      .run(randomUUID(), a, b, low, high)
  }
  let admin: TestProfile | null = null
  async function adminApi(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    if (admin === null) {
      admin = await register('admin')
      h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?`).run(accountOf(admin.profileId))
    }
    const res = await fetch(`${h.backendOrigin}/api/admin/co-play-restrictions${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${admin.cookie}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  async function setFlag(enabled: boolean): Promise<void> {
    const r = await adminApi('PUT', '/settings', { enabled })
    assert(r.status === 200 && r.body.settings.enabled === enabled, `флаг: ${JSON.stringify(r.body)}`)
  }
  async function impose(a: string, b: string, extra: Record<string, unknown> = { indefinite: true }): Promise<string> {
    const r = await adminApi('POST', '', { firstProfileId: a, secondProfileId: b, reason: 'E2E', ...extra })
    assert(r.status === 201, `налагане: ${JSON.stringify(r.body)}`)
    await sleep(500)
    return r.body.restriction.restrictionId as string
  }
  async function lift(id: string): Promise<void> {
    const r = await adminApi('POST', `/${id}/lift`, {})
    assert(r.status === 200, `отмяна: ${JSON.stringify(r.body)}`)
  }
  async function createRoom(host: Client, options: Record<string, unknown> = {}): Promise<string> {
    const frames = await act(host, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, manualStart: true, ...options }, 900)
    const created = frames.find((f) => f.type === 'private_room_updated')
    assert(created !== undefined, `(setup) масата на ${host.label}: ${JSON.stringify(frames.map((f) => f.type === 'error' ? f.data.message : f.type))}`)
    return created.data.room.id as string
  }
  const sit = (c: Client, roomId: string, team: 'A' | 'B', slotIndex: 0 | 1) => act(c, { type: 'join_private_room', privateRoomId: roomId, team, slotIndex })
  /** Заключена маса: покана -> приемане -> сядане. */
  async function inviteAndSit(host: Client, guest: Client, roomId: string, team: 'A' | 'B', slotIndex: 0 | 1): Promise<Frame[]> {
    const from = guest.frames.length
    await act(host, { type: 'invite_to_private_room', toProfiles: [{ profileId: guest.profile.profileId, displayName: guest.profile.displayName }] }, 800)
    const invite = await waitFrame(guest, (f) => f.type === 'private_room_invite_received', from)
    assert(invite !== null, `(setup) ${guest.label} не получи покана`)
    await act(guest, { type: 'respond_private_room_invite', inviteId: invite.data.inviteId, accept: true })
    return sit(guest, roomId, team, slotIndex)
  }
  const seated = (frames: Frame[], profileId: string) =>
    frames.some((f) => f.type === 'private_room_updated' && f.data.room.slots.some((s: any) => s.occupant?.profileId === profileId))
  function lastRoom(c: Client, roomId: string): any {
    return [...c.frames].reverse().find((f) => f.type === 'private_room_updated' && f.data.room.id === roomId)?.data.room ?? null
  }
  const roomHas = (room: any, profileId: string) => room !== null && room.slots.some((s: any) => s.occupant?.profileId === profileId)
  const enforcementAudits = () =>
    (h.db.prepare(`SELECT details_json FROM co_play_restriction_audit WHERE action = 'enforcement_removed' ORDER BY rowid`).all() as Array<{ details_json: string }>)
      .map((row) => JSON.parse(row.details_json) as Record<string, unknown>)
  const roomLedger = (profileId: string) =>
    (h.db.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE profile_id = ?`).get(profileId) as { n: number }).n
  async function closeAll(): Promise<void> {
    for (const c of opened.splice(0)) await c.close().catch(() => undefined)
    await sleep(600)
  }
  return { connect, waitFrame, act, register, addSecondProfile, befriend, adminApi, setFlag, impose, lift, createRoom, sit, inviteAndSit, seated, lastRoom, roomHas, enforcementAudits, roomLedger, closeAll }
}

async function prepare(h: GiftBackHarness): Promise<void> {
  await h.restartServer()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* рестарт */ }
    await sleep(300)
  }
}

// ═══ Сървър 1 ═══════════════════════════════════════════════════════════════
const h = await startGiftBackHarness({ patchServerSource: [SHORT_PRIVATE_MATCH] })
const env = makeEnv(h)
try {
  await prepare(h)
  await env.setFlag(true)

  // ─── R1 / R10 ─────────────────────────────────────────────────────────
  {
    const [pH, pA, pB, pC] = [await env.register('h1'), await env.register('a1'), await env.register('b1'), await env.register('c1')]
    const [H, A, B, C] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB), await env.connect('C', pC)]
    const roomId = await env.createRoom(H)
    assert(env.seated(await env.sit(A, roomId, 'B', 0), pA.profileId), '(setup) A седна')
    await env.impose(pA.profileId, pB.profileId)
    const asPartner = await env.sit(B, roomId, 'B', 1)
    const asOpponent = await env.sit(B, roomId, 'A', 1)
    await check('[R1] директно сядане: забранен партньор и забранен противник -> co_play_restricted с точния текст, без име; масата непроменена', () => {
      for (const frames of [asPartner, asOpponent]) {
        const error = frames.find(isRestricted)
        assert(error !== undefined && error.data.message === ROOM_TEXT, JSON.stringify(frames.map((f) => f.type === 'error' ? f.data : f.type)))
        assert(!error.data.message.includes(pA.displayName), 'съобщението съдържа името на A')
        assert(!env.seated(frames, pB.profileId), 'Б седна')
      }
      const room = env.lastRoom(H, roomId)
      assert(!env.roomHas(room, pB.profileId) && env.roomHas(room, pA.profileId) && env.roomHas(room, pH.profileId), 'съставът е променен')
      assert(h.getBalance(pB.profileId) === BALANCE && env.roomLedger(pB.profileId) === 0, 'портфейлът на Б')
    })
    const cSit = await env.sit(C, roomId, 'B', 1)
    await check('[R10] неограничен потребител сяда нормално на масата с ограничения A', () => {
      assert(env.seated(cSit, pC.profileId) && !cSit.some(isRestricted), JSON.stringify(cSit.map((f) => f.type)))
    })
    await env.closeAll()
  }

  // ─── R2 ───────────────────────────────────────────────────────────────
  {
    const [pH, pA, pB] = [await env.register('h2'), await env.register('a2'), await env.register('b2')]
    const aSecond = env.addSecondProfile(pA.profileId, `AltA${Date.now() % 100000}`)
    const [H, A, B] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB)]
    const roomId = await env.createRoom(H)
    assert(env.seated(await env.sit(B, roomId, 'B', 0), pB.profileId), '(setup) Б седна')
    await env.impose(aSecond, pB.profileId)
    const aSit = await env.sit(A, roomId, 'A', 1)
    await check('[R2] двустранност + друг профил: забрана чрез втори профил на акаунта на A; Б седнал -> A получава отказ', () => {
      assert(aSit.some(isRestricted) && !env.seated(aSit, pA.profileId), JSON.stringify(aSit.map((f) => f.type)))
    })
    await env.closeAll()
  }

  // ─── R3 ───────────────────────────────────────────────────────────────
  {
    const [pH, pA, pX, pD] = [await env.register('h3'), await env.register('a3'), await env.register('x3'), await env.register('d3')]
    const [H, A, X, D] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('X', pX), await env.connect('D', pD)]
    const roomId = await env.createRoom(H, { isLocked: true })
    assert(env.seated(await env.inviteAndSit(H, A, roomId, 'B', 0), pA.profileId), '(setup) A седна')
    await env.impose(pA.profileId, pX.profileId)
    const xFrom = X.frames.length
    const dFrom = D.frames.length
    const hFrames = await env.act(H, { type: 'invite_to_private_room', toProfiles: [{ profileId: pX.profileId, displayName: pX.displayName }, { profileId: pD.profileId, displayName: pD.displayName }] }, 1000)
    await check('[R3] покана към забранен -> отказ към домакина (без име); забраненият не получава покана; неограниченият — да', () => {
      const error = hFrames.find(isRestricted)
      assert(error !== undefined && !error.data.message.includes(pX.displayName), JSON.stringify(hFrames.map((f) => f.type)))
      assert(!X.frames.slice(xFrom).some((f) => f.type === 'private_room_invite_received'), 'X получи покана')
      assert(D.frames.slice(dFrom).some((f) => f.type === 'private_room_invite_received'), 'D не получи покана')
      assert(!(env.lastRoom(H, roomId)?.pendingInvites ?? []).some?.((i: any) => i.toProfileId === pX.profileId), 'поканата към X е създадена')
    })
    await env.closeAll()
  }

  // ─── R4 ───────────────────────────────────────────────────────────────
  {
    const [pH, pD, pE] = [await env.register('h4'), await env.register('d4'), await env.register('e4')]
    const [H, D, E] = [await env.connect('H', pH), await env.connect('D', pD), await env.connect('E', pE)]
    const roomId = await env.createRoom(H, { isLocked: true })
    await env.impose(pD.profileId, pE.profileId)
    const dFrom = D.frames.length
    await env.act(H, { type: 'invite_to_private_room', toProfiles: [{ profileId: pD.profileId, displayName: pD.displayName }] }, 800)
    const invite = await env.waitFrame(D, (f) => f.type === 'private_room_invite_received', dFrom)
    assert(invite !== null, '(setup) D не получи покана')
    assert(env.seated(await env.inviteAndSit(H, E, roomId, 'B', 0), pE.profileId), '(setup) E седна след поканата')
    const accept1 = await env.act(D, { type: 'respond_private_room_invite', inviteId: invite.data.inviteId, accept: true })
    await env.act(E, { type: 'leave_private_room' })
    const accept2 = await env.act(D, { type: 'respond_private_room_invite', inviteId: invite.data.inviteId, accept: true })
    await check('[R4] промяна на състава след поканата: приемането се отказва; поканата остава; след напускане на E приемането минава', () => {
      assert(accept1.some(isRestricted) && !accept1.some((f) => f.type === 'private_room_invite_accept_confirmed'), JSON.stringify(accept1.map((f) => f.type)))
      assert(accept2.some((f) => f.type === 'private_room_invite_accept_confirmed'), `второ приемане: ${JSON.stringify(accept2.map((f) => f.type === 'error' ? f.data.message : f.type))}`)
    })
    await env.closeAll()
  }

  // ─── R5 ───────────────────────────────────────────────────────────────
  {
    const [pH, pF, pP, pH2, pG, pP2] = [await env.register('h5'), await env.register('f5'), await env.register('p5'), await env.register('h5b'), await env.register('g5'), await env.register('p5b')]
    env.befriend(pH.profileId, pP.profileId)
    env.befriend(pH2.profileId, pP2.profileId)
    const [H, F, P, H2, G, P2] = [await env.connect('H', pH), await env.connect('F', pF), await env.connect('P', pP), await env.connect('H2', pH2), await env.connect('G', pG), await env.connect('P2', pP2)]
    const roomId = await env.createRoom(H, { invitePartner: true })
    await env.sit(F, roomId, 'B', 0)
    await env.impose(pF.profileId, pP.profileId)
    const pFrom = P.frames.length
    const invite1 = await env.act(H, { type: 'invite_private_room_partner', toProfileId: pP.profileId })
    const room2 = await env.createRoom(H2, { invitePartner: true })
    await env.impose(pG.profileId, pP2.profileId)
    const p2From = P2.frames.length
    await env.act(H2, { type: 'invite_private_room_partner', toProfileId: pP2.profileId })
    const partnerInvite = await env.waitFrame(P2, (f) => f.type === 'private_room_invite_received' && f.data.inviteKind === 'partner', p2From)
    assert(partnerInvite !== null, '(setup) P2 не получи покана за партньор')
    assert(env.seated(await env.sit(G, room2, 'B', 0), pG.profileId), '(setup) G седна след поканата')
    const accept1 = await env.act(P2, { type: 'respond_private_room_invite', inviteId: partnerInvite.data.inviteId, accept: true })
    const stillPending = env.lastRoom(H2, room2)?.partnerReservation?.invite ?? null
    await env.act(G, { type: 'leave_private_room' })
    const accept2 = await env.act(P2, { type: 'respond_private_room_invite', inviteId: partnerInvite.data.inviteId, accept: true }, 900)
    await check('[R5] покана за партньор: отказ при изпращане към забранен (без покана към него)', () => {
      assert(invite1.some(isRestricted), JSON.stringify(invite1.map((f) => f.type === 'error' ? f.data.code : f.type)))
      assert(!P.frames.slice(pFrom).some((f) => f.type === 'private_room_invite_received'), 'P получи покана')
    })
    await check('[R5] покана за партньор: промяна на състава -> отказ при приемане без промяна; след напускане на G приемането сяда P2', () => {
      assert(accept1.some(isRestricted) && !env.seated(accept1, pP2.profileId), JSON.stringify(accept1.map((f) => f.type)))
      assert(stillPending !== null, 'поканата за партньор е анулирана при отказа')
      assert(env.seated(accept2, pP2.profileId), `второ приемане: ${JSON.stringify(accept2.map((f) => f.type === 'error' ? f.data.message : f.type))}`)
    })
    await env.closeAll()
  }

  // ─── R6 ───────────────────────────────────────────────────────────────
  {
    // а) по-късно седналият излиза
    const [pH, pA, pB] = [await env.register('h6'), await env.register('a6'), await env.register('b6')]
    const [H, A, B] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB)]
    const roomId = await env.createRoom(H)
    await env.sit(A, roomId, 'B', 0)
    await sleep(50)
    await env.sit(B, roomId, 'A', 1)
    const auditsBefore = env.enforcementAudits().length
    const bFrom = B.frames.length
    const aFrom = A.frames.length
    await env.impose(pA.profileId, pB.profileId)
    await sleep(500)
    await check('[R6] налагане при обща маса: по-късно седналият (Б) излиза с известие; останалите остават; без удържан залог; одит', () => {
      const bFrames = B.frames.slice(bFrom)
      assert(bFrames.some((f) => f.type === 'private_room_left') && bFrames.some(isRestricted), JSON.stringify(bFrames.map((f) => f.type)))
      assert(!A.frames.slice(aFrom).some((f) => f.type === 'private_room_left'), 'A е изваден')
      const room = env.lastRoom(H, roomId)
      assert(env.roomHas(room, pA.profileId) && env.roomHas(room, pH.profileId) && !env.roomHas(room, pB.profileId), 'съставът')
      assert(h.getBalance(pB.profileId) === BALANCE && env.roomLedger(pB.profileId) === 0, 'залог')
      const audits = env.enforcementAudits().slice(auditsBefore)
      assert(audits.length === 1 && audits[0]!.context === 'private_room' && audits[0]!.trigger === 'restriction_imposed' && audits[0]!.profileId === pB.profileId, JSON.stringify(audits))
    })
    await env.closeAll()
  }
  {
    // б) защита на създателя (седнал отново по-късно)
    const [pH, pA] = [await env.register('h6b'), await env.register('a6b')]
    const [H, A] = [await env.connect('H', pH), await env.connect('A', pA)]
    const roomId = await env.createRoom(H)
    await env.sit(A, roomId, 'B', 0)
    await env.act(H, { type: 'leave_private_room' })
    const rejoin = await env.sit(H, roomId, 'A', 0)
    assert(env.seated(rejoin, pH.profileId), `(setup) създателят не седна отново: ${JSON.stringify(rejoin.map((f) => f.type === 'error' ? f.data.message : f.type))}`)
    const aFrom = A.frames.length
    const hFrom = H.frames.length
    await env.impose(pH.profileId, pA.profileId)
    await sleep(500)
    await check('[R6] защита на създателя: създателят остава дори да е седнал по-късно; другият излиза', () => {
      assert(A.frames.slice(aFrom).some((f) => f.type === 'private_room_left'), 'A не е изваден')
      assert(!H.frames.slice(hFrom).some((f) => f.type === 'private_room_left'), 'създателят е изваден')
    })
    await env.closeAll()
  }
  {
    // в) несъвместими покани се отменят, несвързаните остават
    const [pH, pA, pX, pY] = [await env.register('h6c'), await env.register('a6c'), await env.register('x6c'), await env.register('y6c')]
    const [H, A, X, Y] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('X', pX), await env.connect('Y', pY)]
    const roomId = await env.createRoom(H, { isLocked: true })
    assert(env.seated(await env.inviteAndSit(H, A, roomId, 'B', 0), pA.profileId), '(setup) A седна')
    await env.act(H, { type: 'invite_to_private_room', toProfiles: [{ profileId: pX.profileId, displayName: pX.displayName }, { profileId: pY.profileId, displayName: pY.displayName }] }, 900)
    const xFrom = X.frames.length
    const yFrom = Y.frames.length
    await env.impose(pA.profileId, pX.profileId)
    await sleep(500)
    await check('[R6] несъвместимата покана (към X) е отменена; поканата към Y и масата са незасегнати', () => {
      assert(X.frames.slice(xFrom).some((f) => f.type === 'private_room_invite_cancelled'), 'поканата към X не е отменена')
      assert(!Y.frames.slice(yFrom).some((f) => f.type === 'private_room_invite_cancelled'), 'поканата към Y е отменена')
      assert(env.roomHas(env.lastRoom(H, roomId), pA.profileId), 'A е изваден')
    })
    void roomId
    await env.closeAll()
  }

  // ─── R7 ───────────────────────────────────────────────────────────────
  {
    await env.setFlag(false)
    const [pH, pA, pB] = [await env.register('h7'), await env.register('a7'), await env.register('b7')]
    const [H, A, B] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB)]
    const roomId = await env.createRoom(H)
    await env.impose(pA.profileId, pB.profileId)
    await env.sit(A, roomId, 'B', 0)
    const bSit = await env.sit(B, roomId, 'A', 1)
    const pX = await env.register('x7')
    const X = await env.connect('X', pX)
    await env.sit(X, roomId, 'B', 1)
    const bMark = B.frames.length
    const xMark = X.frames.length
    await env.impose(pA.profileId, pX.profileId)
    await sleep(500)
    await check('[R7] изключен флаг: сядане без отказ; налагане при обща маса не маха никого', () => {
      assert(env.seated(bSit, pB.profileId) && !bSit.some(isRestricted), JSON.stringify(bSit.map((f) => f.type)))
      assert(!X.frames.slice(xMark).some((f) => f.type === 'private_room_left'), 'X е изваден при изключен флаг')
    })
    await env.setFlag(true)
    await sleep(800)
    await check('[R7] включване на флага при съществуващ конфликт: по-късно седналите (Б, X) излизат; A и създателят остават', () => {
      assert(B.frames.slice(bMark).some((f) => f.type === 'private_room_left') && B.frames.slice(bMark).some(isRestricted), 'Б не е изваден')
      assert(X.frames.slice(xMark).some((f) => f.type === 'private_room_left'), 'X не е изваден')
      const room = env.lastRoom(H, roomId)
      assert(env.roomHas(room, pA.profileId) && env.roomHas(room, pH.profileId), 'A/създателят са изведени')
      const audits = env.enforcementAudits().filter((a) => a.context === 'private_room' && a.trigger === 'flag_enabled')
      assert(audits.length === 2, JSON.stringify(audits))
    })
    await env.closeAll()
  }

  // ─── R8: започнат мач ─────────────────────────────────────────────────
  {
    const [pA, pB] = [await env.register('a8'), await env.register('b8')]
    const A = await env.connect('A', pA)
    let B = await env.connect('B', pB)
    const roomId = await env.createRoom(A, { manualStart: false })
    await env.sit(B, roomId, 'B', 0)
    const aFrom = A.frames.length
    const bFrom = B.frames.length
    await env.act(A, { type: 'add_bot_to_private_room_team', team: 'A' })
    await env.act(B, { type: 'add_bot_to_private_room_team', team: 'B' })
    const aFull = await env.waitFrame(A, (f) => f.type === 'private_room_full', aFrom, 8000)
    const bFull = await env.waitFrame(B, (f) => f.type === 'private_room_full', bFrom, 8000)
    assert(aFull !== null && bFull !== null, '(setup) частният мач не стартира')
    const gameId = aFull.data.roomId as string
    const marks = { A: A.frames.length, B: B.frames.length }
    await env.impose(pA.profileId, pB.profileId)
    await sleep(800)
    const probe = await env.act(A, { type: 'submit_play_card', roomId: gameId, cardId: 'probe-invalid-card' }, 800)
    await check('[R8] започнат мач: налагането не го прекъсва и не маха играчи', () => {
      for (const [c, mark] of [[A, marks.A], [B, marks.B]] as const) {
        assert(!c.frames.slice(mark).some((f) => isRestricted(f) || f.type === 'private_room_left' || f.type === 'room_closed'), `${c.label}: ${JSON.stringify(c.frames.slice(mark).map((f) => f.type))}`)
      }
      const errors = probe.filter((f) => f.type === 'error').map((f) => String(f.data.message))
      assert(!errors.includes('You are not attached to this room.') && !errors.includes('Room was not found.'), JSON.stringify(errors))
    })
    await B.close()
    await sleep(800)
    B = await env.connect('B', pB)
    const sessionFrames = await env.act(B, { type: 'join_matchmaking', stake: STAKE }, 900)
    const inGame = sessionFrames.find((f) => f.type === 'session_in_game')
    const resumed = inGame
      ? await env.act(B, { type: 'resume_room', roomId: inGame.data.roomId, reconnectToken: inGame.data.reconnectToken }, 1200)
      : []
    await check('[R8] reconnect към започнатия мач работи (session_in_game -> resume_room -> room_resumed)', () => {
      assert(inGame !== undefined && inGame.data.roomId === gameId, JSON.stringify(sessionFrames.map((f) => f.type)))
      assert(resumed.some((f) => f.type === 'room_resumed'), JSON.stringify(resumed.map((f) => f.type === 'error' ? f.data.message : f.type)))
    })
    // Край на мача (до 1 точка; ходовете на хората ги поемат ботовете).
    const ended = await env.waitFrame(A, (f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.roomStatus === 'finished', 0, 300_000)
    assert(ended !== null, '(setup) мачът не стигна до края')
    await sleep(1500)
    const balances = { A: h.getBalance(pA.profileId), B: h.getBalance(pB.profileId) }
    await env.act(A, { type: 'request_replay', roomId: gameId }, 600)
    const bVote = await env.act(B, { type: 'request_replay', roomId: gameId }, 5000)
    const lastSnap = [...B.frames].reverse().find((f) => f.type === 'room_snapshot' && f.data?.roomId === gameId)?.data
    const bSeat = [...B.frames].reverse().find((f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.yourSeat)?.data?.yourSeat
    await check('[R8] повторен мач между ограничените акаунти се отказва: по-късно гласувалият (Б) -> „изход“; без нов залог', () => {
      const restarted = bVote.some((f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.roomStatus !== 'finished' && f.data?.game?.matchEnded == null)
      assert(!restarted, 'повторният мач стартира')
      const matchEnded = lastSnap?.game?.matchEnded
      assert(matchEnded != null && Array.isArray(matchEnded.leaveVotes) && matchEnded.leaveVotes.includes(bSeat), `leaveVotes: ${JSON.stringify(matchEnded?.leaveVotes)} (място ${bSeat})`)
      assert(h.getBalance(pA.profileId) === balances.A && h.getBalance(pB.profileId) === balances.B, `баланси: ${JSON.stringify(balances)} -> ${h.getBalance(pA.profileId)}, ${h.getBalance(pB.profileId)}`)
    })
    await env.closeAll()
  }

  // ─── R9 ───────────────────────────────────────────────────────────────
  {
    const [pH, pA, pB] = [await env.register('h9'), await env.register('a9'), await env.register('b9')]
    const [H, A, B] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB)]
    const roomId = await env.createRoom(H)
    await env.sit(A, roomId, 'B', 0)
    const id = await env.impose(pA.profileId, pB.profileId)
    await env.lift(id)
    const bSit = await env.sit(B, roomId, 'A', 1)
    await check('[R9] отменена забрана не пречи', () => {
      assert(env.seated(bSit, pB.profileId), JSON.stringify(bSit.map((f) => f.type === 'error' ? f.data.message : f.type)))
    })
    await env.closeAll()
  }
  {
    const [pH, pA, pB] = [await env.register('h9e'), await env.register('a9e'), await env.register('b9e')]
    const id = await env.impose(pA.profileId, pB.profileId, { durationDays: 1 })
    h.db.prepare(`UPDATE co_play_restrictions SET expires_at = ? WHERE restriction_id = ?`).run(new Date(Date.now() - 1000).toISOString(), id)
    await prepare(h)
    const [H, A, B] = [await env.connect('H', pH), await env.connect('A', pA), await env.connect('B', pB)]
    const roomId = await env.createRoom(H)
    await env.sit(A, roomId, 'B', 0)
    const bSit = await env.sit(B, roomId, 'A', 1)
    await check('[R9] изтекла забрана не пречи (след рестарт)', () => {
      assert(env.seated(bSit, pB.profileId), JSON.stringify(bSit.map((f) => f.type === 'error' ? f.data.message : f.type)))
    })
    await env.closeAll()
  }
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки (сървър 1)', () => { throw error })
} finally {
  await env.closeAll().catch(() => undefined)
  await h.close()
}

// ═══ Сървър 2: изключена САМО входната проверка на store-а ══════════════════
const h2 = await startGiftBackHarness({ patchServerSource: [BYPASS_STORE_ENTRY_CHECK] })
const env2 = makeEnv(h2)
try {
  await prepare(h2)
  await env2.setFlag(true)
  {
    const [pH, pA, pB] = [await env2.register('h11'), await env2.register('a11'), await env2.register('b11')]
    const [H, A, B] = [await env2.connect('H', pH), await env2.connect('A', pA), await env2.connect('B', pB)]
    await env2.impose(pA.profileId, pB.profileId)
    const roomId = await env2.createRoom(H, { manualStart: true })
    await env2.sit(A, roomId, 'A', 1)
    await sleep(50)
    const bSit = await env2.sit(B, roomId, 'B', 0)
    assert(env2.seated(bSit, pB.profileId), '(setup) входната проверка не е изключена')
    await env2.act(B, { type: 'add_bot_to_private_room_team', team: 'B' })
    const marks = { A: A.frames.length, B: B.frames.length }
    const start = await env2.act(H, { type: 'start_private_room' }, 1200)
    await check('[R11] ръчен старт: финалната проверка не допуска мача; Б (по-късно седнал) излиза с известие; одит pre_start', () => {
      assert(start.some(isRestricted), JSON.stringify(start.map((f) => f.type === 'error' ? f.data.code : f.type)))
      assert(![H, A, B].some((c) => c.frames.some((f) => f.type === 'private_room_full')), 'мачът стартира')
      assert(B.frames.slice(marks.B).some((f) => f.type === 'private_room_left') && B.frames.slice(marks.B).some(isRestricted), 'Б не е изваден')
      assert(!A.frames.slice(marks.A).some((f) => f.type === 'private_room_left'), 'A е изваден')
      const audits = env2.enforcementAudits().filter((a) => a.trigger === 'pre_start')
      assert(audits.length === 1 && audits[0]!.profileId === pB.profileId, JSON.stringify(audits))
    })
    await env2.closeAll()
  }
  {
    const [pH, pA, pB] = [await env2.register('h12'), await env2.register('a12'), await env2.register('b12')]
    const [H, A, B] = [await env2.connect('H', pH), await env2.connect('A', pA), await env2.connect('B', pB)]
    await env2.impose(pA.profileId, pB.profileId)
    const roomId = await env2.createRoom(H, { manualStart: false })
    await env2.sit(A, roomId, 'A', 1)
    await sleep(50)
    await env2.sit(B, roomId, 'B', 0)
    const bMark = B.frames.length
    await env2.act(B, { type: 'add_bot_to_private_room_team', team: 'B' }, 1200)
    await check('[R12] автоматичен старт: финалната проверка не допуска мача; Б излиза', () => {
      assert(![H, A, B].some((c) => c.frames.some((f) => f.type === 'private_room_full')), 'мачът стартира')
      assert(B.frames.slice(bMark).some((f) => f.type === 'private_room_left') && B.frames.slice(bMark).some(isRestricted), JSON.stringify(B.frames.slice(bMark).map((f) => f.type)))
      assert(h2.getBalance(pB.profileId) === BALANCE, 'залог на Б')
    })
    void roomId
    await env2.closeAll()
  }
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h2.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки (сървър 2)', () => { throw error })
} finally {
  await env2.closeAll().catch(() => undefined)
  await h2.close()
}

finishAndExit()
