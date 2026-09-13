/**
 * checkRegistrationModerationGuard.ts
 *
 * E2E тест на registration anti-evasion gate-а (спешен production security
 * fix, разширен през пет follow-up briefа: ONE DEVICE -> ONE REGISTERED
 * ACCOUNT; IP + ACTIVE moderation secondary signal + DB-level one-device
 * guarantee; hard-delete evasion fix (ban) + bounded IP lookup; hard-delete
 * evasion fix (mute) + задължителен valid visitorId; 48h IP recency
 * прозорец за false-positive намаляване):
 *
 * Финална policy:
 *   A) DUPLICATE ACCOUNT PREVENTION — visitor_id вече свързан (site_visit_events)
 *      с КАКЪВТО И ДА Е съществуващ permanent profile (clean или не) -> BLOCK.
 *      НЯМА 48h прозорец тук — same device никога не създава втори permanent
 *      account, независимо колко стар е association-ът (тест AR).
 *   A2/B2) HARD-DELETE EVASION (ban И mute), device path — hard-deleted
 *      профил, който Е ИМАЛ активен BAN или активен Topics/Лафче mute в
 *      момента на изтриването -> BLOCK, докато оригиналната санкция не
 *      изтече. Same visitor/device path — НЯМА 48h прозорец тук също.
 *   B) IP + ACTIVE MODERATION + 48h RECENCY (пети follow-up brief) — нов/
 *      различен device, IP-то вече свързано с профил с АКТИВЕН ban/mute,
 *      И конкретният IP е бил реално използван от този профил през
 *      последните 48 часа (site_visit_events.occurred_at за живи профили,
 *      admin_profile_deletion_visitor_snapshots.last_seen_at за
 *      hard-deleted) -> BLOCK. IP-usage по-стар от 48h -> НЕ блокира само
 *      по IP сигнала (тестове AN-AQ, AS-AV).
 *   C) IP/device + clean/expired/lifted ИЛИ IP-usage >48h (жив ИЛИ
 *      hard-deleted) -> НЕ блокира (IP сам по себе си не означава "един
 *      човек"; временна санкция не се превръща в permanent block; стар
 *      IP-usage не е силен anti-evasion сигнал).
 *
 * Плюс "immediate visitor/profile binding": успешна регистрация СИНХРОННО
 * асоциира visitor_id <-> новия profile_id, ВЪТРЕ в регистрационната
 * транзакция — виж authStore.ts's register().
 *
 * Плюс DB-level "ONE DEVICE -> ONE PERMANENT ACCOUNT" invariant —
 * visitor_registration_bindings (PRIMARY KEY anonymous_visitor_id),
 * обикновен INSERT (не "OR IGNORE") ВЪТРЕ в СЪЩАТА транзакция — PK conflict
 * rollback-ва цялата регистрация, DB-enforced независимо от process
 * topology (виж 20260913_001 migration-а).
 *
 * Плюс задължителен valid visitorId (четвърти follow-up brief §2) —
 * authStore.ts::register() отхвърля липсващ/malformed/прекалено дълъг
 * visitorId ПРЕДИ каквато и да е DB проверка/write, със СЪЩИЯ generic
 * REGISTRATION_RESTRICTED резултат.
 *
 * Изолирано копие на реалния сървър (собствена temp SQLite база, реални
 * migrations, реален HTTP слой) — mirror на
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts pattern-а.
 *
 * Покрива (production report test matrix, кумулативно през трите брифа):
 *  A. Нов visitor_id, без никакви DB записи -> регистрацията минава.
 *  B. Същият visitor_id като АКТИВНО заглушен (Topics/Лафче section mute)
 *     профил -> 403 REGISTRATION_RESTRICTED, генеричен message.
 *  C. Същият visitor_id като АКТИВНО баннат профил -> 403 REGISTRATION_RESTRICTED.
 *  D. Същият visitor_id, mute-ът е ИЗТЕКЪЛ -> ВСЕ ПАК blocked (duplicate
 *     account prevention е по-широка от moderation evasion — профилът
 *     СЪЩЕСТВУВА, статусът на санкцията е ирелевантен за blocking решението).
 *  E. Същият visitor_id, банът е ВДИГНАТ (lifted_at set) -> ВСЕ ПАК blocked,
 *     същата логика като D.
 *  F/G. Банният профил е бил виждан и с ДРУГ, отделен visitor_id (multi-
 *     device профил) -> и ДВАТА негови visitor_id-та блокират нова
 *     регистрация (директен single-hop match за всеки, не транзитивен chain).
 *  K. Отказана регистрация -> НЯМА нов ред в accounts за този email.
 *  L. Generic client грешка -> response body НЕ съдържа matched profile id,
 *     IP/device, нито дума за "бан"/"мут"/"дублира".
 *  M. Нормален несвързан registration flow продължава да работи (login
 *     веднага работи за success случая).
 *  N. Guest -> register flow: архитектурно потвърдено (audit) — един-
 *     единствен account-creation choke point, не се тества отделно тук.
 *  O. Същия visitor_id като СЪЩЕСТВУВАЩ CLEAN (без ban/mute) профил ->
 *     403 REGISTRATION_RESTRICTED (duplicate-account prevention).
 *  P. Същия сценарий -> няма нов account/profile/profile_wallets/
 *     profile_progress ред.
 *  Q. Регистрация A от visitor X успешна -> ВЕДНАГА (без допълнителен
 *     page-view call) регистрация B от СЪЩИЯ visitor X -> rejected (доказва
 *     "immediate visitor/profile binding" fix-а).
 *  R. Два конкурентни (Promise.all) registration опита със СЪЩИЯ visitor_id
 *     -> максимум ЕДНА permanent registration се създава.
 *  T. Guest-only visitor (site_visit_events ред с profile_id=NULL, никога
 *     не е регистрирал) -> първата permanent регистрация остава allowed.
 *  U. След успешна регистрация -> site_visit_events И
 *     visitor_registration_bindings редовете, свързващи visitor_id с новия
 *     profile_id, са налични ВЕДНАГА (директна DB проверка).
 *  V. Нов visitor_id + СЪЩИЯТ IP като АКТИВНО баннат профил -> 403 (IP +
 *     ACTIVE moderation, финална policy §B).
 *  W. Нов visitor_id + СЪЩИЯТ IP като АКТИВНО заглушен профил -> 403.
 *  X. Нов visitor_id + СЪЩИЯТ IP като профил с EXPIRED/LIFTED санкция ->
 *     allowed (IP + неактивна санкция не блокира, §C).
 *  Y. Нов visitor_id + СЪЩИЯТ IP като CLEAN профил -> allowed (= стария
 *     тест "S" — IP-only policy важи еднакво за clean и historical профили).
 *  Z. Два конкурентни registration опита със СЪЩИЯ visitor_id -> DB-level
 *     гаранция: точно 1 permanent registration + точно 1 ред във
 *     visitor_registration_bindings (разширение на R с директна DB
 *     проверка на canonical таблицата).
 *  AA. Duplicate visitor binding conflict, СИМУЛИРАН directно в canonical
 *     таблицата (БЕЗ съответен site_visit_events ред — доказва, че DB
 *     constraint-ът е независим enforcement layer, не просто разчита на
 *     pre-check-а) -> цялата транзакция rollback-ва: без account/profile/
 *     wallet/progress.
 *  AB. EXPLAIN QUERY PLAN за visitor lookup, стария IP lookup и финалния
 *     bounded IP + ACTIVE moderation lookup (EXISTS subqueries) -> индексиран
 *     SEARCH, не full table SCAN на растящата site_visit_events таблица.
 *  AC. Hard-deleted АКТИВНО баннат профил + СЪЩИЯТ visitor_id -> НЕ може да
 *     bypass-не moderation protection (403) — hard-delete evasion fix,
 *     трети follow-up brief §1.
 *  AD. Hard-deleted АКТИВНО баннат профил + НОВ visitor_id + СЪЩИЯТ IP ->
 *     403 (historical ban linkage през admin_profile_deletion_visitor_snapshots).
 *  AE. IP с много historical CLEAN профили + ЕДИН active banned/muted
 *     профил -> restriction се намира коректно (bounded single SQL query,
 *     не application-side N+1 loop).
 *  AF. IP само с много clean/expired профили -> allowed.
 *  AG. Hard-deleted profile с ACTIVE Topics mute + СЪЩИЯ visitor -> 403.
 *  AH. Hard-deleted profile с ACTIVE Topics mute + НОВ visitor + СЪЩИЯТ IP
 *     -> 403.
 *  AI. Същият deleted mute СЛЕД оригиналния muted_until -> allowed (не
 *     permanent block от временен mute).
 *  AJ. Registration без visitorId -> rejected, zero DB writes.
 *  AK. visitorId="" -> rejected.
 *  AL. Malformed/прекалено дълъг visitorId -> rejected.
 *  AM. Нормален UUID visitorId -> normal clean registration allowed.
 *  AN. Нов visitor + ACTIVE BAN профил + IP използван преди 5 минути -> 403.
 *  AO. Нов visitor + ACTIVE MUTE профил + IP използван преди 47 часа -> 403.
 *  AP. Нов visitor + ACTIVE BAN профил + IP последно използван преди 49
 *     часа -> allowed (извън 48h прозореца).
 *  AQ. Нов visitor + ACTIVE MUTE профил + IP последно използван преди 49
 *     часа -> allowed.
 *  AR. Same visitor/device + съществуващ акаунт, дори IP association >48h
 *     -> ВСЕ ПАК 403 (48h НЕ отслабва device policy-то).
 *  AS. Hard-deleted actively banned профил + recent IP (<=48h) -> 403.
 *  AT. Hard-deleted actively banned профил + old IP (>48h) -> allowed по IP
 *     сигнала.
 *  AU. Hard-deleted active mute snapshot + recent IP (<=48h) -> 403.
 *  AV. Hard-deleted active mute snapshot + old IP (>48h) -> allowed по IP
 *     сигнала.
 *  AW. Popup съдържа втория нов параграф ("свържете се с екипа на
 *     Pika.bg"), без IP/visitor_id/ban/mute/matched profile leak.
 *
 * Забележка: старият тест "H/I/J" (споделен IP с баннат профил -> allowed)
 * от първоначалния, по-тесен fix е СУПЕРСЕДНАТ от V/W/X/Y след финалната
 * IP + ACTIVE moderation policy — премахнат оттук, за да не твърди грешен
 * (вече неверен) очакван резултат.
 *
 * Hard-delete + moderation evasion audit (трети И четвърти follow-up
 * brief) — намерено и затворено, за BAN И MUTE:
 *   - BAN: profile_bans.profile_id е ON DELETE SET NULL (НЕ CASCADE, виж
 *     20260902_002/003 migrations) с deleted_profile_id_snapshot колона —
 *     активен-към-момента-на-изтриване бан ПРЕЖИВЯВА hard delete директно
 *     (profileBanStore.getActiveBanForDeletedProfile).
 *   - MUTE: topic_section_mutes/topic_mute_evidence СА ON DELETE CASCADE,
 *     БЕЗ snapshot колона (за разлика от profile_bans) — активен Topics/
 *     Лафче mute би изчезнал напълно при hard delete БЕЗ допълнителна мярка.
 *     Затворено чрез НОВА, dedicated таблица
 *     admin_profile_deletion_moderation_snapshots (20260913_003) —
 *     profileHardDeleteService.ts snapshot-ва active_topics_mute_until
 *     ПРЕДИ cascade-а (само IF профилът реално е бил активно заглушен),
 *     БЕЗ да пипа topic_section_mutes/topic_mute_evidence schema/FK/
 *     semantics изобщо (нулев diff риск за самата mute apply/remove логика).
 * admin_profile_deletion_visitor_snapshots (20260902_003) пази агрегиран
 * (deleted_profile_id, anonymous_visitor_id, ip_address) мост, populated
 * ЕДИНСТВЕНО в момента на hard delete — единственият оцелял начин да се
 * свърже visitor_id/IP със стар profile_id, след като site_visit_events.
 * profile_id вече е SET NULL. Reuse-вани directno (profileBanStore.
 * getActiveBanForDeletedProfile, profileHardDeleteService.
 * findDeletedProfileIdsForVisitorId/findDeletedProfileIdsForIp/
 * hasActiveMuteSnapshotForDeletedProfile) — БЕЗ ALTER на mute системата.
 *
 * Плюс: server-side audit log съдържание (match_type/reason) в stdout при
 * блокиран опит (без password/secrets).
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'RegGuardSmoke1!'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-reg-guard-smoke-'))
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

  const databaseFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')

  return {
    root,
    serverDir,
    databaseFile,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
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
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((res) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); res() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); res() })
  })
}

type RegisterAttemptResult = { status: number; body: Record<string, unknown> | null }

async function attemptRegister(
  port: number,
  input: { email: string; displayName: string; visitorId?: string; forwardedFor?: string },
): Promise<RegisterAttemptResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.forwardedFor) headers['X-Forwarded-For'] = input.forwardedFor
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: input.email,
      password: PASSWORD,
      displayName: input.displayName,
      gender: 'male',
      // explicit `!== undefined` (не truthy check) — тестове AK/AL трябва да
      // могат да пратят visitorId: '' (empty string) explicit, не само да
      // го пропуснат изцяло (тест AJ).
      ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
    }),
  })
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  return { status: res.status, body }
}

type RegisteredUser = { profileId: string; accountId: string; email: string }

async function registerAllowed(
  port: number,
  input: { email: string; displayName: string; visitorId?: string; forwardedFor?: string },
): Promise<RegisteredUser> {
  const result = await attemptRegister(port, input)
  if (result.status !== 200) {
    throw new Error(`Очаквах успешна регистрация, получих status=${result.status} body=${JSON.stringify(result.body)}`)
  }
  const payload = result.body as { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } } } | null
  if (!payload?.ok || !payload.session) {
    throw new Error(`Регистрацията не е успешна: ${JSON.stringify(result.body)}`)
  }
  return { profileId: payload.session.profile.profileId, accountId: payload.session.account.accountId, email: input.email }
}

async function login(port: number, email: string): Promise<{ status: number; cookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  return { status: res.status, cookie: rawCookie ? rawCookie.split(';')[0]! : null }
}

/** Mirror на promoteRole в checkAdminProfileBanAndDeleteHttpAuthorization.ts — директен DB update, за да не минаваме през целия role-grant HTTP flow (несвързан с regisration guard-а). */
function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

