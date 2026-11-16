/**
 * Визуален harness за админ панела „Забрани за съвместна игра“ (Етап 5) —
 * реалният showAdminCoPlayRestrictionsPanel с ИЗОЛИРАНИ тестови данни: малък
 * фалшив API в паметта на страницата вместо мрежа (форма на отговорите като
 * server/src/coPlayRestrictions/coPlayRestrictionAdminHttpApi.ts).
 * Сценарий от query-то: ?scenario=default|conflict|forbidden|empty.
 * Само за scripts/checkCoPlayAdminPanel.ts; не влиза в production build-а.
 */

import { showAdminCoPlayRestrictionsPanel, type CoPlayRestrictionView } from '../../src/app/adminCoPlayRestrictions/showAdminCoPlayRestrictionsPanel'

type Scenario = 'default' | 'conflict' | 'forbidden' | 'empty'
const params = new URLSearchParams(location.search)
const scenario = (params.get('scenario') ?? 'default') as Scenario
const delayMs = Number(params.get('delay') ?? '350')
const pageSize = Number(params.get('pageSize') ?? '20')

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const DAY = 86_400_000

let enabled = false
let settingsUpdatedAt: string | null = iso(-3 * DAY)

const ref = (profileId: string, accountId: string, name: string, current: string | null = name) => ({
  profileId, accountId, displayNameSnapshot: name, currentDisplayName: current,
})

function base(id: string, a: ReturnType<typeof ref>, b: ReturnType<typeof ref>): CoPlayRestrictionView {
  return {
    restrictionId: id, gameScope: 'belot', status: 'active', profiles: [a, b], reason: 'Договаряне на игра', durationDays: 30, isIndefinite: false,
    createdAt: iso(-2 * DAY), createdByProfileId: 'adm-1', createdByDisplayName: 'Главен админ', activatedAt: iso(-2 * DAY), pendingReason: null, pendingTournaments: [],
    expiresAt: iso(28 * DAY + 5 * 3_600_000), endedAt: null, endKind: null, liftedByProfileId: null, liftedByDisplayName: null, liftReason: null,
  }
}

let restrictions: CoPlayRestrictionView[] = scenario === 'empty' ? [] : [
  base('r-active-1', ref('p-ivan', 'acc-1', 'Иван'), ref('p-petar', 'acc-2', 'Петър')),
  { ...base('r-indef', ref('p-maria', 'acc-3', 'Мария'), ref('p-georgi', 'acc-4', 'Георги', 'Георги_Нов')), durationDays: null, isIndefinite: true, expiresAt: null, reason: 'Многократно умишлено губене в полза на партньора' },
  {
    ...base('r-pending', ref('p-tour-x', 'acc-5', 'Стефан'), ref('p-tour-y', 'acc-6', 'Нина')),
    status: 'pending_activation', activatedAt: null, pendingReason: 'shared_tournament', durationDays: 14, expiresAt: null, createdAt: iso(-3_600_000),
    pendingTournaments: [{ tournamentId: 't-1-aaaaaaaa', name: 'Есенна купа', status: 'open' }, { tournamentId: 't-2-bbbbbbbb', name: 'Нощен турнир', status: 'semifinal_in_progress' }],
  },
  { ...base('r-expired', ref('p-kalin', 'acc-7', 'Калин'), ref('p-dora', 'acc-8', 'Дора')), status: 'expired', durationDays: 7, createdAt: iso(-20 * DAY), activatedAt: iso(-20 * DAY), expiresAt: iso(-13 * DAY), endedAt: null },
  { ...base('r-lifted', ref('p-asen', 'acc-9', 'Асен'), ref('p-vera', 'acc-10', 'Вера', null)), status: 'lifted', createdAt: iso(-10 * DAY), activatedAt: iso(-10 * DAY), expiresAt: iso(20 * DAY), endedAt: iso(-1 * DAY), endKind: 'lifted', liftedByProfileId: 'adm-2', liftedByDisplayName: 'Модератор Админ', liftReason: 'Недоразумение — изяснено' },
  { ...base('r-stale', ref('p-boris', 'acc-11', 'Борис'), ref('p-lili', 'acc-12', 'Лили')) },
]
// Допълнителни изтекли записи — за странирането.
for (let i = 0; i < 24 && scenario !== 'empty'; i += 1) {
  restrictions.push({ ...base(`r-old-${i}`, ref(`p-old-a${i}`, `acc-oa${i}`, `Стар${i}А`), ref(`p-old-b${i}`, `acc-ob${i}`, `Стар${i}Б`)), status: 'expired', createdAt: iso(-(40 + i) * DAY), activatedAt: iso(-(40 + i) * DAY), expiresAt: iso(-(30 + i) * DAY), durationDays: 10 })
}

