/**
 * checkCoPlayRestrictions.ts — „Забрана за съвместна игра“, Етап 1: store,
 * кеш в паметта, глобален флаг, административен одит и HTTP API (права).
 * Само изолирани временни SQLite бази (всички миграции), без production данни.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkCoPlayRestrictions.ts   (от server/)
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import {
  CO_PLAY_MS_PER_DAY,
  createCoPlayRestrictionStore,
  type CoPlayRestrictionStore,
} from '../src/db/coPlayRestrictionStore.js'
import { createCoPlayRestrictionAdminHttpRequestHandler } from '../src/coPlayRestrictions/coPlayRestrictionAdminHttpApi.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
  }
}

const sourceMigrations = join(resolve(process.cwd()), 'database', 'migrations')
const sqliteModule = await import('node:sqlite')
type SqliteDatabase = InstanceType<typeof sqliteModule.DatabaseSync>
const tempRoots: string[] = []
const toClose: Array<{ close: () => void }> = []

const START = Date.UTC(2027, 0, 10, 8, 0, 0)
let nowMs = START
const clock = () => nowMs

type Env = { path: string; raw: SqliteDatabase; store: CoPlayRestrictionStore }

async function freshEnv(): Promise<Env> {
  nowMs = START
  const root = await mkdtemp(join(tmpdir(), 'belot-co-play-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceMigrations, entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  raw.exec('PRAGMA foreign_keys = ON;')
  toClose.push(raw)
  const store = await createCoPlayRestrictionStore(path, { now: clock })
  toClose.push(store)
  return { path, raw, store }
}

function seedAccount(raw: SqliteDatabase): string {
  const accountId = randomUUID()
  raw.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
  return accountId
}
function seedProfile(raw: SqliteDatabase, accountId: string | null, name: string, kind: 'human' | 'bot' = 'human'): string {
  const profileId = randomUUID()
  raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, ?);`)
    .run(profileId, accountId, name, `${name.toLowerCase()}-${profileId.slice(0, 8)}`, kind)
  return profileId
}

/** Два акаунта: A (профили a1, a2) и B (профили b1, b2) + трети акаунт C (c1). */
function seedWorld(raw: SqliteDatabase) {
  const accountA = seedAccount(raw)
  const accountB = seedAccount(raw)
  const accountC = seedAccount(raw)
  return {
    accountA,
    accountB,
    a1: seedProfile(raw, accountA, 'Alpha'),
    a2: seedProfile(raw, accountA, 'AlphaSecond'),
    b1: seedProfile(raw, accountB, 'Bravo'),
    b2: seedProfile(raw, accountB, 'BravoSecond'),
    c1: seedProfile(raw, accountC, 'Charlie'),
    admin: seedProfile(raw, seedAccount(raw), 'AdminUser'),
  }
}

function openRows(raw: SqliteDatabase): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM co_play_restrictions WHERE ended_at IS NULL;`).get() as { n: number }).n
}
function auditActions(raw: SqliteDatabase): string[] {
  return (raw.prepare(`SELECT action FROM co_play_restriction_audit ORDER BY created_at, rowid;`).all() as Array<{ action: string }>).map((r) => r.action)
}

console.log('\ncheckCoPlayRestrictions\n')

// ─── Store и кеш ──────────────────────────────────────────────────────────

await check('[S1] Миграцията: таблиците съществуват; CO_PLAY_RESTRICTIONS_ENABLED е изключен по подразбиране', async () => {
  const { raw, store } = await freshEnv()
  for (const table of ['co_play_restrictions', 'co_play_restriction_audit', 'co_play_restriction_settings']) {
    assert(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?;`).get(table) !== undefined, `липсва ${table}`)
  }
  assertEqual(store.isEnabled(), false, 'флагът по подразбиране')
  assertEqual(store.getCachedRestrictionCount(), 0, 'празен кеш')
})