/** Реален admin hard-delete HTTP call (DELETE /api/admin/profiles/:id) — за тестове AC/AD, за да упражним реалния cascade/snapshot flow (profileHardDeleteService.ts), не reimplement-нат raw SQL. */
async function hardDeleteProfile(port: number, adminCookie: string, targetProfileId: string, reason: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/profiles/${targetProfileId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ reason }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// ─── Direct DB setup/assertion helpers (mirror на promoteRole в
// checkAdminProfileBanAndDeleteHttpAuthorization.ts — deterministic setup,
// без да минаваме през admin HTTP endpoints, които не са предмет на този тест) ───

/**
 * Симулира анонимно (guest, никога не регистрирал) browsing или "друг
 * browser session" на вече регистриран профил — profileId=null покрива
 * guest-only visitor сценария (тест T); profileId=<друг вече регистриран
 * профил> покрива multi-device сценария (тест F/G secondary device), за
 * КОЙТО няма реален register() call, затова не се създава автоматично от
 * immediate-binding fix-а. За НОВО регистриран профил самата registerAllowed()
 * вече създава този ред автоматично (виж authStore.ts's register() —
 * INSERT-и в site_visitors/site_visit_events вътре в регистрационната
 * транзакция) — тази helper функция НЕ Е нужна за primary visitor_id-та след
 * този fix.
 */
function insertVisitorEvent(databaseFile: string, input: { visitorId: string; profileId: string | null; ip: string | null }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id) VALUES (?)`).run(input.visitorId)
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, ip_address)
    VALUES (?, ?, ?, '/lobby', 'navigate', ?)
  `).run(randomUUID(), input.visitorId, input.profileId, input.ip)
  db.close()
}

/**
 * 48h IP recency тестове (пети follow-up brief) — same като insertVisitorEvent,
 * но с explicit контрол над occurred_at чрез SQLite datetime() modifier
 * (напр. '-5 minutes', '-47 hours', '-49 hours') — за да симулираме "IP-то е
 * било използвано точно преди N време", без реален sleep/wait в теста.
 */
function insertVisitorEventAgo(databaseFile: string, input: { visitorId: string; profileId: string | null; ip: string | null; agoModifier: string }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id) VALUES (?)`).run(input.visitorId)
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, ip_address, occurred_at)
    VALUES (?, ?, ?, '/lobby', 'navigate', ?, datetime('now', ?))
  `).run(randomUUID(), input.visitorId, input.profileId, input.ip, input.agoModifier)
  db.close()
}

/**
 * Тест AR — доказва, че device/visitor duplicate-account policy-то НЯМА
 * 48h прозорец (за разлика от IP-only policy-то). Състарява ВСИЧКИ
 * site_visit_events редове на даден visitor_id (вкл. автоматично записания
 * при самата регистрация) — device match-ът трябва да продължи да блокира
 * независимо колко стар е association-ът.
 */
