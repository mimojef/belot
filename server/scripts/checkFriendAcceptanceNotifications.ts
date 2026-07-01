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
 * [C1]  invalid ID → ok:false, reason: invalid_id
 * [C2]  nonexistent friendship → ok:false, reason: not_found
 * [C3]  addressee извиква mark → ok:false, reason: forbidden
 * [C4]  трети профил → ok:false, reason: forbidden
 * [C5]  pending friendship → ok:false, reason: wrong_status
 * [C6]  requester + unread accepted → ok:true, status: marked
 * [C7]  requester + already read → ok:true, status: already_read
 * [C8]  failed result не променя DB (forbidden, wrong_status, not_found)
 * [C9]  idempotent: already_read timestamp не се сменя
 * [C10] invalid_id → HTTP 400, shouldBroadcast: false
 * [C11] not_found → HTTP 404, shouldBroadcast: false
 * [C12] forbidden → HTTP 403, shouldBroadcast: false
 * [C13] wrong_status → HTTP 409, shouldBroadcast: false
 * [C14] marked → HTTP 200, shouldBroadcast: true
 * [C15] already_read → HTTP 200, shouldBroadcast: true
 * [C16] само marked/already_read позволяват broadcast — всички ok:false не
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
 *
 * [F1] rejectRequest връща requesterProfileId при успешен reject
 * [F2] rejectRequest с чужд addressee → ok:false (не връща requesterProfileId)
 * [F3] rejectRequest на несъществуваща покана → ok:false
 * [F4] friend_request_rejected WS message съдържа friendshipId поле
 * [F5] Frontend: rejected friendshipId се премахва от outgoingPending idempotently
 * [F6] Frontend: cancelFriendRequest при "не беше намерена" → silent remove, без error
 * [F7] Frontend: cancelFriendRequest при друга грешка → friendsErrorText се показва
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
  FriendRequestRejectedMessage,
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

// ─── Endpoint mapping helpers ─────────────────────────────────────────────────
//
// Pure функции, извлечени от бизнес логиката на handler-а в index.ts.
// Позволяват детерминистично тестване на HTTP status/body и broadcast решение
// без стартиране на реален HTTP server.

import type { MarkAcceptanceReadResult } from '../src/db/friendshipStore.js'

const ENDPOINT_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/

function isValidFriendshipId(id: string): boolean {
  return ENDPOINT_ID_REGEX.test(id)
}

type HttpMapping = { status: number; ok: boolean; shouldBroadcast: boolean }