await check('[S2] Налагане + двустранност: важи в двете посоки, независимо от реда на избраните профили', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const result = store.imposeRestriction({ firstProfileId: w.b1, secondProfileId: w.a1, reason: 'Сговор', durationDays: 30, actorProfileId: w.admin })
  assert(result.ok, `налагането не мина: ${JSON.stringify(result)}`)
  if (!result.ok) return
  assertEqual(result.restriction.status, 'active', 'статус')
  assertEqual(result.restriction.reason, 'Сговор', 'причина')
  assertEqual(result.restriction.createdByProfileId, w.admin, 'наложил')
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'a1→b1')
  assert(store.isRestrictedBetweenProfiles(w.b1, w.a1), 'b1→a1')
  assertEqual(store.findRestrictedProfileIds(w.a1, [w.b1, w.c1]), [w.b1], 'find от a1')
  assertEqual(store.findRestrictedProfileIds(w.b1, [w.c1, w.a1]), [w.a1], 'find от b1')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.c1), 'a1→c1 не е забранен')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.a2), 'профили на един акаунт не са „забранени“ помежду си')
  const selected = result.restriction.profiles.map((p) => p.profileId).sort()
  assertEqual(selected, [w.a1, w.b1].sort(), 'избраните профили са запазени')
})

await check('[S3] Различни профили на същите акаунти: забраната важи за всички комбинации', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: null, actorProfileId: w.admin }).ok, 'налагане')
  for (const [x, y] of [[w.a1, w.b2], [w.a2, w.b1], [w.a2, w.b2], [w.b2, w.a2]] as const) {
    assert(store.isRestrictedBetweenProfiles(x, y), 'липсва забрана за комбинация от профили')
  }
})

await check('[S4] Новосъздаден профил на ограничен акаунт: веднага е ограничен', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 60, actorProfileId: w.admin }).ok, 'налагане')
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'затопляне на кеша')
  const a3 = seedProfile(raw, w.accountA, 'AlphaThird')
  assert(store.isRestrictedBetweenProfiles(a3, w.b1), 'новият профил на акаунт A не е ограничен с b1')
  assert(store.isRestrictedBetweenProfiles(w.b2, a3), 'новият профил на акаунт A не е ограничен с b2')
  assert(!store.isRestrictedBetweenProfiles(a3, w.c1), 'новият профил е ограничен с несвързан акаунт')
})

await check('[S5] Отказ: един и същ акаунт, един и същ профил, бот/профил без акаунт, несъществуващ профил', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const bot = seedProfile(raw, null, 'BotOne', 'bot')
  const cases: Array<[string, string, string]> = [
    [w.a1, w.a2, 'same_account'],
    [w.a1, w.a1, 'same_profile'],
    [w.a1, bot, 'profile_not_eligible'],
    [w.a1, randomUUID(), 'profile_not_found'],
    [w.a1, '', 'invalid_profiles'],
  ]
  for (const [first, second, code] of cases) {
    const result = store.imposeRestriction({ firstProfileId: first, secondProfileId: second, reason: 'x', durationDays: 30, actorProfileId: w.admin })
    assert(!result.ok && result.code === code, `очакван ${code}, получено ${JSON.stringify(result)}`)
  }
  assertEqual(openRows(raw), 0, 'не трябва да има записи')
  assertEqual(auditActions(raw), [], 'няма одит при отказ')
})

await check('[S6] Валидация: задължителна причина и срок — цяло положително число дни (или безсрочна)', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  for (const reason of ['', '   ', 'x'.repeat(501)]) {
    const result = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason, durationDays: 30, actorProfileId: w.admin })
    assert(!result.ok && result.code === 'invalid_reason', `причина ${JSON.stringify(reason.slice(0, 5))}: ${JSON.stringify(result)}`)
  }
  for (const days of [0, -1, 1.5, 3651, Number.NaN]) {
    const result = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: days, actorProfileId: w.admin })
    assert(!result.ok && result.code === 'invalid_duration', `срок ${days}: ${JSON.stringify(result)}`)
  }
  assertEqual(openRows(raw), 0, 'не трябва да има записи')
})

