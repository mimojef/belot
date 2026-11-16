/**
 * checkCoPlayMatchmakingE2E.ts — „Забрана за съвместна игра“, Етап 2:
 * случайните маси на Белот. Реален изолиран сървър (giftBackTestHarness),
 * реални WS връзки със сесийни бисквитки, реално административно API.
 *
 *   [C1]  А чака, Б (забрана) получава отказ co_play_restricted (точният текст, без име);
 *   [C2]  обратната посока;
 *   [C3]  забрана, наложена чрез ДРУГ профил на акаунта на А;
 *   [C4]  при отказ: таймер, бройка и портфейл непроменени;
 *   [C5]  Б чака на друг залог — запазва участието си;
 *   [C6]  А напуска -> Б влиза;
 *   [C7]  А вече играе -> Б влиза в новата чакалня;
 *   [C8]  налагане при общо чакане: по-късно влезлият излиза, таймерът на А е същият;
 *   [C9]  залогът е върнат точно веднъж (и затварянето не връща втори път) + одит;
 *   [C11] отменена и изтекла забрана не пречат;
 *   [C12] изключен флаг: без отказ, налагането не маха никого;
 *   [C13] включване на флага при съществуващ конфликт: по-късно влезлият излиза;
 *   [C14] неограничени играчи и ботове не са засегнати;
 *   [C10] финална проверка преди старт (втори сървър с изключена САМО входната
 *         проверка — конфликтът се стига само така): групата не стартира,
 *         Б излиза с връщане, след нов играч стартират само неограничените.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayMatchmakingE2E.ts
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckCoPlayMatchmakingE2E\n')

const BALANCE = 50_000_000
const RESTRICTED_TEXT = 'В тази чакалня има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'

type Frame = { at: number; type: string; data: any }
type Client = { label: string; profile: TestProfile; frames: Frame[]; send: (m: unknown) => void; close: () => Promise<void> }

function makeEnv(h: GiftBackHarness) {
  const wsOrigin = h.backendOrigin.replace(/^http/, 'ws')

  async function connect(label: string, profile: TestProfile): Promise<Client> {
    const socket = new WebSocket(`${wsOrigin}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}` } })
    const frames: Frame[] = []
    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(String(raw))
        frames.push({ at: Date.now(), type: String(data?.type ?? ''), data })
      } catch { /* not JSON */ }
    })
    await new Promise<void>((resolveOpen, reject) => { socket.once('open', () => resolveOpen()); socket.once('error', reject) })
    await sleep(300)
    return {
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

  async function register(tag: string): Promise<TestProfile> {
    // Само изолираната тестова база: много регистрации от един IP.
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    const p = await h.register(tag)
    h.setBalance(p.profileId, BALANCE)
    return p
  }

  function accountOf(profileId: string): string {
    return (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  }

  /** Втори профил на същия акаунт (без сесия) — за налагане „чрез друг профил“. */
  function addSecondProfile(profileId: string, name: string): string {
    const id = randomUUID()
    h.db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human')`)
      .run(id, accountOf(profileId), name, `${name.toLowerCase()}-${id.slice(0, 8)}`)
    return id
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
    assert(r.status === 200 && r.body.settings.enabled === enabled, `флаг ${enabled}: ${JSON.stringify(r)}`)
  }
  async function impose(a: string, b: string, extra: Record<string, unknown> = { indefinite: true }): Promise<string> {
    const r = await adminApi('POST', '', { firstProfileId: a, secondProfileId: b, reason: 'E2E тест', ...extra })
    assert(r.status === 201, `налагане: ${JSON.stringify(r)}`)
    return r.body.restriction.restrictionId as string
  }
  async function lift(id: string): Promise<void> {
    const r = await adminApi('POST', `/${id}/lift`, {})
    assert(r.status === 200, `отмяна: ${JSON.stringify(r)}`)
  }

  const ledger = (profileId: string, entryType: 'stake_debit' | 'stake_refund') =>
    (h.db.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE profile_id = ? AND entry_type = ? AND room_id LIKE 'queue:%'`).get(profileId, entryType) as { n: number }).n

  const enforcementAudits = () =>
    (h.db.prepare(`SELECT details_json FROM co_play_restriction_audit WHERE action = 'enforcement_removed' ORDER BY rowid`).all() as Array<{ details_json: string }>)
      .map((row) => JSON.parse(row.details_json) as Record<string, unknown>)

  async function join(c: Client, stake: number): Promise<number> {
    const from = c.frames.length
    c.send({ type: 'join_matchmaking', stake })
    await sleep(400)
    return from
  }

  return { connect, waitFrame, register, addSecondProfile, adminApi, setFlag, impose, lift, ledger, enforcementAudits, join, accountOf }
}

function isRestrictedError(f: Frame): boolean {
  return f.type === 'error' && f.data.code === 'co_play_restricted'
}

async function prepare(h: GiftBackHarness, waitSeconds: number): Promise<number[]> {
  h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run(String(waitSeconds))
  await h.restartServer()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* рестарт */ }
    await sleep(300)
  }
  const stakes = (h.db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 AND min_level <= 1 ORDER BY stake_amount`).all() as Array<{ stake_amount: number }>).map((r) => r.stake_amount)
  assert(stakes.length >= 3, `(setup) нужни са 3 залога за ниво 1, има ${JSON.stringify(stakes)}`)
  return stakes
}

