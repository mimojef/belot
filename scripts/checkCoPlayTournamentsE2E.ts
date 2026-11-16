/**
 * checkCoPlayTournamentsE2E.ts — „Забрана за съвместна игра“, Етап 4: свързването
 * в сървъра. Реален изолиран сървър (giftBackTestHarness), реално HTTP API за
 * турнирите и за административното управление. Турнирите се създават директно
 * в изолираната база на сървъра (tournamentStore), за да не зависи тестът от
 * формата за създаване.
 *
 *   [E1] HTTP самостоятелна регистрация: 409 co_play_restricted, точният текст, без такса;
 *   [E2] HTTP покана за партньор към забранен: 409 co_play_restricted;
 *   [E3] API: налагане при общ турнир -> pending_activation (дати, причина, турнири);
 *   [E4] отмяна на турнира от създателя -> автоматично активиране (+ одит);
 *   [E5] рестарт: турнирът е приключил, докато сървърът е спрян -> активиране при старта;
 *   [E6] включване на флага при конфликт в незапочнал турнир -> 409 със списъка;
 *   [E7] отмяна на изчакваща забрана през API.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayTournamentsE2E.ts
 */

import { createTournamentStore } from '../server/src/db/tournamentStore.js'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckCoPlayTournamentsE2E\n')

const BALANCE = 50_000_000
const FEE = 5_000
const TOURNAMENT_TEXT = 'В този турнир има играч, с когото нямате право да участвате поради наложено административно наказание.'