await check('[S7] Без дублиране: втора активна забрана за същите акаунти се отказва (и с други профили/обратен ред)', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const first = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 30, actorProfileId: w.admin })
  assert(first.ok, 'първо налагане')
  for (const [x, y] of [[w.a1, w.b1], [w.b2, w.a2], [w.b1, w.a1]] as const) {
    const again = store.imposeRestriction({ firstProfileId: x, secondProfileId: y, reason: 'y', durationDays: null, actorProfileId: w.admin })
    assert(!again.ok && again.code === 'already_restricted', `очакван already_restricted: ${JSON.stringify(again)}`)
    if (!again.ok && first.ok) assertEqual(again.existingRestrictionId, first.restriction.restrictionId, 'съществуващата забрана')
  }
  assertEqual(openRows(raw), 1, 'точно един отворен ред')
  assertEqual(store.getCachedRestrictionCount(), 1, 'точно един запис в кеша')
})

await check('[S8] Изтичане: 1 ден = 24 ч от налагането; отпада автоматично без job; статус „изтекла“, различен от „отменена“', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const result = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 30, actorProfileId: w.admin })
  assert(result.ok, 'налагане')
  if (!result.ok) return
  assertEqual(result.restriction.expiresAt, new Date(START + 30 * CO_PLAY_MS_PER_DAY).toISOString(), 'expiresAt')
  nowMs = START + 30 * CO_PLAY_MS_PER_DAY - 1
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'все още активна 1 ms преди изтичането')
  nowMs = START + 30 * CO_PLAY_MS_PER_DAY
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'действа след изтичането')
  assertEqual(store.getCachedRestrictionCount(), 0, 'изтеклата отпада от кеша при четене')
  const view = store.getRestriction(result.restriction.restrictionId)
  assertEqual(view?.status, 'expired', 'статус')
  assertEqual(view?.endKind, null, 'не е отбелязана като отменена')
  assertEqual(store.listRestrictions({ status: 'expired' }).total, 1, 'в списъка „изтекли“')
  assertEqual(store.listRestrictions({ status: 'active' }).total, 0, 'не е в „активни“')
  assertEqual(store.listRestrictions({ status: 'lifted' }).total, 0, 'не е в „отменени“')
})

await check('[S9] Безсрочна забрана: без дата на изтичане, действа и след 100 години', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const result = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: null, actorProfileId: w.admin })
  assert(result.ok && result.restriction.isIndefinite && result.restriction.expiresAt === null, 'безсрочна')
  nowMs = START + 36_500 * CO_PLAY_MS_PER_DAY
  assert(store.isRestrictedBetweenProfiles(w.b2, w.a2), 'безсрочната не действа')
})

await check('[S10] Отмяна: веднага спира да действа; повторна отмяна и отмяна на изтекла се отказват', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const imposed = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 30, actorProfileId: w.admin })
  assert(imposed.ok, 'налагане')
  if (!imposed.ok) return
  nowMs += 1000
  const lifted = store.liftRestriction({ restrictionId: imposed.restriction.restrictionId, actorProfileId: w.admin, reason: 'Грешка' })
  assert(lifted.ok, `отмяната не мина: ${JSON.stringify(lifted)}`)
  if (!lifted.ok) return
  assertEqual(lifted.restriction.status, 'lifted', 'статус')
  assertEqual(lifted.restriction.endKind, 'lifted', 'endKind')
  assertEqual(lifted.restriction.liftedByProfileId, w.admin, 'отменил')
  assertEqual(lifted.restriction.liftReason, 'Грешка', 'причина за отмяна')
  assertEqual(lifted.restriction.endedAt, new Date(nowMs).toISOString(), 'момент на отмяна')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'отменената още действа')
  const again = store.liftRestriction({ restrictionId: imposed.restriction.restrictionId, actorProfileId: w.admin })
  assert(!again.ok && again.code === 'not_active' && again.status === 'lifted', `повторна отмяна: ${JSON.stringify(again)}`)
  const second = store.imposeRestriction({ firstProfileId: w.a2, secondProfileId: w.b2, reason: 'y', durationDays: 1, actorProfileId: w.admin })
  assert(second.ok, 'второ налагане')
  if (!second.ok) return
  nowMs += 2 * CO_PLAY_MS_PER_DAY
  const expiredLift = store.liftRestriction({ restrictionId: second.restriction.restrictionId, actorProfileId: w.admin })
  assert(!expiredLift.ok && expiredLift.code === 'not_active' && expiredLift.status === 'expired', `отмяна на изтекла: ${JSON.stringify(expiredLift)}`)
  const missing = store.liftRestriction({ restrictionId: randomUUID(), actorProfileId: w.admin })
  assert(!missing.ok && missing.code === 'not_found', 'несъществуваща')
})

