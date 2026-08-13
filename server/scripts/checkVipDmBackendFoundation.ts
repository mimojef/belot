import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAuthStore } from '../src/db/authStore.js'
import { createBlockStore } from '../src/db/blockStore.js'
import { createChatStore } from '../src/db/chatStore.js'
import { createFriendshipStore } from '../src/db/friendshipStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createVipStore } from '../src/db/vipStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
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

async function applyMigrations(databaseFilePath: string): Promise<void> {
  await applyMigrationFiles(databaseFilePath, () => true)
}

async function applyMigrationFiles(databaseFilePath: string, shouldApply: (file: string) => boolean): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA foreign_keys = ON;')

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .filter(shouldApply)
    .sort()

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }

  db.close()
}

type ProfileFriendshipsSchemaSnapshot = {
  tableSql: string
  indexSqlByName: Record<string, string>
  columns: unknown[]
  foreignKeys: unknown[]
  indexesByName: Record<string, { unique: number; origin: string; partial: number }>
  indexedColumnsByName: Record<string, unknown[]>
}

function getProfileFriendshipsSchemaSnapshot(db: SqliteDatabase): ProfileFriendshipsSchemaSnapshot {
  const schemaRows = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE tbl_name = 'profile_friendships'
      AND name NOT LIKE 'sqlite_autoindex%'
    ORDER BY type, name;
  `).all() as { type: string; name: string; sql: string | null }[]
  const columns = db.prepare('PRAGMA table_info(profile_friendships)').all()
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(profile_friendships)').all()
  const indexes = db.prepare('PRAGMA index_list(profile_friendships)').all() as {
    name: string
    unique: number
    origin: string
    partial: number
  }[]
  const indexSqlByName: Record<string, string> = {}
  const indexesByName: Record<string, { unique: number; origin: string; partial: number }> = {}
  const indexedColumnsByName: Record<string, unknown[]> = {}

  for (const row of schemaRows) {
    if (row.type === 'table') continue
    if (row.sql !== null) indexSqlByName[row.name] = row.sql
  }

  for (const index of indexes) {
    indexesByName[index.name] = {
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
    }
    indexedColumnsByName[index.name] = db.prepare(`PRAGMA index_info(${index.name})`).all()
  }

  const tableSql = schemaRows.find((row) => row.type === 'table')?.sql ?? ''

  return { tableSql, indexSqlByName, columns, foreignKeys, indexesByName, indexedColumnsByName }
}

function normalizeVipDmTableSql(sql: string): string {
  return sql.replace(/,\s*'vip_dm'/g, '')
}

function assertProfileFriendshipsSchemaPreserved(
  before: ProfileFriendshipsSchemaSnapshot,
  after: ProfileFriendshipsSchemaSnapshot,
): void {
  assertEqual(JSON.stringify(after.columns), JSON.stringify(before.columns), 'profile_friendships columns')
  assertEqual(JSON.stringify(after.foreignKeys), JSON.stringify(before.foreignKeys), 'profile_friendships foreign keys')
  assertEqual(normalizeVipDmTableSql(after.tableSql), normalizeVipDmTableSql(before.tableSql), 'profile_friendships table SQL')

  const beforeIndexNames = Object.keys(before.indexesByName).sort()
  const afterIndexNamesWithoutVip = Object.keys(after.indexesByName)
    .filter((name) => name !== 'idx_profile_friendships_vip_dm_pair')
    .sort()
  assertEqual(JSON.stringify(afterIndexNamesWithoutVip), JSON.stringify(beforeIndexNames), 'profile_friendships existing index names')

  for (const indexName of beforeIndexNames) {
    assertEqual(JSON.stringify(after.indexesByName[indexName]), JSON.stringify(before.indexesByName[indexName]), `${indexName} flags`)
    assertEqual(
      JSON.stringify(after.indexedColumnsByName[indexName]),
      JSON.stringify(before.indexedColumnsByName[indexName]),
      `${indexName} columns`,
    )
    if (before.indexSqlByName[indexName] !== undefined) {
      assertEqual(after.indexSqlByName[indexName], before.indexSqlByName[indexName], `${indexName} SQL`)
    }
  }

  assert(after.tableSql.includes("'vip_dm'"), 'after schema does not include vip_dm kind CHECK')
  assert(after.indexesByName.idx_profile_friendships_vip_dm_pair !== undefined, 'after schema does not include vip_dm pair index')
  assertEqual(after.indexesByName.idx_profile_friendships_vip_dm_pair.unique, 1, 'vip_dm pair index unique')
  assertEqual(after.indexesByName.idx_profile_friendships_vip_dm_pair.partial, 1, 'vip_dm pair index partial')
  assertEqual(
    JSON.stringify(after.indexedColumnsByName.idx_profile_friendships_vip_dm_pair),
    JSON.stringify(before.indexedColumnsByName.idx_profile_friendships_friend_pair),
    'vip_dm pair indexed columns',
  )
}

async function verifyRepresentativeMigrationData(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-vip-dm-migration-data-'))
  const dbPath = join(tempDir, 'migration-data.sqlite')
  let migrationDb: SqliteDatabase | null = null

  try {
    await applyMigrationFiles(dbPath, (file) => file < '20260812_005_add_vip_dm_conversation_kind.sql')
    migrationDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    migrationDb.exec('PRAGMA foreign_keys = ON;')

    for (const [profileId, displayName] of [
      ['rep-a', 'RepA'],
      ['rep-b', 'RepB'],
      ['rep-c', 'RepC'],
      ['rep-d', 'RepD'],
    ]) {
      migrationDb.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name)
        VALUES (?, ?, ?)
      `).run(profileId, displayName, displayName.toLowerCase())
    }

    migrationDb.exec(`
      INSERT INTO profile_friendships (
        friendship_id, requester_profile_id, addressee_profile_id,
        lower_profile_id, higher_profile_id, status, responded_at, kind
      ) VALUES
        ('rep-friend', 'rep-a', 'rep-b', 'rep-a', 'rep-b', 'accepted', CURRENT_TIMESTAMP, 'friend'),
        ('rep-pending', 'rep-c', 'rep-d', 'rep-c', 'rep-d', 'pending', NULL, 'friend'),
        ('rep-support', 'rep-a', 'rep-c', 'rep-a', 'rep-c', 'accepted', CURRENT_TIMESTAMP, 'pika_support');

      INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body)
      VALUES
        ('rep-msg-friend', 'rep-friend', 'rep-a', 'friend message'),
        ('rep-msg-support', 'rep-support', 'rep-a', 'support message');

      INSERT INTO chat_conversation_reads (profile_id, friendship_id, last_read_at)
      VALUES
        ('rep-b', 'rep-friend', CURRENT_TIMESTAMP),
        ('rep-c', 'rep-support', CURRENT_TIMESTAMP);

      INSERT INTO friend_chat_attachments (
        message_id, storage_filename, width, height, byte_size, content_type
      ) VALUES
        ('rep-msg-friend', '11111111-1111-4111-8111-111111111111.webp', 10, 10, 100, 'image/webp'),
        ('rep-msg-support', '22222222-2222-4222-8222-222222222222.webp', 20, 20, 200, 'image/webp');
    `)

    const beforeSchema = getProfileFriendshipsSchemaSnapshot(migrationDb)
    const beforeRows = JSON.stringify(migrationDb.prepare(`
      SELECT friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id,
        higher_profile_id, status, blocker_profile_id, requester_acceptance_read_at, kind
      FROM profile_friendships
      ORDER BY friendship_id;
    `).all())
    const beforeMessages = JSON.stringify(migrationDb.prepare('SELECT * FROM friend_chat_messages ORDER BY message_id').all())
    const beforeReads = JSON.stringify(migrationDb.prepare('SELECT * FROM chat_conversation_reads ORDER BY profile_id, friendship_id').all())
    const beforeAttachments = JSON.stringify(migrationDb.prepare('SELECT * FROM friend_chat_attachments ORDER BY message_id').all())

    migrationDb.exec(readFileSync(join(migrationsDir, '20260812_005_add_vip_dm_conversation_kind.sql'), 'utf8'))

    const afterSchema = getProfileFriendshipsSchemaSnapshot(migrationDb)
    const afterRows = JSON.stringify(migrationDb.prepare(`
      SELECT friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id,
        higher_profile_id, status, blocker_profile_id, requester_acceptance_read_at, kind
      FROM profile_friendships
      ORDER BY friendship_id;
    `).all())
    const afterMessages = JSON.stringify(migrationDb.prepare('SELECT * FROM friend_chat_messages ORDER BY message_id').all())
    const afterReads = JSON.stringify(migrationDb.prepare('SELECT * FROM chat_conversation_reads ORDER BY profile_id, friendship_id').all())
    const afterAttachments = JSON.stringify(migrationDb.prepare('SELECT * FROM friend_chat_attachments ORDER BY message_id').all())

    assertEqual(afterRows, beforeRows, 'profile_friendships data after migration')
    assertEqual(afterMessages, beforeMessages, 'friend_chat_messages data after migration')
    assertEqual(afterReads, beforeReads, 'chat_conversation_reads data after migration')
    assertEqual(afterAttachments, beforeAttachments, 'friend_chat_attachments data after migration')
    assertProfileFriendshipsSchemaPreserved(beforeSchema, afterSchema)

    const foreignKeyViolations = migrationDb.prepare('PRAGMA foreign_key_check').all()
    assertEqual(foreignKeyViolations.length, 0, 'foreign_key_check violations')

    migrationDb.prepare(`
      INSERT INTO profile_friendships (
        friendship_id, requester_profile_id, addressee_profile_id,
        lower_profile_id, higher_profile_id, status, kind
      ) VALUES ('rep-vip', 'rep-b', 'rep-d', 'rep-b', 'rep-d', 'accepted', 'vip_dm')
    `).run()
  } finally {
    if (migrationDb !== null) migrationDb.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

function futureSqlDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')
}