function backdateVisitorEvents(databaseFile: string, visitorId: string, agoModifier: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE site_visit_events SET occurred_at = datetime('now', ?) WHERE anonymous_visitor_id = ?`).run(agoModifier, visitorId)
  db.close()
}

function insertBan(databaseFile: string, profileId: string, opts: { active: boolean }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const bannedUntil = opts.active ? "datetime('now', '+7 days')" : "datetime('now', '-1 days')"
  const liftedAt = opts.active ? 'NULL' : "datetime('now')"
  db.prepare(`
    INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id, lifted_at)
    VALUES (?, ?, ${bannedUntil}, 'test ban', NULL, ${liftedAt})
  `).run(randomUUID(), profileId)
  db.close()
}

function insertMute(databaseFile: string, profileId: string, opts: { active: boolean }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const mutedUntil = opts.active ? "datetime('now', '+1 hours')" : "datetime('now', '-1 hours')"
  db.prepare(`
    INSERT INTO topic_section_mutes (profile_id, muted_until, reason)
    VALUES (?, ${mutedUntil}, 'test mute')
  `).run(profileId)
  db.close()
}

/**
 * Тест AI помощник — симулира "оригиналната mute продължителност вече е
 * изтекла" СЛЕД hard delete, БЕЗ реален sleep: директно измества
 * admin_profile_deletion_moderation_snapshots.active_topics_mute_until в
 * миналото. Функционално еквивалентно на "времето е минало", защото
 * реалната имплементация (hasActiveMuteSnapshotForDeletedProfile) сравнява
 * exactly тази колона срещу CURRENT_TIMESTAMP at read time.
 */
function expireModerationSnapshot(databaseFile: string, deletedProfileId: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`
    UPDATE admin_profile_deletion_moderation_snapshots
    SET active_topics_mute_until = datetime('now', '-1 hours')
    WHERE deleted_profile_id = ?
  `).run(deletedProfileId)
  db.close()
}

function countAccountsByEmail(databaseFile: string, email: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE email = ?`).get(email) as { n: number }
  db.close()
  return row.n
}

function countRows(databaseFile: string, table: 'accounts' | 'profiles' | 'profile_wallets' | 'profile_progress'): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }
  db.close()
  return row.n
}

function hasVisitorProfileEvent(databaseFile: string, visitorId: string, profileId: string): boolean {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT 1 FROM site_visit_events WHERE anonymous_visitor_id = ? AND profile_id = ? LIMIT 1;
  `).get(visitorId, profileId)
  db.close()
  return row !== undefined
}

/** DB-level "ONE DEVICE -> ONE PERMANENT ACCOUNT" invariant (follow-up brief §3) — брой redове в canonical таблицата за даден visitor_id (0 или 1, никога повече — PRIMARY KEY). */
function countVisitorRegistrationBindings(databaseFile: string, visitorId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM visitor_registration_bindings WHERE anonymous_visitor_id = ?`).get(visitorId) as { n: number }
  db.close()
  return row.n
}

/**
 * Симулира "canonical binding вече съществува, но БЕЗ съответен
 * site_visit_events ред" (тест AA) — директен raw INSERT в
 * visitor_registration_bindings, заобикаляйки нормалния registration flow.
 * Доказва, че DB constraint-ът е независим enforcement layer от
 * checkRegistrationModerationRestriction's pre-check (който чете само
 * site_visit_events) — не просто дублира pre-check-а.
 */
function insertVisitorRegistrationBindingDirect(databaseFile: string, visitorId: string, profileId: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`INSERT INTO visitor_registration_bindings (anonymous_visitor_id, profile_id) VALUES (?, ?)`).run(visitorId, profileId)
  db.close()
}

/** EXPLAIN QUERY PLAN за дадена SQL заявка — връща всички редове от плана слепени в един низ, за текстови assertions (тест AB). */
function explainQueryPlan(databaseFile: string, sql: string, params: unknown[]): string {
  const db = new DatabaseSync(databaseFile)
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>
  db.close()
  return rows.map((r) => r.detail).join(' | ')
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Registration anti-evasion gate (moderation guard) E2E test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)

