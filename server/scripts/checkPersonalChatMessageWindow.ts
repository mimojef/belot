import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  createChatStore,
  PERSONAL_CHAT_HISTORY_LIMIT,
  PERSONAL_CHAT_STORAGE_LIMIT,
  type ChatMessageSnapshot,
} from '../src/db/chatStore.ts'
import type { PlayerPublicProfileSnapshot, ProfileId } from '../src/core/serverTypes.ts'
import type { PlayerProgressStore } from '../src/db/playerProgressStore.ts'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitForCondition(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

function makeProfile(profileId: ProfileId): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName: profileId,
    avatarUrl: null,
    level: 1,
    rankTitle: null,
    skillRating: null,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: null,
    nextRankGames: null,
    gamesUntilNextRank: null,
    rankProgressRatio: null,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: 0,
    galleryImages: [],
    gender: null,
    likesCount: 0,
    hasLikedByMe: false,
    isBlockedByMe: false,
  }
}

function createFakeProgressStore(): PlayerProgressStore {
  return {
    getPublicProfile: (profileId: ProfileId) => makeProfile(profileId),
  } as PlayerProgressStore
}

async function createStoreFixture() {
  const sqliteModule = await import('node:sqlite')
  const dir = await mkdtemp(join(tmpdir(), 'belot-personal-chat-store-'))
  const databaseFile = join(dir, 'chat.sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFile, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE profile_friendships (
      friendship_id TEXT PRIMARY KEY,
      requester_profile_id TEXT NOT NULL,
      addressee_profile_id TEXT NOT NULL,
      lower_profile_id TEXT NOT NULL,
      higher_profile_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT NULL
    );

    CREATE TABLE friend_chat_messages (
      message_id TEXT PRIMARY KEY,
      friendship_id TEXT NOT NULL,
      sender_profile_id TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) <= 1000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT NULL,
      FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE
    );

    CREATE INDEX idx_friend_chat_messages_friendship
      ON friend_chat_messages(friendship_id, created_at);

    CREATE TABLE friend_chat_attachments (
      message_id TEXT PRIMARY KEY REFERENCES friend_chat_messages(message_id) ON DELETE CASCADE,
      storage_filename TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX idx_friend_chat_attachments_filename
      ON friend_chat_attachments(storage_filename);

    CREATE TABLE friend_chat_attachment_deletions (
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      storage_filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending', 'done', 'failed'))
    );

    CREATE TABLE chat_conversation_reads (
      profile_id TEXT NOT NULL,
      friendship_id TEXT NOT NULL,
      last_read_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, friendship_id)
    );
  `)
  database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', ?);
  `).run('friendship-a', 'profile-a', 'profile-b', 'profile-a', 'profile-b', '2020-01-01 00:00:00')
  database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', ?);
  `).run('friendship-b', 'profile-a', 'profile-c', 'profile-a', 'profile-c', '2020-01-01 00:00:00')

  const store = await createChatStore(databaseFile, createFakeProgressStore(), { isBlocked: () => false })
  return {
    database,
    store,
    cleanup: async () => {
      store.close()
      database.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function seedMessages(
  database: SqliteDatabase,
  friendshipId: string,
  count: number,
  options: { prefix?: string; senderProfileId?: string; sameCreatedAt?: boolean; startIndex?: number } = {},
): void {
  const prefix = options.prefix ?? 'msg'
  const senderProfileId = options.senderProfileId ?? 'profile-b'
  const startIndex = options.startIndex ?? 1
  const insert = database.prepare(`
    INSERT INTO friend_chat_messages (
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    ) VALUES (?, ?, ?, ?, ?);
  `)

  for (let index = 0; index < count; index++) {
    const n = startIndex + index
    const suffix = String(n).padStart(3, '0')
    const createdAt = options.sameCreatedAt
      ? '2020-01-01 10:00:00'
      : `2020-01-01 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
    insert.run(`${prefix}-${suffix}`, friendshipId, senderProfileId, `${prefix}-${suffix}`, createdAt)
  }
}