// ═══ Сървър 1: реалният код ═════════════════════════════════════════════════
const h = await startGiftBackHarness()
const opened: Client[] = []
try {
  const [S1, S2, S3] = await prepare(h, 600) as [number, number, number]
  const env = makeEnv(h)
  const open = async (label: string, profile: TestProfile) => { const c = await env.connect(label, profile); opened.push(c); return c }
  const closeAll = async (...clients: Client[]) => { for (const c of clients) await c.close(); await sleep(500) }

  await check('[C0] (setup) флагът е изключен по подразбиране', async () => {
    const r = await env.adminApi('GET', '/settings')
    assert(r.status === 200 && r.body.settings.enabled === false, JSON.stringify(r.body))
  })

  // ─── C12 / C13: изключен флаг, после включване при съществуващ конфликт ──
  {
    const [pA, pB] = [await env.register('fa'), await env.register('fb')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    await env.impose(pA.profileId, pB.profileId)
    await env.join(A, S1)
    const bFrom = await env.join(B, S1)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFrom, 2000)
    await check('[C12] изключен флаг: Б влиза при чакащ А (без отказ)', () => {
      assert(bJoined !== null && bJoined.data.queuedPlayers === 2, `Б: ${JSON.stringify(B.frames.slice(bFrom).map((f) => f.type))}`)
      assert(!B.frames.slice(bFrom).some(isRestrictedError), 'отказ при изключен флаг')
    })
    // Налагане при изключен флаг докато двамата чакат — никой не се маха.
    const [pX] = [await env.register('fx')]
    const X = await open('X', pX)
    await env.join(X, S1)
    const marks = { A: A.frames.length, X: X.frames.length }
    await env.impose(pA.profileId, pX.profileId)
    await sleep(800)
    await check('[C12] изключен флаг: налагане при общо чакане не маха никого', () => {
      for (const c of [A, X]) assert(!c.frames.slice(marks[c.label as 'A' | 'X']).some((f) => f.type === 'matchmaking_left'), `${c.label} е изваден`)
      assert(env.enforcementAudits().length === 0, 'одит на премахване при изключен флаг')
    })
    const balanceB = h.getBalance(pB.profileId)
    const bMark = B.frames.length
    const xMark = X.frames.length
    const aMark = A.frames.length
    await env.setFlag(true)
    const bLeft = await env.waitFrame(B, (f) => f.type === 'matchmaking_left' && f.data.removed === true, bMark, 3000)
    const xLeft = await env.waitFrame(X, (f) => f.type === 'matchmaking_left' && f.data.removed === true, xMark, 3000)
    await sleep(500)
    await check('[C13] включване на флага: по-късно влезлите (Б и Х) излизат с известие и връщане; А остава', () => {
      assert(bLeft !== null && B.frames.slice(bMark).some(isRestrictedError), 'Б не е изваден с известие')
      assert(xLeft !== null && X.frames.slice(xMark).some(isRestrictedError), 'Х не е изваден с известие')
      assert(!A.frames.slice(aMark).some((f) => f.type === 'matchmaking_left'), 'А е изваден')
      assert(h.getBalance(pB.profileId) === BALANCE && balanceB === BALANCE - S1, `Б баланс: преди ${balanceB}, след ${h.getBalance(pB.profileId)}`)
      assert(env.ledger(pB.profileId, 'stake_refund') === 1, 'Б: точно едно връщане')
      const audits = env.enforcementAudits()
      assert(audits.length === 2 && audits.every((a) => a.trigger === 'flag_enabled'), JSON.stringify(audits))
    })
    await closeAll(A, B, X)
  }

  // ─── C1 / C4: А чака, Б получава отказ ────────────────────────────────
  {
    const [pA, pB, pC] = [await env.register('a1'), await env.register('b1'), await env.register('c1')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    const C = await open('C', pC)
    await env.impose(pB.profileId, pA.profileId)
    const aFrom = await env.join(A, S1)
    const aJoined = await env.waitFrame(A, (f) => f.type === 'matchmaking_joined', aFrom)
    const aMark = A.frames.length
    const bFrom = await env.join(B, S1)
    await sleep(600)
    const bFrames = B.frames.slice(bFrom)
    await check('[C1] А чака, Б получава отказ co_play_restricted с точния текст, без име', () => {
      const error = bFrames.find(isRestrictedError)
      assert(error !== undefined, `Б: ${JSON.stringify(bFrames.map((f) => f.type))}`)
      assert(error.data.message === RESTRICTED_TEXT, `текст: ${error.data.message}`)
      assert(!error.data.message.includes(pA.displayName), 'съобщението съдържа името на А')
      assert(bFrames.some((f) => f.type === 'matchmaking_left' && f.data.removed === false), 'Б: липсва matchmaking_left (връщане в лобито)')
      assert(!bFrames.some((f) => f.type === 'matchmaking_joined'), 'Б е влязъл')
    })
    const aBeforeC = A.frames.length
    const cFrom = await env.join(C, S1)
    const cJoined = await env.waitFrame(C, (f) => f.type === 'matchmaking_joined', cFrom)
    await check('[C4] при отказ: бройката и таймерът на А непроменени, портфейлът на Б непокътнат', () => {
      const aStatusesBeforeC = A.frames.slice(aMark, aBeforeC).filter((f) => f.type === 'matchmaking_status')
      assert(
        aStatusesBeforeC.every((f) => f.data.queuedPlayers === 1 && f.data.countdownEndsAt === aJoined?.data.countdownEndsAt),
        `А статус след отказа: ${JSON.stringify(aStatusesBeforeC.map((f) => [f.data.queuedPlayers, f.data.countdownEndsAt]))}`,
      )
      assert(cJoined !== null && cJoined.data.queuedPlayers === 2, `бройка след отказа: ${cJoined?.data.queuedPlayers}`)
      assert(aJoined !== null && cJoined.data.countdownEndsAt === aJoined.data.countdownEndsAt, 'таймерът на масата е променен')
      assert(h.getBalance(pB.profileId) === BALANCE, `Б баланс: ${h.getBalance(pB.profileId)}`)
      assert(env.ledger(pB.profileId, 'stake_debit') === 0 && env.ledger(pB.profileId, 'stake_refund') === 0, 'Б: движение в ledger')
    })
    await closeAll(A, B, C)
  }

  // ─── C2: обратна посока ──────────────────────────────────────────────
  {
    const [pA, pB] = [await env.register('a2'), await env.register('b2')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    await env.impose(pA.profileId, pB.profileId)
    await env.join(B, S1)
    const aFrom = await env.join(A, S1)
    await sleep(500)
    await check('[C2] обратна посока: Б чака, А получава отказ', () => {
      assert(A.frames.slice(aFrom).some(isRestrictedError), 'А не получи отказ')
      assert(!A.frames.slice(aFrom).some((f) => f.type === 'matchmaking_joined'), 'А е влязъл')
    })
    await closeAll(A, B)
  }

  // ─── C3: друг профил на същия акаунт ─────────────────────────────────
  {
    const [pA, pB] = [await env.register('a3'), await env.register('b3')]
    const a3second = env.addSecondProfile(pA.profileId, `AltA${Date.now() % 100000}`)
    const A = await open('A', pA)
    const B = await open('B', pB)
    await env.impose(a3second, pB.profileId)
    await env.join(A, S1)
    const bFrom = await env.join(B, S1)
    await sleep(500)
    await check('[C3] забрана, наложена чрез друг профил на акаунта на А, важи за профила, който чака', () => {
      assert(B.frames.slice(bFrom).some(isRestrictedError), 'Б не получи отказ')
    })
    await closeAll(A, B)
  }

  // ─── C5: Б запазва участието си на друг залог ───────────────────────
  {
    const [pA, pB, pD] = [await env.register('a5'), await env.register('b5'), await env.register('d5')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    const D = await open('D', pD)
    await env.impose(pA.profileId, pB.profileId)
    await env.join(A, S1)
    const bFirst = await env.join(B, S2)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFirst)
    const bFrom = await env.join(B, S1)
    await sleep(500)
    const dFrom = await env.join(D, S2)
    const dJoined = await env.waitFrame(D, (f) => f.type === 'matchmaking_joined', dFrom)
    await check('[C5] Б чака на друг залог: получава отказ, без matchmaking_left, екранът му се връща към залога му; остава в чакалнята', () => {
      const frames = B.frames.slice(bFrom)
      assert(frames.some(isRestrictedError), 'Б не получи отказ')
      assert(!frames.some((f) => f.type === 'matchmaking_left'), 'Б получи matchmaking_left')
      assert(frames.some((f) => f.type === 'matchmaking_status' && f.data.stake === S2), 'Б не получи статуса на своя залог')
      assert(bJoined !== null && dJoined !== null && dJoined.data.queuedPlayers === 2, `Б не е в чакалнята на ${S2}: ${dJoined?.data.queuedPlayers}`)
      assert(dJoined.data.countdownEndsAt === bJoined.data.countdownEndsAt, 'таймерът на чакалнята на Б е променен')
    })
    await closeAll(A, B, D)
  }

  // ─── C6: А напуска, Б влиза ─────────────────────────────────────────
  {
    const [pA, pB] = [await env.register('a6'), await env.register('b6')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    await env.impose(pA.profileId, pB.profileId)
    await env.join(A, S1)
    const rejectedFrom = await env.join(B, S1)
    A.send({ type: 'leave_matchmaking' })
    await sleep(500)
    const bFrom = await env.join(B, S1)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFrom)
    await check('[C6] след отказ А напуска чакалнята -> Б влиза успешно', () => {
      assert(B.frames.slice(rejectedFrom, bFrom).some(isRestrictedError), '(setup) първият опит не е отказан')
      assert(bJoined !== null && bJoined.data.queuedPlayers === 1, `Б: ${JSON.stringify(B.frames.slice(bFrom).map((f) => f.type))}`)
    })
    await closeAll(A, B)
  }

  // ─── C7: А вече играе, Б влиза в новата чакалня ─────────────────────
  {
    const [pA, pB, p1, p2, p3] = [await env.register('a7'), await env.register('b7'), await env.register('m1'), await env.register('m2'), await env.register('m3')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    const M = [await open('M1', p1), await open('M2', p2), await open('M3', p3)]
    await env.impose(pA.profileId, pB.profileId)
    const aFrom = await env.join(A, S3)
    for (const m of M) await env.join(m, S3)
    const aGame = await env.waitFrame(A, (f) => f.type === 'match_found', aFrom, 8000)
    const bFrom = await env.join(B, S3)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFrom)
    await check('[C7] А е в започнат мач -> Б влиза в новата чакалня за същия залог', () => {
      assert(aGame !== null, '(setup) мачът на А не стартира')
      assert(bJoined !== null && bJoined.data.queuedPlayers === 1, `Б: ${JSON.stringify(B.frames.slice(bFrom).map((f) => f.type))}`)
      assert(!B.frames.slice(bFrom).some(isRestrictedError), 'Б получи отказ')
    })
    await closeAll(B)
  }

  // ─── C8 / C9: налагане при общо чакане ──────────────────────────────
  {
    const [pA, pB] = [await env.register('a8'), await env.register('b8')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    const aFrom = await env.join(A, S1)
    const aJoined = await env.waitFrame(A, (f) => f.type === 'matchmaking_joined', aFrom)
    await env.join(B, S1)
    for (let i = 0; i < 20 && env.ledger(pB.profileId, 'stake_debit') < 1; i += 1) await sleep(200)
    const debitedB = h.getBalance(pB.profileId)
    const marks = { A: A.frames.length, B: B.frames.length }
    const auditsBefore = env.enforcementAudits().length
    await env.impose(pA.profileId, pB.profileId)
    const bLeft = await env.waitFrame(B, (f) => f.type === 'matchmaking_left' && f.data.removed === true, marks.B, 3000)
    const aStatus = await env.waitFrame(A, (f) => f.type === 'matchmaking_status', marks.A, 3000)
    await check('[C8] налагане при общо чакане: Б (по-късно влязъл) излиза с известие; А остава с непроменен таймер', () => {
      assert(bLeft !== null && B.frames.slice(marks.B).some(isRestrictedError), 'Б не е изваден с известие')
      assert(!A.frames.slice(marks.A).some((f) => f.type === 'matchmaking_left'), 'А е изваден')
      assert(aStatus !== null && aStatus.data.queuedPlayers === 1, `А бройка: ${aStatus?.data.queuedPlayers}`)
      assert(aJoined !== null && aStatus.data.countdownEndsAt === aJoined.data.countdownEndsAt, 'таймерът на А е променен')
    })
    await B.close()
    await sleep(800)
    await check('[C9] залогът на Б е върнат точно веднъж; затварянето не връща втори път; одит на действието', () => {
      assert(debitedB === BALANCE - S1, `(setup) Б не е платил залог: ${debitedB}`)
      assert(h.getBalance(pB.profileId) === BALANCE, `Б баланс: ${h.getBalance(pB.profileId)}`)
      assert(env.ledger(pB.profileId, 'stake_debit') === 1 && env.ledger(pB.profileId, 'stake_refund') === 1, `Б ledger: debit=${env.ledger(pB.profileId, 'stake_debit')} refund=${env.ledger(pB.profileId, 'stake_refund')}`)
      const audits = env.enforcementAudits().slice(auditsBefore)
      assert(audits.length === 1, `одит: ${JSON.stringify(audits)}`)
      const audit = audits[0]!
      assert(audit.trigger === 'restriction_imposed' && audit.profileId === pB.profileId && audit.stakeRefunded === true && audit.stake === S1, JSON.stringify(audit))
    })
    await closeAll(A)
  }

  // ─── C11: отменена и изтекла забрана ────────────────────────────────
  {
    const [pA, pB] = [await env.register('a11'), await env.register('b11')]
    const A = await open('A', pA)
    const B = await open('B', pB)
    const id = await env.impose(pA.profileId, pB.profileId)
    await env.lift(id)
    await env.join(A, S1)
    const bFrom = await env.join(B, S1)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFrom)
    await check('[C11] отменена забрана не пречи', () => {
      assert(bJoined !== null && !B.frames.slice(bFrom).some(isRestrictedError), JSON.stringify(B.frames.slice(bFrom).map((f) => f.type)))
    })
    await closeAll(A, B)
  }
  {
    const [pA, pB] = [await env.register('a11e'), await env.register('b11e')]
    const id = await env.impose(pA.profileId, pB.profileId, { durationDays: 1 })
    // Срокът изтича (изолираната база) -> рестарт: зареждат се само активните.
    h.db.prepare(`UPDATE co_play_restrictions SET expires_at = ? WHERE restriction_id = ?`).run(new Date(Date.now() - 1000).toISOString(), id)
    await prepare(h, 600)
    const A = await open('A', pA)
    const B = await open('B', pB)
    await env.join(A, S1)
    const bFrom = await env.join(B, S1)
    const bJoined = await env.waitFrame(B, (f) => f.type === 'matchmaking_joined', bFrom)
    await check('[C11] изтекла забрана не пречи (флагът остава включен след рестарт)', async () => {
      assert(bJoined !== null && !B.frames.slice(bFrom).some(isRestrictedError), JSON.stringify(B.frames.slice(bFrom).map((f) => f.type)))
      const settings = await env.adminApi('GET', '/settings')
      assert(settings.body.settings.enabled === true, 'флагът след рестарт')
    })
    await closeAll(A, B)
  }

  // ─── C14: неограничени играчи и ботове ──────────────────────────────
  {
    const [pA, pB, pC, pD] = [await env.register('a14'), await env.register('b14'), await env.register('c14'), await env.register('d14')]
    const A = await open('A', pA)
    const C = await open('C', pC)
    const D = await open('D', pD)
    await env.impose(pA.profileId, pB.profileId)
    await env.join(A, S2)
    const cFrom = await env.join(C, S2)
    const dFrom = await env.join(D, S2)
    const cJoined = await env.waitFrame(C, (f) => f.type === 'matchmaking_joined', cFrom)
    const dJoined = await env.waitFrame(D, (f) => f.type === 'matchmaking_joined', dFrom)
    await check('[C14] неограничени играчи при чакащ ограничен А: влизат нормално', () => {
      assert(cJoined !== null && dJoined !== null && dJoined.data.queuedPlayers === 3, `бройка: ${dJoined?.data.queuedPlayers}`)
      assert(![C, D].some((c) => c.frames.some(isRestrictedError)), 'неограничен играч получи отказ')
    })
    await closeAll(A, C, D)
  }

  await check('[C14b] ограничен играч сам + ботове: масата стартира с ботове (кратка чакалня)', async () => {
    h.db.prepare(`UPDATE admin_settings SET setting_value = '20' WHERE setting_key = 'belot_random_table_wait_seconds'`).run()
    const [pA, pB] = [await env.register('a14b'), await env.register('b14b')]
    const A = await open('A', pA)
    await env.impose(pA.profileId, pB.profileId)
    const aFrom = await env.join(A, S3)
    const found = await env.waitFrame(A, (f) => f.type === 'match_found', aFrom, 40_000)
    assert(found !== null && found.data.botPlayers === 3, `match_found: ${JSON.stringify(found?.data)}`)
    await closeAll(A)
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки (сървър 1)', () => { throw error })
} finally {
  for (const c of opened) await c.close().catch(() => undefined)
  await h.close()
}

// ═══ Сървър 2: изключена САМО входната проверка (финална проверка) ══════════
const h2 = await startGiftBackHarness({
  patchServerSource: [{
    file: 'index.ts',
    find: 'getQueueEntryByConnectionId(matchmakingState.queueEntries, connection.id)?.stake !== message.stake &&',
    replace: 'false && getQueueEntryByConnectionId(matchmakingState.queueEntries, connection.id)?.stake !== message.stake &&',
  }],
})
const opened2: Client[] = []
try {
  const [S1] = await prepare(h2, 600) as [number]
  const env = makeEnv(h2)
  const open = async (label: string, profile: TestProfile) => { const c = await env.connect(label, profile); opened2.push(c); return c }
  const [pA, pB, pC, pD, pE] = [await env.register('fa'), await env.register('fb'), await env.register('fc'), await env.register('fd'), await env.register('fe')]
  const [A, B, C, D, E] = [await open('A', pA), await open('B', pB), await open('C', pC), await open('D', pD), await open('E', pE)]
  await env.setFlag(true)
  await env.impose(pA.profileId, pB.profileId)
  const marks = { A: A.frames.length, C: C.frames.length, D: D.frames.length }
  await env.join(A, S1)
  await env.join(C, S1)
  await env.join(D, S1)
  const bFrom = await env.join(B, S1)
  await sleep(1000)
  const bFrames = B.frames.slice(bFrom)
  await check('[C10] финална проверка: група А,C,D,Б не стартира; Б (по-късно влязъл) излиза с известие', () => {
    assert(bFrames.some((f) => f.type === 'matchmaking_joined'), '(setup) входната проверка не е изключена — Б не влезе')
    assert(![A, C, D, B].some((c) => c.frames.some((f) => f.type === 'match_found')), 'стартира мач с ограничена двойка')
    assert(bFrames.some((f) => f.type === 'matchmaking_left' && f.data.removed === true) && bFrames.some(isRestrictedError), 'Б не е изваден с известие')
    for (const c of [A, C, D]) assert(!c.frames.slice(marks[c.label as 'A' | 'C' | 'D']).some((f) => f.type === 'matchmaking_left'), `${c.label} е изваден`)
  })
  await check('[C10] финална проверка: залогът на Б е върнат точно веднъж; одит pre_start', () => {
    assert(h2.getBalance(pB.profileId) === BALANCE, `Б баланс: ${h2.getBalance(pB.profileId)}`)
    assert(env.ledger(pB.profileId, 'stake_debit') === env.ledger(pB.profileId, 'stake_refund'), `Б ledger: debit=${env.ledger(pB.profileId, 'stake_debit')} refund=${env.ledger(pB.profileId, 'stake_refund')}`)
    assert(env.ledger(pB.profileId, 'stake_refund') <= 1, 'двойно връщане')
    const audits = env.enforcementAudits()
    assert(audits.length === 1 && audits[0]!.trigger === 'pre_start' && audits[0]!.profileId === pB.profileId, JSON.stringify(audits))
  })
  const eFrom = await env.join(E, S1)
  const found = await Promise.all([A, C, D, E].map((c) => env.waitFrame(c, (f) => f.type === 'match_found', c === E ? eFrom : marks[c.label as 'A' | 'C' | 'D'] ?? 0, 8000)))
  await check('[C10] групата е преизчислена: след нов неограничен играч стартират А, C, D, E в една игра', () => {
    assert(found.every((f) => f !== null), `match_found: ${found.map((f) => f !== null)}`)
    assert(new Set(found.map((f) => f!.data.roomId)).size === 1, 'не са в една игра')
    assert(found[0]!.data.humanPlayers === 4, `хора: ${found[0]!.data.humanPlayers}`)
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h2.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки (сървър 2)', () => { throw error })
} finally {
  for (const c of opened2) await c.close().catch(() => undefined)
  await h2.close()
}

finishAndExit()