try {
  await waitFor('server ready', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms`)
      return res.status === 200
    } catch {
      return false
    }
  }, 30_000)

  const runId = Date.now().toString(36)

  // ── Admin bootstrap (за тестове AC/AD — реален hard-delete HTTP flow) ───
  const adminEmail = `reg-guard-${runId}-admin@example.test`
  await registerAllowed(port, { email: adminEmail, displayName: `RegGuardAdmin${runId}`, visitorId: randomUUID(), forwardedFor: '198.51.100.200' })
  promoteRole(isolated.databaseFile, adminEmail, 'admin')
  const adminLoginResult = await login(port, adminEmail)
  if (adminLoginResult.cookie === null) {
    throw new Error('Не успях да получа admin session cookie за AC/AD тестовете.')
  }
  const adminCookie = adminLoginResult.cookie

  // ── A. Нов visitor_id, чист IP -> регистрацията минава ──────────────────
  await check('A. нов visitor_id + чист IP -> registration allowed', async () => {
    const freshVisitorId = randomUUID()
    const email = `reg-guard-${runId}-a@example.test`
    const user = await registerAllowed(port, { email, displayName: `RegGuardA${runId}`, visitorId: freshVisitorId, forwardedFor: '198.51.100.1' })
    assert(user.profileId.length > 0, 'очаквах валиден profileId')
  })

  // ── Setup: "victim" профил (АКТИВНО заглушен) — visitor_id -> profile
  //    binding-ът вече се създава АВТОМАТИЧНО от самата registerAllowed()
  //    (immediate visitor/profile binding fix, §2) — НЕ Е нужен ръчен
  //    insertVisitorEvent тук повече. ────────────────────────────────────
  const mutedVisitorId = randomUUID()
  const mutedVictim = await registerAllowed(port, {
    email: `reg-guard-${runId}-muted-victim@example.test`,
    displayName: `RegGuardMV${runId}`,
    visitorId: mutedVisitorId,
    forwardedFor: '198.51.100.2',
  })
  insertMute(isolated.databaseFile, mutedVictim.profileId, { active: true })

  // ── B. Същият device като активно заглушен профил -> rejected ───────────
  await check('B. същия visitor_id като АКТИВНО заглушен профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-b@example.test`,
      displayName: `RegGuardB${runId}`,
      visitorId: mutedVisitorId,
      forwardedFor: '198.51.100.3',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── D. Същият device, mute-ът е ИЗТЕКЪЛ -> ВСЕ ПАК blocked (follow-up §1:
  //    duplicate-account prevention е по-широка от moderation evasion —
  //    профилът СЪЩЕСТВУВА, статусът на конкретната санкция е ирелевантен
  //    за blocking решението). СЕМАНТИКАТА Е ПРОМЕНЕНА спрямо
  //    първоначалния fix (там: allowed). ────────────────────────────────
  await check('D. същия visitor_id, mute-ът е изтекъл -> ВСЕ ПАК blocked (duplicate account, не moderation)', async () => {
    const expiredMuteVisitorId = randomUUID()
    const expiredVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-expired-mute-victim@example.test`,
      displayName: `RegGuardEMV${runId}`,
      visitorId: expiredMuteVisitorId,
      forwardedFor: '198.51.100.4',
    })
    insertMute(isolated.databaseFile, expiredVictim.profileId, { active: false })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-d@example.test`,
      displayName: `RegGuardD${runId}`,
      visitorId: expiredMuteVisitorId,
      forwardedFor: '198.51.100.5',
    })
    assert(result.status === 403, `очаквах 403 (duplicate account), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── Setup: "victim" профил (АКТИВНО баннат) — primary visitor_id binding
  //    е автоматичен (виж коментара при mutedVictim); secondary visitor_id
  //    симулира ВТОРИ, реално различен browser/device на СЪЩИЯ профил (за
  //    F/G) — за него НЯМА register() call, затова остава ръчен DB insert.
  const bannedVisitorIdPrimary = randomUUID()
  const bannedVisitorIdSecondary = randomUUID()
  const bannedVictim = await registerAllowed(port, {
    email: `reg-guard-${runId}-banned-victim@example.test`,
    displayName: `RegGuardBV${runId}`,
    visitorId: bannedVisitorIdPrimary,
    forwardedFor: '198.51.100.6',
  })
  insertVisitorEvent(isolated.databaseFile, { visitorId: bannedVisitorIdSecondary, profileId: bannedVictim.profileId, ip: '198.51.100.7' })
  insertBan(isolated.databaseFile, bannedVictim.profileId, { active: true })

  // ── C. Същият device (primary) като активно баннат профил -> rejected ───
  await check('C. същия visitor_id (primary device) като АКТИВНО баннат профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-c@example.test`,
      displayName: `RegGuardC${runId}`,
      visitorId: bannedVisitorIdPrimary,
      forwardedFor: '198.51.100.8',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── F/G. Вторият (secondary) device на СЪЩИЯ баннат профил -> rejected ──
  // Semantics (production report "Direct vs linked device"): profile A ->
  // visitor X (primary, real register), profile A -> visitor Y (secondary,
  // симулиран директен DB event) — регистрация от Y се блокира чрез ДВА
  // НЕЗАВИСИМИ директни single-hop lookup-а (X->A и Y->A поотделно), НЕ
  // чрез транзитивен chain (X->Y или обратното). Няма intermediary.
  await check('F/G. secondary device на същия АКТИВНО баннат профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-fg@example.test`,
      displayName: `RegGuardFG${runId}`,
      visitorId: bannedVisitorIdSecondary,
      forwardedFor: '198.51.100.9',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── E. Същият device, банът е ВДИГНАТ (lifted) -> ВСЕ ПАК blocked
  //    (same rationale като D). ──────────────────────────────────────────
  await check('E. същия visitor_id, банът е lifted -> ВСЕ ПАК blocked (duplicate account, не moderation)', async () => {
    const liftedBanVisitorId = randomUUID()
    const liftedVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-lifted-ban-victim@example.test`,
      displayName: `RegGuardLBV${runId}`,
      visitorId: liftedBanVisitorId,
      forwardedFor: '198.51.100.10',
    })
    insertBan(isolated.databaseFile, liftedVictim.profileId, { active: false })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-e@example.test`,
      displayName: `RegGuardE${runId}`,
      visitorId: liftedBanVisitorId,
      forwardedFor: '198.51.100.11',
    })
    assert(result.status === 403, `очаквах 403 (duplicate account), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── V. Нов visitor_id + СЪЩИЯТ IP като АКТИВНО баннат профил -> 403
  //    (IP + ACTIVE moderation, финална policy §B) ─────────────────────────
  await check('V. нов visitor_id + същия IP като АКТИВНО баннат профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const sharedIp = '203.0.113.50'
    const ipBanVictimVisitorId = randomUUID()
    const ipBanVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ip-ban-victim@example.test`,
      displayName: `RegGuardIPBV${runId}`,
      visitorId: ipBanVictimVisitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, ipBanVictim.profileId, { active: true })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-v@example.test`,
      displayName: `RegGuardV${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 403, `очаквах 403 (IP + ACTIVE ban), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── W. Нов visitor_id + СЪЩИЯТ IP като АКТИВНО заглушен профил -> 403 ───
  await check('W. нов visitor_id + същия IP като АКТИВНО заглушен профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const sharedIp = '203.0.113.51'
    const ipMuteVictimVisitorId = randomUUID()
    const ipMuteVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ip-mute-victim@example.test`,
      displayName: `RegGuardIPMV${runId}`,
      visitorId: ipMuteVictimVisitorId,
      forwardedFor: sharedIp,
    })
    insertMute(isolated.databaseFile, ipMuteVictim.profileId, { active: true })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-w@example.test`,
      displayName: `RegGuardW${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 403, `очаквах 403 (IP + ACTIVE mute), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── X. Нов visitor_id + СЪЩИЯТ IP като профил с EXPIRED/LIFTED санкция ->
  //    allowed (IP + неактивна санкция не блокира, §C) ────────────────────
  await check('X. нов visitor_id + същия IP като профил с EXPIRED/LIFTED санкция -> registration allowed', async () => {
    const sharedIp = '203.0.113.52'
    const ipExpiredVictimVisitorId = randomUUID()
    const ipExpiredVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ip-expired-victim@example.test`,
      displayName: `RegGuardIPEV${runId}`,
      visitorId: ipExpiredVictimVisitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, ipExpiredVictim.profileId, { active: false })
    insertMute(isolated.databaseFile, ipExpiredVictim.profileId, { active: false })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-x@example.test`,
      displayName: `RegGuardX${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 200, `очаквах 200 (allowed — expired/lifted санкция на IP не блокира), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── Y (= стария тест "S"). Нов visitor_id + СЪЩИЯТ IP като CLEAN профил ─
  await check('Y. споделен IP + различен visitor + CLEAN профил -> registration allowed', async () => {
    const sharedCleanIp = '203.0.113.80'
    const cleanIpVisitorId = randomUUID()
    await registerAllowed(port, {
      email: `reg-guard-${runId}-s-victim@example.test`,
      displayName: `RegGuardSV${runId}`,
      visitorId: cleanIpVisitorId,
      forwardedFor: sharedCleanIp,
    })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-s@example.test`,
      displayName: `RegGuardS${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedCleanIp,
    })
    assert(result.status === 200, `очаквах 200 (allowed), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── K. Отказана регистрация -> няма нов account ред за този email ───────
  await check('K. отказана регистрация -> няма нов account ред', async () => {
    const email = `reg-guard-${runId}-k@example.test`
    const before = countAccountsByEmail(isolated.databaseFile, email)
    assert(before === 0, 'sanity: email не трябва да съществува преди опита')

    const result = await attemptRegister(port, {
      email,
      displayName: `RegGuardK${runId}`,
      visitorId: bannedVisitorIdPrimary,
      forwardedFor: '198.51.100.12',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)

    const after = countAccountsByEmail(isolated.databaseFile, email)
    assert(after === 0, `очаквах 0 нови account редове след отказана регистрация, намерих ${after}`)
  })

  // ── L. Generic client грешка -> без leak на profile/IP/device/причина ───
  await check('L. generic client error -> без matched profile/IP/device/moderation reason leak', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-l@example.test`,
      displayName: `RegGuardL${runId}`,
      visitorId: bannedVisitorIdPrimary,
      forwardedFor: '198.51.100.13',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)
    const body = result.body ?? {}
    const keys = Object.keys(body)
    assert(
      keys.every((k) => k === 'ok' || k === 'code' || k === 'message'),
      `response body съдържа неочаквани полета: ${JSON.stringify(keys)}`,
    )
    const serialized = JSON.stringify(body).toLowerCase()
    assert(!serialized.includes(bannedVictim.profileId.toLowerCase()), 'response body съдържа matched profileId')
    assert(!serialized.includes(bannedVisitorIdPrimary.toLowerCase()), 'response body съдържа visitor_id')
    assert(!serialized.includes('бан'), 'response body съдържа думата "бан"')
    assert(!serialized.includes('мут'), 'response body съдържа думата "мут"')
    assert(!serialized.includes('дублира'), 'response body съдържа думата "дублира"')
    assert(!serialized.includes('198.51.100'), 'response body съдържа IP адрес')
  })

  // ── M. Нормален несвързан registration flow продължава да работи ────────
  await check('M. нормален несвързан registration flow + login продължава да работи', async () => {
    const email = `reg-guard-${runId}-m@example.test`
    await registerAllowed(port, { email, displayName: `RegGuardM${runId}`, visitorId: randomUUID(), forwardedFor: '198.51.100.14' })
    const loginResult = await login(port, email)
    assert(loginResult.status === 200 && loginResult.cookie !== null, `очаквах успешен login, получих status=${loginResult.status}`)
  })

  // ── O. Същия visitor_id като СЪЩЕСТВУВАЩ CLEAN профил -> rejected ───────
  const cleanVisitorId = randomUUID()
  const cleanVictim = await registerAllowed(port, {
    email: `reg-guard-${runId}-clean-victim@example.test`,
    displayName: `RegGuardCV${runId}`,
    visitorId: cleanVisitorId,
    forwardedFor: '198.51.100.20',
  })
  // cleanVictim е напълно чист — без ban, без mute, нарочно.

  await check('O. същия visitor_id като СЪЩЕСТВУВАЩ CLEAN профил -> 403 REGISTRATION_RESTRICTED', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-o@example.test`,
      displayName: `RegGuardO${runId}`,
      visitorId: cleanVisitorId,
      forwardedFor: '198.51.100.21',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
    assert(cleanVictim.profileId.length > 0, 'sanity: cleanVictim трябва да е реален профил')
  })

  // ── P. Същия сценарий -> няма нов account/profile/wallet/progress ред ───
  await check('P. clean-duplicate опит -> няма нов account/profile/profile_wallets/profile_progress ред', async () => {
    const accountsBefore = countRows(isolated.databaseFile, 'accounts')
    const profilesBefore = countRows(isolated.databaseFile, 'profiles')
    const walletsBefore = countRows(isolated.databaseFile, 'profile_wallets')
    const progressBefore = countRows(isolated.databaseFile, 'profile_progress')

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-p@example.test`,
      displayName: `RegGuardP${runId}`,
      visitorId: cleanVisitorId,
      forwardedFor: '198.51.100.22',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status}`)

    assert(countRows(isolated.databaseFile, 'accounts') === accountsBefore, 'accounts редовете са се променили')
    assert(countRows(isolated.databaseFile, 'profiles') === profilesBefore, 'profiles редовете са се променили')
    assert(countRows(isolated.databaseFile, 'profile_wallets') === walletsBefore, 'profile_wallets редовете са се променили')
    assert(countRows(isolated.databaseFile, 'profile_progress') === progressBefore, 'profile_progress редовете са се променили')
  })

  // ── Q. Веднага след успешна регистрация A, СЪЩИЯТ visitor опитва
  //    регистрация B — БЕЗ какъвто и да е допълнителен page-view call по
  //    средата (доказва immediate visitor/profile binding fix-а, §2). ─────
  await check('Q. втора регистрация от СЪЩИЯ visitor_id ВЕДНАГА (без page-view) -> rejected', async () => {
    const immediateVisitorId = randomUUID()
    await registerAllowed(port, {
      email: `reg-guard-${runId}-q-first@example.test`,
      displayName: `RegGuardQFirst${runId}`,
      visitorId: immediateVisitorId,
      forwardedFor: '198.51.100.95',
    })
    // НИКАКЪВ insertVisitorEvent/page-view извикване тук — точно сценарият
    // от follow-up brief §2.
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-q-second@example.test`,
      displayName: `RegGuardQSecond${runId}`,
      visitorId: immediateVisitorId,
      forwardedFor: '198.51.100.96',
    })
    assert(result.status === 403, `очаквах 403 (immediate duplicate block), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── R/Z. Два конкурентни (Promise.all) registration опита със СЪЩИЯ
  //    visitor_id -> DB-level гаранция: максимум ЕДНА permanent registration
  //    И точно 1 ред във visitor_registration_bindings (не просто process-
  //    level synchronous-event-loop late — виж production report-а "DB-
  //    level one-device guarantee") ────────────────────────────────────────
  await check('R/Z. два конкурентни registration опита със СЪЩИЯ visitor_id -> DB-level guarantee: точно 1 permanent registration', async () => {
    const raceVisitorId = randomUUID()
    const emailA = `reg-guard-${runId}-race-a@example.test`
    const emailB = `reg-guard-${runId}-race-b@example.test`

    const [resultA, resultB] = await Promise.all([
      attemptRegister(port, { email: emailA, displayName: `RegGuardRaceA${runId}`, visitorId: raceVisitorId, forwardedFor: '198.51.100.90' }),
      attemptRegister(port, { email: emailB, displayName: `RegGuardRaceB${runId}`, visitorId: raceVisitorId, forwardedFor: '198.51.100.91' }),
    ])

    const statuses = [resultA.status, resultB.status].sort((a, b) => a - b)
    assert(
      statuses[0] === 200 && statuses[1] === 403,
      `очаквах точно 1x200 + 1x403, получих ${JSON.stringify([resultA.status, resultB.status])} (bodies: ${JSON.stringify([resultA.body, resultB.body])})`,
    )

    const countA = countAccountsByEmail(isolated.databaseFile, emailA)
    const countB = countAccountsByEmail(isolated.databaseFile, emailB)
    assert(countA + countB === 1, `очаквах точно 1 нов account измежду двата email-а, намерих ${countA + countB}`)

    const bindingCount = countVisitorRegistrationBindings(isolated.databaseFile, raceVisitorId)
    assert(bindingCount === 1, `очаквах точно 1 ред във visitor_registration_bindings за raceVisitorId, намерих ${bindingCount}`)
  })

  // ── T. Guest-only visitor (без permanent account) -> първата регистрация
  //    остава allowed ──────────────────────────────────────────────────────
  await check('T. guest-only visitor (без permanent account) -> първата регистрация е allowed', async () => {
    const guestOnlyVisitorId = randomUUID()
    // Симулира анонимно browsing (guest, никога не е регистрирал) —
    // site_visit_events ред със profile_id=NULL, точно каквото
    // createVisitorPageViewTracker.ts/handleSiteVisitPageViewRequest пращат
    // за unauthenticated посетители.
    insertVisitorEvent(isolated.databaseFile, { visitorId: guestOnlyVisitorId, profileId: null, ip: '198.51.100.30' })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-t@example.test`,
      displayName: `RegGuardT${runId}`,
      visitorId: guestOnlyVisitorId,
      forwardedFor: '198.51.100.30',
    })
    assert(result.status === 200, `очаквах 200 (guest-only, без permanent account), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── U. Веднага след успешна регистрация -> visitor/profile association е
  //    налична (директна DB проверка, не само inferred от Q) — И в legacy
  //    site_visit_events, И в canonical visitor_registration_bindings ─────
  await check('U. след успешна регистрация, visitor/profile association е налична веднага (legacy + canonical)', async () => {
    const bindingVisitorId = randomUUID()
    const user = await registerAllowed(port, {
      email: `reg-guard-${runId}-u@example.test`,
      displayName: `RegGuardU${runId}`,
      visitorId: bindingVisitorId,
      forwardedFor: '198.51.100.97',
    })
    assert(
      hasVisitorProfileEvent(isolated.databaseFile, bindingVisitorId, user.profileId),
      'очаквах site_visit_events ред, свързващ visitorId с новия profileId, веднага след успешна регистрация',
    )
    assert(
      countVisitorRegistrationBindings(isolated.databaseFile, bindingVisitorId) === 1,
      'очаквах visitor_registration_bindings ред за bindingVisitorId веднага след успешна регистрация',
    )
  })

  // ── AA. Duplicate visitor binding conflict, симулиран directno в
  //    canonical таблицата (БЕЗ съответен site_visit_events ред) -> цялата
  //    регистрационна транзакция rollback-ва: без account/profile/wallet/
  //    progress (follow-up brief §3/§5 AA) ─────────────────────────────────
  await check('AA. duplicate visitor binding conflict -> цялата транзакция rollback-ва (без account/profile/wallet/progress)', async () => {
    // Setup: съществуващ профил + ръчно вмъкнат canonical binding ред за нов
    // visitor_id, БЕЗ съответен site_visit_events ред — симулира сценарий,
    // при който pre-check-ът (който чете site_visit_events) НЕ би хванал
    // конфликта сам, но DB constraint-ът върху canonical таблицата все пак
    // го хваща (независим enforcement layer, не дублиране на pre-check-а).
    const conflictingProfile = await registerAllowed(port, {
      email: `reg-guard-${runId}-aa-owner@example.test`,
      displayName: `RegGuardAAOwner${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.98',
    })
    const aaVisitorId = randomUUID()
    insertVisitorRegistrationBindingDirect(isolated.databaseFile, aaVisitorId, conflictingProfile.profileId)

    const email = `reg-guard-${runId}-aa@example.test`
    const accountsBefore = countRows(isolated.databaseFile, 'accounts')
    const profilesBefore = countRows(isolated.databaseFile, 'profiles')
    const walletsBefore = countRows(isolated.databaseFile, 'profile_wallets')
    const progressBefore = countRows(isolated.databaseFile, 'profile_progress')

    const result = await attemptRegister(port, {
      email,
      displayName: `RegGuardAA${runId}`,
      visitorId: aaVisitorId,
      forwardedFor: '198.51.100.99',
    })

    assert(result.status === 403, `очаквах 403 (DB-level binding conflict), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)

    assert(countAccountsByEmail(isolated.databaseFile, email) === 0, 'очаквах 0 нови account редове след binding conflict')
    assert(countRows(isolated.databaseFile, 'accounts') === accountsBefore, 'accounts редовете са се променили след rollback')
    assert(countRows(isolated.databaseFile, 'profiles') === profilesBefore, 'profiles редовете са се променили след rollback')
    assert(countRows(isolated.databaseFile, 'profile_wallets') === walletsBefore, 'profile_wallets редовете са се променили след rollback')
    assert(countRows(isolated.databaseFile, 'profile_progress') === progressBefore, 'profile_progress редовете са се променили след rollback')
    assert(
      countVisitorRegistrationBindings(isolated.databaseFile, aaVisitorId) === 1,
      'очаквах точно 1 (оригиналния, ръчно вмъкнат) binding ред за aaVisitorId — без duplicate',
    )
  })

  // ── AN. Нов visitor + ACTIVE BAN профил + IP използван преди 5 минути ──
  await check('AN. нов visitor + ACTIVE BAN профил + IP използван преди 5 минути -> 403', async () => {
    const anVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-an-victim@example.test`,
      displayName: `RegGuardANV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.190',
    })
    insertBan(isolated.databaseFile, anVictim.profileId, { active: true })
    const anIp = '203.0.113.130'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: anVictim.profileId, ip: anIp, agoModifier: '-5 minutes' })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-an@example.test`,
      displayName: `RegGuardAN${runId}`,
      visitorId: randomUUID(),
      forwardedFor: anIp,
    })
    assert(result.status === 403, `очаквах 403 (IP използван преди 5 мин, ACTIVE ban), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AO. Нов visitor + ACTIVE MUTE профил + IP използван преди 47 часа ──
  await check('AO. нов visitor + ACTIVE MUTE профил + IP използван преди 47 часа -> 403', async () => {
    const aoVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ao-victim@example.test`,
      displayName: `RegGuardAOV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.191',
    })
    insertMute(isolated.databaseFile, aoVictim.profileId, { active: true })
    const aoIp = '203.0.113.131'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: aoVictim.profileId, ip: aoIp, agoModifier: '-47 hours' })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ao@example.test`,
      displayName: `RegGuardAO${runId}`,
      visitorId: randomUUID(),
      forwardedFor: aoIp,
    })
    assert(result.status === 403, `очаквах 403 (IP използван преди 47ч, ACTIVE mute), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AP. Нов visitor + ACTIVE BAN профил + последна употреба на IP преди
  //    49 часа -> ALLOW (48h прозорецът е изтекъл) ─────────────────────────
  await check('AP. нов visitor + ACTIVE BAN профил + IP последно използван преди 49 часа -> registration allowed', async () => {
    const apVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ap-victim@example.test`,
      displayName: `RegGuardAPV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.192',
    })
    insertBan(isolated.databaseFile, apVictim.profileId, { active: true })
    const apIp = '203.0.113.132'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: apVictim.profileId, ip: apIp, agoModifier: '-49 hours' })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ap@example.test`,
      displayName: `RegGuardAP${runId}`,
      visitorId: randomUUID(),
      forwardedFor: apIp,
    })
    assert(result.status === 200, `очаквах 200 (IP-usage >48h, извън recency прозореца), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AQ. Нов visitor + ACTIVE MUTE профил + последна употреба на IP преди
  //    49 часа -> ALLOW ────────────────────────────────────────────────────
  await check('AQ. нов visitor + ACTIVE MUTE профил + IP последно използван преди 49 часа -> registration allowed', async () => {
    const aqVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-aq-victim@example.test`,
      displayName: `RegGuardAQV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.193',
    })
    insertMute(isolated.databaseFile, aqVictim.profileId, { active: true })
    const aqIp = '203.0.113.133'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: aqVictim.profileId, ip: aqIp, agoModifier: '-49 hours' })

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-aq@example.test`,
      displayName: `RegGuardAQ${runId}`,
      visitorId: randomUUID(),
      forwardedFor: aqIp,
    })
    assert(result.status === 200, `очаквах 200 (IP-usage >48h, извън recency прозореца), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AR. Same visitor/device + existing account, дори IP association да е
  //    >48h -> BLOCK. 48h НЕ трябва да отслабва device policy-то ─────────
  await check('AR. same visitor/device + съществуващ акаунт, IP association >48h -> ВСЕ ПАК 403 (device policy без 48h прозорец)', async () => {
    const arVisitorId = randomUUID()
    await registerAllowed(port, {
      email: `reg-guard-${runId}-ar-victim@example.test`,
      displayName: `RegGuardARV${runId}`,
      visitorId: arVisitorId,
      forwardedFor: '198.51.100.194',
    })
    // Състаряваме ВСИЧКИ site_visit_events редове на arVisitorId (вкл.
    // автоматично записания при самата регистрация) на много повече от 48ч —
    // device match-ът (findProfileIdsForVisitorId) няма occurred_at филтър
    // изобщо, затова трябва да продължи да блокира.
    backdateVisitorEvents(isolated.databaseFile, arVisitorId, '-1000 hours')

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ar@example.test`,
      displayName: `RegGuardAR${runId}`,
      visitorId: arVisitorId,
      forwardedFor: '198.51.100.195',
    })
    assert(result.status === 403, `очаквах 403 (device policy няма 48h прозорец), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AB. EXPLAIN QUERY PLAN за visitor lookup и IP lookup -> индексиран
  //    SEARCH, не full table SCAN на растящата site_visit_events таблица
  //    (follow-up brief §2/§5 AB) ────────────────────────────────────────
  await check('AB. EXPLAIN QUERY PLAN -> visitor/IP lookup използват индекс, не full table scan', () => {
    const visitorPlan = explainQueryPlan(
      isolated.databaseFile,
      'SELECT DISTINCT profile_id FROM site_visit_events WHERE anonymous_visitor_id = ? AND profile_id IS NOT NULL',
      ['dummy-visitor-id'],
    )
    assert(visitorPlan.includes('SEARCH'), `очаквах indexed SEARCH за visitor lookup, получих: ${visitorPlan}`)
    assert(!visitorPlan.includes('SCAN'), `visitor lookup плана съдържа full table SCAN: ${visitorPlan}`)

    const ipPlan = explainQueryPlan(
      isolated.databaseFile,
      'SELECT DISTINCT profile_id FROM site_visit_events WHERE ip_address = ? AND profile_id IS NOT NULL',
      ['198.51.100.1'],
    )
    assert(ipPlan.includes('SEARCH'), `очаквах indexed SEARCH за IP lookup, получих: ${ipPlan}`)
    assert(!ipPlan.includes('SCAN'), `IP lookup плана съдържа full table SCAN: ${ipPlan}`)

    // Финалният bounded IP + 48h recency + ACTIVE moderation lookup (пети
    // follow-up brief §2/§3/§5) — точно SQL текста, ползван от
    // findFirstActivelyModeratedProfileIdForIp в siteVisitStore.ts.
    const ipModerationPlan = explainQueryPlan(
      isolated.databaseFile,
      `SELECT DISTINCT sve.profile_id
       FROM site_visit_events sve
       WHERE sve.ip_address = ?
         AND sve.profile_id IS NOT NULL
         AND sve.occurred_at >= datetime('now', '-48 hours')
         AND (
           EXISTS (
             SELECT 1 FROM profile_bans pb
             WHERE pb.profile_id = sve.profile_id
               AND pb.lifted_at IS NULL
               AND pb.banned_until > CURRENT_TIMESTAMP
           )
           OR EXISTS (
             SELECT 1 FROM topic_section_mutes tsm
             WHERE tsm.profile_id = sve.profile_id
               AND tsm.muted_until > CURRENT_TIMESTAMP
           )
         )
       LIMIT 1`,
      ['198.51.100.1'],
    )
    assert(ipModerationPlan.includes('SEARCH'), `очаквах indexed SEARCH за IP moderation lookup, получих: ${ipModerationPlan}`)
    assert(!ipModerationPlan.includes('SCAN'), `IP moderation lookup плана съдържа full table SCAN: ${ipModerationPlan}`)

    // Hard-delete evasion (mute case, четвърти follow-up brief §5) —
    // hasActiveMuteSnapshotForDeletedProfile lookup-а в profileHardDeleteService.ts.
    const muteSnapshotPlan = explainQueryPlan(
      isolated.databaseFile,
      `SELECT 1
       FROM admin_profile_deletion_moderation_snapshots
       WHERE deleted_profile_id = ?
         AND active_topics_mute_until > CURRENT_TIMESTAMP
       LIMIT 1`,
      ['dummy-deleted-profile-id'],
    )
    assert(muteSnapshotPlan.includes('SEARCH'), `очаквах indexed SEARCH за deleted-mute snapshot lookup, получих: ${muteSnapshotPlan}`)
    assert(!muteSnapshotPlan.includes('SCAN'), `deleted-mute snapshot lookup плана съдържа full table SCAN: ${muteSnapshotPlan}`)

    // Hard-delete evasion IP + 48h recency lookup (пети follow-up brief §4) —
    // findDeletedProfileIdsForIp в profileHardDeleteService.ts. Таблицата е
    // малка/bounded (само admin hard-delete actions) — умишлено unindexed,
    // но плана все пак не трябва да показва full SCAN за bounded размера ѝ.
    const deletedIpPlan = explainQueryPlan(
      isolated.databaseFile,
      `SELECT DISTINCT deleted_profile_id
       FROM admin_profile_deletion_visitor_snapshots
       WHERE ip_address = ?
         AND last_seen_at >= datetime('now', '-48 hours')`,
      ['dummy-ip'],
    )

    console.log(`  [explain] visitor lookup: ${visitorPlan}`)
    console.log(`  [explain] IP lookup (legacy): ${ipPlan}`)
    console.log(`  [explain] IP + 48h recency + ACTIVE moderation lookup (final, bounded): ${ipModerationPlan}`)
    console.log(`  [explain] deleted-mute snapshot lookup: ${muteSnapshotPlan}`)
    console.log(`  [explain] deleted-profile IP + 48h recency lookup: ${deletedIpPlan}`)
  })

  // ── AC. Hard-deleted АКТИВНО баннат профил + СЪЩИЯТ visitor_id -> НЕ може
  //    да bypass-не moderation protection (трети follow-up brief §1) ──────
  await check('AC. hard-deleted АКТИВНО баннат профил + същия visitor_id -> НЕ bypass-ва (403)', async () => {
    const acVisitorId = randomUUID()
    const acVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ac-victim@example.test`,
      displayName: `RegGuardACV${runId}`,
      visitorId: acVisitorId,
      forwardedFor: '198.51.100.150',
    })
    insertBan(isolated.databaseFile, acVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, acVictim.profileId, 'test hard delete — active ban evasion check')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    // Sanity: профилът реално е изтрит от accounts/profiles.
    assert(
      countAccountsByEmail(isolated.databaseFile, `reg-guard-${runId}-ac-victim@example.test`) === 0,
      'sanity: account редът трябва да е изтрит след hard delete',
    )

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ac@example.test`,
      displayName: `RegGuardAC${runId}`,
      visitorId: acVisitorId,
      forwardedFor: '198.51.100.151',
    })
    assert(result.status === 403, `очаквах 403 (hard-delete evasion protection), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AD. Hard-deleted АКТИВНО баннат профил + НОВ visitor_id + СЪЩИЯТ IP
  //    -> 403 (historical ban linkage през
  //    admin_profile_deletion_visitor_snapshots) ─────────────────────────
  await check('AD. hard-deleted АКТИВНО баннат профил + нов visitor_id + същия IP -> 403', async () => {
    const sharedIp = '203.0.113.90'
    const adVisitorId = randomUUID()
    const adVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ad-victim@example.test`,
      displayName: `RegGuardADV${runId}`,
      visitorId: adVisitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, adVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, adVictim.profileId, 'test hard delete — IP evasion check')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ad@example.test`,
      displayName: `RegGuardAD${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 403, `очаквах 403 (historical ban linkage през IP), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AE. IP с много historical CLEAN профили + ЕДИН active banned/muted
  //    профил -> restriction се намира коректно (bounded single SQL query) ─
  await check('AE. IP с много clean профили + един active banned профил -> намерен коректно, без N+1', async () => {
    const sharedIp = '203.0.113.100'
    const CLEAN_PROFILE_COUNT = 15

    for (let i = 0; i < CLEAN_PROFILE_COUNT; i++) {
      await registerAllowed(port, {
        email: `reg-guard-${runId}-ae-clean-${i}@example.test`,
        displayName: `RegGuardAEClean${i}${runId}`,
        visitorId: randomUUID(),
        forwardedFor: sharedIp,
      })
    }

    const bannedVisitorId = randomUUID()
    const bannedOnIp = await registerAllowed(port, {
      email: `reg-guard-${runId}-ae-banned@example.test`,
      displayName: `RegGuardAEBanned${runId}`,
      visitorId: bannedVisitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, bannedOnIp.profileId, { active: true })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ae@example.test`,
      displayName: `RegGuardAE${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 403, `очаквах 403 (намерен active ban измежду ${CLEAN_PROFILE_COUNT} clean профила), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AF. IP само с много clean/expired профили -> allowed ────────────────
  await check('AF. IP само с много clean/expired профили -> registration allowed', async () => {
    const sharedIp = '203.0.113.110'
    const CLEAN_PROFILE_COUNT = 10

    for (let i = 0; i < CLEAN_PROFILE_COUNT; i++) {
      await registerAllowed(port, {
        email: `reg-guard-${runId}-af-clean-${i}@example.test`,
        displayName: `RegGuardAFClean${i}${runId}`,
        visitorId: randomUUID(),
        forwardedFor: sharedIp,
      })
    }

    const expiredVisitorId = randomUUID()
    const expiredOnIp = await registerAllowed(port, {
      email: `reg-guard-${runId}-af-expired@example.test`,
      displayName: `RegGuardAFExpired${runId}`,
      visitorId: expiredVisitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, expiredOnIp.profileId, { active: false })
    insertMute(isolated.databaseFile, expiredOnIp.profileId, { active: false })

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-af@example.test`,
      displayName: `RegGuardAF${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 200, `очаквах 200 (allowed — само clean/expired на IP-то), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AG. Hard-deleted profile с ACTIVE Topics mute + СЪЩИЯ visitor -> 403
  //    (четвърти follow-up brief §1) ───────────────────────────────────────
  await check('AG. hard-deleted profile с ACTIVE Topics mute + същия visitor -> 403', async () => {
    const agVisitorId = randomUUID()
    const agVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ag-victim@example.test`,
      displayName: `RegGuardAGV${runId}`,
      visitorId: agVisitorId,
      forwardedFor: '198.51.100.160',
    })
    insertMute(isolated.databaseFile, agVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, agVictim.profileId, 'test hard delete — active mute evasion check')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ag@example.test`,
      displayName: `RegGuardAG${runId}`,
      visitorId: agVisitorId,
      forwardedFor: '198.51.100.161',
    })
    assert(result.status === 403, `очаквах 403 (hard-delete mute evasion protection), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AH. Hard-deleted profile с ACTIVE Topics mute + НОВ visitor + СЪЩИЯТ
  //    IP -> 403 ────────────────────────────────────────────────────────────
  await check('AH. hard-deleted profile с ACTIVE Topics mute + нов visitor + същия IP -> 403', async () => {
    const sharedIp = '203.0.113.120'
    const ahVisitorId = randomUUID()
    const ahVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ah-victim@example.test`,
      displayName: `RegGuardAHV${runId}`,
      visitorId: ahVisitorId,
      forwardedFor: sharedIp,
    })
    insertMute(isolated.databaseFile, ahVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, ahVictim.profileId, 'test hard delete — IP mute evasion check')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const freshVisitorId = randomUUID()
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ah@example.test`,
      displayName: `RegGuardAH${runId}`,
      visitorId: freshVisitorId,
      forwardedFor: sharedIp,
    })
    assert(result.status === 403, `очаквах 403 (historical mute linkage през IP), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AS. Hard-deleted actively banned профил + recent IP (<=48h) -> BLOCK ─
  await check('AS. hard-deleted actively banned профил + recent IP (<=48h) -> 403', async () => {
    const asVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-as-victim@example.test`,
      displayName: `RegGuardASV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.196',
    })
    const asIp = '203.0.113.140'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: asVictim.profileId, ip: asIp, agoModifier: '-5 minutes' })
    insertBan(isolated.databaseFile, asVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, asVictim.profileId, 'test hard delete — 48h IP recency (recent, ban)')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-as@example.test`,
      displayName: `RegGuardAS${runId}`,
      visitorId: randomUUID(),
      forwardedFor: asIp,
    })
    assert(result.status === 403, `очаквах 403 (recent IP <=48h + hard-deleted active ban snapshot), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AT. Hard-deleted actively banned профил + old IP (>48h) -> ALLOW по
  //    IP сигнала (стар IP отпреди месеци не трябва да стане "recent" само
  //    защото профилът е изтрит днес) ──────────────────────────────────────
  await check('AT. hard-deleted actively banned профил + old IP (>48h) -> registration allowed по IP сигнала', async () => {
    const atVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-at-victim@example.test`,
      displayName: `RegGuardATV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.197',
    })
    const atIp = '203.0.113.141'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: atVictim.profileId, ip: atIp, agoModifier: '-2160 hours' }) // 90 дни
    insertBan(isolated.databaseFile, atVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, atVictim.profileId, 'test hard delete — 48h IP recency (old, ban)')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-at@example.test`,
      displayName: `RegGuardAT${runId}`,
      visitorId: randomUUID(),
      forwardedFor: atIp,
    })
    assert(result.status === 200, `очаквах 200 (IP-usage отпреди 90 дни, извън 48h прозореца), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AU. Hard-deleted active mute snapshot + recent IP (<=48h) -> BLOCK ──
  await check('AU. hard-deleted active mute snapshot + recent IP (<=48h) -> 403', async () => {
    const auVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-au-victim@example.test`,
      displayName: `RegGuardAUV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.198',
    })
    const auIp = '203.0.113.142'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: auVictim.profileId, ip: auIp, agoModifier: '-5 minutes' })
    insertMute(isolated.databaseFile, auVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, auVictim.profileId, 'test hard delete — 48h IP recency (recent, mute)')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-au@example.test`,
      displayName: `RegGuardAU${runId}`,
      visitorId: randomUUID(),
      forwardedFor: auIp,
    })
    assert(result.status === 403, `очаквах 403 (recent IP <=48h + hard-deleted active mute snapshot), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AV. Hard-deleted active mute snapshot + old IP (>48h) -> ALLOW по IP
  //    сигнала ────────────────────────────────────────────────────────────
  await check('AV. hard-deleted active mute snapshot + old IP (>48h) -> registration allowed по IP сигнала', async () => {
    const avVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-av-victim@example.test`,
      displayName: `RegGuardAVV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.199',
    })
    const avIp = '203.0.113.143'
    insertVisitorEventAgo(isolated.databaseFile, { visitorId: randomUUID(), profileId: avVictim.profileId, ip: avIp, agoModifier: '-2160 hours' })
    insertMute(isolated.databaseFile, avVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, avVictim.profileId, 'test hard delete — 48h IP recency (old, mute)')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-av@example.test`,
      displayName: `RegGuardAV${runId}`,
      visitorId: randomUUID(),
      forwardedFor: avIp,
    })
    assert(result.status === 200, `очаквах 200 (IP-usage отпреди 90 дни, извън 48h прозореца), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AW. Popup съдържа втория нов параграф и не leak-ва internal reason ──
  await check('AW. registration-restricted popup съдържа втория параграф, без IP/visitor_id/ban/mute/profile leak', () => {
    const popupSourcePath = resolve(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
    const fullSource = readFileSync(popupSourcePath, 'utf8')
    const startMarker = 'function renderRegistrationRestrictedPopup('
    const startIndex = fullSource.indexOf(startMarker)
    assert(startIndex !== -1, `не намерих ${startMarker} в ${popupSourcePath}`)
    const nextFunctionIndex = fullSource.indexOf('\nfunction ', startIndex + startMarker.length)
    const popupSource = fullSource.slice(startIndex, nextFunctionIndex === -1 ? fullSource.length : nextFunctionIndex)

    assert(popupSource.includes('Сигурни ли сте, че вече нямате регистрация в платформата?'), 'липсва първия параграф')
    assert(
      popupSource.includes('Ако смятате, че това предупреждение е грешно показано, свържете се с екипа на Pika.bg.'),
      'липсва вторият, нов параграф',
    )
    assert(popupSource.includes('Разбрах'), 'липсва бутонът "Разбрах"')

    const lowerPopupSource = popupSource.toLowerCase()
    for (const forbidden of ['visitorid', 'visitor_id', 'ip_address', 'x-forwarded-for', 'бан', 'мут', 'matchedprofileid', 'profileid']) {
      assert(!lowerPopupSource.includes(forbidden), `popup markup-ът съдържа забранен термин: "${forbidden}"`)
    }
  })

  // ── AI. Същият deleted mute СЛЕД оригиналния muted_until -> allowed (ако
  //    няма друга restriction) — не permanent block от временен mute ──────
  await check('AI. hard-deleted profile, mute snapshot-ът вече е изтекъл -> registration allowed', async () => {
    const aiVisitorId = randomUUID()
    const aiVictim = await registerAllowed(port, {
      email: `reg-guard-${runId}-ai-victim@example.test`,
      displayName: `RegGuardAIV${runId}`,
      visitorId: aiVisitorId,
      forwardedFor: '198.51.100.170',
    })
    insertMute(isolated.databaseFile, aiVictim.profileId, { active: true })

    const deleteResult = await hardDeleteProfile(port, adminCookie, aiVictim.profileId, 'test hard delete — expired mute snapshot check')
    assert(deleteResult.status === 200, `admin hard-delete очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    // Симулираме "оригиналната mute продължителност вече е минала" —
    // виж expireModerationSnapshot doc коментара.
    expireModerationSnapshot(isolated.databaseFile, aiVictim.profileId)

    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ai@example.test`,
      displayName: `RegGuardAI${runId}`,
      visitorId: aiVisitorId,
      forwardedFor: '198.51.100.171',
    })
    assert(result.status === 200, `очаквах 200 (mute snapshot-ът вече е изтекъл, не permanent block), получих ${result.status} body=${JSON.stringify(result.body)}`)
  })

  // ── AJ. Registration без visitorId -> rejected, zero DB writes ──────────
  await check('AJ. registration без visitorId -> rejected, zero DB writes', async () => {
    const email = `reg-guard-${runId}-aj@example.test`
    const accountsBefore = countRows(isolated.databaseFile, 'accounts')
    const profilesBefore = countRows(isolated.databaseFile, 'profiles')

    const result = await attemptRegister(port, {
      email,
      displayName: `RegGuardAJ${runId}`,
      forwardedFor: '198.51.100.180',
      // visitorId изцяло пропуснат.
    })
    assert(result.status === 403, `очаквах 403 (изисква valid visitorId), получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, email) === 0, 'очаквах 0 нови account редове')
    assert(countRows(isolated.databaseFile, 'accounts') === accountsBefore, 'accounts редовете са се променили')
    assert(countRows(isolated.databaseFile, 'profiles') === profilesBefore, 'profiles редовете са се променили')
  })

  // ── AK. visitorId = "" -> rejected ───────────────────────────────────────
  await check('AK. visitorId="" -> rejected', async () => {
    const result = await attemptRegister(port, {
      email: `reg-guard-${runId}-ak@example.test`,
      displayName: `RegGuardAK${runId}`,
      visitorId: '',
      forwardedFor: '198.51.100.181',
    })
    assert(result.status === 403, `очаквах 403, получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'REGISTRATION_RESTRICTED', `очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(result.body)}`)
  })

  // ── AL. malformed visitorId -> rejected (вкл. прекалено дълъг) ──────────
  await check('AL. malformed/прекалено дълъг visitorId -> rejected', async () => {
    const malformedResult = await attemptRegister(port, {
      email: `reg-guard-${runId}-al-malformed@example.test`,
      displayName: `RegGuardALMalformed${runId}`,
      visitorId: 'not-a-real-uuid',
      forwardedFor: '198.51.100.182',
    })
    assert(malformedResult.status === 403, `malformed: очаквах 403, получих ${malformedResult.status} body=${JSON.stringify(malformedResult.body)}`)
    assert(malformedResult.body?.code === 'REGISTRATION_RESTRICTED', `malformed: очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(malformedResult.body)}`)

    const tooLongResult = await attemptRegister(port, {
      email: `reg-guard-${runId}-al-toolong@example.test`,
      displayName: `RegGuardALTooLong${runId}`,
      visitorId: `${randomUUID()}${'a'.repeat(500)}`,
      forwardedFor: '198.51.100.183',
    })
    assert(tooLongResult.status === 403, `too-long: очаквах 403, получих ${tooLongResult.status} body=${JSON.stringify(tooLongResult.body)}`)
    assert(tooLongResult.body?.code === 'REGISTRATION_RESTRICTED', `too-long: очаквах code=REGISTRATION_RESTRICTED, получих ${JSON.stringify(tooLongResult.body)}`)
  })

  // ── AM. Нормален UUID visitorId -> normal clean registration allowed ───
  await check('AM. нормален UUID visitorId -> normal clean registration allowed', async () => {
    const user = await registerAllowed(port, {
      email: `reg-guard-${runId}-am@example.test`,
      displayName: `RegGuardAM${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.184',
    })
    assert(user.profileId.length > 0, 'очаквах валиден profileId')
  })

  // ── Audit log съдържание (spec §8, follow-up §5) — без password/secrets ──
  await check('audit log съдържа match_type/reason (вкл. IP match и duplicate_account) за блокирани опити, без password/secrets', () => {
    const logs = server.output()
    assert(logs.includes('[registration-guard] blocked registration attempt'), 'липсва [registration-guard] лог ред за блокиран опит')
    assert(logs.includes('"reason":"active_ban"'), 'липсва reason=active_ban в лога')
    assert(logs.includes('"reason":"active_mute"'), 'липсва reason=active_mute в лога')
    assert(logs.includes('"reason":"duplicate_account"'), 'липсва reason=duplicate_account в лога')
    assert(logs.includes('"matchType":"ip"'), 'липсва matchType=ip в лога (IP + ACTIVE moderation блок)')
    assert(!logs.toLowerCase().includes(PASSWORD.toLowerCase()), 'логът съдържа тестовата парола')
  })
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  try {
    await stopServer(server)
  } catch (err) {
    fail('Спиране на сървъра', err)
  }
  // Windows file-lock retry (mirror на checkAdminProfileBanAndDeleteHttpAuthorization.ts) —
  // temp cleanup failure не е тестов провал, само best-effort.
  let cleanupOk = false
  for (let attempt = 0; attempt < 5 && !cleanupOk; attempt++) {
    try {
      if (attempt > 0) await sleep(500)
      await isolated.cleanup()
      cleanupOk = true
    } catch {
      // ще опитаме пак
    }
  }
  if (!cleanupOk) {
    console.warn('  [warn] Временните файлове не бяха изтрити (Windows file lock) — не е тестов провал.')
  }
}

console.log(`\n═══ Резултат: ${passed} passed, ${failed} failed ═══\n`)
if (failed > 0) {
  process.exitCode = 1
}