await check('[S11] Повторно налагане: след отмяна и след изтичане — нова забрана, историята се пази; изтеклата се затваря като „изтекла“', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const first = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'първа', durationDays: 5, actorProfileId: w.admin })
  assert(first.ok, 'първа')
  if (!first.ok) return
  assert(store.liftRestriction({ restrictionId: first.restriction.restrictionId, actorProfileId: w.admin }).ok, 'отмяна')
  const second = store.imposeRestriction({ firstProfileId: w.a2, secondProfileId: w.b1, reason: 'втора', durationDays: 2, actorProfileId: w.admin })
  assert(second.ok, 'втора след отмяна')
  if (!second.ok) return
  nowMs += 3 * CO_PLAY_MS_PER_DAY
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'втората е изтекла')
  const third = store.imposeRestriction({ firstProfileId: w.b2, secondProfileId: w.a1, reason: 'трета', durationDays: null, actorProfileId: w.admin })
  assert(third.ok, `трета след изтичане: ${JSON.stringify(third)}`)
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'третата не действа')
  const all = store.listRestrictions({ status: 'all' })
  assertEqual(all.total, 3, 'историята — три записа')
  const byId = new Map(all.items.map((item) => [item.restrictionId, item]))
  assertEqual(byId.get(first.restriction.restrictionId)?.endKind, 'lifted', 'първата — отменена')
  assertEqual(byId.get(second.restriction.restrictionId)?.endKind, 'expired', 'втората — затворена като изтекла')
  assertEqual(byId.get(second.restriction.restrictionId)?.endedAt, second.restriction.expiresAt, 'затворена в момента на изтичане')
  assertEqual(byId.get(third.ok ? third.restriction.restrictionId : '')?.status, 'active', 'третата — активна')
  assertEqual(auditActions(raw), ['settings_update', 'impose', 'lift', 'impose', 'close_expired', 'impose'], 'одит')
})

await check('[S12] Зареждане след рестарт: флагът и активните забрани се зареждат; изтекли и отменени — не', async () => {
  const { path, raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const accountD = seedAccount(raw)
  const d1 = seedProfile(raw, accountD, 'Delta')
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'безсрочна', durationDays: null, actorProfileId: w.admin }).ok, 'активна')
  const lifted = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.c1, reason: 'за отмяна', durationDays: 10, actorProfileId: w.admin })
  if (lifted.ok) store.liftRestriction({ restrictionId: lifted.restriction.restrictionId, actorProfileId: w.admin })
  assert(store.imposeRestriction({ firstProfileId: w.b1, secondProfileId: d1, reason: 'кратка', durationDays: 1, actorProfileId: w.admin }).ok, 'кратка')
  nowMs += 2 * CO_PLAY_MS_PER_DAY
  const restarted = await createCoPlayRestrictionStore(path, { now: clock })
  toClose.push(restarted)
  assertEqual(restarted.isEnabled(), true, 'флагът след рестарт')
  assertEqual(restarted.getCachedRestrictionCount(), 1, 'само активната е в кеша')
  assert(restarted.isRestrictedBetweenProfiles(w.b2, w.a2), 'активната след рестарт')
  assert(!restarted.isRestrictedBetweenProfiles(w.a1, w.c1), 'отменената след рестарт')
  assert(!restarted.isRestrictedBetweenProfiles(w.b1, d1), 'изтеклата след рестарт')
})