const h = await startGiftBackHarness()
try {
  const dbPath = (h.db as unknown as { location: () => string }).location()
  const tournamentStore = await createTournamentStore(dbPath)
  let seq = 0
  let lastCreator: TestProfile | null = null

  async function register(tag: string): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    const p = await h.register(tag)
    h.setBalance(p.profileId, BALANCE)
    return p
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  const admin = await register('admin')
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?`).run(accountOf(admin.profileId))

  async function api(profile: TestProfile, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${h.backendOrigin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${profile.cookie}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const adminApi = (method: string, path: string, body?: unknown) => api(admin, method, `/api/admin/co-play-restrictions${path}`, body)
  async function impose(a: string, b: string, extra: Record<string, unknown> = { durationDays: 30 }) {
    const r = await adminApi('POST', '', { firstProfileId: a, secondProfileId: b, reason: 'E2E', ...extra })
    assert(r.status === 201, `налагане: ${JSON.stringify(r.body)}`)
    return r.body.restriction
  }
  /** Нов създател за всеки турнир (лимит на активни турнири на създател). */
  async function createTournament(_owner?: TestProfile): Promise<string> {
    const creator = await register(`owner${seq + 1}`)
    lastCreator = creator
    seq += 1
    const result = tournamentStore.createTournament({
      name: `E2E турнир ${seq}`,
      creatorProfileId: creator.profileId,
      visibility: 'public',
      entryFee: FEE,
      startMode: 'scheduled',
      scheduledStartAt: new Date(Date.now() + (24 + seq * 3) * 3600_000).toISOString(),
      playerCapacity: 8,
    })
    if (!result.ok) throw new Error(`createTournament: ${result.reason}`)
    return result.tournament.tournamentId
  }
  const join = (p: TestProfile, tournamentId: string) => api(p, 'POST', `/api/tournaments/${tournamentId}/join`, {})
  async function joinOk(p: TestProfile, tournamentId: string): Promise<void> {
    const r = await join(p, tournamentId)
    assert(r.status === 200 && r.body.ok === true, `(setup) записване: ${JSON.stringify(r.body)}`)
  }
  const restrictionRow = (id: string) => h.db.prepare('SELECT activated_at, expires_at, ended_at FROM co_play_restrictions WHERE restriction_id = ?').get(id) as { activated_at: string | null; expires_at: string | null; ended_at: string | null }

  // ─── E6: включване на флага при конфликт (флагът още е изключен) ──────
  {
    const [pC, pD, pK] = [await register('c6'), await register('d6'), await register('k6')]
    const restriction = await impose(pC.profileId, pD.profileId) // активна: още няма общ турнир
    const t = await createTournament(pK)
    await joinOk(pC, t)
    await joinOk(pD, t) // флагът е изключен -> разрешено
    const refused = await adminApi('PUT', '/settings', { enabled: true })
    await check('[E6] включване на флага при активна забрана в общ незапочнал турнир -> 409 със списъка; флагът остава изключен', async () => {
      assert(refused.status === 409 && refused.body.code === 'tournament_conflicts', JSON.stringify(refused.body))
      const conflict = refused.body.conflicts.find((c: any) => c.tournamentId === t)
      assert(conflict !== undefined && conflict.restrictionId === restriction.restrictionId && conflict.tournamentStatus === 'open' && typeof conflict.tournamentName === 'string', JSON.stringify(refused.body.conflicts))
      const settings = await adminApi('GET', '/settings')
      assert(settings.body.settings.enabled === false, 'флагът е включен')
      const entries = (h.db.prepare(`SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed'`).get(t) as { n: number }).n
      assert(entries === 2, 'участник е изваден')
    })
    // Разрешаване: администраторът отменя активната забрана -> флагът се включва.
    const lift = await adminApi('POST', `/${restriction.restrictionId}/lift`, {})
    assert(lift.status === 200, `(setup) отмяна: ${JSON.stringify(lift.body)}`)
    const enabled = await adminApi('PUT', '/settings', { enabled: true })
    assert(enabled.status === 200 && enabled.body.settings.enabled === true, `(setup) флаг: ${JSON.stringify(enabled.body)}`)
  }

  // ─── E1 / E2 ──────────────────────────────────────────────────────────
  {
    const [pA, pB, pK] = [await register('a1'), await register('b1'), await register('k1')]
    await impose(pA.profileId, pB.profileId)
    const t = await createTournament(pK)
    await joinOk(pA, t)
    const refused = await join(pB, t)
    await check('[E1] HTTP самостоятелна регистрация: 409 co_play_restricted с точния текст, без име, без такса', () => {
      assert(refused.status === 409 && refused.body.reason === 'co_play_restricted', JSON.stringify(refused))
      assert(refused.body.message === TOURNAMENT_TEXT && !refused.body.message.includes(pA.displayName), refused.body.message)
      assert(h.getBalance(pB.profileId) === BALANCE, `баланс: ${h.getBalance(pB.profileId)}`)
    })
    const t2 = await createTournament(pK)
    const invite = await api(pA, 'POST', `/api/tournaments/${t2}/partner-invites`, { inviteeProfileId: pB.profileId })
    await check('[E2] HTTP покана за партньор към забранен: 409 co_play_restricted; поканилият не плаща', () => {
      assert(invite.status === 409 && invite.body.reason === 'co_play_restricted' && invite.body.message === TOURNAMENT_TEXT, JSON.stringify(invite.body))
      assert(h.getBalance(pA.profileId) === BALANCE - FEE, `баланс на A: ${h.getBalance(pA.profileId)}`)
    })
  }

  // ─── E3 / E4 / E7 ─────────────────────────────────────────────────────
  {
    const [pA, pB, pK] = [await register('a3'), await register('b3'), await register('k3')]
    const t = await createTournament(pK)
    const creatorOfT = lastCreator
    await joinOk(pA, t)
    await joinOk(pB, t)
    const restriction = await impose(pA.profileId, pB.profileId, { durationDays: 30 })
    const list = await adminApi('GET', '?status=pending_activation')
    await check('[E3] API: налагане при общ турнир -> pending_activation с дата на заявка, без активиране и срок, причина и турнира', () => {
      assert(restriction.status === 'pending_activation' && restriction.activatedAt === null && restriction.expiresAt === null, JSON.stringify(restriction))
      assert(restriction.durationDays === 30 && typeof restriction.createdAt === 'string' && restriction.pendingReason === 'shared_tournament', JSON.stringify(restriction))
      const ref = restriction.pendingTournaments.find((x: any) => x.tournamentId === t)
      assert(ref !== undefined && ref.status === 'open' && typeof ref.name === 'string', JSON.stringify(restriction.pendingTournaments))
      assert(list.status === 200 && list.body.items.some((x: any) => x.restrictionId === restriction.restrictionId), JSON.stringify(list.body))
    })
    const cancel = await api(creatorOfT!, 'POST', `/api/tournaments/${t}/cancel`, {})
    assert(cancel.status === 200, `(setup) отмяна на турнира: ${JSON.stringify(cancel.body)}`)
    await sleep(300)
    const row = restrictionRow(restriction.restrictionId)
    await check('[E4] отмяна на турнира от създателя -> забраната се активира веднага (срокът тече от активирането) + одит', () => {
      assert(row.activated_at !== null && row.expires_at !== null, JSON.stringify(row))
      const expectedMs = Date.parse(row.activated_at) + 30 * 24 * 3600_000
      assert(Date.parse(row.expires_at) === expectedMs, `срок: ${JSON.stringify(row)}`)
      const audit = (h.db.prepare(`SELECT COUNT(*) AS n FROM co_play_restriction_audit WHERE restriction_id = ? AND action = 'activate'`).get(restriction.restrictionId) as { n: number }).n
      assert(audit === 1, `одит: ${audit}`)
    })

    const [pX, pY] = [await register('x7'), await register('y7')]
    const t7 = await createTournament(pK)
    await joinOk(pX, t7)
    await joinOk(pY, t7)
    const pending = await impose(pX.profileId, pY.profileId, { indefinite: true })
    const lifted = await adminApi('POST', `/${pending.restrictionId}/lift`, { reason: 'Грешка' })
    await check('[E7] отмяна на изчакваща забрана през API преди активирането', () => {
      assert(pending.status === 'pending_activation', JSON.stringify(pending))
      assert(lifted.status === 200 && lifted.body.restriction.status === 'lifted' && lifted.body.restriction.activatedAt === null, JSON.stringify(lifted.body))
    })
  }

  // ─── E5: рестарт ──────────────────────────────────────────────────────
  {
    const [pA, pB, pK] = [await register('a5'), await register('b5'), await register('k5')]
    const t = await createTournament(pK)
    await joinOk(pA, t)
    await joinOk(pB, t)
    const restriction = await impose(pA.profileId, pB.profileId, { durationDays: 7 })
    // Турнирът приключва, докато сървърът е спрян (симулирано в изолираната база).
    h.db.prepare(`UPDATE tournaments SET status = 'finished' WHERE tournament_id = ?`).run(t)
    await h.restartServer()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* рестарт */ }
      await sleep(300)
    }
    await sleep(500)
    const row = restrictionRow(restriction.restrictionId) // преди каквото и да е четене през API
    await check('[E5] рестарт: изчакващата забрана се активира при старта на сървъра', () => {
      assert(row.activated_at !== null && row.expires_at !== null && Date.parse(row.expires_at) === Date.parse(row.activated_at) + 7 * 24 * 3600_000, JSON.stringify(row))
    })
  }
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
}
finishAndExit()