function createPair(leftProfileId: string, rightProfileId: string): { lowerProfileId: string; higherProfileId: string } {
  return leftProfileId.localeCompare(rightProfileId, 'en') <= 0
    ? { lowerProfileId: leftProfileId, higherProfileId: rightProfileId }
    : { lowerProfileId: rightProfileId, higherProfileId: leftProfileId }
}

async function main(): Promise<void> {
  await check('[0] representative pre-migration data survives 005 rebuild with only vip_dm schema additions', verifyRepresentativeMigrationData)

  const tempDir = await mkdtemp(join(tmpdir(), 'belot-vip-dm-foundation-'))
  const dbPath = join(tempDir, 'vip-dm.sqlite')
  let db: SqliteDatabase | null = null

  try {
    await applyMigrations(dbPath)

    const progressStore = await createPlayerProgressStore(dbPath)
    const authStore = await createAuthStore(dbPath, progressStore)
    const friendshipStore = await createFriendshipStore(dbPath, progressStore)
    const blockStore = await createBlockStore(dbPath)
    const vipStore = await createVipStore(dbPath)
    const chatStore = await createChatStore(dbPath, progressStore, blockStore, friendshipStore, {
      vipStatusChecker: {
        isActiveVip: (profileId) => vipStore.getStatus(profileId).isActive,
      },
    })
    db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')

    function registerHuman(email: string, displayName: string): string {
      const result = authStore.register({ email, password: 'secret1', displayName, gender: 'male' })
      assert(result.ok === true, `registration failed for ${email}`)
      return result.ok ? result.session.profile.profileId! : ''
    }

    function grantVip(profileId: string): void {
      vipStore.grantVip(profileId, 'admin_grant', { unit: 'days', amount: 30 })
    }

    function expireVip(profileId: string): void {
      db!.prepare(`UPDATE vip_status SET active_until = ? WHERE profile_id = ?`).run(futureSqlDate(-1), profileId)
    }

    const alice = registerHuman('vipdm-alice@example.test', 'VipDmAlice')
    const bob = registerHuman('vipdm-bob@example.test', 'VipDmBob')
    const carol = registerHuman('vipdm-carol@example.test', 'VipDmCarol')
    const dana = registerHuman('vipdm-dana@example.test', 'VipDmDana')
    const erin = registerHuman('vipdm-erin@example.test', 'VipDmErin')

    await check('[1] migration allows vip_dm and adds order-independent unique pair protection', () => {
      const pair = createPair(alice, bob)
      const friendshipId = randomUUID()
      db!.prepare(`
        INSERT INTO profile_friendships (
          friendship_id, requester_profile_id, addressee_profile_id,
          lower_profile_id, higher_profile_id, status, kind
        ) VALUES (?, ?, ?, ?, ?, 'accepted', 'vip_dm')
      `).run(friendshipId, alice, bob, pair.lowerProfileId, pair.higherProfileId)
      let duplicateRejected = false
      try {
        db!.prepare(`
          INSERT INTO profile_friendships (
            friendship_id, requester_profile_id, addressee_profile_id,
            lower_profile_id, higher_profile_id, status, kind
          ) VALUES (?, ?, ?, ?, ?, 'accepted', 'vip_dm')
        `).run(randomUUID(), bob, alice, pair.lowerProfileId, pair.higherProfileId)
      } catch {
        duplicateRejected = true
      }
      assert(duplicateRejected, 'duplicate vip_dm pair was accepted')
      db!.prepare(`DELETE FROM profile_friendships WHERE friendship_id = ?`).run(friendshipId)
    })

    await check('[2] VIP to VIP non-friend start creates vip_dm; repeat returns same row', () => {
      grantVip(alice)
      grantVip(bob)
      const first = chatStore.getOrCreateVipDmConversation(alice, bob)
      assert(first.ok, 'first start failed')
      if (!first.ok) return
      assertEqual(first.conversation.kind, 'vip_dm', 'conversation kind')
      const second = chatStore.getOrCreateVipDmConversation(bob, alice)
      assert(second.ok, 'repeat start failed')
      if (!second.ok) return
      assertEqual(second.friendshipId, first.friendshipId, 'repeat friendshipId')
      const row = db!.prepare(`SELECT COUNT(*) AS cnt FROM profile_friendships WHERE kind = 'vip_dm' AND lower_profile_id = ? AND higher_profile_id = ?`)
        .get(createPair(alice, bob).lowerProfileId, createPair(alice, bob).higherProfileId) as { cnt: number }
      assertEqual(row.cnt, 1, 'vip_dm row count')
    })

    await check('[3] friend pair starts a separate vip_dm conversation', () => {
      const request = friendshipStore.sendRequest(carol, dana)
      assert(request.ok, 'friend request failed')
      if (!request.ok) return
      const accept = friendshipStore.acceptRequest(dana, request.friendshipId)
      assert(accept.ok, 'friend accept failed')
      grantVip(carol)
      grantVip(dana)
      const started = chatStore.getOrCreateVipDmConversation(carol, dana)
      assert(started.ok, 'start on friend pair failed')
      if (!started.ok) return
      assert(started.friendshipId !== request.friendshipId, 'vip_dm reused friend friendshipId')
      assertEqual(started.conversation.kind, 'vip_dm', 'friend pair vip_dm kind')
      const pair = createPair(carol, dana)
      const vipRows = db!.prepare(`SELECT COUNT(*) AS cnt FROM profile_friendships WHERE kind = 'vip_dm' AND lower_profile_id = ? AND higher_profile_id = ?`)
        .get(pair.lowerProfileId, pair.higherProfileId) as { cnt: number }
      assertEqual(vipRows.cnt, 1, 'vip_dm row count')
      const friendRows = db!.prepare(`SELECT COUNT(*) AS cnt FROM profile_friendships WHERE kind = 'friend' AND lower_profile_id = ? AND higher_profile_id = ?`)
        .get(pair.lowerProfileId, pair.higherProfileId) as { cnt: number }
      assertEqual(friendRows.cnt, 1, 'friend row count')
    })

    await check('[4] non-VIP sender/recipient, self, and blocked pairs are denied', () => {
      const nonVipSender = chatStore.getOrCreateVipDmConversation(erin, alice)
      assert(!nonVipSender.ok && nonVipSender.code === 'vip_required', 'non-VIP sender was not denied with vip_required')

      grantVip(erin)
      const frank = registerHuman('vipdm-frank@example.test', 'VipDmFrank')
      const nonVipRecipient = chatStore.getOrCreateVipDmConversation(erin, frank)
      assert(!nonVipRecipient.ok && nonVipRecipient.code === 'vip_counterpart_required', 'non-VIP recipient was not denied')

      const self = chatStore.getOrCreateVipDmConversation(erin, erin)
      assert(!self.ok && self.code === 'self', 'self start was not denied')

      blockStore.toggleBlock(erin, bob)
      const blocked = chatStore.getOrCreateVipDmConversation(erin, bob)
      assert(!blocked.ok && blocked.code === 'blocked', 'blocked start was not denied')
      blockStore.toggleBlock(erin, bob)
    })

    await check('[5] vip_dm send requires both active VIP; expiry keeps history/read state', () => {
      const started = chatStore.getOrCreateVipDmConversation(alice, bob)
      assert(started.ok, 'vip_dm missing')
      if (!started.ok) return
      const sent = chatStore.sendMessage(alice, started.friendshipId, 'hello vip')
      assert(sent.ok, 'vip_dm send failed while both active')
      chatStore.markConversationRead(bob, started.friendshipId)
      db!.prepare(`UPDATE vip_status SET active_until = ? WHERE profile_id = ?`).run(futureSqlDate(-1), alice)
      const expired = chatStore.sendMessage(alice, started.friendshipId, 'after expiry')
      assert(!expired.ok && expired.code === 'vip_required', 'expired sender was not denied')
      const history = chatStore.listMessages(alice, started.friendshipId)
      assert(history.ok, 'history read failed after expiry')
      if (history.ok) assert(history.messages.some((m) => m.body === 'hello vip'), 'history was lost after expiry')
      const readRow = db!.prepare(`SELECT 1 FROM chat_conversation_reads WHERE profile_id = ? AND friendship_id = ?`)
        .get(bob, started.friendshipId)
      assert(readRow !== undefined, 'read state was lost after expiry')
      grantVip(alice)
      const renewed = chatStore.sendMessage(alice, started.friendshipId, 'after renew')
      assert(renewed.ok, 'send did not recover after renew')
    })

    await check('[6] block denies send but does not delete vip_dm history or attachments; unblock restores while VIP active', () => {
      const started = chatStore.getOrCreateVipDmConversation(alice, bob)
      assert(started.ok, 'vip_dm missing')
      if (!started.ok) return
      const withAttachment = chatStore.sendMessage(alice, started.friendshipId, '', {
        storageFilename: `${randomUUID()}.webp`,
        width: 20,
        height: 20,
        byteSize: 123,
        contentType: 'image/webp',
      })
      assert(withAttachment.ok, 'attachment message failed')
      blockStore.toggleBlock(bob, alice)
      const blocked = chatStore.sendMessage(alice, started.friendshipId, 'blocked')
      assert(!blocked.ok && blocked.code === 'blocked', 'blocked send was not denied')
      const messageRows = db!.prepare(`SELECT COUNT(*) AS cnt FROM friend_chat_messages WHERE friendship_id = ?`)
        .get(started.friendshipId) as { cnt: number }
      assert(messageRows.cnt >= 1, 'messages were deleted by block')
      const attachmentRows = db!.prepare(`
        SELECT COUNT(*) AS cnt
        FROM friend_chat_attachments a
        JOIN friend_chat_messages m ON m.message_id = a.message_id
        WHERE m.friendship_id = ?
      `).get(started.friendshipId) as { cnt: number }
      assert(attachmentRows.cnt >= 1, 'attachments were deleted by block')
      blockStore.toggleBlock(bob, alice)
      const restored = chatStore.sendMessage(alice, started.friendshipId, 'unblocked')
      assert(restored.ok, 'send did not recover after unblock')
    })

    await check('[6b] exact send authorization matrix for friend, vip_dm, and pika_support', () => {
      const friendVipA = registerHuman('vipdm-matrix-friend-vip-a@example.test', 'MatrixFriendVipA')
      const friendVipB = registerHuman('vipdm-matrix-friend-vip-b@example.test', 'MatrixFriendVipB')
      grantVip(friendVipA)
      grantVip(friendVipB)
      const friendVipRequest = friendshipStore.sendRequest(friendVipA, friendVipB)
      assert(friendVipRequest.ok, 'friend VIP request failed')
      if (!friendVipRequest.ok) return
      assert(friendshipStore.acceptRequest(friendVipB, friendVipRequest.friendshipId).ok, 'friend VIP accept failed')
      assert(chatStore.sendMessage(friendVipA, friendVipRequest.friendshipId, 'friend both vip').ok, 'friend both VIP send failed')

      const friendPlainA = registerHuman('vipdm-matrix-friend-plain-a@example.test', 'MatrixFriendPlainA')
      const friendPlainB = registerHuman('vipdm-matrix-friend-plain-b@example.test', 'MatrixFriendPlainB')
      const friendPlainRequest = friendshipStore.sendRequest(friendPlainA, friendPlainB)
      assert(friendPlainRequest.ok, 'friend plain request failed')
      if (!friendPlainRequest.ok) return
      assert(friendshipStore.acceptRequest(friendPlainB, friendPlainRequest.friendshipId).ok, 'friend plain accept failed')
      assert(chatStore.sendMessage(friendPlainA, friendPlainRequest.friendshipId, 'friend no vip').ok, 'friend non-VIP send failed')
      grantVip(friendPlainA)
      expireVip(friendPlainA)
      assert(chatStore.sendMessage(friendPlainA, friendPlainRequest.friendshipId, 'friend expired vip').ok, 'friend expired VIP send failed')
      blockStore.toggleBlock(friendPlainA, friendPlainB)
      const friendBlockedBySender = chatStore.sendMessage(friendPlainA, friendPlainRequest.friendshipId, 'friend blocked sender')
      assert(!friendBlockedBySender.ok && friendBlockedBySender.code === 'blocked', 'friend A->B block did not deny with blocked')
      blockStore.toggleBlock(friendPlainA, friendPlainB)
      blockStore.toggleBlock(friendPlainB, friendPlainA)
      const friendBlockedByRecipient = chatStore.sendMessage(friendPlainA, friendPlainRequest.friendshipId, 'friend blocked recipient')
      assert(!friendBlockedByRecipient.ok && friendBlockedByRecipient.code === 'blocked', 'friend B->A block did not deny with blocked')
      blockStore.toggleBlock(friendPlainB, friendPlainA)

      const vipA = registerHuman('vipdm-matrix-vip-a@example.test', 'MatrixVipA')
      const vipB = registerHuman('vipdm-matrix-vip-b@example.test', 'MatrixVipB')
      grantVip(vipA)
      grantVip(vipB)
      const vipDm = chatStore.getOrCreateVipDmConversation(vipA, vipB)
      assert(vipDm.ok, 'vip_dm matrix start failed')
      if (!vipDm.ok) return
      assert(chatStore.sendMessage(vipA, vipDm.friendshipId, 'vip both active').ok, 'vip_dm both active send failed')
      expireVip(vipA)
      const inactiveSender = chatStore.sendMessage(vipA, vipDm.friendshipId, 'vip inactive sender')
      assert(!inactiveSender.ok && inactiveSender.code === 'vip_required', 'vip_dm inactive sender code mismatch')
      grantVip(vipA)
      expireVip(vipB)
      const inactiveRecipient = chatStore.sendMessage(vipA, vipDm.friendshipId, 'vip inactive recipient')
      assert(!inactiveRecipient.ok && inactiveRecipient.code === 'vip_counterpart_required', 'vip_dm inactive recipient code mismatch')
      grantVip(vipB)
      blockStore.toggleBlock(vipA, vipB)
      const vipBlockedBySender = chatStore.sendMessage(vipA, vipDm.friendshipId, 'vip blocked sender')
      assert(!vipBlockedBySender.ok && vipBlockedBySender.code === 'blocked', 'vip_dm A->B block code mismatch')
      blockStore.toggleBlock(vipA, vipB)
      blockStore.toggleBlock(vipB, vipA)
      const vipBlockedByRecipient = chatStore.sendMessage(vipA, vipDm.friendshipId, 'vip blocked recipient')
      assert(!vipBlockedByRecipient.ok && vipBlockedByRecipient.code === 'blocked', 'vip_dm B->A block code mismatch')
      blockStore.toggleBlock(vipB, vipA)

      const supportA = registerHuman('vipdm-matrix-support-a@example.test', 'MatrixSupportA')
      const supportB = registerHuman('vipdm-matrix-support-b@example.test', 'MatrixSupportB')
      const supportPair = createPair(supportA, supportB)
      const supportId = randomUUID()
      db!.prepare(`
        INSERT INTO profile_friendships (
          friendship_id, requester_profile_id, addressee_profile_id,
          lower_profile_id, higher_profile_id, status, kind
        ) VALUES (?, ?, ?, ?, ?, 'accepted', 'pika_support')
      `).run(supportId, supportA, supportB, supportPair.lowerProfileId, supportPair.higherProfileId)
      assert(chatStore.sendMessage(supportA, supportId, 'support no vip').ok, 'pika_support gained accidental VIP requirement')
    })

    await check('[7] existing vip_dm stays separate when friend request is accepted', () => {
      grantVip(erin)
      const frank = registerHuman('vipdm-frank-convert@example.test', 'VipDmFrankConvert')
      grantVip(frank)
      const vipDm = chatStore.getOrCreateVipDmConversation(erin, frank)
      assert(vipDm.ok, 'vip_dm creation failed')
      if (!vipDm.ok) return
      chatStore.markConversationRead(frank, vipDm.friendshipId)
      const message = chatStore.sendMessage(erin, vipDm.friendshipId, 'before friendship', {
        storageFilename: `${randomUUID()}.webp`,
        width: 16,
        height: 16,
        byteSize: 99,
        contentType: 'image/webp',
      })
      assert(message.ok, 'vip_dm message failed')
      const request = friendshipStore.sendRequest(erin, frank)
      assert(request.ok, 'friend request failed after vip_dm')
      if (!request.ok) return
      assert(request.friendshipId !== vipDm.friendshipId, 'pending friend unexpectedly reused vip_dm id before accept')
      const accept = friendshipStore.acceptRequest(frank, request.friendshipId)
      assert(accept.ok, 'friend accept failed')
      const vipRow = db!.prepare(`
        SELECT kind, status, requester_profile_id, addressee_profile_id, lower_profile_id,
          higher_profile_id, responded_at
        FROM profile_friendships
        WHERE friendship_id = ?
      `).get(vipDm.friendshipId) as {
        kind: string
        status: string
        requester_profile_id: string
        addressee_profile_id: string
        lower_profile_id: string
        higher_profile_id: string
        responded_at: string | null
      } | undefined
      assert(vipRow !== undefined, 'vip_dm row missing after friend accept')
      assertEqual(vipRow!.kind, 'vip_dm', 'vip_dm kind after friend accept')
      assertEqual(vipRow!.status, 'accepted', 'vip_dm status after friend accept')
      assertEqual(vipRow!.requester_profile_id, erin, 'vip_dm requester unchanged')
      assertEqual(vipRow!.addressee_profile_id, frank, 'vip_dm addressee unchanged')
      assertEqual(vipRow!.lower_profile_id, createPair(erin, frank).lowerProfileId, 'vip_dm lower profile id')
      assertEqual(vipRow!.higher_profile_id, createPair(erin, frank).higherProfileId, 'vip_dm higher profile id')
      const friendRow = db!.prepare(`
        SELECT kind, status, responded_at
        FROM profile_friendships
        WHERE friendship_id = ?
      `).get(request.friendshipId) as { kind: string; status: string; responded_at: string | null } | undefined
      assert(friendRow !== undefined, 'accepted friend row missing')
      assertEqual(friendRow!.kind, 'friend', 'accepted friend kind')
      assertEqual(friendRow!.status, 'accepted', 'accepted friend status')
      assert(friendRow!.responded_at !== null, 'accepted friend responded_at missing')
      const duplicateRows = db!.prepare(`
        SELECT COUNT(*) AS cnt
        FROM profile_friendships
        WHERE lower_profile_id = ? AND higher_profile_id = ?
      `).get(createPair(erin, frank).lowerProfileId, createPair(erin, frank).higherProfileId) as { cnt: number }
      assertEqual(duplicateRows.cnt, 2, 'separate friend+vip_dm pair row count')
      const friendList = friendshipStore.listForProfile(erin)
      assert(friendList.friends.some((friend) => friend.friendshipId === request.friendshipId), 'accepted friend missing from friend list')
      assert(!friendList.friends.some((friend) => friend.friendshipId === vipDm.friendshipId), 'vip_dm leaked into friend list')
      const history = chatStore.listMessages(erin, vipDm.friendshipId)
      assert(history.ok, 'vip_dm history failed')
      if (history.ok) assert(history.messages.some((m) => m.body === 'before friendship'), 'vip_dm messages lost')
      const friendMessage = chatStore.sendMessage(erin, request.friendshipId, 'friend only after accept')
      assert(friendMessage.ok, 'friend message failed after accept')
      const friendHistory = chatStore.listMessages(frank, request.friendshipId)
      assert(friendHistory.ok, 'friend history failed')
      if (friendHistory.ok) {
        assert(friendHistory.messages.some((m) => m.body === 'friend only after accept'), 'friend message missing from friend history')
        assert(!friendHistory.messages.some((m) => m.body === 'before friendship'), 'vip_dm message leaked into friend history')
      }
      const vipHistoryAfterFriendMessage = chatStore.listMessages(frank, vipDm.friendshipId)
      assert(vipHistoryAfterFriendMessage.ok, 'vip_dm history after friend message failed')
      if (vipHistoryAfterFriendMessage.ok) {
        assert(!vipHistoryAfterFriendMessage.messages.some((m) => m.body === 'friend only after accept'), 'friend message leaked into vip_dm history')
      }
      const readRow = db!.prepare(`SELECT 1 FROM chat_conversation_reads WHERE profile_id = ? AND friendship_id = ?`)
        .get(frank, vipDm.friendshipId)
      assert(readRow !== undefined, 'vip_dm reads lost')
      const attachment = db!.prepare(`
        SELECT 1
        FROM friend_chat_attachments a
        JOIN friend_chat_messages m ON m.message_id = a.message_id
        WHERE m.friendship_id = ?
      `).get(vipDm.friendshipId)
      assert(attachment !== undefined, 'vip_dm attachments lost')
      const friendAttachment = db!.prepare(`
        SELECT 1
        FROM friend_chat_attachments a
        JOIN friend_chat_messages m ON m.message_id = a.message_id
        WHERE m.friendship_id = ?
      `).get(request.friendshipId)
      assert(friendAttachment === undefined, 'vip_dm attachment leaked into friend conversation')
      const remove = friendshipStore.removeRelationship(erin, request.friendshipId)
      assert(remove.ok, 'friend removal failed')
      const vipAfterRemove = db!.prepare(`SELECT kind, status FROM profile_friendships WHERE friendship_id = ?`)
        .get(vipDm.friendshipId) as { kind: string; status: string } | undefined
      assert(vipAfterRemove !== undefined, 'friend removal deleted vip_dm')
      assertEqual(vipAfterRemove!.kind, 'vip_dm', 'vip_dm kind after friend removal')
      assertEqual(vipAfterRemove!.status, 'accepted', 'vip_dm status after friend removal')
    })

    await check('[8] unknown kind fails closed and is not returned as friend', () => {
      db!.exec('PRAGMA ignore_check_constraints = ON;')
      const pair = createPair(alice, carol)
      const corruptId = randomUUID()
      db!.prepare(`
        INSERT INTO profile_friendships (
          friendship_id, requester_profile_id, addressee_profile_id,
          lower_profile_id, higher_profile_id, status, kind
        ) VALUES (?, ?, ?, ?, ?, 'accepted', 'mystery')
      `).run(corruptId, alice, carol, pair.lowerProfileId, pair.higherProfileId)
      db!.exec('PRAGMA ignore_check_constraints = OFF;')
      const listed = chatStore.listConversations(alice).find((c) => c.friendshipId === corruptId)
      assert(listed === undefined, 'unknown kind was listed as a conversation')
      const send = chatStore.sendMessage(alice, corruptId, 'nope')
      assert(!send.ok && send.code === 'invalid_conversation_kind', 'unknown kind did not fail closed on send')
    })

    await check('[9] vip_dm does not satisfy audited friend-only queries', () => {
      const tournamentSource = readdirSync(resolve(serverRoot, 'src/db'))
        .filter((file) => file === 'tournamentEconomyStore.ts')
        .map((file) => file)
      assertEqual(tournamentSource.length, 1, 'tournament source present')
      const tournamentText = readFileSync(resolve(serverRoot, 'src/db/tournamentEconomyStore.ts'), 'utf8')
      const giftText = readFileSync(resolve(serverRoot, 'src/db/yellowCoinGiftStore.ts'), 'utf8')
      assert(tournamentText.includes("AND kind = 'friend'"), 'tournament friend eligibility lacks kind guard')
      assert(tournamentText.includes("AND f.kind = 'friend'"), 'tournament accepted friend list lacks kind guard')
      assert(giftText.includes("AND kind = 'friend'"), 'yellow coin gift friend query lacks kind guard')
    })

    await check('[10] pika_support remains isolated from vip_dm start', () => {
      const pair = createPair(alice, bob)
      const supportId = randomUUID()
      db!.prepare(`
        INSERT INTO profile_friendships (
          friendship_id, requester_profile_id, addressee_profile_id,
          lower_profile_id, higher_profile_id, status, kind
        ) VALUES (?, ?, ?, ?, ?, 'accepted', 'pika_support')
      `).run(supportId, alice, bob, pair.lowerProfileId, pair.higherProfileId)
      const vip = chatStore.getOrCreateVipDmConversation(alice, bob)
      assert(vip.ok, 'vip_dm lookup failed')
      if (!vip.ok) return
      assert(vip.friendshipId !== supportId, 'vip_dm start returned pika_support row')
    })

    await check('[11] conversation list returns separate friend and vip_dm rows for one pair', () => {
      const listA = registerHuman('vipdm-list-a@example.test', 'VipDmListA')
      const listB = registerHuman('vipdm-list-b@example.test', 'VipDmListB')
      grantVip(listA)
      grantVip(listB)
      const vipDm = chatStore.getOrCreateVipDmConversation(listA, listB)
      assert(vipDm.ok, 'vip_dm list start failed')
      if (!vipDm.ok) return
      const sent = chatStore.sendMessage(listA, vipDm.friendshipId, 'list metadata')
      assert(sent.ok, 'vip_dm list message failed')
      const beforeRead = chatStore.listConversations(listB).find((conversation) => conversation.friendshipId === vipDm.friendshipId)
      assert(beforeRead !== undefined, 'vip_dm conversation missing from list')
      assertEqual(beforeRead!.kind, 'vip_dm', 'vip_dm listed kind')
      assertEqual(beforeRead!.friend.profileId, listA, 'vip_dm listed friend profile')
      assert(beforeRead!.unreadCount >= 1, 'vip_dm unread count did not increase')
      assert(beforeRead!.lastMessage !== null && beforeRead!.lastMessage.body === 'list metadata', 'vip_dm lastMessage missing')
      assert(beforeRead!.updatedAt.length > 0, 'vip_dm updatedAt missing')

      const pair = createPair(listA, listB)
      const legacyFriendId = randomUUID()
      db!.prepare(`
        INSERT INTO profile_friendships (
          friendship_id, requester_profile_id, addressee_profile_id,
          lower_profile_id, higher_profile_id, status, kind
        ) VALUES (?, ?, ?, ?, ?, 'accepted', 'friend')
      `).run(legacyFriendId, listA, listB, pair.lowerProfileId, pair.higherProfileId)
      const afterLegacyDuplicate = chatStore.listConversations(listA)
        .filter((conversation) => conversation.friend.profileId === listB && (conversation.kind === 'friend' || conversation.kind === 'vip_dm'))
      assertEqual(afterLegacyDuplicate.length, 2, 'friend+vip_dm pair visible conversation count')
      assert(afterLegacyDuplicate.some((conversation) => conversation.kind === 'friend' && conversation.friendshipId === legacyFriendId), 'friend row missing from list')
      assert(afterLegacyDuplicate.some((conversation) => conversation.kind === 'vip_dm' && conversation.friendshipId === vipDm.friendshipId), 'vip_dm row missing from list')
    })

    chatStore.close()
    vipStore.close()
    blockStore.close()
    friendshipStore.close()
    progressStore.close()
    authStore.close()
  } finally {
    if (db !== null) db.close()
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log(`\nVIP DM backend foundation checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

await main()