await check('[S13] Флаг изключен: проверките пропускат ограниченията; забраните и историята остават; промяната е с одит', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const imposed = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: null, actorProfileId: w.admin })
  assert(imposed.ok, 'налагане при изключен флаг (записва се)')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'изключен флаг -> без ограничение')
  assertEqual(store.findRestrictedProfileIds(w.a1, [w.b1]), [], 'изключен флаг -> find празно')
  assert(store.getActiveRestrictionIdBetweenProfiles(w.a1, w.b1) !== null, 'забраната е записана (независимо от флага)')
  const on = store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(on.changed && on.settings.enabled, 'включване')
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'включен флаг -> ограничение')
  const same = store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(!same.changed, 'без промяна -> без запис')
  store.setEnabled({ enabled: false, actorProfileId: w.admin })
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'изключване без рестарт')
  assertEqual(store.listRestrictions({ status: 'active' }).total, 1, 'забраната остава')
  const audit = store.listAudit({}).items.filter((item) => item.action === 'settings_update')
  assertEqual(audit.length, 2, 'два одит записа за флага')
  assertEqual(audit[0]?.details, { setting: 'CO_PLAY_RESTRICTIONS_ENABLED', from: true, to: false }, 'последната промяна')
  assertEqual(audit[0]?.actorProfileId, w.admin, 'извършител')
})

await check('[S14] Административен одит: налагане и отмяна с извършител, избрани профили, акаунти, срок и причини', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const imposed = store.imposeRestriction({ firstProfileId: w.b1, secondProfileId: w.a1, reason: 'Сговор', durationDays: 7, actorProfileId: w.admin })
  assert(imposed.ok, 'налагане')
  if (!imposed.ok) return
  store.liftRestriction({ restrictionId: imposed.restriction.restrictionId, actorProfileId: w.admin, reason: 'Обжалване' })
  const audit = store.listAudit({ restrictionId: imposed.restriction.restrictionId })
  assertEqual(audit.items.map((item) => item.action), ['lift', 'impose'], 'действия (най-новите първи)')
  const impose = audit.items[1]
  assertEqual(impose?.actorProfileId, w.admin, 'извършител')
  assertEqual(impose?.actorDisplayName, 'AdminUser', 'име на извършителя')
  assertEqual(impose?.details?.selectedProfileIds, [w.b1, w.a1], 'избраните профили (в реда на избора)')
  assertEqual(impose?.details?.durationDays, 7, 'срок')
  assertEqual(impose?.details?.reason, 'Сговор', 'причина')
  assertEqual(audit.items[0]?.details, { reason: 'Обжалване' }, 'причина за отмяна')
})

await check('[S15] Търсене по профил: по име или id на всеки профил от двата акаунта; филтри по статус', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  assert(store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: null, actorProfileId: w.admin }).ok, 'налагане')
  assertEqual(store.listRestrictions({ status: 'all', profileQuery: 'bravosecond' }).total, 1, 'по име на друг профил на акаунт B')
  assertEqual(store.listRestrictions({ status: 'all', profileQuery: w.a2 }).total, 1, 'по id на друг профил на акаунт A')
  assertEqual(store.listRestrictions({ status: 'all', profileQuery: 'charlie' }).total, 0, 'несвързан профил')
  assertEqual(store.listRestrictions({ status: 'all', profileQuery: '%' }).total, 0, 'LIKE wildcard се третира буквално')
  const item = store.listRestrictions({ status: 'active', profileQuery: 'alpha' }).items[0]
  assert(item !== undefined && item.profiles.some((p) => p.currentDisplayName === 'Alpha'), 'текущите имена на избраните профили')
})

await check('[S16] База и кеш не се разминават: неуспешна транзакция не променя кеша; проверките са само от паметта', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  // Принудителна грешка в базата по време на налагането (след INSERT на забраната).
  raw.exec(`CREATE TRIGGER fail_audit_main BEFORE INSERT ON co_play_restriction_audit WHEN NEW.action = 'impose' BEGIN SELECT RAISE(ABORT, 'forced'); END;`)
  let threw = false
  try {
    store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 10, actorProfileId: w.admin })
  } catch {
    threw = true
  }
  assert(threw, 'очаквана грешка от базата')
  assertEqual(openRows(raw), 0, 'транзакцията е върната')
  assertEqual(store.getCachedRestrictionCount(), 0, 'кешът не е променен')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'няма ограничение')
  raw.exec(`DROP TRIGGER fail_audit_main;`)
  assert(store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 10, actorProfileId: w.admin }).ok, 'налагане след премахване на тригера')
  // Затоплени профили: проверката работи и при затворена база (само памет).
  assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'затопляне')
  assert(!store.isRestrictedBetweenProfiles(w.a1, w.c1), 'затопляне (c1)')
  store.close()
  assert(store.isRestrictedBetweenProfiles(w.b1, w.a1), 'проверка без база (b1→a1)')
  assertEqual(store.findRestrictedProfileIds(w.a1, [w.b1, w.c1]), [w.b1], 'find без база')
})