const audit: Array<Record<string, unknown>> = [
  { auditId: 'a1', restrictionId: 'r-pending', action: 'impose', actorProfileId: 'adm-1', actorDisplayName: 'Главен админ', createdAt: iso(-3_600_000), details: { durationDays: 14, status: 'pending_activation', reason: 'Нарушение' } },
  { auditId: 'a2', restrictionId: 'r-active-1', action: 'activate', actorProfileId: null, actorDisplayName: null, createdAt: iso(-2 * DAY), details: { durationDays: 30, expiresAt: iso(28 * DAY) } },
  { auditId: 'a3', restrictionId: 'r-lifted', action: 'lift', actorProfileId: 'adm-2', actorDisplayName: 'Модератор Админ', createdAt: iso(-1 * DAY), details: { reason: 'Недоразумение — изяснено', previousStatus: 'active' } },
  { auditId: 'a4', restrictionId: 'r-expired', action: 'close_expired', actorProfileId: 'adm-1', actorDisplayName: 'Главен админ', createdAt: iso(-12 * DAY), details: { expiresAt: iso(-13 * DAY) } },
  { auditId: 'a5', restrictionId: null, action: 'settings_update', actorProfileId: 'adm-1', actorDisplayName: 'Главен админ', createdAt: '2026-07-01T09:05:00.000Z', details: { setting: 'CO_PLAY_RESTRICTIONS_ENABLED', from: true, to: false } },
  { auditId: 'a6', restrictionId: 'r-active-1', action: 'enforcement_removed', actorProfileId: 'adm-1', actorDisplayName: 'Главен админ', createdAt: iso(-2 * DAY + 60_000), details: { context: 'matchmaking', trigger: 'restriction_imposed', stake: 5000, stakeRefunded: true } },
  { auditId: 'a7', restrictionId: 'r-indef', action: 'tournament_conflict_detected', actorProfileId: null, actorDisplayName: null, createdAt: iso(-5 * DAY), details: { tournamentId: 't-9-cccccccc' } },
]

const players = [
  { profileId: 'p-new-1', displayName: 'Тестов Играч', avatarUrl: null, level: 12, isBot: false },
  { profileId: 'p-new-2', displayName: 'Тестова Играчка', avatarUrl: null, level: 4, isBot: false },
  { profileId: 'p-bot-1', displayName: 'Тестов Бот', avatarUrl: null, level: 20, isBot: true },
  { profileId: 'p-same-acc', displayName: 'Тестов Двойник', avatarUrl: null, level: 3, isBot: false },
  { profileId: 'p-ineligible', displayName: 'Тестов Гост', avatarUrl: null, level: 1, isBot: false },
  { profileId: 'p-dup-a', displayName: 'Тестов Иван', avatarUrl: null, level: 9, isBot: false },
  { profileId: 'p-dup-b', displayName: 'Тестов Петър', avatarUrl: null, level: 9, isBot: false },
  { profileId: 'p-tour-a', displayName: 'Тестов Турнир1', avatarUrl: null, level: 7, isBot: false },
  { profileId: 'p-tour-b', displayName: 'Тестов Турнир2', avatarUrl: null, level: 7, isBot: false },
  { profileId: 'p-bad-dur', displayName: 'Тестов Срок', avatarUrl: null, level: 2, isBot: false },
]