function messageBodies(messages: ChatMessageSnapshot[]): string[] {
  return messages.map((message) => message.body)
}

async function runStoreRegressionChecks(): Promise<void> {
  await check('[S1] listMessages returns 0/1/99/100 messages in chronological order', async () => {
    for (const count of [0, 1, 99, 100]) {
      const fixture = await createStoreFixture()
      try {
        seedMessages(fixture.database, 'friendship-a', count)
        const result = fixture.store.listMessages('profile-a', 'friendship-a')
        assert(result.ok, `listMessages failed for count=${count}`)
        assertEqual(result.messages.length, count, `length for count=${count}`)
        if (count > 0) {
          assertEqual(result.messages[0].body, 'msg-001', `first body for count=${count}`)
          assertEqual(result.messages[count - 1].body, `msg-${String(count).padStart(3, '0')}`, `last body for count=${count}`)
        }
      } finally {
        await fixture.cleanup()
      }
    }
  })

  await check('[S2] listMessages with 101 stored rows returns messages 2-101, oldest-to-newest', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', 101)
      const result = fixture.store.listMessages('profile-a', 'friendship-a')
      assert(result.ok, 'listMessages failed')
      assertEqual(result.messages.length, PERSONAL_CHAT_HISTORY_LIMIT, 'history length')
      assertEqual(result.messages[0].body, 'msg-002', 'first visible body')
      assertEqual(result.messages[99].body, 'msg-101', 'last visible body')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S3] equal created_at rows use rowid as stable secondary order', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', 101, { prefix: 'tie', sameCreatedAt: true })
      const result = fixture.store.listMessages('profile-a', 'friendship-a')
      assert(result.ok, 'listMessages failed')
      assertEqual(result.messages.length, PERSONAL_CHAT_HISTORY_LIMIT, 'history length')
      assertEqual(result.messages[0].body, 'tie-002', 'first stable body')
      assertEqual(result.messages[99].body, 'tie-101', 'last stable body')
      assertEqual(messageBodies(result.messages).join(','), Array.from({ length: 100 }, (_, i) => `tie-${String(i + 2).padStart(3, '0')}`).join(','), 'stable body sequence')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S4] sendMessage after 100 existing rows returns the inserted message id and latest 100 history', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', 100)
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', 'unique-101')
      assert(result.ok, 'sendMessage failed')
      assertEqual(result.newMessage.body, 'unique-101', 'newMessage body')
      assert(result.messages.some((message) => message.messageId === result.newMessage.messageId), 'latest history includes inserted message')
      assertEqual(result.messages[0].body, 'msg-002', 'first visible after send')
      assertEqual(result.messages[99].messageId, result.newMessage.messageId, 'last visible is inserted message')
      const row = fixture.database.prepare('SELECT body FROM friend_chat_messages WHERE message_id = ?').get(result.newMessage.messageId) as { body: string } | undefined
      assertEqual(row?.body, 'unique-101', 'inserted DB body')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S5] storage pruning keeps 500 rows and never deletes the new message', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', PERSONAL_CHAT_STORAGE_LIMIT)
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', 'unique-501')
      assert(result.ok, 'sendMessage failed')
      const count = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE friendship_id = ?').get('friendship-a') as { count: number }
      assertEqual(count.count, PERSONAL_CHAT_STORAGE_LIMIT, 'stored row count')
      const oldest = fixture.database.prepare('SELECT body FROM friend_chat_messages WHERE friendship_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1').get('friendship-a') as { body: string }
      assertEqual(oldest.body, 'msg-002', 'oldest retained body')
      const inserted = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE message_id = ?').get(result.newMessage.messageId) as { count: number }
      assertEqual(inserted.count, 1, 'inserted row retained')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S6] pruning one friendship does not affect another friendship', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', PERSONAL_CHAT_STORAGE_LIMIT)
      seedMessages(fixture.database, 'friendship-b', 3, { prefix: 'other', senderProfileId: 'profile-c' })
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', 'unique-501')
      assert(result.ok, 'sendMessage failed')
      const countA = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE friendship_id = ?').get('friendship-a') as { count: number }
      const countB = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE friendship_id = ?').get('friendship-b') as { count: number }
      assertEqual(countA.count, PERSONAL_CHAT_STORAGE_LIMIT, 'friendship-a count')
      assertEqual(countB.count, 3, 'friendship-b count')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S7] endpoint history window remains latest 100 from the stored 500 rows', async () => {
    const fixture = await createStoreFixture()
    try {
      seedMessages(fixture.database, 'friendship-a', PERSONAL_CHAT_STORAGE_LIMIT)
      const result = fixture.store.listMessages('profile-a', 'friendship-a')
      assert(result.ok, 'listMessages failed')
      assertEqual(result.messages.length, PERSONAL_CHAT_HISTORY_LIMIT, 'history length')
      assertEqual(result.messages[0].body, 'msg-401', 'first visible body')
      assertEqual(result.messages[99].body, 'msg-500', 'last visible body')
    } finally {
      await fixture.cleanup()
    }
  })

  // Инвариантът "text ИЛИ attachment задължителни" е application-level (JS
  // if в chatStore.sendMessage), НЕ SQLite CHECK/trigger — migration-ът
  // 20260729_001 разхлаби body CHECK-а до length(body) <= 1000 (позволява
  // '' на DB ниво), затова тук викаме production store API директно
  // (fixture.store.sendMessage — не HTTP mock), за да докажем, че
  // единственият production write path налага инварианта коректно.
  await check('[S8] sendMessage отхвърля body="" без attachment (application-level guard, не DB constraint)', async () => {
    const fixture = await createStoreFixture()
    try {
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', '')
      assert(!result.ok, 'sendMessage трябва да отхвърли празно body без attachment')
      const count = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages').get() as { count: number }
      assertEqual(count.count, 0, 'не трябва да е записан никакъв ред при отхвърлено съобщение')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S9] sendMessage приема body="" КОГАТО има attachment (текст не е задължителен при снимка)', async () => {
    const fixture = await createStoreFixture()
    try {
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', '', {
        storageFilename: `${randomUUID()}.webp`,
        width: 100,
        height: 80,
        byteSize: 12345,
        contentType: 'image/webp',
      })
      assert(result.ok, `sendMessage с attachment трябва да успее: ${!result.ok ? result.message : ''}`)
      if (result.ok) {
        assertEqual(result.newMessage.body, '', 'body остава празен')
        assert(result.newMessage.attachment !== null, 'attachment трябва да е зададен')
      }
      const dbRow = fixture.database.prepare(
        'SELECT m.body, a.storage_filename FROM friend_chat_messages m JOIN friend_chat_attachments a ON a.message_id = m.message_id',
      ).get() as { body: string; storage_filename: string } | undefined
      assert(dbRow !== undefined, 'DB трябва да съдържа message+attachment ред')
      assertEqual(dbRow?.body, '', 'DB body е празен')
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S10] sendMessage продължава да приема текст-само (без attachment) — регресия след migration-а', async () => {
    const fixture = await createStoreFixture()
    try {
      const result = fixture.store.sendMessage('profile-a', 'friendship-a', 'здравей')
      assert(result.ok, 'text-only sendMessage трябва да успее')
      if (result.ok) {
        assertEqual(result.newMessage.body, 'здравей', 'body запазен')
        assertEqual(result.newMessage.attachment, null, 'няма attachment за текстово съобщение')
      }
    } finally {
      await fixture.cleanup()
    }
  })

  await check('[S11] Attachment INSERT failure (UNIQUE storage_filename collision) rollback-ва и message insert-а — не остава ред без attachment', async () => {
    const fixture = await createStoreFixture()
    try {
      const collidingFilename = `${randomUUID()}.webp`
      // Пресяваме съществуващ ред с този filename директно в DB (симулира
      // теоретична колизия — randomUUID() прави това практически невъзможно
      // в production, но тестваме defensive поведението на транзакцията).
      const seedResult = fixture.store.sendMessage('profile-a', 'friendship-a', '', {
        storageFilename: collidingFilename, width: 10, height: 10, byteSize: 100, contentType: 'image/webp',
      })
      assert(seedResult.ok, 'seed sendMessage трябва да успее')

      let threw = false
      try {
        fixture.store.sendMessage('profile-a', 'friendship-a', '', {
          storageFilename: collidingFilename, width: 20, height: 20, byteSize: 200, contentType: 'image/webp',
        })
      } catch {
        threw = true
      }
      assert(threw, 'втори sendMessage със същия storage_filename трябва да хвърли грешка (UNIQUE constraint)')

      const messageCount = fixture.database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages').get() as { count: number }
      assertEqual(messageCount.count, 1, 'само първото (успешно) съобщение трябва да е записано — вторият опит е изцяло rollback-нат')

      const orphanBodyRows = fixture.database.prepare(
        `SELECT m.message_id FROM friend_chat_messages m
         LEFT JOIN friend_chat_attachments a ON a.message_id = m.message_id
         WHERE trim(m.body) = '' AND a.message_id IS NULL`,
      ).all() as { message_id: string }[]
      assertEqual(orphanBodyRows.length, 0, 'не трябва да съществува ред с празен body и без attachment')
    } finally {
      await fixture.cleanup()
    }
  })
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-personal-chat-http-'))
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
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = {
  child: ChildProcessWithoutNullStreams
  output: () => string
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.on('data', (chunk) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      server.child.kill('SIGKILL')
      resolveStop()
    }, 10_000)
    server.child.once('exit', () => {
      clearTimeout(timeout)
      resolveStop()
    })
  })
}

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('No TCP port was assigned.'))
        return
      }
      srv.close(() => resolveFree(address.port))
    })
  })
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie !== null ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookie = (headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0] ?? null
  let responseBody: any = null
  try {
    responseBody = await response.json()
  } catch {
    responseBody = null
  }
  return { status: response.status, body: responseBody, setCookie }
}