await check('[S17] Етап 2 — проверка по accountId: двустранна, флаг, изтичане, отмяна; работи без база (нула SQL заявки)', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const imposed = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 2, actorProfileId: w.admin })
  assert(imposed.ok, 'налагане')
  if (!imposed.ok) return
  const accountC = (raw.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(w.c1) as { account_id: string }).account_id
  assert(!store.isEnforcementActive(), 'изключен флаг -> неактивно прилагане')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, w.accountB), null, 'изключен флаг -> null')
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  assert(store.isEnforcementActive(), 'включен флаг + забрана -> активно')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, w.accountB), imposed.restriction.restrictionId, 'A->B')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountB, w.accountA), imposed.restriction.restrictionId, 'B->A')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, accountC), null, 'A->C')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, w.accountA), null, 'същият акаунт')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, null), null, 'гост/без акаунт')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(undefined, w.accountB), null, 'липсващ акаунт')
  // Без база: затворена връзка -> проверките по акаунт все пак работят (само памет).
  store.close()
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountB, w.accountA), imposed.restriction.restrictionId, 'без база')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(randomUUID(), w.accountA), null, 'непознат акаунт без база')
  nowMs += 2 * CO_PLAY_MS_PER_DAY
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, w.accountB), null, 'изтекла (без база)')
  assert(!store.isEnforcementActive(), 'след изтичане кешът е празен -> неактивно')
})

await check('[S18] Етап 2 — отменена забрана: прилагането спира веднага; одит enforcement_removed се записва', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  store.setEnabled({ enabled: true, actorProfileId: w.admin })
  const imposed = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: null, actorProfileId: w.admin })
  if (!imposed.ok) throw new Error('налагане')
  store.recordEnforcementAudit({ restrictionId: imposed.restriction.restrictionId, actorProfileId: null, details: { context: 'matchmaking', trigger: 'pre_start' } })
  assert(store.liftRestriction({ restrictionId: imposed.restriction.restrictionId, actorProfileId: w.admin }).ok, 'отмяна')
  assertEqual(store.getEnforcedRestrictionIdBetweenAccounts(w.accountA, w.accountB), null, 'отменена')
  assert(!store.isEnforcementActive(), 'без активни забрани -> неактивно')
  const audit = store.listAudit({ restrictionId: imposed.restriction.restrictionId }).items.map((item) => item.action)
  assertEqual(audit, ['lift', 'enforcement_removed', 'impose'], 'одит')
})

// ─── HTTP API и права ─────────────────────────────────────────────────────

await check('[A1] API: без сесия -> 401; роли под admin -> 403 за всички действия, без промени', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const imposed = store.imposeRestriction({ firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 10, actorProfileId: w.admin })
  const id = imposed.ok ? imposed.restriction.restrictionId : 'x'
  const api = await startApi(store, () => true)
  try {
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/co-play-restrictions?status=all'],
      ['POST', '/api/admin/co-play-restrictions', { firstProfileId: w.a2, secondProfileId: w.c1, reason: 'x', durationDays: 3 }],
      ['GET', '/api/admin/co-play-restrictions/settings'],
      ['PUT', '/api/admin/co-play-restrictions/settings', { enabled: true }],
      ['GET', '/api/admin/co-play-restrictions/audit'],
      ['GET', `/api/admin/co-play-restrictions/${id}`],
      ['POST', `/api/admin/co-play-restrictions/${id}/lift`, {}],
    ]
    for (const [method, path, body] of requests) {
      const anonymous = await api.call(method, path, null, body)
      assertEqual(anonymous.status, 401, `${method} ${path} без сесия`)
      for (const role of ['subadmin', 'pika_team', 'chat_admin', 'top_chat_admin', 'marketing', 'player', null]) {
        const response = await api.call(method, path, { profileId: w.c1, role }, body)
        assertEqual(response.status, 403, `${method} ${path} роля ${role}`)
      }
    }
    assertEqual(openRows(raw), 1, 'няма нови забрани')
    assertEqual(store.isEnabled(), false, 'флагът не е променен')
    assertEqual(store.getRestriction(id)?.status, 'active', 'забраната не е отменена')
  } finally {
    await api.close()
  }
})

