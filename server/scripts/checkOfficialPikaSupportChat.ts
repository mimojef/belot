import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createFriendshipStore } from '../src/db/friendshipStore.js'
import { createBlockStore } from '../src/db/blockStore.js'
import { createChatStore } from '../src/db/chatStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

const OFFICIAL_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'
const OTHER_PIKA_TEAM_PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
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
  const db = new DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA foreign_keys = ON;')

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }

  db.close()
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-pika-support-chat-'))
  const dbPath = join(tempDir, 'pika-support-chat.sqlite')
  let db: DatabaseSync | null = null

  try {
    await applyMigrations(dbPath)

    const progressStore = await createPlayerProgressStore(dbPath)
    const authStore = await createAuthStore(dbPath, progressStore)
    const friendshipStore = await createFriendshipStore(dbPath, progressStore)
    const blockStore = await createBlockStore(dbPath)
    const chatStore = await createChatStore(dbPath, progressStore, blockStore, friendshipStore, {
      officialPikaProfileId: OFFICIAL_PROFILE_ID,
    })
    // Втори chatStore instance, конфигуриран БЕЗ official profile — за
    // fail-closed сценария (липсваща/невалидна env стойност).
    const chatStoreNoBypass = await createChatStore(dbPath, progressStore, blockStore, friendshipStore, {
      officialPikaProfileId: null,
    })
    db = new DatabaseSync(dbPath, { open: true })
    // FK enforcement е per-connection в SQLite — изрично OFF тук, защото
    // insertProfileWithId по-долу пренаписва profile_id/account_id за
    // фиксирани UUID-та в множество таблици (profiles/accounts/wallets/
    // progress), обновявайки ги последователно, не атомарно спрямо
    // account_sessions.account_id/profile_id FK-тата (тестова fixture
    // операция, не production код path).
    db.exec('PRAGMA foreign_keys = OFF;')

    function registerHuman(email: string, displayName: string): string {
      const result = authStore.register({ email, password: 'secret1', displayName, gender: 'male' })
      assert(result.ok === true, `registration failed for ${email}: ${result.ok ? '' : result.message}`)
      return result.ok ? result.session.profile.profileId! : ''
    }

    // Регистрира нормален профил (с реален account_id, като всеки истински
    // потребител), после пренаписва profile_id/account_id-references на
    // изрично зададен UUID — нужно за OFFICIAL_PROFILE_ID (фиксиран, точно
    // конфигурираният в chatStore options по-горе) и за симулиране на друг
    // pika_team-role профил. isRegisteredHumanProfile (friendshipStore.ts)
    // изисква account_id IS NOT NULL — profile-и без реален акаунт (както
    // старата ръчна raw-INSERT версия на този helper) не могат да пращат
    // friend requests, което би провалило EC1 сценариите по-долу.
    function insertProfileWithId(profileId: string, displayName: string): void {
      // Регистрира с временно, НЕ-reserved display name — containment guard-ът
      // (validateProfileDisplayName) отхвърля всяко име, което СЪДЪРЖА PIKABG
      // като substring (напр. "PIKABGFixture" също е reserved), затова
      // временното име тук е напълно несвързано с 'PIKABG'. Официалният
      // exact-UUID exception изисква профилът вече да Е configured official
      // profileId — но по време на register() UUID-то още не съществува,
      // значи не можем директно да регистрираме с 'PIKABG'. Пренаписваме
      // display name-a директно в реда СЛЕД като profile_id вече е фиксиран.
      const registrationDisplayName = `FixtureTemp${Math.random().toString(36).slice(2, 8)}`
      const email = `${displayName.toLowerCase()}-fixed@example.test`
      const registered = authStore.register({ email, password: 'secret1', displayName: registrationDisplayName, gender: 'male' })
      assert(registered.ok === true, `fixture registration failed for ${displayName}: ${registered.ok ? '' : registered.message}`)
      if (!registered.ok) return

      const oldProfileId = registered.session.profile.profileId!
      const oldAccountId = registered.session.account.accountId

      db!.prepare(`UPDATE profiles SET profile_id = ? WHERE profile_id = ?`).run(profileId, oldProfileId)
      db!.prepare(`UPDATE profile_wallets SET profile_id = ? WHERE profile_id = ?`).run(profileId, oldProfileId)
      db!.prepare(`UPDATE profile_progress SET profile_id = ? WHERE profile_id = ?`).run(profileId, oldProfileId)
      db!.prepare(`UPDATE accounts SET account_id = ? WHERE account_id = ?`).run(profileId, oldAccountId)
      db!.prepare(`
        UPDATE profiles
        SET account_id = ?, display_name = ?, normalized_display_name = ?, username = ?, normalized_username = ?
        WHERE profile_id = ?
      `).run(profileId, displayName, displayName.toLowerCase(), displayName, displayName.toLowerCase(), profileId)
    }

    // Официалният PIKABG профил — фиксиран UUID, конфигуриран изрично в
    // chatStore options по-горе (не зависи от process.env в теста).
    insertProfileWithId(OFFICIAL_PROFILE_ID, 'PIKABG')
    insertProfileWithId(OTHER_PIKA_TEAM_PROFILE_ID, 'OtherPikaTeam')

    const alice = registerHuman('alice@example.test', 'Alice')
    const bob = registerHuman('bob@example.test', 'Bob')

    await check('[1] PIKABG can start a chat with a registered non-friend', () => {
      const result = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, alice)
      assert(result.ok === true, `start failed: ${result.ok ? '' : result.message}`)
    })

    await check('[2] the created conversation is of the official (pika_support) kind', () => {
      const result = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, alice)
      assert(result.ok === true, 'lookup failed')
      if (result.ok) {
        assert(result.conversation.kind === 'pika_support', `kind=${result.conversation.kind}`)
        const row = db!.prepare(`SELECT kind, status FROM profile_friendships WHERE friendship_id = ?`)
          .get(result.friendshipId) as { kind: string; status: string } | undefined
        assert(row !== undefined, 'row missing')
        assert(row!.kind === 'pika_support', `db kind=${row!.kind}`)
        assert(row!.status === 'accepted', `db status=${row!.status}`)
      }
    })

    let aliceFriendshipId = ''

    await check('[3] the recipient can reply without being friends', () => {
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, alice)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return
      aliceFriendshipId = started.friendshipId

      const reply = chatStore.sendMessage(alice, aliceFriendshipId, 'Здравей, имам въпрос.')
      assert(reply.ok === true, `reply failed: ${reply.ok ? '' : reply.message}`)

      const fromOfficial = chatStore.sendMessage(OFFICIAL_PROFILE_ID, aliceFriendshipId, 'Здравей! Как мога да помогна?')
      assert(fromOfficial.ok === true, `official send failed: ${fromOfficial.ok ? '' : fromOfficial.message}`)
    })

    await check('[4] the recipient cannot create the official conversation before PIKABG', () => {
      const carol = registerHuman('carol@example.test', 'Carol')
      const attempt = chatStore.getOrCreatePikaSupportConversation(carol, OFFICIAL_PROFILE_ID)
      assert(attempt.ok === false, 'non-official initiator was allowed to create the conversation')
      if (!attempt.ok) {
        assert(!attempt.message.includes('undefined'), 'message malformed')
      }
      // Потвърждение: няма запис в базата за тази двойка.
      const row = db!.prepare(`
        SELECT 1 FROM profile_friendships
        WHERE kind = 'pika_support'
          AND (requester_profile_id = ? OR addressee_profile_id = ?)
      `).get(carol, carol) as unknown
      assert(row === undefined, 'a pika_support row was created by a non-official initiator')
    })

    await check('[5] another pika_team-role profile cannot use the bypass', () => {
      const attempt = chatStore.getOrCreatePikaSupportConversation(OTHER_PIKA_TEAM_PROFILE_ID, bob)
      assert(attempt.ok === false, 'non-official pika_team profile was allowed to start an official chat')
    })

    await check('[6] a normal non-friend chat is still rejected (friendship guard intact)', () => {
      const result = chatStore.sendMessage(alice, 'nonexistent-friendship-id', 'hi')
      assert(result.ok === false, 'message sent without an accepted friendship')

      // Alice и Bob не са приятели — опит да "измислят" общ friendshipId чрез
      // произволен низ трябва да се провали идентично.
      const forged = chatStore.sendMessage(bob, aliceFriendshipId, 'опит да пиша в чужд разговор')
      assert(forged.ok === false, 'bob (not a participant) was allowed to send into the pika_support conversation')
    })

    await check('[7] a forged conversation_kind from the client cannot bypass the friendship guard', () => {
      // Симулира client bypass опит: директен ред с kind='pika_support', но
      // БЕЗ да мине през getOrCreatePikaSupportConversation (т.е. сякаш
      // клиент е подправил заявка, ако endpoint-ът НЕ валидираше
      // server-side) — създаваме ръчно ред между Bob и Carol, initiator НЕ
      // е official, и потвърждаваме, че endpoint-ната функция отказва да
      // достави идентичен резултат за произволен друг чифт, докато store
      // API-то (getOrCreatePikaSupportConversation) е ЕДИНСТВЕНИЯТ path,
      // който създава такива редове — опит да го извикаме с
      // non-official initiator винаги се отказва (виж [4]/[5]), значи
      // client не може да произведе валиден pika_support ред по никакъв
      // начин извън authoritative server кода.
      const carol2 = registerHuman('carol2@example.test', 'Carol2')
      const bypassAttempt = chatStore.getOrCreatePikaSupportConversation(bob, carol2)
      assert(bypassAttempt.ok === false, 'forged non-official pika_support creation succeeded')
    })

    await check('[8] starting again finds the same conversation (idempotent)', () => {
      const first = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, bob)
      const second = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, bob)
      assert(first.ok === true && second.ok === true, 'start failed')
      if (first.ok && second.ok) {
        assert(first.friendshipId === second.friendshipId, 'duplicate conversation created on repeat start')
      }
    })

    await check('[9] concurrent-style requests do not create duplicates (unique partial index)', () => {
      const dave = registerHuman('dave@example.test', 'Dave')
      // Node:sqlite е синхронен — симулираме "състезание" чрез директен
      // duplicate INSERT опит СЛЕД като getOrCreatePikaSupportConversation
      // вече е създала реда, за да потвърдим, че partial unique index-ът
      // реално отхвърля втори ред за същата двойка.
      const first = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, dave)
      assert(first.ok === true, 'first start failed')

      let threwOnDuplicate = false
      try {
        db!.prepare(`
          INSERT INTO profile_friendships (
            friendship_id, requester_profile_id, addressee_profile_id,
            lower_profile_id, higher_profile_id, status, kind, responded_at
          ) VALUES (?, ?, ?, ?, ?, 'accepted', 'pika_support', CURRENT_TIMESTAMP);
        `).run(
          'forced-duplicate-id',
          OFFICIAL_PROFILE_ID,
          dave,
          OFFICIAL_PROFILE_ID < dave ? OFFICIAL_PROFILE_ID : dave,
          OFFICIAL_PROFILE_ID < dave ? dave : OFFICIAL_PROFILE_ID,
        )
      } catch {
        threwOnDuplicate = true
      }
      assert(threwOnDuplicate, 'unique partial index did not reject a second pika_support row for the same pair')

      // И самата store функция, извикана отново, продължава да намира
      // оригиналния ред (идемпотентност дори "след" опит за race).
      const again = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, dave)
      assert(again.ok === true && again.friendshipId === first.friendshipId, 'race handling produced a different conversation')
    })

    await check('[10] PIKABG viewer sees the chat button eligibility for a non-friend (server-side signal)', () => {
      // Server-side еквивалент на frontend-ната UI видимост: единственият
      // profileId, за който getOrCreatePikaSupportConversation връща ok:true
      // като initiator, е точно OFFICIAL_PROFILE_ID — frontend решава
      // видимостта на бутона по authSession.profile.profileId ===
      // OFFICIAL_PIKA_PROFILE_ID (виж createLobbyFlowController.ts), но
      // authoritative пропуск/отказ е точно тук.
      const eve = registerHuman('eve@example.test', 'Eve')
      const result = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, eve)
      assert(result.ok === true, 'official profile could not start chat with a fresh non-friend')
    })

    await check('[11] other profiles (including pika_team role) cannot trigger the bypass as initiator', () => {
      const frank = registerHuman('frank@example.test', 'Frank')
      const asAlice = chatStore.getOrCreatePikaSupportConversation(alice, frank)
      const asOtherPikaTeam = chatStore.getOrCreatePikaSupportConversation(OTHER_PIKA_TEAM_PROFILE_ID, frank)
      assert(asAlice.ok === false, 'regular profile could act as initiator')
      assert(asOtherPikaTeam.ok === false, 'other pika_team-role profile could act as initiator')
    })

    await check('[12] the conversation snapshot is flagged as pika_support for "Екип Pika.bg" display', () => {
      const conversations = chatStore.listConversations(alice)
      const officialConversation = conversations.find((c) => c.friendshipId === aliceFriendshipId)
      assert(officialConversation !== undefined, 'conversation missing from listConversations')
      assert(officialConversation!.kind === 'pika_support', `kind=${officialConversation!.kind}`)
    })

    await check('[13] unread counter works for the official conversation', () => {
      const grace = registerHuman('grace@example.test', 'Grace')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, grace)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      const sent = chatStore.sendMessage(OFFICIAL_PROFILE_ID, started.friendshipId, 'Здравей от екипа!')
      assert(sent.ok === true, 'send failed')

      const graceConversations = chatStore.listConversations(grace)
      const conversation = graceConversations.find((c) => c.friendshipId === started.friendshipId)
      assert(conversation !== undefined, 'conversation missing for recipient')
      assert(conversation!.unreadCount === 1, `unreadCount=${conversation!.unreadCount}`)

      chatStore.markConversationRead(grace, started.friendshipId)
      const afterRead = chatStore.listConversations(grace)
        .find((c) => c.friendshipId === started.friendshipId)
      assert(afterRead!.unreadCount === 0, `unreadCount after read=${afterRead!.unreadCount}`)
    })

    await check('[14] a conversation with no activity for 12+ months is archived', () => {
      const heidi = registerHuman('heidi@example.test', 'Heidi')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, heidi)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      // Изкуствено "състаряваме" последното обновяване с > 365 дни назад —
      // симулира сървърен timestamp в миналото (не разчитаме на клиентски
      // часовник, виж isConversationArchived в chatStore.ts).
      const oldTimestamp = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)

      const activeList = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(
        !activeList.some((c) => c.friendshipId === started.friendshipId),
        'stale conversation still appears in the active list',
      )

      const archivedList = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, true)
      const archivedEntry = archivedList.find((c) => c.friendshipId === started.friendshipId)
      assert(archivedEntry !== undefined, 'stale conversation missing from includeArchived=true list')
      assert(archivedEntry!.isArchived === true, 'isArchived flag not set')
    })

    await check('[15] a new message brings an archived conversation back to the active list', () => {
      const ivan = registerHuman('ivan@example.test', 'Ivan')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, ivan)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      const oldTimestamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)

      const archivedBefore = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(!archivedBefore.some((c) => c.friendshipId === started.friendshipId), 'conversation not archived before reply')

      // Отговор ОТ получателя (не от PIKABG) също трябва да активира разговора.
      const reply = chatStore.sendMessage(ivan, started.friendshipId, 'Отговарям в стар разговор')
      assert(reply.ok === true, `reply failed: ${reply.ok ? '' : reply.message}`)

      const activeAfter = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(
        activeAfter.some((c) => c.friendshipId === started.friendshipId),
        'conversation did not return to the active list after a new message',
      )
    })

    await check('[16] messages are not deleted when a conversation becomes archived', () => {
      const judy = registerHuman('judy@example.test', 'Judy')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, judy)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      chatStore.sendMessage(OFFICIAL_PROFILE_ID, started.friendshipId, 'Съобщение преди архивиране')

      const oldTimestamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)
      db!.prepare(`UPDATE friend_chat_messages SET created_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)

      const messagesResult = chatStore.listMessages(judy, started.friendshipId)
      assert(messagesResult.ok === true, 'listMessages failed for archived conversation')
      if (messagesResult.ok) {
        assert(messagesResult.messages.length === 1, `expected 1 message, got ${messagesResult.messages.length}`)
      }
    })

    await check('[extra] official conversations never leak into the regular friend-request UI', () => {
      const kevin = registerHuman('kevin@example.test', 'Kevin')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, kevin)
      assert(started.ok === true, 'start failed')

      const kevinFriendships = friendshipStore.listForProfile(kevin)
      assert(
        !kevinFriendships.friends.some((f) => f.friendshipId === (started.ok ? started.friendshipId : '')),
        'pika_support conversation leaked into friends list',
      )
      assert(
        !kevinFriendships.incomingPending.some((f) => f.friendshipId === (started.ok ? started.friendshipId : '')),
        'pika_support conversation leaked into incoming pending list',
      )

      const officialFriendships = friendshipStore.listForProfile(OFFICIAL_PROFILE_ID)
      assert(
        !officialFriendships.friends.some((f) => f.friendshipId === (started.ok ? started.friendshipId : '')),
        'pika_support conversation leaked into official profile friends list',
      )
    })

    await check('[extra] fail-closed: without a configured official profileId, no bypass is possible', () => {
      const laura = registerHuman('laura@example.test', 'Laura')
      const result = chatStoreNoBypass.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, laura)
      assert(result.ok === false, 'bypass worked even though officialPikaProfileId was not configured')
    })

    await check('[extra] self-chat and guest/non-existent recipients are rejected', () => {
      const selfAttempt = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, OFFICIAL_PROFILE_ID)
      assert(selfAttempt.ok === false, 'self-chat was allowed')

      const missingAttempt = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, 'nonexistent-profile-id')
      assert(missingAttempt.ok === false, 'chat with a non-existent profile was allowed')
    })

    await check('[extra] blocked recipients still cannot receive new messages through the official conversation', () => {
      const mallory = registerHuman('mallory@example.test', 'Mallory')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, mallory)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      blockStore.toggleBlock(mallory, OFFICIAL_PROFILE_ID)

      const attempt = chatStore.sendMessage(OFFICIAL_PROFILE_ID, started.friendshipId, 'опит след блокиране')
      assert(attempt.ok === false, 'message was sent despite an active block')
    })

    // ─── Edge case 1: existing kind='friend' friendship + pika_support ──────
    // Table-level UNIQUE(lower,higher) от оригиналната schema би блокирала
    // втори ред за същата двойка независимо от kind — migration-ът замени
    // го с ДВА partial unique indexes (един per kind), за да могат двата
    // records да съществуват едновременно. Виж 20260804_002_....sql.
    await check('[EC1-a] PIKABG and recipient already have an accepted kind=\'friend\' friendship — starting the official chat still succeeds', () => {
      const nina = registerHuman('nina@example.test', 'Nina')

      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, nina)
      assert(friendRequest.ok === true, `friend request failed: ${friendRequest.ok ? '' : friendRequest.message}`)
      if (!friendRequest.ok) return
      const acceptResult = friendshipStore.acceptRequest(nina, friendRequest.friendshipId)
      assert(acceptResult.ok === true, 'accept failed')

      const officialStart = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, nina)
      assert(officialStart.ok === true, `official chat start failed despite existing friendship: ${officialStart.ok ? '' : officialStart.message}`)
    })

    await check('[EC1-b] the friendship row stays kind=\'friend\' and keeps showing up in the friends list', () => {
      const oscar = registerHuman('oscar@example.test', 'Oscar')
      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, oscar)
      assert(friendRequest.ok === true, 'friend request failed')
      if (!friendRequest.ok) return
      friendshipStore.acceptRequest(oscar, friendRequest.friendshipId)

      chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, oscar)

      const oscarFriendships = friendshipStore.listForProfile(oscar)
      assert(
        oscarFriendships.friends.some((f) => f.friendshipId === friendRequest.friendshipId),
        'the accepted friendship disappeared from the friends list after starting the official chat',
      )

      const row = db!.prepare(`SELECT kind FROM profile_friendships WHERE friendship_id = ?`)
        .get(friendRequest.friendshipId) as { kind: string } | undefined
      assert(row !== undefined && row.kind === 'friend', `friendship row kind mutated: ${row?.kind}`)
    })

    await check('[EC1-c] the official conversation is a separate row (different friendshipId, kind=\'pika_support\')', () => {
      const paul = registerHuman('paul@example.test', 'Paul')
      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, paul)
      assert(friendRequest.ok === true, 'friend request failed')
      if (!friendRequest.ok) return
      friendshipStore.acceptRequest(paul, friendRequest.friendshipId)

      const officialStart = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, paul)
      assert(officialStart.ok === true, 'official chat start failed')
      if (!officialStart.ok) return

      assert(
        officialStart.friendshipId !== friendRequest.friendshipId,
        'the official conversation reused the friendship row id instead of creating a separate row',
      )
      assert(officialStart.conversation.kind === 'pika_support', `kind=${officialStart.conversation.kind}`)

      const rows = db!.prepare(`
        SELECT friendship_id, kind FROM profile_friendships
        WHERE (lower_profile_id = ? AND higher_profile_id = ?)
           OR (lower_profile_id = ? AND higher_profile_id = ?)
      `).all(
        OFFICIAL_PROFILE_ID < paul ? OFFICIAL_PROFILE_ID : paul,
        OFFICIAL_PROFILE_ID < paul ? paul : OFFICIAL_PROFILE_ID,
        OFFICIAL_PROFILE_ID < paul ? OFFICIAL_PROFILE_ID : paul,
        OFFICIAL_PROFILE_ID < paul ? paul : OFFICIAL_PROFILE_ID,
      ) as Array<{ friendship_id: string; kind: string }>
      assert(rows.length === 2, `expected exactly 2 rows (friend + pika_support) for the pair, got ${rows.length}`)
      assert(rows.some((r) => r.kind === 'friend'), 'friend row missing')
      assert(rows.some((r) => r.kind === 'pika_support'), 'pika_support row missing')
    })

    await check('[EC1-d] the two conversations do not share message history', () => {
      const quinn = registerHuman('quinn@example.test', 'Quinn')
      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, quinn)
      assert(friendRequest.ok === true, 'friend request failed')
      if (!friendRequest.ok) return
      friendshipStore.acceptRequest(quinn, friendRequest.friendshipId)

      const officialStart = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, quinn)
      assert(officialStart.ok === true, 'official chat start failed')
      if (!officialStart.ok) return

      const friendMsg = chatStore.sendMessage(quinn, friendRequest.friendshipId, 'Здравей като приятел')
      assert(friendMsg.ok === true, `friend message failed: ${friendMsg.ok ? '' : friendMsg.message}`)
      const officialMsg = chatStore.sendMessage(OFFICIAL_PROFILE_ID, officialStart.friendshipId, 'Здравей от екипа')
      assert(officialMsg.ok === true, `official message failed: ${officialMsg.ok ? '' : officialMsg.message}`)

      const friendMessages = chatStore.listMessages(quinn, friendRequest.friendshipId)
      const officialMessages = chatStore.listMessages(quinn, officialStart.friendshipId)
      assert(friendMessages.ok === true && officialMessages.ok === true, 'listMessages failed')
      if (!friendMessages.ok || !officialMessages.ok) return

      assert(friendMessages.messages.length === 1, `friend conversation should have 1 message, got ${friendMessages.messages.length}`)
      assert(officialMessages.messages.length === 1, `official conversation should have 1 message, got ${officialMessages.messages.length}`)
      assert(friendMessages.messages[0].body === 'Здравей като приятел', 'friend conversation shows wrong body')
      assert(officialMessages.messages[0].body === 'Здравей от екипа', 'official conversation shows wrong body')
    })

    await check('[EC1-e] starting again finds the same pika_support conversation even with an existing friendship, and creates no duplicate', () => {
      const rachel = registerHuman('rachel@example.test', 'Rachel')
      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, rachel)
      assert(friendRequest.ok === true, 'friend request failed')
      if (!friendRequest.ok) return
      friendshipStore.acceptRequest(rachel, friendRequest.friendshipId)

      const first = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, rachel)
      const second = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, rachel)
      assert(first.ok === true && second.ok === true, 'start failed')
      if (!first.ok || !second.ok) return
      assert(first.friendshipId === second.friendshipId, 'repeat start created a different pika_support row')

      const countRow = db!.prepare(`
        SELECT COUNT(*) as cnt FROM profile_friendships
        WHERE kind = 'pika_support'
          AND (requester_profile_id = ? OR addressee_profile_id = ?)
          AND (requester_profile_id = ? OR addressee_profile_id = ?)
      `).get(OFFICIAL_PROFILE_ID, OFFICIAL_PROFILE_ID, rachel, rachel) as { cnt: number }
      assert(countRow.cnt === 1, `expected exactly 1 pika_support row for the pair, got ${countRow.cnt}`)
    })

    // ─── Edge case 2: archive scope is pika_support-only ────────────────────
    await check('[EC2-a] a pika_support conversation with no activity for 12+ months is archived', () => {
      const sam = registerHuman('sam@example.test', 'Sam')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, sam)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      const oldTimestamp = new Date(Date.now() - 380 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)

      const active = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(!active.some((c) => c.friendshipId === started.friendshipId), 'stale pika_support conversation still in active list')

      const archived = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, true)
      const entry = archived.find((c) => c.friendshipId === started.friendshipId)
      assert(entry !== undefined && entry.isArchived === true, 'stale pika_support conversation not flagged as archived')
    })

    await check('[EC2-b] a pika_support conversation under 12 months stays active', () => {
      const tina = registerHuman('tina@example.test', 'Tina')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, tina)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      const recentTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(recentTimestamp, started.friendshipId)

      const active = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      const entry = active.find((c) => c.friendshipId === started.friendshipId)
      assert(entry !== undefined, 'recent pika_support conversation missing from active list')
      assert(entry!.isArchived === false, 'recent pika_support conversation incorrectly flagged as archived')
    })

    await check('[EC2-c] an old kind=\'friend\' conversation is NOT auto-archived by this feature', () => {
      const uma = registerHuman('uma@example.test', 'Uma')
      const friendRequest = friendshipStore.sendRequest(OFFICIAL_PROFILE_ID, uma)
      assert(friendRequest.ok === true, 'friend request failed')
      if (!friendRequest.ok) return
      friendshipStore.acceptRequest(uma, friendRequest.friendshipId)

      // "Активирай" разговора чрез съобщение, после го "състаряваме" — точно
      // както при [EC2-a], но за обикновено приятелство. isArchived е
      // изчислена и връщана и за kind='friend' в снапшота (derived поле, не
      // отделен bypass), но задачата тук изисква тя ДА НЕ бъде използвана за
      // да скрие приятелски разговори от нормалния списък автоматично.
      chatStore.sendMessage(uma, friendRequest.friendshipId, 'Здравей отдавна')
      const oldTimestamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, friendRequest.friendshipId)
      db!.prepare(`UPDATE friend_chat_messages SET created_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, friendRequest.friendshipId)

      const active = chatStore.listConversations(uma, undefined, false)
      assert(
        active.some((c) => c.friendshipId === friendRequest.friendshipId),
        'an old kind=\'friend\' conversation was hidden from the normal active list — archiving must stay pika_support-only for this feature',
      )
    })

    await check('[EC2-d] archived=1 does not leak other profiles\' conversations', () => {
      const victor = registerHuman('victor@example.test', 'Victor')
      const wendy = registerHuman('wendy@example.test', 'Wendy')
      const startedVictor = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, victor)
      const startedWendy = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, wendy)
      assert(startedVictor.ok === true && startedWendy.ok === true, 'start failed')
      if (!startedVictor.ok || !startedWendy.ok) return

      const oldTimestamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id IN (?, ?)`)
        .run(oldTimestamp, startedVictor.friendshipId, startedWendy.friendshipId)

      const victorArchived = chatStore.listConversations(victor, undefined, true)
      assert(
        victorArchived.some((c) => c.friendshipId === startedVictor.friendshipId),
        'victor cannot see his own archived conversation',
      )
      assert(
        !victorArchived.some((c) => c.friendshipId === startedWendy.friendshipId),
        'victor can see wendy\'s archived conversation — cross-profile leak',
      )
    })

    await check('[EC2-e] a new message in an archived pika_support conversation returns it to active, without deleting history', () => {
      const xander = registerHuman('xander@example.test', 'Xander')
      const started = chatStore.getOrCreatePikaSupportConversation(OFFICIAL_PROFILE_ID, xander)
      assert(started.ok === true, 'start failed')
      if (!started.ok) return

      chatStore.sendMessage(OFFICIAL_PROFILE_ID, started.friendshipId, 'Старо съобщение преди архивиране')
      const oldTimestamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      db!.prepare(`UPDATE profile_friendships SET updated_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)
      db!.prepare(`UPDATE friend_chat_messages SET created_at = ? WHERE friendship_id = ?`)
        .run(oldTimestamp, started.friendshipId)

      const beforeReply = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(!beforeReply.some((c) => c.friendshipId === started.friendshipId), 'conversation not archived before reply')

      const reply = chatStore.sendMessage(xander, started.friendshipId, 'Отговор в архивиран служебен чат')
      assert(reply.ok === true, `reply failed: ${reply.ok ? '' : reply.message}`)

      const afterReply = chatStore.listConversations(OFFICIAL_PROFILE_ID, undefined, false)
      assert(
        afterReply.some((c) => c.friendshipId === started.friendshipId),
        'archived pika_support conversation did not return to the active list after a new message',
      )

      const messages = chatStore.listMessages(xander, started.friendshipId)
      assert(messages.ok === true, 'listMessages failed')
      if (messages.ok) {
        assert(messages.messages.length === 2, `expected 2 messages (old + reply), got ${messages.messages.length}`)
      }
    })

    progressStore.close()
    authStore.close()
    friendshipStore.close()
    blockStore.close()
    chatStore.close()
    chatStoreNoBypass.close()
  } finally {
    db?.close()
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log(`\nOfficial Pika support chat checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