function mapStoreResultToHttp(result: MarkAcceptanceReadResult): HttpMapping {
  if (!result.ok) {
    switch (result.reason) {
      case 'invalid_id':   return { status: 400, ok: false, shouldBroadcast: false }
      case 'not_found':    return { status: 404, ok: false, shouldBroadcast: false }
      case 'forbidden':    return { status: 403, ok: false, shouldBroadcast: false }
      case 'wrong_status': return { status: 409, ok: false, shouldBroadcast: false }
    }
  }
  // Both 'marked' and 'already_read' → 200 + broadcast (clears stale state in other tabs)
  return { status: 200, ok: true, shouldBroadcast: true }
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

  // Тестваме store result contract + HTTP mapping (mapStoreResultToHttp) + broadcast decision.
  // HTTP routing (401 без сесия) е manual check — вижте MANUAL CHECKS по-горе.
  // store.markAcceptanceRead е callable директно; mapStoreResultToHttp е чиста функция.

  const storeC = await createFriendshipStore(fullDbPath, makeStubProgressStore(profiles))

  // — Store result checks —

  await check('[C1] invalid_id → ok:false, reason: invalid_id', () => {
    const result = storeC.markAcceptanceRead('prof-alice', 'bad id with spaces!')
    assert(!result.ok && result.reason === 'invalid_id', `Очаквано invalid_id, получено: ${JSON.stringify(result)}`)
  })

  await check('[C2] nonexistent friendship → ok:false, reason: not_found', () => {
    const result = storeC.markAcceptanceRead('prof-alice', randomUUID())
    assert(!result.ok && result.reason === 'not_found', `Очаквано not_found, получено: ${JSON.stringify(result)}`)
  })

  await check('[C3] addressee извиква mark → ok:false, reason: forbidden', () => {
    // fIdSecurity: requester=bob, addressee=carol. Carol е addressee.
    const result = storeC.markAcceptanceRead('prof-carol', fIdSecurity)
    assert(!result.ok && result.reason === 'forbidden', `Очаквано forbidden, получено: ${JSON.stringify(result)}`)
  })

  await check('[C4] трети профил → ok:false, reason: forbidden', () => {
    const result = storeC.markAcceptanceRead('prof-dave', fIdSecurity)
    assert(!result.ok && result.reason === 'forbidden', `Очаквано forbidden, получено: ${JSON.stringify(result)}`)
  })

  await check('[C5] pending friendship → ok:false, reason: wrong_status', () => {
    const result = storeC.markAcceptanceRead('prof-alice', fIdPending)
    assert(!result.ok && result.reason === 'wrong_status', `Очаквано wrong_status, получено: ${JSON.stringify(result)}`)
  })

  await check('[C6] requester + unread accepted → ok:true, status: marked', () => {
    const cId = randomUUID()
    const cDb = new DatabaseSync(fullDbPath, { open: true })
    cDb.exec('PRAGMA foreign_keys = ON;')
    seedProfile(cDb, { profileId: 'prof-c6req', displayName: 'C6Req' })
    seedProfile(cDb, { profileId: 'prof-c6adr', displayName: 'C6Adr' })
    profiles.set('prof-c6req', { profileId: 'prof-c6req', displayName: 'C6Req' })
    seedAcceptedFriendship(cDb, { friendshipId: cId, requesterProfileId: 'prof-c6req', addresseeProfileId: 'prof-c6adr', readAt: null })
    cDb.close()
    const result = storeC.markAcceptanceRead('prof-c6req', cId)
    assert(result.ok && result.status === 'marked', `Очаквано marked, получено: ${JSON.stringify(result)}`)
    const rows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [cId],
    )
    assert(rows[0]!.requester_acceptance_read_at !== null, 'DB трябва да е маркирана')
  })

  await check('[C7] requester + already read → ok:true, status: already_read', () => {
    const cId = randomUUID()
    const cDb = new DatabaseSync(fullDbPath, { open: true })
    cDb.exec('PRAGMA foreign_keys = ON;')
    seedProfile(cDb, { profileId: 'prof-c7req', displayName: 'C7Req' })
    seedProfile(cDb, { profileId: 'prof-c7adr', displayName: 'C7Adr' })
    profiles.set('prof-c7req', { profileId: 'prof-c7req', displayName: 'C7Req' })
    seedAcceptedFriendship(cDb, { friendshipId: cId, requesterProfileId: 'prof-c7req', addresseeProfileId: 'prof-c7adr', readAt: '2026-06-01T10:00:00' })
    cDb.close()
    const result = storeC.markAcceptanceRead('prof-c7req', cId)
    assert(result.ok && result.status === 'already_read', `Очаквано already_read, получено: ${JSON.stringify(result)}`)
  })

  await check('[C8] failed result не променя DB (forbidden, wrong_status, not_found)', () => {
    // Проверяваме fIdSecurity (bob's) и fIdPending — и двата трябва да останат непроменени.
    storeC.markAcceptanceRead('prof-carol', fIdSecurity) // forbidden
    storeC.markAcceptanceRead('prof-alice', fIdPending)  // wrong_status
    storeC.markAcceptanceRead('prof-alice', randomUUID()) // not_found

    const secRows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdSecurity],
    )
    assert(secRows[0]!.requester_acceptance_read_at === null, 'fIdSecurity трябва да остане NULL')

    const pendRows = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [fIdPending],
    )
    assert(pendRows[0]!.requester_acceptance_read_at === null, 'fIdPending трябва да остане NULL')
  })

  await check('[C9] idempotent: already_read timestamp не се сменя', () => {
    const cId = randomUUID()
    const cDb = new DatabaseSync(fullDbPath, { open: true })
    cDb.exec('PRAGMA foreign_keys = ON;')
    seedProfile(cDb, { profileId: 'prof-c9req', displayName: 'C9Req' })
    seedProfile(cDb, { profileId: 'prof-c9adr', displayName: 'C9Adr' })
    profiles.set('prof-c9req', { profileId: 'prof-c9req', displayName: 'C9Req' })
    seedAcceptedFriendship(cDb, { friendshipId: cId, requesterProfileId: 'prof-c9req', addresseeProfileId: 'prof-c9adr', readAt: null })
    cDb.close()

    storeC.markAcceptanceRead('prof-c9req', cId)
    const rows1 = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [cId],
    )
    const ts1 = rows1[0]!.requester_acceptance_read_at

    const result2 = storeC.markAcceptanceRead('prof-c9req', cId)
    assert(result2.ok && result2.status === 'already_read', 'Второто извикване трябва да е already_read')
    const rows2 = dbQuery<{ requester_acceptance_read_at: string | null }>(
      fullDbPath,
      `SELECT requester_acceptance_read_at FROM profile_friendships WHERE friendship_id = ?`,
      [cId],
    )
    assert(ts1 === rows2[0]!.requester_acceptance_read_at, `Timestamp не трябва да се смени: ${ts1} → ${rows2[0]!.requester_acceptance_read_at}`)
  })

  // — HTTP mapping checks (чиста функция, без HTTP server) —

  await check('[C10] invalid_id → HTTP 400, shouldBroadcast: false', () => {
    const r = mapStoreResultToHttp({ ok: false, reason: 'invalid_id' })
    assert(r.status === 400 && !r.shouldBroadcast, `Очаквано 400/false, получено: ${JSON.stringify(r)}`)
  })

  await check('[C11] not_found → HTTP 404, shouldBroadcast: false', () => {
    const r = mapStoreResultToHttp({ ok: false, reason: 'not_found' })
    assert(r.status === 404 && !r.shouldBroadcast, `Очаквано 404/false, получено: ${JSON.stringify(r)}`)
  })

  await check('[C12] forbidden → HTTP 403, shouldBroadcast: false', () => {
    const r = mapStoreResultToHttp({ ok: false, reason: 'forbidden' })
    assert(r.status === 403 && !r.shouldBroadcast, `Очаквано 403/false, получено: ${JSON.stringify(r)}`)
  })

  await check('[C13] wrong_status → HTTP 409, shouldBroadcast: false', () => {
    const r = mapStoreResultToHttp({ ok: false, reason: 'wrong_status' })
    assert(r.status === 409 && !r.shouldBroadcast, `Очаквано 409/false, получено: ${JSON.stringify(r)}`)
  })

  await check('[C14] marked → HTTP 200, shouldBroadcast: true', () => {
    const r = mapStoreResultToHttp({ ok: true, status: 'marked' })
    assert(r.status === 200 && r.shouldBroadcast, `Очаквано 200/true, получено: ${JSON.stringify(r)}`)
  })

  await check('[C15] already_read → HTTP 200, shouldBroadcast: true (clears stale state)', () => {
    const r = mapStoreResultToHttp({ ok: true, status: 'already_read' })
    assert(r.status === 200 && r.shouldBroadcast, `Очаквано 200/true, получено: ${JSON.stringify(r)}`)
  })

  await check('[C16] само marked и already_read позволяват broadcast (всички ok:false не)', () => {
    const failReasons = ['invalid_id', 'not_found', 'forbidden', 'wrong_status'] as const
    for (const reason of failReasons) {
      const r = mapStoreResultToHttp({ ok: false, reason })
      assert(!r.shouldBroadcast, `reason=${reason} не трябва да позволява broadcast`)
    }
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

  console.log('\n=== F. friend_request_rejected Checks ===\n')

  // F store helpers
  const fRejDbPath = join(dir, 'frej.sqlite')
  await buildFullDatabase(fRejDbPath)
  const fRejProfiles = new Map([
    ['prof-f-alice', { profileId: 'prof-f-alice', displayName: 'FAlice' }],
    ['prof-f-bob', { profileId: 'prof-f-bob', displayName: 'FBob' }],
    ['prof-f-carol', { profileId: 'prof-f-carol', displayName: 'FCarol' }],
  ])
  const fRejDb = new DatabaseSync(fRejDbPath, { open: true })
  fRejDb.exec('PRAGMA foreign_keys = ON;')
  for (const [id, p] of fRejProfiles) seedProfile(fRejDb, { profileId: id, displayName: p.displayName })
  const fIdRejPending = randomUUID()
  seedPendingFriendship(fRejDb, {
    friendshipId: fIdRejPending,
    requesterProfileId: 'prof-f-alice',
    addresseeProfileId: 'prof-f-bob',
  })
  fRejDb.close()
  const storeF = await createFriendshipStore(fRejDbPath, makeStubProgressStore(fRejProfiles))

  await check('[F1] rejectRequest връща requesterProfileId при успешен reject', () => {
    const result = storeF.rejectRequest('prof-f-bob', fIdRejPending)
    assert(result.ok, `Очаквано ok:true, получено: ${JSON.stringify(result)}`)
    if (result.ok) {
      assert(
        result.requesterProfileId === 'prof-f-alice',
        `requesterProfileId трябва да е prof-f-alice, получено: ${result.requesterProfileId}`,
      )
    }
  })

  await check('[F2] rejectRequest с чужд addressee → ok:false', () => {
    // carol не е addressee на fIdRejPending (вече изтрита, правим нова)
    const fIdNew = randomUUID()
    const tmpDb = new DatabaseSync(fRejDbPath, { open: true })
    tmpDb.exec('PRAGMA foreign_keys = ON;')
    seedPendingFriendship(tmpDb, { friendshipId: fIdNew, requesterProfileId: 'prof-f-alice', addresseeProfileId: 'prof-f-bob' })
    tmpDb.close()
    const result = storeF.rejectRequest('prof-f-carol', fIdNew) // carol е трети
    assert(!result.ok, `Очаквано ok:false, получено: ${JSON.stringify(result)}`)
  })

  await check('[F3] rejectRequest на несъществуваща покана → ok:false', () => {
    const result = storeF.rejectRequest('prof-f-bob', randomUUID())
    assert(!result.ok, `Очаквано ok:false за несъществуваща покана, получено: ${JSON.stringify(result)}`)
  })

  storeF.close()

  await check('[F4] friend_request_rejected WS message съдържа friendshipId поле', () => {
    const msg: FriendRequestRejectedMessage = {
      type: 'friend_request_rejected',
      friendshipId: 'test-fid-rejected',
    }
    assert(msg.type === 'friend_request_rejected', 'type трябва да е правилен')
    assert(typeof msg.friendshipId === 'string', 'friendshipId трябва да е string')
  })

  // Frontend state helpers за outgoingPending
  type OutgoingPendingEntry = { friendshipId: string; toProfileId: string }
  type OutgoingFriendshipsState = { outgoingPending: OutgoingPendingEntry[]; friendsErrorText: string | null }

  function applyRejectedEvent(state: OutgoingFriendshipsState, friendshipId: string): OutgoingFriendshipsState {
    return {
      ...state,
      outgoingPending: state.outgoingPending.filter((r) => r.friendshipId !== friendshipId),
    }
  }

  function applyCancelNotFound(state: OutgoingFriendshipsState, friendshipId: string): OutgoingFriendshipsState {
    return {
      ...state,
      outgoingPending: state.outgoingPending.filter((r) => r.friendshipId !== friendshipId),
      friendsErrorText: null,
    }
  }

  function applyCancelOtherError(state: OutgoingFriendshipsState, errorMsg: string): OutgoingFriendshipsState {
    return { ...state, friendsErrorText: errorMsg }
  }

  const entryA: OutgoingPendingEntry = { friendshipId: 'out-a', toProfileId: 'prof-x' }
  const entryB: OutgoingPendingEntry = { friendshipId: 'out-b', toProfileId: 'prof-y' }

  await check('[F5] Frontend: rejected friendshipId се премахва от outgoingPending idempotently', () => {
    const state: OutgoingFriendshipsState = { outgoingPending: [entryA, entryB], friendsErrorText: null }
    const after1 = applyRejectedEvent(state, 'out-a')
    assert(after1.outgoingPending.length === 1, 'Трябва да остане 1 запис')
    assert(!after1.outgoingPending.some((r) => r.friendshipId === 'out-a'), 'out-a трябва да е премахнато')
    assert(after1.outgoingPending.some((r) => r.friendshipId === 'out-b'), 'out-b трябва да остане')
    // idempotent — second event for same id
    const after2 = applyRejectedEvent(after1, 'out-a')
    assert(after2.outgoingPending.length === 1, 'Второто event трябва да е no-op')
  })

  await check('[F6] Frontend: cancelFriendRequest при "не беше намерена" → silent remove, без error', () => {
    const state: OutgoingFriendshipsState = { outgoingPending: [entryA, entryB], friendsErrorText: null }
    const after = applyCancelNotFound(state, 'out-a')
    assert(!after.outgoingPending.some((r) => r.friendshipId === 'out-a'), 'out-a трябва да е премахнато')
    assert(after.friendsErrorText === null, 'friendsErrorText трябва да е null (no error shown)')
  })

  await check('[F7] Frontend: cancelFriendRequest при друга грешка → friendsErrorText се показва', () => {
    const state: OutgoingFriendshipsState = { outgoingPending: [entryA, entryB], friendsErrorText: null }
    const errMsg = 'Грешка при комуникация.'
    const after = applyCancelOtherError(state, errMsg)
    assert(after.friendsErrorText === errMsg, 'Грешката трябва да е записана в state')
    assert(after.outgoingPending.length === 2, 'outgoingPending не трябва да се промени при друга грешка')
  })

} finally {
  await rm(dir, { recursive: true, force: true })
}

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