await check('[A2] API (admin): налагане, срок/безсрочна, отказ за един акаунт и дублиране, списък, отделна забрана, одит', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const api = await startApi(store, () => true)
  const admin = { profileId: w.admin, role: 'admin' }
  try {
    const both = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 5, indefinite: true })
    assertEqual(both.status, 400, 'срок И безсрочна')
    const none = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x' })
    assertEqual(none.status, 400, 'без срок')
    const text = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: '30' })
    assertEqual(text.status, 400, 'срок като текст')
    const sameAccount = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.a2, reason: 'x', durationDays: 30 })
    assertEqual([sameAccount.status, sameAccount.body.code], [409, 'same_account'], 'един акаунт')
    const created = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'Сговор', durationDays: 30, actorProfileId: w.c1 })
    assertEqual(created.status, 201, 'налагане')
    assertEqual(created.body.restriction.createdByProfileId, w.admin, 'извършителят е от сесията, не от тялото')
    const duplicate = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.b2, secondProfileId: w.a2, reason: 'x', indefinite: true })
    assertEqual([duplicate.status, duplicate.body.code], [409, 'already_restricted'], 'дублиране')
    const indefinite = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.c1, reason: 'x', indefinite: true })
    assertEqual([indefinite.status, indefinite.body.restriction.isIndefinite], [201, true], 'безсрочна')
    const list = await api.call('GET', '/api/admin/co-play-restrictions?status=active&q=bravo', admin)
    assertEqual([list.status, list.body.total, list.body.enabled], [200, 1, false], 'списък с търсене')
    const badStatus = await api.call('GET', '/api/admin/co-play-restrictions?status=foo', admin)
    assertEqual(badStatus.status, 400, 'невалиден статус')
    const one = await api.call('GET', `/api/admin/co-play-restrictions/${created.body.restriction.restrictionId}`, admin)
    assertEqual([one.status, one.body.restriction.status], [200, 'active'], 'една забрана')
    const missing = await api.call('GET', `/api/admin/co-play-restrictions/${randomUUID()}`, admin)
    assertEqual(missing.status, 404, 'несъществуваща')
    const audit = await api.call('GET', '/api/admin/co-play-restrictions/audit', admin)
    assertEqual([audit.status, audit.body.total], [200, 2], 'одит')
  } finally {
    await api.close()
  }
})

await check('[A3] API (admin): отмяна (и повторна), флаг без рестарт, Origin защита на промените', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  let originAllowed = true
  const api = await startApi(store, () => originAllowed)
  const admin = { profileId: w.admin, role: 'admin' }
  try {
    const created = await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 30 })
    const id = created.body.restriction.restrictionId as string
    const enabled = await api.call('PUT', '/api/admin/co-play-restrictions/settings', admin, { enabled: true })
    assertEqual([enabled.status, enabled.body.settings.enabled, enabled.body.changed], [200, true, true], 'включване на флага')
    assert(store.isRestrictedBetweenProfiles(w.a1, w.b1), 'флагът важи веднага, без рестарт')
    const badFlag = await api.call('PUT', '/api/admin/co-play-restrictions/settings', admin, { enabled: 'yes' })
    assertEqual(badFlag.status, 400, 'невалиден флаг')
    originAllowed = false
    const blockedLift = await api.call('POST', `/api/admin/co-play-restrictions/${id}/lift`, admin, {})
    assertEqual(blockedLift.status, 403, 'промяна от чужд Origin')
    const readAllowed = await api.call('GET', '/api/admin/co-play-restrictions/settings', admin)
    assertEqual(readAllowed.status, 200, 'четенето не зависи от Origin')
    originAllowed = true
    const lifted = await api.call('POST', `/api/admin/co-play-restrictions/${id}/lift`, admin, { reason: 'Обжалване' })
    assertEqual([lifted.status, lifted.body.restriction.status, lifted.body.restriction.liftReason], [200, 'lifted', 'Обжалване'], 'отмяна')
    assert(!store.isRestrictedBetweenProfiles(w.a1, w.b1), 'отменената не действа')
    const again = await api.call('POST', `/api/admin/co-play-restrictions/${id}/lift`, admin, {})
    assertEqual([again.status, again.body.code, again.body.status], [409, 'not_active', 'lifted'], 'повторна отмяна')
    const wrongMethod = await api.call('DELETE', `/api/admin/co-play-restrictions/${id}`, admin)
    assertEqual(wrongMethod.status, 405, 'метод')
    const unrelated = await api.call('GET', '/api/admin/other', admin)
    assertEqual(unrelated.status, 599, 'други пътища не се обработват')
  } finally {
    await api.close()
  }
})