function openProfileWebSocket(port: number, cookie: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try {
      frames.push(JSON.parse(data.toString()))
    } catch {
      // Ignore non-JSON frames.
    }
  })
  return new Promise((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen({ ws, frames }))
    ws.once('error', reject)
  })
}

function insertHttpSeedMessages(
  database: SqliteDatabase,
  friendshipId: string,
  senderProfileId: string,
  count: number,
  options: { prefix?: string; startIndex?: number } = {},
): void {
  const prefix = options.prefix ?? 'seed'
  const startIndex = options.startIndex ?? 1
  const insert = database.prepare(`
    INSERT INTO friend_chat_messages (
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    ) VALUES (?, ?, ?, ?, ?);
  `)
  for (let index = 0; index < count; index++) {
    const n = startIndex + index
    const suffix = String(n).padStart(3, '0')
    const createdAt = `2020-01-01 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
    insert.run(`${prefix}-${suffix}`, friendshipId, senderProfileId, `${prefix}-${suffix}`, createdAt)
  }
}

async function runSpawnedServerRegressionCheck(): Promise<void> {
  let server: RunningServer | null = null
  const isolated = await createIsolatedServerRoot(sourceServerRoot)

  try {
    const sqliteModule = await import('node:sqlite')
    const port = await findFreePort()
    server = startServer(isolated.serverDir, port)

    try {
      await waitForCondition('server health', async () => {
        try {
          const response = await fetch(`http://localhost:${port}/health`)
          const body = await response.json()
          return response.status === 200 && body.ok === true
        } catch {
          return false
        }
      }, 30_000)
    } catch (error) {
      console.error('--- spawned server output ---')
      console.error(server.output())
      throw error
    }

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const registerA = await httpJson(port, 'POST', '/api/auth/register', null, {
      email: `chat-window-a-${runId}@example.test`,
      password: 'ChatWindow1!',
      displayName: 'ChatWindowA',
      gender: 'male',
    })
    assertEqual(registerA.status, 200, `register A response ${JSON.stringify(registerA.body)}`)
    const registerB = await httpJson(port, 'POST', '/api/auth/register', null, {
      email: `chat-window-b-${runId}@example.test`,
      password: 'ChatWindow1!',
      displayName: 'ChatWindowB',
      gender: 'female',
    })
    assertEqual(registerB.status, 200, `register B response ${JSON.stringify(registerB.body)}`)

    const cookieA = registerA.setCookie
    const cookieB = registerB.setCookie
    assert(cookieA !== null, 'missing cookie A')
    assert(cookieB !== null, 'missing cookie B')
    const profileA = registerA.body.session.profile.profileId as string
    const profileB = registerB.body.session.profile.profileId as string
    const lowerProfileId = [profileA, profileB].sort()[0]
    const higherProfileId = [profileA, profileB].sort()[1]
    const friendshipId = `chat-window-friendship-${runId}`

    const database: SqliteDatabase = new sqliteModule.DatabaseSync(isolated.databaseFile, {
      open: true,
      enableForeignKeyConstraints: true,
    })
    try {
      database.prepare(`
        INSERT INTO profile_friendships (
          friendship_id,
          requester_profile_id,
          addressee_profile_id,
          lower_profile_id,
          higher_profile_id,
          status,
          responded_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `).run(friendshipId, profileA, profileB, lowerProfileId, higherProfileId)
      insertHttpSeedMessages(database, friendshipId, profileB, 100)

      const wsA = await openProfileWebSocket(port, cookieA)
      const wsB = await openProfileWebSocket(port, cookieB)
      try {
        const marker101 = `unique-101-${runId}`
        const post101 = await httpJson(
          port,
          'POST',
          `/api/chat/${encodeURIComponent(friendshipId)}/messages`,
          cookieA,
          { body: marker101 },
        )

        assertEqual(post101.status, 200, `POST 101 status/body ${JSON.stringify(post101.body)}`)
        assert(post101.body?.ok === true, 'POST 101 ok=true')
        assert(post101.body.newMessage, 'POST 101 includes newMessage')
        assertEqual(post101.body.newMessage.body, marker101, 'POST 101 newMessage body')
        assertEqual(post101.body.messages.length, PERSONAL_CHAT_HISTORY_LIMIT, 'POST 101 history length')
        assertEqual(post101.body.messages[0].body, 'seed-002', 'POST 101 first visible body')
        assertEqual(post101.body.messages[99].messageId, post101.body.newMessage.messageId, 'POST 101 last visible is newMessage')
        assertEqual(post101.body.messages.filter((message: ChatMessageSnapshot) => message.messageId === post101.body.newMessage.messageId).length, 1, 'POST 101 no duplicate in response')

        const db101 = database.prepare('SELECT message_id, body FROM friend_chat_messages WHERE body = ?').get(marker101) as { message_id: string; body: string } | undefined
        assert(db101, 'DB contains marker101')
        assertEqual(db101.message_id, post101.body.newMessage.messageId, 'DB id equals HTTP newMessage id')

        await waitForCondition(
          'recipient receives chat_message_received for real 101st id',
          () => wsB.frames.some((frame) => frame.type === 'chat_message_received' && frame.messageId === post101.body.newMessage.messageId),
          5_000,
        )
        const recipientFrame101 = wsB.frames.find((frame) => frame.type === 'chat_message_received' && frame.messageId === post101.body.newMessage.messageId)
        assertEqual(recipientFrame101.friendshipId, friendshipId, 'recipient WS friendshipId')
        assertEqual(recipientFrame101.senderProfileId, profileA, 'recipient WS sender profile')
        assert(!wsA.frames.some((frame) => frame.type === 'chat_message_received' && frame.messageId === post101.body.newMessage.messageId), 'sender does not receive a duplicate chat_message_received echo')

        const getA101 = await httpJson(port, 'GET', `/api/chat/${encodeURIComponent(friendshipId)}/messages`, cookieA)
        const getB101 = await httpJson(port, 'GET', `/api/chat/${encodeURIComponent(friendshipId)}/messages`, cookieB)
        assertEqual(getA101.status, 200, `GET A 101 status/body ${JSON.stringify(getA101.body)}`)
        assertEqual(getB101.status, 200, `GET B 101 status/body ${JSON.stringify(getB101.body)}`)
        assert(getA101.body.messages.some((message: ChatMessageSnapshot) => message.messageId === post101.body.newMessage.messageId), 'GET A includes marker101')
        assert(getB101.body.messages.some((message: ChatMessageSnapshot) => message.messageId === post101.body.newMessage.messageId), 'GET B includes marker101')
        assertEqual(getA101.body.messages[0].body, 'seed-002', 'GET A first visible after 101')
        assertEqual(getB101.body.messages[0].body, 'seed-002', 'GET B first visible after 101')

        insertHttpSeedMessages(database, friendshipId, profileB, 399, { prefix: 'bulk', startIndex: 102 })
        const marker501 = `unique-501-${runId}`
        const post501 = await httpJson(
          port,
          'POST',
          `/api/chat/${encodeURIComponent(friendshipId)}/messages`,
          cookieA,
          { body: marker501 },
        )
        assertEqual(post501.status, 200, `POST 501 status/body ${JSON.stringify(post501.body)}`)
        assert(post501.body?.newMessage, 'POST 501 includes newMessage')
        assertEqual(post501.body.newMessage.body, marker501, 'POST 501 newMessage body')

        const totalRows = database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE friendship_id = ?').get(friendshipId) as { count: number }
        assertEqual(totalRows.count, PERSONAL_CHAT_STORAGE_LIMIT, 'DB row count after 501st send')
        const prunedSeed1 = database.prepare('SELECT COUNT(*) AS count FROM friend_chat_messages WHERE friendship_id = ? AND body = ?').get(friendshipId, 'seed-001') as { count: number }
        assertEqual(prunedSeed1.count, 0, 'oldest row pruned after 501st send')
        const db501 = database.prepare('SELECT message_id FROM friend_chat_messages WHERE body = ?').get(marker501) as { message_id: string } | undefined
        assert(db501, 'DB contains marker501')
        assertEqual(db501.message_id, post501.body.newMessage.messageId, 'DB id equals HTTP 501 newMessage id')

        await waitForCondition(
          'recipient receives chat_message_received for real 501st id',
          () => wsB.frames.some((frame) => frame.type === 'chat_message_received' && frame.messageId === post501.body.newMessage.messageId),
          5_000,
        )
        const refreshB = await httpJson(port, 'GET', `/api/chat/${encodeURIComponent(friendshipId)}/messages`, cookieB)
        assertEqual(refreshB.status, 200, `refresh GET B status/body ${JSON.stringify(refreshB.body)}`)
        assert(refreshB.body.messages.some((message: ChatMessageSnapshot) => message.messageId === post501.body.newMessage.messageId), 'refresh GET B includes marker501')
        assertEqual(refreshB.body.messages.length, PERSONAL_CHAT_HISTORY_LIMIT, 'refresh GET B latest 100 length')
      } finally {
        wsA.ws.close()
        wsB.ws.close()
      }
    } finally {
      database.close()
    }
  } finally {
    await stopServer(server)
    await isolated.cleanup()
  }
}

console.log('\ncheckPersonalChatMessageWindow\n')

await runStoreRegressionChecks()
await check('[H1] spawned server two-client HTTP+WS uses the real inserted id and latest windows', runSpawnedServerRegressionCheck)

console.log(`\nResult: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
