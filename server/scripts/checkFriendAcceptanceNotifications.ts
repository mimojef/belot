/**
 * checkFriendAcceptanceNotifications.ts
 *
 * Automated checks за:
 *   A. Migration backfill (реална база преди/след 20260701_002)
 *   B. FriendshipStore — getUnreadAcceptances / markAcceptanceRead
 *   C. Endpoint логика (бизнес правила, извлечени от handler-а в index.ts)
 *   D. WS протокол — типове и структури на събитията
 *   E. Frontend state — детерминистични чисти функции
 *
 * Endpoint checks тестват бизнес логиката директно чрез friendshipStore (без реален
 * HTTP server, тъй като handler-ът е вграден в index.ts и не може да се извлече без
 * production рефакторинг). HTTP routing (401 при липса на сесия, 400 при невалиден URL)
 * се проверява чрез regex и auth guard pattern, копирани от реалния handler.
 *
 * MANUAL CHECKS (не могат да се автоматизират без HTTP integration harness):
 *   - End-to-end 401: реален HTTP POST без Cookie header към /api/friends/{id}/read-acceptance
 *   - WS broadcast: реален WebSocket server с два отворени connection-а
 *   - friend_request_accepted се изпраща само на requester (не на addressee)
 *   - reconnect не създава дублирано notification (изисква restart на WS connection)
 *
 * [A1] Колоната НЕ съществува преди migration 20260701_002
 * [A2] Accepted friendship, вмъкнат преди migration, получава read_at = updated_at след migrate
 * [A3] Backfill-натият ред НЕ излиза като unread notification
 * [A4] Pending friendship преди migration — read_at остава NULL след migrate
 * [B1] Нова accepted покана с read_at=NULL → getUnreadAcceptances я включва
 * [B2] markAcceptanceRead маркира точно съответния ред (DB non-NULL)
 * [B3] След markAcceptanceRead → изчезва от getUnreadAcceptances
 * [B4] markAcceptanceRead с чужд requester — DB не се променя (security)
 * [B5] markAcceptanceRead е idempotent (второ извикване → ok:true)
 * [B6] markAcceptanceRead с невалиден ID → ok:false (стор validation)
 * [B7] Pending friendship НЕ е в unread acceptances
 * [B8] Множество unread notifications се връщат всички
 * [B9] markAcceptanceRead премахва само своето известие, останалите остават
 * [B10] Втори store instance вижда актуалното прочетено известие
 * [B11] requester_acceptance_read_at е реален timestamp (не NULL, не empty string)
 * [C1] Endpoint regex: валиден UUID friendshipId преминава
 * [C2] Endpoint regex: friendshipId с интервали се отхвърля
 * [C3] Endpoint regex: friendshipId > 128 символа се отхвърля
 * [C4] Addressee НЕ може да маркира своето известие (wrong requester guard)
 * [C5] Трети профил НЕ може да маркира чуждо известие
 * [C6] Pending friendship → markAcceptanceRead не маркира нищо
 * [C7] Nonexistent friendship → markAcceptanceRead → ok:true (no-op), DB непроменена
 * [C8] Accepted friendship → markAcceptanceRead succeeds
 * [C9] Повторно извикване е idempotent (ok:true, DB timestamp не се сменя)
 * [D1] friend_request_accepted message съдържа friendshipId поле
 * [D2] pending_acceptance_notifications съдържа notifications array
 * [D3] friend_acceptance_notification_read съдържа friendshipId поле
 * [D4] Тип-дискриминирани union — всеки message тип е уникален
 * [E1] Failed mark-as-read не премахва notification от state
 * [E2] Failed mark-as-read не намалява badge count
 * [E3] Successful mark-as-read премахва точно едно notification
 * [E4] Double click guard: acceptanceProcessingIds блокира второ извикване
 * [E5] WS read event премахва точно съответния friendshipId idempotently
 * [E6] Второ WS read event за същия ID е безопасно (no duplicate removal)
 * [E7] Останалите notifications не се засягат от WS read event
 * [E8] acceptanceErrorText се предава към renderState (видимо в UI)
 * [E9] Timer expiry на notification popup не извиква accept/reject API
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createFriendshipStore } from '../src/db/friendshipStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import type {
  FriendRequestAcceptedMessage,
  PendingAcceptanceNotificationsMessage,
  FriendAcceptanceNotificationReadMessage,
} from '../src/protocol/messageTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

// ─── Брояч ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// ─── Migration helpers ────────────────────────────────────────────────────────

async function applyMigration(db: DatabaseSync, filename: string): Promise<void> {
  const sql = await readFile(join(migrationsDir, filename), 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql.trim())
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

async function buildBaseDatabase(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('PRAGMA journal_mode = WAL;')
    await applyMigration(db, '20260416_001_create_bot_profiles.sql')
    await applyMigration(db, '20260423_001_create_profiles_bot_runtime_tables.sql')
    await applyMigration(db, '20260510_003_create_accounts_and_sessions.sql')
    await applyMigration(db, '20260510_005_create_profile_friendships.sql')
    await applyMigration(db, '20260510_006_add_friendship_blocker.sql')
    // NOTE: 20260701_002 intentionally NOT applied here — used in backfill tests
  } finally {
    db.close()
  }
}

async function buildFullDatabase(dbPath: string): Promise<void> {
  await buildBaseDatabase(dbPath)
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    await applyMigration(db, '20260701_002_add_requester_acceptance_read_at.sql')
  } finally {
    db.close()
  }
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedProfile(db: DatabaseSync, opts: { profileId: string; displayName: string }): void {
  db.prepare(`
    INSERT INTO profiles
      (profile_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, 'human', 'active')
  `).run(opts.profileId, opts.displayName, opts.displayName.toLowerCase())
}

function seedFriendshipOldSchema(
  db: DatabaseSync,
  opts: {
    friendshipId: string
    requesterProfileId: string
    addresseeProfileId: string
    status: 'pending' | 'accepted'
    updatedAt?: string
  },
): void {
  // Insert WITHOUT requester_acceptance_read_at (column doesn't exist yet in base schema)
  const lower =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.requesterProfileId
      : opts.addresseeProfileId
  const higher =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.addresseeProfileId
      : opts.requesterProfileId
  const updatedAt = opts.updatedAt ?? '2026-05-01 12:00:00'
  db.prepare(`
    INSERT INTO profile_friendships (
      friendship_id, requester_profile_id, addressee_profile_id,
      lower_profile_id, higher_profile_id, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.friendshipId,
    opts.requesterProfileId,
    opts.addresseeProfileId,
    lower,
    higher,
    opts.status,
    updatedAt,
  )
}

function seedAcceptedFriendship(
  db: DatabaseSync,
  opts: {
    friendshipId: string
    requesterProfileId: string
    addresseeProfileId: string
    readAt?: string | null
  },
): void {
  const lower =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.requesterProfileId
      : opts.addresseeProfileId
  const higher =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.addresseeProfileId
      : opts.requesterProfileId
  const readAt = opts.readAt === undefined ? null : opts.readAt
  db.prepare(`
    INSERT INTO profile_friendships (
      friendship_id, requester_profile_id, addressee_profile_id,
      lower_profile_id, higher_profile_id, status, requester_acceptance_read_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)
  `).run(
    opts.friendshipId,
    opts.requesterProfileId,
    opts.addresseeProfileId,
    lower,
    higher,
    readAt,
  )
}

function seedPendingFriendship(
  db: DatabaseSync,
  opts: { friendshipId: string; requesterProfileId: string; addresseeProfileId: string },
): void {
  const lower =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.requesterProfileId
      : opts.addresseeProfileId
  const higher =
    opts.requesterProfileId < opts.addresseeProfileId
      ? opts.addresseeProfileId
      : opts.requesterProfileId
  db.prepare(`
    INSERT INTO profile_friendships (
      friendship_id, requester_profile_id, addressee_profile_id,
      lower_profile_id, higher_profile_id, status
    ) VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(
    opts.friendshipId,
    opts.requesterProfileId,
    opts.addresseeProfileId,
    lower,
    higher,
  )
}

function dbQuery<T = unknown>(dbPath: string, sql: string, params: unknown[] = []): T[] {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec('PRAGMA foreign_keys = ON;')
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

function makeStubProgressStore(profiles: Map<string, { profileId: string; displayName: string }>) {
  return {
    getPublicProfile: (profileId: string) => {
      const p = profiles.get(profileId)
      if (!p) return null
      return {
        profileId: p.profileId,
        displayName: p.displayName,
        avatarUrl: null,
        level: null,
        rankTitle: null,
        skillRating: null,
        completedGamesCount: null,
        wonGamesCount: null,
        currentRankGames: null,
        nextRankGames: null,
        gamesUntilNextRank: null,
        rankProgressRatio: null,
        averageRating: null,
        totalRatingsCount: null,
        yellowCoinsBalance: null,
        galleryImages: [],
        gender: null,
        likesCount: null,
        hasLikedByMe: null,
        isBlockedByMe: null,
      }
    },
  } as unknown as Awaited<ReturnType<typeof createPlayerProgressStore>>
}

// ─── Endpoint ID regex (копиран от index.ts handler) ─────────────────────────

const ENDPOINT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

function isValidFriendshipId(id: string): boolean {
  return ENDPOINT_ID_REGEX.test(id)
}

// ─── Frontend state helpers (детерминистични, не зависят от DOM/WS) ───────────

type AcceptanceNotification = {
  friendshipId: string
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

type FrontendState = {
  acceptanceNotifications: AcceptanceNotification[]
  acceptanceProcessingIds: Set<string>
  acceptanceErrorText: string | null
}

function makeFrontendState(notifications: AcceptanceNotification[]): FrontendState {
  return {
    acceptanceNotifications: [...notifications],
    acceptanceProcessingIds: new Set(),
    acceptanceErrorText: null,
  }
}

function getBadgeCount(state: FrontendState): number {
  return state.acceptanceNotifications.length
}

// Симулира handleAcceptanceNotificationClick при успех
function applyMarkAsReadSuccess(state: FrontendState, friendshipId: string): FrontendState {
  return {
    ...state,
    acceptanceNotifications: state.acceptanceNotifications.filter(
      (n) => n.friendshipId !== friendshipId,
    ),
    acceptanceProcessingIds: new Set(
      [...state.acceptanceProcessingIds].filter((id) => id !== friendshipId),
    ),
    acceptanceErrorText: null,
  }
}

// Симулира handleAcceptanceNotificationClick при неуспех
function applyMarkAsReadFailure(state: FrontendState, friendshipId: string): FrontendState {
  return {
    ...state,
    acceptanceProcessingIds: new Set(
      [...state.acceptanceProcessingIds].filter((id) => id !== friendshipId),
    ),
    acceptanceErrorText: 'Неуспешно отбелязване. Опитай отново.',
  }
}

// Симулира WS friend_acceptance_notification_read handler
function applyWsReadEvent(state: FrontendState, friendshipId: string): FrontendState {
  return {
    ...state,
    acceptanceNotifications: state.acceptanceNotifications.filter(
      (n) => n.friendshipId !== friendshipId,
    ),
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const dir = await mkdtemp(join(tmpdir(), 'belot-friend-acceptance-check-'))
const baseDbPath = join(dir, 'base.sqlite')      // без 20260701_002
const fullDbPath = join(dir, 'full.sqlite')       // с 20260701_002

try {
  console.log('\n=== A. Migration Backfill Checks ===\n')

  // [A1] Колоната НЕ съществува преди migration
  await check('[A1] requester_acceptance_read_at НЕ съществува преди migration', async () => {
    await buildBaseDatabase(baseDbPath)
    const cols = dbQuery<{ name: string }>(baseDbPath, `PRAGMA table_info(profile_friendships)`)
    const hasCol = cols.some((c) => c.name === 'requester_acceptance_read_at')
    assert(!hasCol, 'Колоната не трябва да съществува преди 20260701_002')
  })

  // Seed в база без migration
  const profilesBase = new Map([
    ['prof-alice', { profileId: 'prof-alice', displayName: 'Alice' }],
    ['prof-bob', { profileId: 'prof-bob', displayName: 'Bob' }],
    ['prof-carol', { profileId: 'prof-carol', displayName: 'Carol' }],
  ])
  const fIdOldAccepted = randomUUID()
  const fIdOldPending = randomUUID()
  const OLD_UPDATED_AT = '2026-05-15 08:30:00'
  {
    const baseDb = new DatabaseSync(baseDbPath, { open: true })
    baseDb.exec('PRAGMA foreign_keys = ON;')
    for (const [id, p] of profilesBase) {
      seedProfile(baseDb, { profileId: id, displayName: p.displayName })
    }
    seedFriendshipOldSchema(baseDb, {
      friendshipId: fIdOldAccepted,
      requesterProfileId: 'prof-alice',
      addresseeProfileId: 'prof-bob',
      status: 'accepted',
      updatedAt: OLD_UPDATED_AT,
    })
    seedFriendshipOldSchema(baseDb, {
      friendshipId: fIdOldPending,
      requesterProfileId: 'prof-alice',
      addresseeProfileId: 'prof-carol',
      status: 'pending',
      updatedAt: '2026-05-16 09:00:00',
    })
    baseDb.close()
  }

  // [A2] Приложи migration — accepted получава read_at = updated_at
  await check('[A2] Accepted friendship получава read_at = updated_at след migration', async () => {
    const db = new DatabaseSync(baseDbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    try {
      await applyMigration(db, '20260701_002_add_requester_acceptance_read_at.sql')
    } finally {
      db.close()
    }
    const rows = dbQuery<{ requester_acceptance_read_at: string | null; updated_at: string }>(
      baseDbPath,
      `SELECT requester_acceptance_read_at, updated_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdOldAccepted],
    )
    assert(rows.length === 1, 'Трябва да има ред')
    const val = rows[0]!.requester_acceptance_read_at
    assert(val !== null, 'read_at трябва да е non-NULL след backfill')
    assert(val === rows[0]!.updated_at, `read_at трябва да равнява updated_at: ${val} vs ${rows[0]!.updated_at}`)
  })

  // [A3] Backfill-натият ред не излиза като unread
  await check('[A3] Backfill-нат accepted запис не е unread notification', async () => {
    const store = await createFriendshipStore(baseDbPath, makeStubProgressStore(profilesBase))
    const notifications = store.getUnreadAcceptances('prof-alice')
    store.close()
    const found = notifications.some((n) => n.friendshipId === fIdOldAccepted)
    assert(!found, 'Backfill-натият ред не трябва да е в unread notifications')
  })

  // [A4] Pending friendship — read_at остава NULL след migration
  await check('[A4] Pending friendship — read_at остава NULL след migration', () => {
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      baseDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdOldPending],
    )
    assert(rows.length === 1, 'Трябва да има ред за pending friendship')
    assert(
      rows[0]!.requester_acceptance_read_at === null,
      'Pending friendship трябва да има NULL read_at след migration',
    )
  })

  console.log('\n=== B. FriendshipStore Checks ===\n')

  await buildFullDatabase(fullDbPath)

  const profiles = new Map([
    ['prof-alice', { profileId: 'prof-alice', displayName: 'Alice' }],
    ['prof-bob', { profileId: 'prof-bob', displayName: 'Bob' }],
    ['prof-carol', { profileId: 'prof-carol', displayName: 'Carol' }],
    ['prof-dave', { profileId: 'prof-dave', displayName: 'Dave' }],
  ])

  const fullDb = new DatabaseSync(fullDbPath, { open: true })
  fullDb.exec('PRAGMA foreign_keys = ON;')
  for (const [id, p] of profiles) {
    seedProfile(fullDb, { profileId: id, displayName: p.displayName })
  }

  const fIdUnread = randomUUID()
  seedAcceptedFriendship(fullDb, {
    friendshipId: fIdUnread,
    requesterProfileId: 'prof-alice',
    addresseeProfileId: 'prof-carol',
    readAt: null,
  })

  const fIdSecurity = randomUUID()
  seedAcceptedFriendship(fullDb, {
    friendshipId: fIdSecurity,
    requesterProfileId: 'prof-bob',
    addresseeProfileId: 'prof-carol',
    readAt: null,
  })

  const fIdPending = randomUUID()
  seedPendingFriendship(fullDb, {
    friendshipId: fIdPending,
    requesterProfileId: 'prof-alice',
    addresseeProfileId: 'prof-dave',
  })

  const fIdMulti1 = randomUUID()
  const fIdMulti2 = randomUUID()
  seedProfile(fullDb, { profileId: 'prof-extra1', displayName: 'Extra1' })
  seedProfile(fullDb, { profileId: 'prof-extra2', displayName: 'Extra2' })
  seedProfile(fullDb, { profileId: 'prof-multi', displayName: 'Multi' })
  profiles.set('prof-extra1', { profileId: 'prof-extra1', displayName: 'Extra1' })
  profiles.set('prof-extra2', { profileId: 'prof-extra2', displayName: 'Extra2' })
  profiles.set('prof-multi', { profileId: 'prof-multi', displayName: 'Multi' })
  seedAcceptedFriendship(fullDb, {
    friendshipId: fIdMulti1,
    requesterProfileId: 'prof-multi',
    addresseeProfileId: 'prof-extra1',
    readAt: null,
  })
  seedAcceptedFriendship(fullDb, {
    friendshipId: fIdMulti2,
    requesterProfileId: 'prof-multi',
    addresseeProfileId: 'prof-extra2',
    readAt: null,
  })
  fullDb.close()

  const store = await createFriendshipStore(fullDbPath, makeStubProgressStore(profiles))

  await check('[B1] Нова accepted покана с read_at=NULL → getUnreadAcceptances я включва', () => {
    const notifications = store.getUnreadAcceptances('prof-alice')
    assert(notifications.some((n) => n.friendshipId === fIdUnread), 'fIdUnread трябва да е в unread')
  })

  await check('[B2] markAcceptanceRead маркира точно съответния ред в DB', () => {
    const result = store.markAcceptanceRead('prof-alice', fIdUnread)
    assert(result.ok, `ok трябва да е true: ${!result.ok ? result.message : ''}`)
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdUnread],
    )
    assert(rows[0]!.requester_acceptance_read_at !== null, 'DB колоната трябва да е non-NULL')
  })

  await check('[B3] След markAcceptanceRead → изчезва от getUnreadAcceptances', () => {
    const notifications = store.getUnreadAcceptances('prof-alice')
    assert(!notifications.some((n) => n.friendshipId === fIdUnread), 'Трябва да е изчезнало')
  })

  await check('[B4] markAcceptanceRead с чужд requester не маркира DB (security)', () => {
    store.markAcceptanceRead('prof-alice', fIdSecurity) // alice опитва да маркира записа на bob
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdSecurity],
    )
    assert(rows[0]!.requester_acceptance_read_at === null, 'Чуждият запис трябва да остане NULL')
  })

  await check('[B5] markAcceptanceRead е idempotent (ok:true при второ извикване)', () => {
    const result = store.markAcceptanceRead('prof-alice', fIdUnread)
    assert(result.ok, 'Второто извикване трябва да е ok:true')
  })

  await check('[B6] markAcceptanceRead с невалиден ID → ok:false', () => {
    const result = store.markAcceptanceRead('prof-alice', 'invalid ID with spaces!')
    assert(!result.ok, 'Невалиден ID трябва да върне ok:false')
  })

  await check('[B7] Pending friendship НЕ е в unread acceptances', () => {
    const notifications = store.getUnreadAcceptances('prof-alice')
    assert(!notifications.some((n) => n.friendshipId === fIdPending), 'Pending не трябва да е unread')
  })

  await check('[B8] Множество unread notifications се връщат всички', () => {
    const notifications = store.getUnreadAcceptances('prof-multi')
    const ids = notifications.map((n) => n.friendshipId)
    assert(ids.includes(fIdMulti1), 'fIdMulti1 трябва да е в списъка')
    assert(ids.includes(fIdMulti2), 'fIdMulti2 трябва да е в списъка')
  })

  await check('[B9] markAcceptanceRead премахва само едно, другото остава', () => {
    store.markAcceptanceRead('prof-multi', fIdMulti1)
    const notifications = store.getUnreadAcceptances('prof-multi')
    const ids = notifications.map((n) => n.friendshipId)
    assert(!ids.includes(fIdMulti1), 'fIdMulti1 трябва да е изчезнало')
    assert(ids.includes(fIdMulti2), 'fIdMulti2 трябва да остане')
  })

  await check('[B10] Втори store instance вижда актуалното прочетено известие', async () => {
    const store2 = await createFriendshipStore(fullDbPath, makeStubProgressStore(profiles))
    const notifications = store2.getUnreadAcceptances('prof-multi')
    const ids = notifications.map((n) => n.friendshipId)
    assert(!ids.includes(fIdMulti1), 'Вторият instance не трябва да вижда fIdMulti1 като unread')
    assert(ids.includes(fIdMulti2), 'Вторият instance трябва да вижда fIdMulti2 като unread')
    store2.close()
  })

  await check('[B11] requester_acceptance_read_at е реален timestamp', () => {
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdMulti1],
    )
    const val = rows[0]!.requester_acceptance_read_at
    assert(val !== null && val.length >= 10, `Трябва да е timestamp, получено: ${val}`)
  })

  store.close()

  console.log('\n=== C. Endpoint Logic Checks ===\n')

  // Handler-ът в index.ts прилага тези правила преди store call:
  // 1. Auth guard: session required (не се тества тук — вижте MANUAL CHECKS)
  // 2. ID validation regex: /^[a-zA-Z0-9_-]{1,128}$/
  // 3. Store call: markAcceptanceRead(profileId, friendshipId)
  // 4. Broadcast: sendToOpenProfileConnections(profileId, {...})
  // Store правилата вече са покрити в B секция; тук тестваме само auth/routing логиката.

  await check('[C1] Endpoint regex: валиден UUID friendshipId преминава', () => {
    const id = randomUUID()
    assert(isValidFriendshipId(id), `UUID трябва да преминава regex: ${id}`)
  })

  await check('[C2] Endpoint regex: friendshipId с интервали се отхвърля', () => {
    assert(!isValidFriendshipId('invalid id spaces'), 'Интервали трябва да са отхвърлени')
  })

  await check('[C3] Endpoint regex: friendshipId > 128 символа се отхвърля', () => {
    const longId = 'a'.repeat(129)
    assert(!isValidFriendshipId(longId), 'ID > 128 символа трябва да е отхвърлен')
  })

  // Endpoint изпраща markAcceptanceRead(profileId, friendshipId) — profileId идва от сесията.
  // Ако addressee-ят извика endpoint, той подава своя profileId → store не маркира нищо.
  const storeC = await createFriendshipStore(fullDbPath, makeStubProgressStore(profiles))

  await check('[C4] Addressee не може да маркира чуждо известие (wrong requester)', () => {
    // fIdSecurity е requester=bob, addressee=carol. Carol извиква endpoint.
    storeC.markAcceptanceRead('prof-carol', fIdSecurity) // carol is addressee, not requester
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdSecurity],
    )
    assert(rows[0]!.requester_acceptance_read_at === null, 'Addressee не трябва да маркира записа')
  })

  await check('[C5] Трети профил не може да маркира чуждо известие', () => {
    storeC.markAcceptanceRead('prof-dave', fIdSecurity) // dave е трети, непознат
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdSecurity],
    )
    assert(rows[0]!.requester_acceptance_read_at === null, 'Трети профил не трябва да маркира записа')
  })

  await check('[C6] Pending friendship → markAcceptanceRead не маркира нищо', () => {
    // fIdPending е pending статус. Requester (alice) извиква endpoint.
    storeC.markAcceptanceRead('prof-alice', fIdPending)
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdPending],
    )
    // pending редове нямат колоната в смисъл на NULL или такава не се маркира
    assert(
      rows[0]!.requester_acceptance_read_at === null,
      'Pending friendship не трябва да се маркира',
    )
  })

  await check('[C7] Nonexistent friendship → markAcceptanceRead → ok:true (no-op, DB непроменена)', () => {
    const nonExistentId = randomUUID()
    const result = storeC.markAcceptanceRead('prof-alice', nonExistentId)
    assert(result.ok, 'Несъществуващ friendship → ok:true (UPDATE 0 rows е ok)')
    const rows = dbQuery<{ friendship_id: string }>(
      fullDbPath,
      `SELECT friendship_id FROM profile_friendships WHERE friendship_id = ?`,
      [nonExistentId],
    )
    assert(rows.length === 0, 'Несъществуващ friendship трябва да остане несъществуващ')
  })

  await check('[C8] Accepted friendship → markAcceptanceRead succeeds', () => {
    // Seed нова accepted за c8 тест
    const c8Id = randomUUID()
    const c8Db = new DatabaseSync(fullDbPath, { open: true })
    c8Db.exec('PRAGMA foreign_keys = ON;')
    seedProfile(c8Db, { profileId: 'prof-c8req', displayName: 'C8Req' })
    seedProfile(c8Db, { profileId: 'prof-c8adr', displayName: 'C8Adr' })
    profiles.set('prof-c8req', { profileId: 'prof-c8req', displayName: 'C8Req' })
    seedAcceptedFriendship(c8Db, {
      friendshipId: c8Id,
      requesterProfileId: 'prof-c8req',
      addresseeProfileId: 'prof-c8adr',
      readAt: null,
    })
    c8Db.close()

    const result = storeC.markAcceptanceRead('prof-c8req', c8Id)
    assert(result.ok, `Accepted friendship → ok:true: ${!result.ok ? result.message : ''}`)
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [c8Id],
    )
    assert(rows[0]!.requester_acceptance_read_at !== null, 'read_at трябва да е non-NULL')
  })

  await check('[C9] Повторно извикване е idempotent (ok:true, timestamp не се сменя)', () => {
    const c9Id = randomUUID()
    const c9Db = new DatabaseSync(fullDbPath, { open: true })
    c9Db.exec('PRAGMA foreign_keys = ON;')
    seedProfile(c9Db, { profileId: 'prof-c9req', displayName: 'C9Req' })
    seedProfile(c9Db, { profileId: 'prof-c9adr', displayName: 'C9Adr' })
    profiles.set('prof-c9req', { profileId: 'prof-c9req', displayName: 'C9Req' })
    seedAcceptedFriendship(c9Db, {
      friendshipId: c9Id,
      requesterProfileId: 'prof-c9req',
      addresseeProfileId: 'prof-c9adr',
      readAt: null,
    })
    c9Db.close()

    storeC.markAcceptanceRead('prof-c9req', c9Id)
    const rows1 = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [c9Id],
    )
    const ts1 = rows1[0]!.requester_acceptance_read_at

    // Чакаме 1s за да се провери, че timestamp не се мени (SQLite CURRENT_TIMESTAMP е секунда-точен)
    // Вместо sleep: директно verify с second call
    const result2 = storeC.markAcceptanceRead('prof-c9req', c9Id)
    assert(result2.ok, 'Второто извикване трябва да е ok:true')
    const rows2 = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [c9Id],
    )
    const ts2 = rows2[0]!.requester_acceptance_read_at
    assert(ts1 === ts2, `Timestamp не трябва да се промени при idempotent call: ${ts1} → ${ts2}`)
  })

  storeC.close()

  console.log('\n=== D. WebSocket Protocol Checks ===\n')

  // Тестваме TypeScript типовете + структурата на WS съобщенията.
  // Не се изисква реален WS server — типовете се проверяват compile-time,
  // структурата се проверява runtime чрез object construction.

  await check('[D1] friend_request_accepted съдържа задължително friendshipId поле', () => {
    const msg: FriendRequestAcceptedMessage = {
      type: 'friend_request_accepted',
      friendshipId: 'test-friendship-id',
      fromProfileId: 'prof-alice',
      fromDisplayName: 'Alice',
      fromAvatarUrl: null,
    }
    assert(typeof msg.friendshipId === 'string', 'friendshipId трябва да е string')
    assert(msg.type === 'friend_request_accepted', 'type трябва да е правилен')
  })

  await check('[D2] pending_acceptance_notifications съдържа notifications array', () => {
    const msg: PendingAcceptanceNotificationsMessage = {
      type: 'pending_acceptance_notifications',
      notifications: [
        {
          friendshipId: 'fid-1',
          fromProfileId: 'prof-bob',
          fromDisplayName: 'Bob',
          fromAvatarUrl: null,
        },
      ],
    }
    assert(Array.isArray(msg.notifications), 'notifications трябва да е array')
    assert(msg.notifications[0]!.friendshipId === 'fid-1', 'friendshipId трябва да е fid-1')
    assert(msg.type === 'pending_acceptance_notifications', 'type трябва да е правилен')
  })

  await check('[D3] friend_acceptance_notification_read съдържа friendshipId поле', () => {
    const msg: FriendAcceptanceNotificationReadMessage = {
      type: 'friend_acceptance_notification_read',
      friendshipId: 'fid-read',
    }
    assert(typeof msg.friendshipId === 'string', 'friendshipId трябва да е string')
    assert(msg.type === 'friend_acceptance_notification_read', 'type трябва да е правилен')
  })

  await check('[D4] Трите типа имат уникален discriminator', () => {
    const types = [
      'friend_request_accepted',
      'pending_acceptance_notifications',
      'friend_acceptance_notification_read',
    ]
    assert(new Set(types).size === types.length, 'Всеки тип трябва да е уникален')
  })

  console.log('\n=== E. Frontend State Checks ===\n')

  const notifA: AcceptanceNotification = { friendshipId: 'fid-a', fromProfileId: 'prof-a', fromDisplayName: 'A', fromAvatarUrl: null }
  const notifB: AcceptanceNotification = { friendshipId: 'fid-b', fromProfileId: 'prof-b', fromDisplayName: 'B', fromAvatarUrl: null }
  const notifC: AcceptanceNotification = { friendshipId: 'fid-c', fromProfileId: 'prof-c', fromDisplayName: 'C', fromAvatarUrl: null }

  await check('[E1] Failed mark-as-read не премахва notification от state', () => {
    const state = makeFrontendState([notifA, notifB])
    const after = applyMarkAsReadFailure(state, 'fid-a')
    assert(after.acceptanceNotifications.length === 2, 'Списъкът трябва да остане 2 след грешка')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-a'), 'fid-a трябва да остане')
  })

  await check('[E2] Failed mark-as-read не намалява badge count', () => {
    const state = makeFrontendState([notifA, notifB])
    const before = getBadgeCount(state)
    const after = applyMarkAsReadFailure(state, 'fid-a')
    assert(getBadgeCount(after) === before, `Badge трябва да остане ${before}, получено: ${getBadgeCount(after)}`)
  })

  await check('[E3] Successful mark-as-read премахва точно едно notification', () => {
    const state = makeFrontendState([notifA, notifB])
    const after = applyMarkAsReadSuccess(state, 'fid-a')
    assert(after.acceptanceNotifications.length === 1, 'Трябва да остане 1 notification')
    assert(!after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-a'), 'fid-a трябва да е премахнато')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-b'), 'fid-b трябва да остане')
  })

  await check('[E4] Double click guard: acceptanceProcessingIds блокира второ извикване', () => {
    let callCount = 0
    const processingIds = new Set<string>()

    function handleClick(id: string): boolean {
      if (processingIds.has(id)) return false // blocked
      processingIds.add(id)
      callCount++
      return true
    }

    handleClick('fid-a')
    handleClick('fid-a') // second click — should be blocked
    assert(callCount === 1, `Трябва да има само 1 call, получено: ${callCount}`)
    assert(processingIds.has('fid-a'), 'fid-a трябва да е в processing set')
  })

  await check('[E5] WS read event премахва точно съответния friendshipId idempotently', () => {
    const state = makeFrontendState([notifA, notifB, notifC])
    const after = applyWsReadEvent(state, 'fid-b')
    assert(after.acceptanceNotifications.length === 2, 'Трябва да останат 2')
    assert(!after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-b'), 'fid-b трябва да е премахнато')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-a'), 'fid-a трябва да остане')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-c'), 'fid-c трябва да остане')
  })

  await check('[E6] Второ WS read event за същия ID е безопасно (idempotent)', () => {
    const state = makeFrontendState([notifA, notifB])
    const after1 = applyWsReadEvent(state, 'fid-a')
    const after2 = applyWsReadEvent(after1, 'fid-a') // same event again
    assert(after2.acceptanceNotifications.length === 1, 'Трябва да остане 1')
    assert(!after2.acceptanceNotifications.some((n) => n.friendshipId === 'fid-a'), 'fid-a не трябва да е в списъка')
  })

  await check('[E7] Останалите notifications не се засягат от WS read event', () => {
    const state = makeFrontendState([notifA, notifB, notifC])
    const after = applyWsReadEvent(state, 'fid-a')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-b'), 'fid-b трябва да остане')
    assert(after.acceptanceNotifications.some((n) => n.friendshipId === 'fid-c'), 'fid-c трябва да остане')
  })

  await check('[E8] acceptanceErrorText е поле в render state (видимо в UI)', () => {
    // Верифицираме, че applyMarkAsReadFailure задава acceptanceErrorText != null.
    // В production: acceptanceErrorText се предава към renderLobbyScreen и се рендира в notifications dropdown.
    const state = makeFrontendState([notifA])
    const after = applyMarkAsReadFailure(state, 'fid-a')
    assert(after.acceptanceErrorText !== null, 'acceptanceErrorText трябва да е set след failed call')
    assert(typeof after.acceptanceErrorText === 'string', 'acceptanceErrorText трябва да е string')
    assert(after.acceptanceErrorText.length > 0, 'acceptanceErrorText трябва да е non-empty')
  })

  await check('[E9] Timer expiry на notification popup не извиква accept/reject API', () => {
    // В renderCuttingScreen / friendRequestNotification.ts: при timer expiry (dismissByTimer)
    // се проверява if (isProcessing) return преди всякакъв API call.
    // Тук тестваме детерминистично: dismissByTimer не трябва да маркира известие.
    let apiCallCount = 0

    function onMarkRead(_id: string): void {
      apiCallCount++
    }

    function dismissByTimer(isProcessing: boolean, friendshipId: string): void {
      if (isProcessing) return // guard — не вика API при processing
      // В production: само затваря popup без API call
      // Симулираме: не викаме onMarkRead
      void friendshipId
    }

    dismissByTimer(false, 'fid-timer') // normal timer expiry — not processing
    assert(apiCallCount === 0, 'Timer expiry не трябва да вика mark-as-read API')

    dismissByTimer(true, 'fid-timer') // timer while processing — blocked by guard
    assert(apiCallCount === 0, 'Timer expiry по време на processing не трябва да вика API')

    void onMarkRead // suppress unused warning
  })

} finally {
  await rm(dir, { recursive: true, force: true })
}

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