await check('[A4] Етап 2 — прилагането след налагане/включване се вика само след успех; изключване и отказ не го викат', async () => {
  const { raw, store } = await freshEnv()
  const w = seedWorld(raw)
  const calls: string[] = []
  const api = await startApi(store, () => true, {
    onRestrictionImposed: ({ actorProfileId }) => { calls.push(`imposed:${actorProfileId}:${store.getCachedRestrictionCount()}`) },
    onEnabledChanged: ({ enabled }) => { calls.push(`enabled:${enabled}:${store.isEnabled()}`) },
  })
  const admin = { profileId: w.admin, role: 'admin' }
  try {
    await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.a2, reason: 'x', durationDays: 3 })
    await api.call('POST', '/api/admin/co-play-restrictions', { profileId: w.c1, role: 'pika_team' }, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 3 })
    assertEqual(calls, [], 'отказите не викат прилагане')
    await api.call('POST', '/api/admin/co-play-restrictions', admin, { firstProfileId: w.a1, secondProfileId: w.b1, reason: 'x', durationDays: 3 })
    assertEqual(calls, [`imposed:${w.admin}:1`], 'след успешно налагане (кешът вече е обновен)')
    await api.call('PUT', '/api/admin/co-play-restrictions/settings', admin, { enabled: true })
    await api.call('PUT', '/api/admin/co-play-restrictions/settings', admin, { enabled: true })
    await api.call('PUT', '/api/admin/co-play-restrictions/settings', admin, { enabled: false })
    assertEqual(calls.slice(1), ['enabled:true:true', 'enabled:false:false'], 'само при реална промяна, след записа')
  } finally {
    await api.close()
  }
})

// ─── Помощни ──────────────────────────────────────────────────────────────

async function startApi(
  store: CoPlayRestrictionStore,
  isAllowedOrigin: () => boolean,
  hooks: Pick<Parameters<typeof createCoPlayRestrictionAdminHttpRequestHandler>[0], 'onRestrictionImposed' | 'onEnabledChanged'> = {},
) {
  const handler = createCoPlayRestrictionAdminHttpRequestHandler({
    ...hooks,
    store,
    getSessionActor: (req: IncomingMessage) => {
      const raw = req.headers['x-test-actor']
      if (typeof raw !== 'string') return null
      const parsed = JSON.parse(raw) as { profileId: string; role: string | null }
      return { profileId: parsed.profileId, accountRole: parsed.role }
    },
    isAllowedOrigin: () => isAllowedOrigin(),
    readJsonBody: (req) => new Promise((resolveBody, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += String(chunk) })
      req.on('end', () => {
        try { resolveBody(data.length === 0 ? {} : JSON.parse(data)) } catch (error) { reject(error) }
      })
    }),
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    void handler(req, res, url.pathname, url.searchParams).then((handled) => {
      if (!handled) {
        res.statusCode = 599
        res.end()
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  return {
    async call(
      method: string,
      path: string,
      actor: { profileId: string; role: string | null } | null,
      body?: unknown,
    ): Promise<{ status: number; body: any }> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (actor !== null) headers['x-test-actor'] = JSON.stringify(actor)
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let parsed: any = null
      try { parsed = text.length > 0 ? JSON.parse(text) : null } catch { parsed = text }
      return { status: response.status, body: parsed }
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

for (const item of toClose) {
  try { item.close() } catch { /* вече затворена */ }
}
for (const root of tempRoots) {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1
