/**
 * checkProfileDeletionPartnerRatings.ts
 *
 * Самоизтриване, Етап 4E4 — партньорски оценки при окончателно изтриване
 * (миграция 20261028_001):
 *   * дадените от изтрития оценки остават в рейтингите на другите, без връзка
 *     към него (rated_by_profile_id = NULL);
 *   * получените от изтрития оценки изчезват;
 *   * profiles.average_rating / total_ratings_count на засегнатите играчи
 *     винаги отговарят на таблицата (вкл. при административно изтриване).
 * САМО временни бази. Оценките се дават през реалния submitPartnerRating.
 *
 * [U] Upgrade на миграцията.  [R] Оценки и изтриване.  [P] Процес (отмяна,
 * worker, restore, rollback, API).  [H] Административно изтриване.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'
import type { ServerRoom } from '../src/core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}
function assertThrows(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) throw new Error(`${message}: очаквана грешка "${fragment}", получена "${text}"`)
    return
  }
  throw new Error(`${message}: не беше отхвърлено`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-partner-ratings-secret-012345'
const NEW_MIGRATION = '20261028_001_preserve_anonymous_partner_ratings.sql'

console.log('\ncheckProfileDeletionPartnerRatings')

const tempRoots: string[] = []
async function createTempServerRoot(filter: (name: string) => boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-ratings-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && filter(entry.name)) {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  return root
}

const sqliteModule = await import('node:sqlite')

// ─── Стая с приключил мач (минимум за submitPartnerRating) ────────────────
function participant(profileId: string) {
  return {
    kind: 'human' as const,
    playerId: randomUUID(),
    connectionId: null,
    isConnected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    reconnectToken: null,
    identity: { accountId: null, profileId, username: null, displayName: 'Player', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
  }
}
function finishedRoom(raterProfileId: string, partnerProfileId: string, opponents: [string, string]): ServerRoom {
  const pts = { teamA: 160, teamB: 0 }
  return {
    id: `room-${randomUUID()}`,
    status: 'playing',
    seats: {
      bottom: { seat: 'bottom', team: 'A', participant: participant(raterProfileId) },
      top: { seat: 'top', team: 'A', participant: participant(partnerProfileId) },
      right: { seat: 'right', team: 'B', participant: participant(opponents[0]) },
      left: { seat: 'left', team: 'B', participant: participant(opponents[1]) },
    },
    game: {
      phase: 'match-ended',
      stateVersion: 1,
      authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A', targetScore: 151, finalScore: pts, endedAt: Date.now() }, score: { match: pts } },
    },
    replayVotes: [],
    leaveVotes: [],
  } as unknown as ServerRoom
}

try {
  console.log('\n[U] Миграция 20261028_001')

  await check('[U1] Upgrade със съществуващи оценки: стойностите са байт по байт запазени; FK SET NULL/CASCADE, UNIQUE, индекси и тригери са налице; FK проверката е чиста', async () => {
    const oldRoot = await createTempServerRoot((name) => name !== NEW_MIGRATION)
    const { databaseFilePath: oldPath } = await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    const old = new sqliteModule.DatabaseSync(oldPath, { open: true, enableForeignKeyConstraints: true })
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, id] of ids.entries()) {
      old.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(id, `Up${index}`, `up${index}`)
    }
    const insert = old.prepare(`INSERT INTO profile_partner_ratings (rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value, created_at) VALUES (?, ?, ?, ?, ?, ?);`)
    insert.run('r1', 'room-a:v1', ids[0], ids[1], 5, '2026-05-01 10:00:00')
    insert.run('r2', 'room-a:v1', ids[1], ids[0], 3, '2026-05-01 10:00:01')
    insert.run('r3', 'room-b:v2', ids[0], ids[2], 6, '2026-06-01 11:00:00')
    const before = JSON.stringify(old.prepare('SELECT * FROM profile_partner_ratings ORDER BY rating_id;').all())
    old.close()
    await cp(join(sourceServerRoot, 'database', 'migrations', NEW_MIGRATION), join(oldRoot, 'database', 'migrations', NEW_MIGRATION))
    await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    const up = new sqliteModule.DatabaseSync(oldPath, { readOnly: true })
    try {
      assertEqual(JSON.stringify(up.prepare('SELECT * FROM profile_partner_ratings ORDER BY rating_id;').all()), before, 'стойности')
      const fks = up.prepare(`SELECT "from", on_delete FROM pragma_foreign_key_list('profile_partner_ratings') ORDER BY "from";`).all() as Array<{ from: string; on_delete: string }>
      assertEqual(JSON.stringify(fks), JSON.stringify([{ from: 'rated_by_profile_id', on_delete: 'SET NULL' }, { from: 'rated_profile_id', on_delete: 'CASCADE' }]), 'FK')
      const notNull = (up.prepare(`SELECT name, "notnull" FROM pragma_table_info('profile_partner_ratings') WHERE name IN ('rated_by_profile_id', 'rated_profile_id') ORDER BY name;`).all() as Array<{ name: string; notnull: number }>).map((c) => `${c.name}:${c.notnull}`).join(',')
      assertEqual(notNull, 'rated_by_profile_id:0,rated_profile_id:1', 'NULL ограничения')
      const objects = (up.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'profile_partner_ratings' AND type IN ('index', 'trigger') ORDER BY name;`).all() as Array<{ name: string }>).map((row) => row.name)
      for (const name of ['idx_profile_partner_ratings_rated_profile_id', 'idx_profile_partner_ratings_rated_by_profile_id', 'trg_profile_partner_ratings_rater_required', 'trg_profile_partner_ratings_anonymous_immutable']) {
        assert(objects.includes(name), `липсва ${name}`)
      }
      assert(objects.some((name) => name.startsWith('sqlite_autoindex_profile_partner_ratings')), 'UNIQUE индексът')
      assertEqual((up.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      assertEqual((up.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity')
    } finally {
      up.close()
    }
  })

  // ─── Основна временна база ───────────────────────────────────────────────
  const root = await createTempServerRoot(() => true)
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const roots: ProfileDeletionUploadRoots = {
    avatars: join(root, 'uploads', 'avatars'),
    profileGallery: join(root, 'uploads', 'profile-gallery'),
    chatAttachments: join(root, 'uploads', 'chat-attachments'),
    topicAttachments: join(root, 'uploads', 'topic-attachments'),
    topicMuteEvidenceAttachments: join(root, 'uploads', 'topic-mute-evidence-attachments'),
    supportAttachments: join(root, 'uploads', 'support-attachments'),
  }
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  const hardDeleteService = await createProfileHardDeleteService(databaseFilePath, { deleteUploadFileByUrl: async () => {} })

  const makeWorker = (exec: ProfileDeletionExecutor, onlyRequestIds: string[]) => createProfileDeletionWorker({
    executor: exec,
    workerId: `w-ratings-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
  type User = { profileId: string; accountId: string }
  let counter = 0
  const registerUser = (label: string): User => {
    counter += 1
    const result = authStore.register({ email: `ratings-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName: `Rt${label}${counter}`, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId }
  }
  const filler = [registerUser('FillA'), registerUser('FillB')]
  const rate = (rater: User, partner: User, value: number) => {
    const result = progressStore.submitPartnerRating(finishedRoom(rater.profileId, partner.profileId, [filler[0]!.profileId, filler[1]!.profileId]), 'bottom', value)
    if (!result.ok) throw new Error(`оценка: ${JSON.stringify(result)}`)
  }
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const insertDueRequest = (user: User): string => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = new Date(Date.parse(dbNow()) - 1000).toISOString()
    const requestedAt = new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
    const guard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledFor)
    } finally {
      db.exec(guard)
    }
    return requestId
  }
  const deleteViaWorker = async (user: User): Promise<string> => {
    const requestId = insertDueRequest(user)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    return requestId
  }
  const ratingsOf = (profileId: string) => db.prepare('SELECT rating_id, room_id, rated_by_profile_id, rating_value, created_at FROM profile_partner_ratings WHERE rated_profile_id = ? ORDER BY rating_id;').all(profileId) as Array<Record<string, unknown>>
  const cacheOf = (profileId: string) => db.prepare('SELECT average_rating AS avg, total_ratings_count AS cnt FROM profiles WHERE profile_id = ?;').get(profileId) as { avg: number; cnt: number } | undefined
  const expectCache = (profileId: string, values: number[], message: string) => {
    const cache = cacheOf(profileId)
    const avg = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
    assert(cache !== undefined, `${message}: профилът липсва`)
    assertEqual(cache!.cnt, values.length, `${message}: брой`)
    assert(Math.abs(cache!.avg - avg) < 1e-9, `${message}: средна ${cache!.avg} != ${avg}`)
    const table = db.prepare('SELECT COUNT(*) AS c, COALESCE(AVG(rating_value), 0) AS a FROM profile_partner_ratings WHERE rated_profile_id = ?;').get(profileId) as { c: number; a: number }
    assert(table.c === cache!.cnt && Math.abs(table.a - cache!.avg) < 1e-9, `${message}: кешът не отговаря на таблицата`)
  }
  const allCachesConsistent = () => Number((db.prepare(`
    SELECT COUNT(*) AS c FROM profiles p WHERE p.profile_kind = 'human' AND (
      p.total_ratings_count <> (SELECT COUNT(*) FROM profile_partner_ratings WHERE rated_profile_id = p.profile_id)
      OR abs(p.average_rating - (SELECT COALESCE(AVG(rating_value), 0) FROM profile_partner_ratings WHERE rated_profile_id = p.profile_id)) > 1e-9);`).get() as { c: number }).c) === 0

  console.log('\n[R] Оценки и окончателно изтриване')

  const alice = registerUser('Alice') // оценявана
  const bob = registerUser('Bob') // оценява Alice, после се изтрива
  const carol = registerUser('Carol')
  const dave = registerUser('Dave')
  const third1 = registerUser('ThirdA')
  const third2 = registerUser('ThirdB')

  await check('[R1] Един потребител оценява друг: ред с оценяващия; средната и броят са коректни', () => {
    rate(bob, alice, 4)
    const rows = ratingsOf(alice.profileId)
    assert(rows.length === 1 && rows[0]!.rated_by_profile_id === bob.profileId && rows[0]!.rating_value === 4, JSON.stringify(rows))
    expectCache(alice.profileId, [4], 'Alice')
  })

  rate(carol, alice, 6)
  rate(dave, alice, 2)
  rate(third1, third2, 5) // трети лица
  rate(alice, bob, 3) // Bob получава оценка
  const thirdPartyBefore = JSON.stringify(ratingsOf(third2.profileId))

  await check('[R4] Множество оценки на един играч: средна (4+6+2)/3 и брой 3', () => {
    expectCache(alice.profileId, [4, 6, 2], 'Alice')
  })

  await deleteViaWorker(bob)
  await check('[R2] Изтриване на оценяващия (Bob): оценката му остава анонимна (rated_by NULL); средната и броят на Alice са непроменени', () => {
    const rows = ratingsOf(alice.profileId)
    assertEqual(rows.length, 3, 'брой редове')
    assertEqual(rows.filter((row) => row.rated_by_profile_id === null).length, 1, 'анонимни')
    assert(!JSON.stringify(rows).includes(bob.profileId), 'ID на Bob в редовете')
    expectCache(alice.profileId, [4, 6, 2], 'Alice')
  })

  await check('[R3] Изтриване на оценявания (Bob): получените от него оценки са изтрити; няма осиротели FK', () => {
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_profile_id = ? OR rated_by_profile_id = ?;').get(bob.profileId, bob.profileId) as { c: number }).c), 0, 'редове с Bob')
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  await deleteViaWorker(carol)
  await check('[R5] Последователно изтриване на двама оценяващи (Bob, Carol): две анонимни оценки; средната и броят — непроменени', () => {
    assertEqual(ratingsOf(alice.profileId).filter((row) => row.rated_by_profile_id === null).length, 2, 'анонимни')
    expectCache(alice.profileId, [4, 6, 2], 'Alice')
  })

  await check('[R9] Нова оценка след анонимизиране: приема се и влиза в средната заедно с анонимните', () => {
    rate(third1, alice, 5)
    expectCache(alice.profileId, [4, 6, 2, 5], 'Alice')
  })

  await check('[R10] Защита от дублиране и заобикаляне: повторна оценка в същата игра — отказ; INSERT без оценяващ — отказ; анонимен ред — неизменим', () => {
    const room = finishedRoom(dave.profileId, third2.profileId, [filler[0]!.profileId, filler[1]!.profileId])
    assert(progressStore.submitPartnerRating(room, 'bottom', 4).ok, 'първа оценка')
    const again = progressStore.submitPartnerRating(room, 'bottom', 1)
    assert(!again.ok && again.alreadyRated, `дублиране: ${JSON.stringify(again)}`)
    assertThrows(() => db.prepare(`INSERT INTO profile_partner_ratings (rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value) VALUES (?, 'x:v1', ?, NULL, 6);`).run(randomUUID(), alice.profileId), 'profile_partner_rating_rater_required', 'NULL оценяващ')
    const anonymousId = (db.prepare('SELECT rating_id FROM profile_partner_ratings WHERE rated_profile_id = ? AND rated_by_profile_id IS NULL LIMIT 1;').get(alice.profileId) as { rating_id: string }).rating_id
    assertThrows(() => db.prepare('UPDATE profile_partner_ratings SET rated_by_profile_id = ? WHERE rating_id = ?;').run(dave.profileId, anonymousId), 'profile_partner_rating_anonymous_immutable', 'присвояване')
    assertThrows(() => db.prepare('UPDATE profile_partner_ratings SET rating_value = 1 WHERE rating_id = ?;').run(anonymousId), 'profile_partner_rating_anonymous_immutable', 'редакция')
  })

  await check('[R6] Последователно изтриване на оценяващ и после оценяван: анонимните оценки изчезват с оценявания; няма остатъци', async () => {
    const rater = registerUser('SeqRater')
    const rated = registerUser('SeqRated')
    rate(rater, rated, 6)
    rate(third1, rated, 2)
    await deleteViaWorker(rater)
    expectCache(rated.profileId, [6, 2], 'SeqRated след изтриване на оценяващия')
    await deleteViaWorker(rated)
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_profile_id = ?;').get(rated.profileId) as { c: number }).c), 0, 'оценки на изтрития оценяван')
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  await check('[R7] Оценките на трети лица са байт по байт непроменени', () => {
    assertEqual(JSON.stringify(ratingsOf(third2.profileId).filter((row) => row.room_id !== undefined && row.rated_by_profile_id === third1.profileId)), JSON.stringify(JSON.parse(thirdPartyBefore)), 'трети лица')
  })

  await check('[R8] Кешът на средните оценки е коректен за всички профили', () => {
    assert(allCachesConsistent(), 'има несъответстващ кеш')
  })

  console.log('\n[P] Процес')

  await check('[P1] Отмяна преди крайния срок: дадените и получените оценки и кешовете са непроменени', async () => {
    const user = registerUser('Cancel')
    rate(user, dave, 5)
    rate(dave, user, 3)
    const before = JSON.stringify([ratingsOf(dave.profileId), ratingsOf(user.profileId), cacheOf(dave.profileId), cacheOf(user.profileId)])
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    assertEqual((await makeWorker(executor, [created.request.requestId]).runOnce()).claimed, 0, 'не е взета преди срока')
    assertEqual(JSON.stringify([ratingsOf(dave.profileId), ratingsOf(user.profileId), cacheOf(dave.profileId), cacheOf(user.profileId)]), before, 'през периода')
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    assertEqual(JSON.stringify([ratingsOf(dave.profileId), ratingsOf(user.profileId), cacheOf(dave.profileId), cacheOf(user.profileId)]), before, 'след отмяната')
  })

  await check('[P2] Окончателно изтриване след срока: completed; дадените оценки — анонимни; получените — изтрити; кешът — коректен', async () => {
    const user = registerUser('Final')
    rate(user, dave, 1)
    rate(third2, user, 6)
    const daveValues = (ratingsOf(dave.profileId) as Array<{ rating_value: number }>).map((row) => row.rating_value)
    // Кешът е остарял отпреди (напр. след стара каскада) — изтриването го поправя.
    db.prepare('UPDATE profiles SET average_rating = 6, total_ratings_count = 99 WHERE profile_id = ?;').run(dave.profileId)
    const requestId = await deleteViaWorker(user)
    assertEqual((db.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status, 'completed', 'статус')
    expectCache(dave.profileId, daveValues, 'Dave')
    assertEqual(ratingsOf(user.profileId).length, 0, 'получените')
  })

  await check('[P3] Повторно изпълнение на worker-а: нищо не се взема и нищо не се променя', async () => {
    const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM profile_partner_ratings ORDER BY rating_id;').all()) + JSON.stringify(db.prepare('SELECT profile_id, average_rating, total_ratings_count FROM profiles ORDER BY profile_id;').all())
    const before = snapshot()
    const requestIds = (db.prepare(`SELECT request_id FROM profile_deletion_requests WHERE status = 'completed';`).all() as Array<{ request_id: string }>).map((row) => row.request_id)
    assertEqual((await makeWorker(executor, requestIds).runOnce()).claimed, 0, 'нищо не е взето')
    assertEqual(snapshot(), before, 'непроменено')
  })

  await check('[P4] Restore от стар backup: replayDeletionForRestore анонимизира дадените, трие получените и преизчислява кеша във възстановената база', async () => {
    const user = registerUser('Replay')
    const target = registerUser('ReplayTarget')
    rate(user, target, 6)
    rate(third1, target, 2)
    rate(target, user, 4)
    const backupPath = join(root, `backup-${randomUUID()}.sqlite`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(backupPath)
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
      assertEqual(restored.replayDeletionForRestore({ profileId: user.profileId, accountIdSnapshot: user.accountId, profileCreatedAtSnapshot: createdAt }).kind, 'deleted', 'replay')
    } finally {
      restored.close()
    }
    const backup = new sqliteModule.DatabaseSync(backupPath, { readOnly: true })
    try {
      const rows = backup.prepare('SELECT rated_by_profile_id, rating_value FROM profile_partner_ratings WHERE rated_profile_id = ? ORDER BY rating_value;').all(target.profileId) as Array<{ rated_by_profile_id: string | null; rating_value: number }>
      assert(rows.length === 2 && rows.some((row) => row.rated_by_profile_id === null && row.rating_value === 6), JSON.stringify(rows))
      assertEqual(Number((backup.prepare('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_profile_id = ? OR rated_by_profile_id = ?;').get(user.profileId, user.profileId) as { c: number }).c), 0, 'нищо не сочи към изтрития')
      const cache = backup.prepare('SELECT average_rating AS avg, total_ratings_count AS cnt FROM profiles WHERE profile_id = ?;').get(target.profileId) as { avg: number; cnt: number }
      assert(cache.cnt === 2 && Math.abs(cache.avg - 4) < 1e-9, JSON.stringify(cache))
    } finally {
      backup.close()
    }
  })

  await check('[P5] Нарушен инвариант (чужда оценка изчезва по време на изтриването): ROLLBACK, failed; профилът, оценките и кешовете са непокътнати', async () => {
    const user = registerUser('Rollback')
    const target = registerUser('RollbackTarget')
    rate(user, target, 5)
    rate(third1, target, 3)
    const before = JSON.stringify([ratingsOf(target.profileId), cacheOf(target.profileId), cacheOf(user.profileId)])
    db.exec(`CREATE TRIGGER trg_test_lose_rating AFTER DELETE ON profiles WHEN OLD.profile_id = '${user.profileId}'
      BEGIN DELETE FROM profile_partner_ratings WHERE rated_profile_id = '${target.profileId}' AND rated_by_profile_id = '${third1.profileId}'; END;`)
    let requestId = ''
    try {
      requestId = insertDueRequest(user)
      assertEqual((await makeWorker(executor, [requestId]).runOnce()).failed, 1, 'failed')
    } finally {
      db.exec('DROP TRIGGER trg_test_lose_rating;')
    }
    const row = db.prepare('SELECT status, db_deleted_at, last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
    assert(row.status === 'failed' && row.db_deleted_at === null && row.last_error_code === 'db_phase_error', JSON.stringify(row))
    assert(cacheOf(user.profileId) !== undefined, 'профилът')
    assertEqual(JSON.stringify([ratingsOf(target.profileId), cacheOf(target.profileId), cacheOf(user.profileId)]), before, 'оценки и кешове')
  })

  await check('[P6] Публичните профилни отговори не съдържат идентификатори на изтритите оценяващи (само средна и брой)', () => {
    const profile = progressStore.getPublicProfile(alice.profileId)
    assert(profile !== null, 'профил')
    const raw = JSON.stringify(profile)
    for (const deleted of [bob, carol]) assert(!raw.includes(deleted.profileId), 'ID на изтрит оценяващ')
    assert(!/rated_by|ratedBy|raters?/i.test(raw), 'списък с оценяващи в публичния отговор')
    assertEqual(profile!.totalRatingsCount, 4, 'брой в отговора')
  })

  console.log('\n[H] Административно изтриване (Етап 4F2 — същите правила като самоизтриването)')

  await check('[H1] Административно изтриване на оценяващ: оценките му остават анонимни (както при самоизтриването), кешът на оценения е коректен', async () => {
    const admin = registerUser('Admin')
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
    const rater = registerUser('AdminRater')
    const rated = registerUser('AdminRated')
    rate(rater, rated, 1)
    rate(third2, rated, 5)
    expectCache(rated.profileId, [1, 5], 'преди')
    const result = await hardDeleteService.hardDeleteProfile({ targetProfileId: rater.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'test' })
    assert(result.ok, JSON.stringify(result))
    expectCache(rated.profileId, [1, 5], 'след административното изтриване')
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_by_profile_id IS NULL AND rated_profile_id = ?;').get(rated.profileId) as { c: number }).c), 1, 'дадената оценка остава анонимна')
    assert(allCachesConsistent(), 'всички кешове')
  })

  for (const store of [executor, requestStore, authStore, progressStore] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