const requests: Array<{ method: string; path: string; body: unknown; at: number }> = []
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  requests.push({ method, path: url.pathname + url.search, body, at: Date.now() })
  await sleep(method === 'GET' ? 60 : delayMs)
  if (scenario === 'forbidden') return json(403, { ok: false, message: 'Само администратор има достъп до забраните за съвместна игра.' })

  if (url.pathname === '/api/players/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    return json(200, { ok: true, players: players.filter((p) => p.displayName.toLowerCase().includes(q)) })
  }
  const prefix = '/api/admin/co-play-restrictions'
  const sub = url.pathname.slice(prefix.length)
  if (sub === '/settings') {
    if (method === 'GET') return json(200, { ok: true, settings: { enabled, updatedAt: settingsUpdatedAt, updatedByProfileId: 'adm-1' } })
    if (body?.enabled === true && scenario === 'conflict') {
      return json(409, {
        ok: false, code: 'tournament_conflicts',
        message: 'Флагът не може да бъде включен: има активни забрани между участници в общ незапочнал турнир.',
        conflicts: [{ restrictionId: 'r-active-1', tournamentId: 't-77-dddddddd', tournamentName: 'Купа Пловдив', tournamentStatus: 'open' }],
        settings: { enabled: false, updatedAt: settingsUpdatedAt, updatedByProfileId: 'adm-1' },
      })
    }
    enabled = body?.enabled === true
    settingsUpdatedAt = new Date().toISOString()
    return json(200, { ok: true, changed: true, settings: { enabled, updatedAt: settingsUpdatedAt, updatedByProfileId: 'adm-1' } })
  }
  if (sub === '/audit') {
    const id = url.searchParams.get('restrictionId')
    const items = id === null ? audit : audit.filter((a) => a.restrictionId === id)
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    return json(200, { ok: true, items: items.slice(offset, offset + limit), total: items.length })
  }
  if (sub === '' && method === 'GET') {
    const status = url.searchParams.get('status') ?? 'active'
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const filtered = restrictions
      .filter((r) => status === 'all' || r.status === status)
      .filter((r) => q === '' || r.profiles.some((p) => (p.currentDisplayName ?? p.displayNameSnapshot).toLowerCase().includes(q) || p.profileId === q))
    return json(200, { ok: true, items: filtered.slice(offset, offset + limit), total: filtered.length, enabled })
  }
  if (sub === '' && method === 'POST') {
    const first = String(body?.firstProfileId ?? '')
    const second = String(body?.secondProfileId ?? '')
    const pair = new Set([first, second])
    const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => json(status, { ok: false, code, message, ...extra })
    if (pair.has('p-same-acc')) return fail(409, 'same_account', 'Двата профила са от един и същ акаунт.')
    if (pair.has('p-ineligible')) return fail(400, 'profile_not_eligible', 'Забрана може да се наложи само между профили на регистрирани акаунти.')
    if (pair.has('p-dup-a') && pair.has('p-dup-b')) return fail(409, 'already_restricted', 'Вече има активна забрана.', { existingRestrictionId: 'r-active-1' })
    if (pair.has('p-bad-dur')) return fail(400, 'invalid_duration', 'Срокът трябва да е цяло число дни от 1 до 3650 или безсрочен.')
    const name = (id: string) => players.find((p) => p.profileId === id)?.displayName ?? id
    const indefinite = body?.indefinite === true
    const created: CoPlayRestrictionView = {
      ...base(`r-new-${restrictions.length}`, ref(first, `acc-${first}`, name(first)), ref(second, `acc-${second}`, name(second))),
      reason: String(body?.reason ?? ''), createdAt: new Date().toISOString(), createdByDisplayName: 'Тест Админ',
      durationDays: indefinite ? null : Number(body?.durationDays), isIndefinite: indefinite,
      activatedAt: new Date().toISOString(),
      expiresAt: indefinite ? null : new Date(Date.now() + Number(body?.durationDays) * DAY).toISOString(),
    }
    if (pair.has('p-tour-a') && pair.has('p-tour-b')) {
      created.status = 'pending_activation'
      created.activatedAt = null
      created.expiresAt = null
      created.pendingReason = 'shared_tournament'
      created.pendingTournaments = [{ tournamentId: 't-55-eeeeeeee', name: 'Зимен шампионат', status: 'open' }]
    }
    restrictions = [created, ...restrictions]
    audit.unshift({ auditId: `a-new-${audit.length}`, restrictionId: created.restrictionId, action: 'impose', actorProfileId: 'adm-test', actorDisplayName: 'Тест Админ', createdAt: created.createdAt, details: { durationDays: created.durationDays, status: created.status, reason: created.reason } })
    return json(201, { ok: true, restriction: created })
  }
  const lift = /^\/([^/]+)\/lift$/.exec(sub)
  if (lift !== null && method === 'POST') {
    const target = restrictions.find((r) => r.restrictionId === lift[1])
    if (target === undefined) return json(404, { ok: false, code: 'not_found', message: 'Забраната не беше намерена.' })
    if (target.restrictionId === 'r-stale') {
      target.status = 'expired'
      return json(409, { ok: false, code: 'not_active', message: 'Забраната вече не е активна.', status: 'expired' })
    }
    target.status = 'lifted'
    target.endedAt = new Date().toISOString()
    target.endKind = 'lifted'
    target.liftedByDisplayName = 'Тест Админ'
    target.liftReason = typeof body?.reason === 'string' ? body.reason : null
    audit.unshift({ auditId: `a-lift-${audit.length}`, restrictionId: target.restrictionId, action: 'lift', actorProfileId: 'adm-test', actorDisplayName: 'Тест Админ', createdAt: target.endedAt, details: { reason: target.liftReason, previousStatus: 'active' } })
    return json(200, { ok: true, restriction: target })
  }
  const one = /^\/([^/]+)$/.exec(sub)
  if (one !== null && method === 'GET') {
    const target = restrictions.find((r) => r.restrictionId === one[1])
    return target === undefined ? json(404, { ok: false, message: 'Забраната не беше намерена.' }) : json(200, { ok: true, restriction: target })
  }
  return json(404, { ok: false, message: 'Не е намерено.' })
}

const panel = showAdminCoPlayRestrictionsPanel({ getApiBaseUrl: () => 'https://api.test', fetchImpl, pageSize })

;(window as any).__coPlayAdminHarness = {
  ready: () => document.querySelector('[data-co-play-flag-state], [data-co-play-settings-error="1"]') !== null && document.querySelector('[data-co-play-row], [data-co-play-list-empty="1"], [data-co-play-list-error="1"]') !== null,
  requests: () => requests.map((r) => ({ method: r.method, path: r.path, body: r.body })),
  mutations: () => requests.filter((r) => r.method !== 'GET').map((r) => ({ method: r.method, path: r.path, body: r.body })),
  close: () => panel.close(),
}
