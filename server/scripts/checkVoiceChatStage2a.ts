/**
 * checkVoiceChatStage2a.ts
 *
 * Гласов чат, Етап 2а — миграция 20261112_001, voiceChatFeatureFlag,
 * voiceChatEligibility (пълна матрица), voiceRoomNaming, voiceChatStore
 * (режим/лимит/одит, атомарни слотове, генерации, grace, reconcile),
 * voiceTableReleaseQueue и административното API. Само изолирани temp
 * SQLite бази с реалните миграции — никога production/dev базата.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceChatStage2a.ts --server-root=.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createVoiceChatAdminRequestHandler, type VoiceChatAdminApiDeps } from '../src/voice/voiceChatAdminApi.js'
import {
  evaluateVoiceAccess,
  evaluateVoiceTableCreation,
  isVoiceSessionBindingCurrent,
  resolveRevocationRotation,
  shouldRecordSpeakingGrant,
  toVoiceLiveKitPermissionProfile,
  type VoiceAccessDecision,
  type VoiceAccessInput,
  type VoiceTableFacts,
} from '../src/voice/voiceChatEligibility.js'
import {
  VOICE_CHAT_LIVEKIT_ENV_NAMES,
  getVoiceChatLiveKitConfigStatus,
  isVoiceChatEmergencyStopActive,
  resolveEffectiveVoiceChatMode,
} from '../src/voice/voiceChatFeatureFlag.js'
import { createVoiceChatStore, type VoiceChatStore } from '../src/voice/voiceChatStore.js'
import type { VoiceChatMode, VoiceRelation, VoiceSessionBinding } from '../src/voice/voiceChatTypes.js'
import { VOICE_ROOM_NAME_PREFIX, buildVoiceRoomName, parseVoiceRoomName } from '../src/voice/voiceRoomNaming.js'
import { createVoiceTableReleaseQueue, type VoiceReleaseScheduler } from '../src/voice/voiceTableReleaseQueue.js'

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
    if (text.includes(fragment)) return
    throw new Error(`${message}: грешка без "${fragment}": ${text}`)
  }
  throw new Error(`${message}: не хвърли грешка`)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')
const VOICE_MIGRATION = '20261112_001_create_voice_chat.sql'

console.log('\ncheckVoiceChatStage2a')
console.log(`Server root: ${sourceServerRoot}`)

const tempRoots: string[] = []

async function createTempServerRoot(filter: (name: string) => boolean = () => true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-voice-chat-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.sql' || !filter(entry.name)) continue
    await cp(join(sourceMigrationsDirectoryPath, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  return root
}

const sqliteModule = await import('node:sqlite')
type SqliteDatabase = InstanceType<typeof sqliteModule.DatabaseSync>

const mainRoot = await createTempServerRoot()
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: mainRoot })
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON;')

const T0 = new Date('2027-03-01T10:00:00.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

function seedProfile(name: string): string {
  const profileId = randomUUID()
  const accountId = randomUUID()
  db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
  db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human');`).run(
    profileId, accountId, name, `${name.toLowerCase()}-${profileId.slice(0, 8)}`,
  )
  return profileId
}

const storesToClose: VoiceChatStore[] = []
const storePaths = new WeakMap<VoiceChatStore, string>()
async function openStore(path = databaseFilePath, busyTimeoutMs?: number): Promise<VoiceChatStore> {
  const store = await createVoiceChatStore(path, busyTimeoutMs === undefined ? {} : { busyTimeoutMs })
  storesToClose.push(store)
  storePaths.set(store, path)
  return store
}

/** Нова изолирана база (за тестове, които искат празно състояние). */
async function freshDatabase(): Promise<{ path: string; raw: SqliteDatabase; store: VoiceChatStore }> {
  const root = await createTempServerRoot()
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  raw.exec('PRAGMA foreign_keys = ON;')
  rawToClose.push(raw)
  return { path, raw, store: await openStore(path) }
}
const rawToClose: SqliteDatabase[] = []

function forceMode(store: VoiceChatStore, mode: VoiceChatMode): void {
  const result = store.setMode(mode, { profileId: null }, at(0))
  assert(result.ok, `setMode(${mode})`)
}

try {
  // ═══ [M] Миграция ═══════════════════════════════════════════════════════
  await check('[M1] Миграцията създава 4-те таблици и индексите', () => {
    for (const table of ['voice_chat_admin_changes', 'voice_tables', 'voice_room_generations', 'voice_speaking_grants']) {
      assert(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`).get(table) !== undefined, table)
    }
    for (const index of [
      'idx_voice_tables_active',
      'idx_voice_tables_active_private_room',
      'idx_voice_tables_active_server_room',
      'idx_voice_room_generations_one_live',
      'idx_voice_room_generations_pending',
      'idx_voice_chat_admin_changes_setting_changed_at',
    ]) {
      assert(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?;`).get(index) !== undefined, index)
    }
    assert(db.prepare(`SELECT 1 FROM server_migrations WHERE filename = ?;`).get(VOICE_MIGRATION) !== undefined, 'ledger ред')
  })

  await check('[M2] Добавяща миграция: върху база с всички предишни миграции + данни; повторен старт я пропуска', async () => {
    const root = await createTempServerRoot((name) => name !== VOICE_MIGRATION)
    const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
    const before = new sqliteModule.DatabaseSync(path, { open: true })
    const tablesBefore = Number((before.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table';`).get() as { c: number }).c)
    before.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('probe_key', 'probe');`).run()
    before.close()
    await cp(join(sourceMigrationsDirectoryPath, VOICE_MIGRATION), join(root, 'database', 'migrations', VOICE_MIGRATION))
    const applied = await ensureServerDatabaseReady({ serverRootOverride: root })
    assertEqual(applied.appliedCount, 1, 'само новата миграция')
    const again = await ensureServerDatabaseReady({ serverRootOverride: root })
    assertEqual(again.appliedCount, 0, 'повторен старт')
    const after = new sqliteModule.DatabaseSync(path, { open: true })
    try {
      const tablesAfter = Number((after.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table';`).get() as { c: number }).c)
      assertEqual(tablesAfter, tablesBefore + 4, 'точно 4 нови таблици')
      assertEqual((after.prepare(`SELECT setting_value AS v FROM admin_settings WHERE setting_key = 'probe_key';`).get() as { v: string }).v, 'probe', 'съществуващите данни непипнати')
      assertEqual(Number((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length), 0, 'foreign_key_check')
    } finally {
      after.close()
    }
  })

  await check('[M3] CHECK ограниченията: невалиден режим/лимит, in_game без стая, released без причина', () => {
    assertThrows(() => db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_at) VALUES (?, 'mode', 'on', 'off', 'x');`).run(randomUUID()), 'CHECK', 'невалиден режим')
    assertThrows(() => db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_at) VALUES (?, 'max_tables', '-1', '10', 'x');`).run(randomUUID()), 'CHECK', 'отрицателен лимит')
    assertThrows(() => db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_at) VALUES (?, 'max_tables', '', '10', 'x');`).run(randomUUID()), 'CHECK', 'празен лимит')
    assertThrows(() => db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, created_at) VALUES (?, 'active', 'in_game', 'x');`).run(randomUUID()), 'CHECK', 'in_game без стая')
    assertThrows(() => db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, created_at, released_at) VALUES (?, 'released', 'waiting', 'x', 'y');`).run(randomUUID()), 'CHECK', 'released без причина')
    assertThrows(() => db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, created_at, release_reason) VALUES (?, 'active', 'waiting', 'x', 'r');`).run(randomUUID()), 'CHECK', 'active с причина')
  })

  await check('[M4] Уникални индекси: две активни маси не могат да делят игрова стая/частна маса; освободена може', () => {
    const a = randomUUID()
    const b = randomUUID()
    const serverRoomId = `room-${randomUUID()}`
    db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, server_room_id, created_at, in_game_at) VALUES (?, 'active', 'in_game', ?, 'x', 'y');`).run(a, serverRoomId)
    assertThrows(() => db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, server_room_id, created_at, in_game_at) VALUES (?, 'active', 'in_game', ?, 'x', 'y');`).run(b, serverRoomId), 'UNIQUE', 'двойно обвързване')
    db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, server_room_id, created_at, in_game_at, released_at, release_reason) VALUES (?, 'released', 'in_game', ?, 'x', 'y', 'z', 'server_room_removed');`).run(b, serverRoomId)
    db.prepare(`DELETE FROM voice_tables WHERE voice_table_id IN (?, ?);`).run(a, b)
  })

  await check('[M5] Изтрит профил: grace редовете CASCADE, одитът SET NULL (без следи от профила)', () => {
    const profileId = seedProfile('Erased')
    const tableId = randomUUID()
    db.prepare(`INSERT INTO voice_tables (voice_table_id, status, phase, created_at) VALUES (?, 'active', 'waiting', 'x');`).run(tableId)
    db.prepare(`INSERT INTO voice_speaking_grants (voice_table_id, match_seq, profile_id, granted_at) VALUES (?, 1, ?, 'x');`).run(tableId, profileId)
    const changeId = randomUUID()
    db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'max_tables', '11', '10', ?, '1999-01-01T00:00:00.000Z');`).run(changeId, profileId)
    db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(profileId)
    assertEqual(Number((db.prepare(`SELECT COUNT(*) AS c FROM voice_speaking_grants WHERE profile_id = ?;`).get(profileId) as { c: number }).c), 0, 'grant')
    assertEqual((db.prepare(`SELECT changed_by_profile_id AS p FROM voice_chat_admin_changes WHERE change_id = ?;`).get(changeId) as { p: string | null }).p, null, 'одит')
    db.prepare(`DELETE FROM voice_chat_admin_changes WHERE change_id = ?;`).run(changeId)
    db.prepare(`DELETE FROM voice_tables WHERE voice_table_id = ?;`).run(tableId)
  })

  // ═══ [F] Env флаг ═══════════════════════════════════════════════════════
  await check('[F1] Авариен стоп: само VOICE_CHAT_ENABLED=0; печели над всеки режим', () => {
    assertEqual(isVoiceChatEmergencyStopActive({}), false, 'липсваща')
    assertEqual(isVoiceChatEmergencyStopActive({ VOICE_CHAT_ENABLED: '1' }), false, '1')
    assertEqual(isVoiceChatEmergencyStopActive({ VOICE_CHAT_ENABLED: ' 0 ' }), true, '0')
    assertEqual(isVoiceChatEmergencyStopActive({ VOICE_CHAT_ENABLED: 'false' }), false, 'false не е стоп')
    for (const mode of ['off', 'admin_only', 'public'] as const) {
      assertEqual(resolveEffectiveVoiceChatMode(mode, true), 'off', `стоп над ${mode}`)
      assertEqual(resolveEffectiveVoiceChatMode(mode, false), mode, `без стоп ${mode}`)
    }
  })

  await check('[F2] LiveKit конфигурация: само имена на липсващите, никога стойности', () => {
    const none = getVoiceChatLiveKitConfigStatus({})
    assert(!none.configured && none.missing.length === VOICE_CHAT_LIVEKIT_ENV_NAMES.length, JSON.stringify(none))
    const secret = 'super-secret-value-123'
    const full = getVoiceChatLiveKitConfigStatus({ LIVEKIT_API_URL: 'https://x', LIVEKIT_WS_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: secret })
    assert(full.configured && full.missing.length === 0, 'пълна')
    assert(!JSON.stringify(full).includes(secret), 'без стойности')
    assert(!getVoiceChatLiveKitConfigStatus({ LIVEKIT_API_URL: 'x', LIVEKIT_WS_URL: 'x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: '   ' }).configured, 'празен secret')
  })

  // ═══ [E] Eligibility ════════════════════════════════════════════════════
  const MODES: VoiceChatMode[] = ['off', 'admin_only', 'public']
  const BOOLS = [false, true] as const

  await check('[E1] Създаване — изброените сценарии', () => {
    const base: { profileId: string | null; isFullAdmin: boolean; isVipActive: boolean; isBanned: boolean } = { profileId: 'p1', isFullAdmin: false, isVipActive: true, isBanned: false }
    const create = (storedMode: VoiceChatMode, requester: Partial<typeof base>, emergencyStop = false) =>
      evaluateVoiceTableCreation({ mode: { storedMode, emergencyStop }, requester: { ...base, ...requester } })
    assertEqual(JSON.stringify(create('off', {})), JSON.stringify({ ok: false, code: 'voice_off' }), 'default OFF')
    assertEqual(JSON.stringify(create('public', {}, true)), JSON.stringify({ ok: false, code: 'voice_off' }), 'авариен стоп')
    assertEqual(create('public', {}).ok, true, 'public + VIP')
    assertEqual(JSON.stringify(create('public', { isVipActive: false })), JSON.stringify({ ok: false, code: 'vip_required' }), 'public без VIP')
    assertEqual(JSON.stringify(create('admin_only', {})), JSON.stringify({ ok: false, code: 'admin_only_mode' }), 'admin_only, не е admin')
    assertEqual(create('admin_only', { isFullAdmin: true }).ok, true, 'admin + VIP')
    assertEqual(JSON.stringify(create('admin_only', { isFullAdmin: true, isVipActive: false })), JSON.stringify({ ok: false, code: 'vip_required' }), 'admin без VIP — без bypass')
    assertEqual(JSON.stringify(create('public', { isBanned: true })), JSON.stringify({ ok: false, code: 'banned' }), 'баннат')
    assertEqual(JSON.stringify(create('public', { profileId: null })), JSON.stringify({ ok: false, code: 'not_authenticated' }), 'гост')
  })

  await check('[E2] Създаване — пълна матрица (3 режима × стоп × admin × VIP × бан × профил = 96) срещу правилата', () => {
    let combos = 0
    for (const storedMode of MODES) for (const emergencyStop of BOOLS) for (const isFullAdmin of BOOLS)
      for (const isVipActive of BOOLS) for (const isBanned of BOOLS) for (const hasProfile of BOOLS) {
        combos += 1
        const decision = evaluateVoiceTableCreation({
          mode: { storedMode, emergencyStop },
          requester: { profileId: hasProfile ? 'p' : null, isFullAdmin, isVipActive, isBanned },
        })
        const effective = emergencyStop ? 'off' : storedMode
        const expected = effective !== 'off' && hasProfile && !isBanned && isVipActive && (effective === 'public' || isFullAdmin)
        assertEqual(decision.ok, expected, `mode=${storedMode} stop=${emergencyStop} admin=${isFullAdmin} vip=${isVipActive} ban=${isBanned} profile=${hasProfile}`)
      }
    assertEqual(combos, 96, 'брой комбинации')
  })

  const TABLE_ID = '11111111-2222-4333-8444-555555555555'
  const OTHER_TABLE_ID = '99999999-2222-4333-8444-555555555555'
  function accessInput(overrides: Partial<VoiceAccessInput> & { relation?: VoiceRelation; sameTable?: boolean; permanentlyLeft?: boolean; vip?: boolean; admin?: boolean; banned?: boolean } = {}): VoiceAccessInput {
    const table: VoiceTableFacts | null = overrides.table === undefined
      ? { voiceTableId: TABLE_ID, status: 'active', phase: 'in_game', matchSeq: 1 }
      : overrides.table
    return {
      mode: overrides.mode ?? { storedMode: 'public', emergencyStop: false },
      requester: overrides.requester ?? { profileId: 'p1', isFullAdmin: overrides.admin ?? false, isVipActive: overrides.vip ?? true, isBanned: overrides.banned ?? false },
      requestedVoiceTableId: overrides.requestedVoiceTableId ?? TABLE_ID,
      table,
      membership: overrides.membership ?? {
        relation: overrides.relation ?? 'player',
        seatedVoiceTableId: overrides.sameTable === false ? OTHER_TABLE_ID : TABLE_ID,
        permanentlyLeft: overrides.permanentlyLeft ?? false,
      },
      sessionBindingCurrent: overrides.sessionBindingCurrent ?? true,
      hasSpeakingGrantForCurrentMatch: overrides.hasSpeakingGrantForCurrentMatch ?? false,
    }
  }
  const denial = (decision: VoiceAccessDecision): string => (decision.canListen ? 'listen' : decision.denialCode)

  await check('[E3] Слушане/говорене — изброените сценарии от задачата', () => {
    const vip = evaluateVoiceAccess(accessInput({ vip: true }))
    assert(vip.canListen && vip.canSpeak && vip.speakBasis === 'vip', 'VIP играч слуша и говори')
    const nonVip = evaluateVoiceAccess(accessInput({ vip: false }))
    assert(nonVip.canListen && !nonVip.canSpeak, 'non-VIP слуша, но не говори')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ relation: 'spectator', admin: true, vip: true }))), 'spectator', 'admin зрител')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ relation: 'spectator' }))), 'spectator', 'зрител')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ relation: 'bot' }))), 'bot', 'бот')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ relation: 'none' }))), 'not_a_player', 'извън масата')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ sameTable: false }))), 'wrong_table', 'друга маса (cross-room)')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ requestedVoiceTableId: OTHER_TABLE_ID }))), 'table_not_found', 'заявка за чужд voiceTableId')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ permanentlyLeft: true, hasSpeakingGrantForCurrentMatch: true }))), 'permanently_left', 'напуснал (и с grace)')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ banned: true, hasSpeakingGrantForCurrentMatch: true }))), 'banned', 'баннат (и с grace)')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ sessionBindingCurrent: false }))), 'invalid_session', 'невалидна игрова сесия')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ mode: { storedMode: 'off', emergencyStop: false } }))), 'voice_off', 'режим OFF')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ mode: { storedMode: 'public', emergencyStop: true } }))), 'voice_off', 'авариен стоп')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ table: { voiceTableId: TABLE_ID, status: 'released', phase: 'in_game', matchSeq: 1 } }))), 'table_released', 'освободена маса')
    assertEqual(denial(evaluateVoiceAccess(accessInput({ table: null }))), 'table_not_found', 'липсваща маса')
    const graced = evaluateVoiceAccess(accessInput({ vip: false, hasSpeakingGrantForCurrentMatch: true }))
    assert(graced.canListen && graced.canSpeak && graced.speakBasis === 'match_grace', 'grace в текущия мач')
    const adminNoVip = evaluateVoiceAccess(accessInput({ admin: true, vip: false }))
    assert(adminNoVip.canListen && !adminNoVip.canSpeak, 'admin играч без VIP — слуша, без bypass за говорене')
  })

  await check('[E4] Пълна матрица на достъпа (3×2 режима × 4 отношения × маса × напуснал × бан × сесия × VIP × grace × admin × 3 статуса = 9216)', () => {
    let combos = 0
    const tableStates: Array<VoiceTableFacts | null> = [
      { voiceTableId: TABLE_ID, status: 'active', phase: 'in_game', matchSeq: 3 },
      { voiceTableId: TABLE_ID, status: 'released', phase: 'in_game', matchSeq: 3 },
      null,
    ]
    for (const storedMode of MODES) for (const emergencyStop of BOOLS)
      for (const relation of ['player', 'spectator', 'bot', 'none'] as const) for (const sameTable of BOOLS)
        for (const permanentlyLeft of BOOLS) for (const banned of BOOLS) for (const session of BOOLS)
          for (const vip of BOOLS) for (const grant of BOOLS) for (const admin of BOOLS) for (const table of tableStates) {
            combos += 1
            const input = accessInput({
              mode: { storedMode, emergencyStop }, relation, sameTable, permanentlyLeft, banned, vip, admin,
              sessionBindingCurrent: session, hasSpeakingGrantForCurrentMatch: grant, table,
            })
            const decision = evaluateVoiceAccess(input)
            const effective = emergencyStop ? 'off' : storedMode
            const listenExpected = effective !== 'off' && !banned && table !== null && table.status === 'active' &&
              relation === 'player' && sameTable && !permanentlyLeft && session
            const speakExpected = listenExpected && (vip || grant)
            const label = JSON.stringify({ storedMode, emergencyStop, relation, sameTable, permanentlyLeft, banned, session, vip, grant, admin, table: table?.status ?? null })
            assertEqual(decision.canListen, listenExpected, `listen ${label}`)
            assertEqual(decision.canSpeak, speakExpected, `speak ${label}`)
            // admin флагът никога не променя решението (без bypass).
            const flipped = evaluateVoiceAccess({ ...input, requester: { ...input.requester, isFullAdmin: !admin } })
            assertEqual(JSON.stringify(flipped), JSON.stringify(decision), `admin bypass ${label}`)
            // admin_only и public са еднакви за вече съществуваща маса.
            if (storedMode !== 'off') {
              const other = evaluateVoiceAccess({ ...input, mode: { storedMode: storedMode === 'public' ? 'admin_only' : 'public', emergencyStop } })
              assertEqual(JSON.stringify(other), JSON.stringify(decision), `mode switch ${label}`)
            }
            const profile = toVoiceLiveKitPermissionProfile(decision)
            if (!decision.canListen) {
              assertEqual(profile, null, `без токен ${label}`)
            } else {
              if (profile === null) throw new Error(`profile ${label}`)
              assert(profile.canSubscribe && profile.canPublishData === false, `profile ${label}`)
              assertEqual(profile.canPublish, decision.canSpeak, `canPublish ${label}`)
              assertEqual(JSON.stringify(profile.canPublishSources), decision.canSpeak ? '["microphone"]' : '[]', `sources ${label}`)
            }
          }
    assertEqual(combos, 9216, 'брой комбинации')
  })

  await check('[E5] LiveKit permission профили — точните grants от задачата', () => {
    assertEqual(
      JSON.stringify(toVoiceLiveKitPermissionProfile(evaluateVoiceAccess(accessInput({ vip: true })))),
      JSON.stringify({ canSubscribe: true, canPublish: true, canPublishSources: ['microphone'], canPublishData: false }),
      'VIP',
    )
    assertEqual(
      JSON.stringify(toVoiceLiveKitPermissionProfile(evaluateVoiceAccess(accessInput({ vip: false })))),
      JSON.stringify({ canSubscribe: true, canPublish: false, canPublishSources: [], canPublishData: false }),
      'non-VIP',
    )
  })

  await check('[E6] Grace се записва само при право от VIP; ротация само при издаден съответен токен', () => {
    assert(shouldRecordSpeakingGrant(evaluateVoiceAccess(accessInput({ vip: true }))), 'VIP -> запис')
    assert(!shouldRecordSpeakingGrant(evaluateVoiceAccess(accessInput({ vip: false, hasSpeakingGrantForCurrentMatch: true }))), 'grace не се самоудължава')
    assert(!shouldRecordSpeakingGrant(evaluateVoiceAccess(accessInput({ vip: false }))), 'non-VIP')
    const listenOnly = evaluateVoiceAccess(accessInput({ vip: false }))
    const none = evaluateVoiceAccess(accessInput({ relation: 'none' }))
    const full = evaluateVoiceAccess(accessInput({ vip: true }))
    assertEqual(resolveRevocationRotation({ wasIssuedToken: true, wasPublishCapable: true, decision: listenOnly }), 'speak_revoked', 'загубено говорене')
    assertEqual(resolveRevocationRotation({ wasIssuedToken: true, wasPublishCapable: false, decision: listenOnly }), null, 'никога не е говорил')
    assertEqual(resolveRevocationRotation({ wasIssuedToken: true, wasPublishCapable: false, decision: none }), 'listen_revoked', 'загубено слушане')
    assertEqual(resolveRevocationRotation({ wasIssuedToken: false, wasPublishCapable: false, decision: none }), null, 'без токен')
    assertEqual(resolveRevocationRotation({ wasIssuedToken: true, wasPublishCapable: true, decision: full }), null, 'без загуба')
  })

  await check('[E7] Session binding: само текущият clientInstanceId на профила за масата', () => {
    const binding: VoiceSessionBinding = { profileId: 'p1', voiceTableId: TABLE_ID, clientInstanceId: 'tab-new', gameConnectionId: 'c2', bindingEpoch: 2, boundAt: 1 }
    assert(isVoiceSessionBindingCurrent({ profileId: 'p1', voiceTableId: TABLE_ID, clientInstanceId: 'tab-new' }, binding), 'текущ')
    assert(!isVoiceSessionBindingCurrent({ profileId: 'p1', voiceTableId: TABLE_ID, clientInstanceId: 'tab-old' }, binding), 'изместен таб')
    assert(!isVoiceSessionBindingCurrent({ profileId: 'p2', voiceTableId: TABLE_ID, clientInstanceId: 'tab-new' }, binding), 'друг профил')
    assert(!isVoiceSessionBindingCurrent({ profileId: 'p1', voiceTableId: OTHER_TABLE_ID, clientInstanceId: 'tab-new' }, binding), 'друга маса')
    assert(!isVoiceSessionBindingCurrent({ profileId: 'p1', voiceTableId: TABLE_ID, clientInstanceId: '' }, { ...binding, clientInstanceId: '' }), 'празен')
    assert(!isVoiceSessionBindingCurrent({ profileId: 'p1', voiceTableId: TABLE_ID, clientInstanceId: 'tab-new' }, null), 'без binding')
  })

  // ═══ [N] Имена на стаите ════════════════════════════════════════════════
  await check('[N1] Имена: формат, парсване, 20 000 без повторение, невалидни входове', () => {
    const name = buildVoiceRoomName(TABLE_ID, 7)
    assert(name.startsWith(VOICE_ROOM_NAME_PREFIX) && name.length <= 128, name)
    const parsed = parseVoiceRoomName(name)
    assert(parsed !== null && parsed.generation === 7 && parsed.compactVoiceTableId === TABLE_ID.replaceAll('-', ''), JSON.stringify(parsed))
    const names = new Set<string>()
    for (let index = 0; index < 20_000; index += 1) names.add(buildVoiceRoomName(TABLE_ID, 1))
    assertEqual(names.size, 20_000, 'уникални')
    assertThrows(() => buildVoiceRoomName('not-a-uuid', 1), 'invalid_table_id', 'невалиден id')
    assertThrows(() => buildVoiceRoomName(TABLE_ID, 0), 'invalid_generation', 'генерация 0')
    assertEqual(parseVoiceRoomName('room-1'), null, 'чужда стая')
    assertEqual(parseVoiceRoomName(`${name}x`), null, 'суфикс')
  })

  // ═══ [S] Store ══════════════════════════════════════════════════════════
  await check('[S1] Default: режим OFF, лимит 10, без одит; резервация отказана', async () => {
    const { store } = await freshDatabase()
    const settings = store.getSettings()
    assert(settings.mode === 'off' && settings.maxTables === 10 && settings.modeChangedAt === null, JSON.stringify(settings))
    assertEqual(store.listAdminChanges().length, 0, 'одит')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: true })
    assert(!reserved.ok && reserved.code === 'voice_off', JSON.stringify(reserved))
    assertEqual(store.countActiveVoiceTables(), 0, 'нула слотове')
  })

  await check('[S2] Резервация по режим: стоп, admin_only (admin/не-admin), public', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const stopped = store.reserveVoiceTable({ emergencyStop: true, requesterIsFullAdmin: true })
    assert(!stopped.ok && stopped.code === 'voice_off', 'авариен стоп')
    assert(store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false }).ok, 'public')
    forceMode(store, 'admin_only')
    const nonAdmin = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    assert(!nonAdmin.ok && nonAdmin.code === 'admin_only_mode', 'admin_only без admin')
    assert(store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: true }).ok, 'admin_only с admin')
    assertEqual(store.countActiveVoiceTables(), 2, 'слотове')
  })

  await check('[S3] Атомарен лимит: точно N резервации, (N+1)-вата -> capacity_reached; освобождаване отваря слот', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    assert(store.setMaxTables(3, { profileId: null }).ok, 'лимит 3')
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      assert(result.ok, `резервация ${index}`)
      if (result.ok) ids.push(result.table.voiceTableId)
    }
    const full = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    assert(!full.ok && full.code === 'capacity_reached' && full.activeCount === 3 && full.maxTables === 3, JSON.stringify(full))
    assert(store.releaseVoiceTable(ids[0]!, 'waiting_room_closed').ok, 'release')
    assert(store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false }).ok, 'нов слот')
    assertEqual(store.countActiveVoiceTables(), 3, 'брой')
  })

  await check('[S4] Намаляване на лимита: съществуващите продължават; нови едва когато броят падне под лимита', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      if (result.ok) ids.push(result.table.voiceTableId)
    }
    const lowered = store.setMaxTables(2, { profileId: null })
    assert(lowered.ok && lowered.activeCount === 5, JSON.stringify(lowered))
    assert(ids.every((id) => store.getVoiceTable(id)?.status === 'active'), 'съществуващите са активни')
    for (const releaseCount of [1, 2, 3]) {
      store.releaseVoiceTable(ids[releaseCount - 1]!, 'server_room_removed')
      const attempt = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      assert(!attempt.ok && attempt.code === 'capacity_reached', `след ${releaseCount} освобождавания: ${store.countActiveVoiceTables()} активни`)
    }
    store.releaseVoiceTable(ids[3]!, 'server_room_removed')
    assertEqual(store.countActiveVoiceTables(), 1, 'под лимита')
    assert(store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false }).ok, 'отново разрешено')
  })

  await check('[S5] Един слот през целия живот: чакалня -> игра е същият ред; без двойно резервиране/обвързване', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    assert(reserved.ok, 'резервация')
    if (!reserved.ok) return
    const id = reserved.table.voiceTableId
    assert(reserved.table.status === 'active' && reserved.table.phase === 'waiting' && reserved.table.matchSeq === 1, JSON.stringify(reserved.table))
    assert(store.bindPrivateRoom(id, 'private-1').ok, 'bind')
    assert(store.bindPrivateRoom(id, 'private-1').ok, 'bind идемпотентно')
    const conflictBind = store.bindPrivateRoom(id, 'private-2')
    assert(!conflictBind.ok && conflictBind.code === 'conflict', 'друга частна маса')
    const inGame = store.markInGame(id, 'server-1', at(10))
    assert(inGame.ok && inGame.table.phase === 'in_game' && inGame.table.serverRoomId === 'server-1', JSON.stringify(inGame))
    assertEqual(store.countActiveVoiceTables(), 1, 'все още 1 слот')
    assert(store.markInGame(id, 'server-1').ok, 'старт идемпотентно')
    const otherServer = store.markInGame(id, 'server-2')
    assert(!otherServer.ok && otherServer.code === 'conflict', 'втора игрова стая')
    const second = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    assert(second.ok, 'втора маса')
    if (!second.ok) return
    const stolen = store.markInGame(second.table.voiceTableId, 'server-1')
    assert(!stolen.ok && stolen.code === 'conflict', 'две гласови маси в една игрова стая')
    const stolenPrivate = store.bindPrivateRoom(second.table.voiceTableId, 'private-1')
    assert(!stolenPrivate.ok && stolenPrivate.code === 'conflict', 'две гласови маси в една частна маса')
    assertEqual(store.findActiveVoiceTableByServerRoomId('server-1')?.voiceTableId, id, 'lookup по игрова стая')
    assertEqual(store.findActiveVoiceTableByPrivateRoomId('private-1')?.voiceTableId, id, 'lookup по частна маса')
  })

  await check('[S6] Освобождаване: идемпотентно, крайно (не може да се активира/обвърже отново), неуспешно create освобождава', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('резервация')
    const id = reserved.table.voiceTableId
    // Неуспешно create_private_room -> компенсиращо освобождаване в същия tick.
    const aborted = store.releaseVoiceTable(id, 'reservation_aborted', at(1))
    assert(aborted.ok && aborted.released && aborted.table?.status === 'released' && aborted.table.releaseReason === 'reservation_aborted', JSON.stringify(aborted))
    assertEqual(store.countActiveVoiceTables(), 0, 'слотът е свободен')
    const again = store.releaseVoiceTable(id, 'waiting_room_closed')
    assert(again.ok && !again.released && again.table?.releaseReason === 'reservation_aborted', 'идемпотентно, причината не се презаписва')
    const bind = store.bindPrivateRoom(id, 'p')
    assert(!bind.ok && bind.code === 'not_active', 'bind след release')
    const game = store.markInGame(id, 's')
    assert(!game.ok && game.code === 'not_active', 'старт след release')
    const unknown = store.releaseVoiceTable(randomUUID(), 'waiting_room_closed')
    assert(unknown.ok && !unknown.released && unknown.table === null, 'непознат id')
    // Затворена/изтекла/празна чакалня.
    for (const reason of ['waiting_room_closed', 'waiting_room_expired', 'waiting_room_empty', 'game_start_failed'] as const) {
      const table = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      if (!table.ok) throw new Error('резервация')
      store.bindPrivateRoom(table.table.voiceTableId, `private-${reason}`)
      assert(store.releaseVoiceTable(table.table.voiceTableId, reason).ok, reason)
    }
    assertEqual(store.countActiveVoiceTables(), 0, 'няма останали слотове')
  })

  await check('[S7] Режими: public->admin_only пази масите; ->off освобождава всички и оттегля стаите; повторно включване -> само нови', async () => {
    const { store } = await freshDatabase()
    const admin = seedProfileIn(store, 'Admin')
    assert(store.setMode('public', { profileId: admin }, at(1)).ok, 'public')
    const a = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    const b = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!a.ok || !b.ok) throw new Error('резервации')
    store.markInGame(b.table.voiceTableId, 'server-b')
    const liveA = store.allocateGeneration(a.table.voiceTableId, 'boot_rotation')
    const liveB = store.allocateGeneration(b.table.voiceTableId, 'boot_rotation')
    if (!liveA.ok || !liveB.ok) throw new Error('генерации')
    const profile = seedProfileIn(store, 'Speaker')
    store.recordSpeakingGrant(b.table.voiceTableId, 1, profile)

    const toAdminOnly = store.setMode('admin_only', { profileId: admin }, at(2))
    assert(toAdminOnly.ok && toAdminOnly.changed && toAdminOnly.releasedVoiceTableIds.length === 0, 'admin_only')
    assert(store.getVoiceTable(a.table.voiceTableId)?.status === 'active' && store.isLiveRoomName(liveA.roomName), 'масите продължават')
    assert(store.hasSpeakingGrant(b.table.voiceTableId, 1, profile), 'правата се запазват')

    const off = store.setMode('off', { profileId: admin }, at(3))
    assert(off.ok && off.changed && off.releasedVoiceTableIds.length === 2 && off.retiredRoomNames.length === 2, JSON.stringify(off))
    assertEqual(store.countActiveVoiceTables(), 0, 'без слотове')
    assert(!store.isLiveRoomName(liveA.roomName) && !store.isLiveRoomName(liveB.roomName), 'няма живи стаи')
    assertEqual(store.getGeneration(liveA.roomName)?.status, 'delete_pending', 'стая A чака DeleteRoom')
    assertEqual(store.getGeneration(liveB.roomName)?.retireReason, 'mode_off', 'причина')
    assertEqual(store.countPendingRoomDeletions(), 2, 'durable опашка')
    assert(!store.hasSpeakingGrant(b.table.voiceTableId, 1, profile), 'grace изчистен')
    const unchanged = store.setMode('off', { profileId: admin }, at(4))
    assert(unchanged.ok && !unchanged.changed, 'същият режим не се одитира')

    assert(store.setMode('public', { profileId: admin }, at(5)).ok, 'повторно включване')
    assertEqual(store.getVoiceTable(a.table.voiceTableId)?.status, 'released', 'старата маса остава освободена')
    const revived = store.allocateGeneration(a.table.voiceTableId, 'boot_rotation')
    assert(!revived.ok && revived.code === 'not_active', 'стара маса не получава нова стая')
    assert(!store.isLiveRoomName(liveA.roomName), 'старото име не се възстановява')
    assert(store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false }).ok, 'нова маса')
    const history = store.listAdminChanges()
    assertEqual(history.map((change) => `${change.previousValue}->${change.newValue}`).join(','), 'off->public,admin_only->off,public->admin_only,off->public', 'одит')
    assert(history.every((change) => change.changedByProfileId === admin), 'actor')
  })

  await check('[S8] Лимит: валидация (цяло число 0..200), 0 = без нови маси, одит', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    for (const bad of [-1, 1.5, '10', 201, Number.NaN, null]) {
      const result = store.setMaxTables(bad, { profileId: null })
      assert(!result.ok && result.code === 'invalid_limit', `невалиден ${String(bad)}`)
    }
    const zero = store.setMaxTables(0, { profileId: null }, at(1))
    assert(zero.ok && zero.changed && zero.previousMaxTables === 10, 'нула')
    const denied = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    assert(!denied.ok && denied.code === 'capacity_reached', 'нула -> без нови')
    assert(store.setMaxTables(200, { profileId: null }, at(2)).ok, '200')
    const same = store.setMaxTables(200, { profileId: null }, at(3))
    assert(same.ok && !same.changed, 'без промяна')
    assertEqual(store.listAdminChanges().filter((change) => change.setting === 'max_tables').length, 2, 'два записа')
  })

  await check('[S9] Създателят губи VIP: масата остава гласова; той слуша, говори само с grace за текущия мач', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const creator = seedProfileIn(store, 'Creator')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('резервация')
    const id = reserved.table.voiceTableId
    store.markInGame(id, 'server-c')
    const table = store.getVoiceTable(id)!
    const facts: VoiceTableFacts = { voiceTableId: id, status: table.status, phase: table.phase, matchSeq: table.matchSeq }
    const asCreator = (vip: boolean): VoiceAccessDecision => evaluateVoiceAccess({
      mode: { storedMode: 'public', emergencyStop: false },
      requester: { profileId: creator, isFullAdmin: false, isVipActive: vip, isBanned: false },
      requestedVoiceTableId: id,
      table: facts,
      membership: { relation: 'player', seatedVoiceTableId: id, permanentlyLeft: false },
      sessionBindingCurrent: true,
      hasSpeakingGrantForCurrentMatch: store.hasSpeakingGrant(id, facts.matchSeq, creator),
    })
    const lostVip = asCreator(false)
    assert(store.getVoiceTable(id)?.status === 'active', 'масата остава гласова')
    assert(lostVip.canListen && !lostVip.canSpeak, 'слуша без grace')
    store.recordSpeakingGrant(id, 1, creator)
    const withGrace = asCreator(false)
    assert(withGrace.canSpeak && withGrace.speakBasis === 'match_grace', 'grace')
  })

  await check('[S10] Match-scoped grace: преживява рестарт; "Преиграй" (+1) го прекратява; идемпотентно; не важи за освободена маса', async () => {
    const { path, store } = await freshDatabase()
    forceMode(store, 'public')
    const player = seedProfileIn(store, 'Grace')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('резервация')
    const id = reserved.table.voiceTableId
    const earlyAdvance = store.advanceMatchSeq(id, 1)
    assert(!earlyAdvance.ok && earlyAdvance.code === 'not_in_game', 'чакалнята не е граница')
    const first = store.recordSpeakingGrant(id, 1, player, at(1))
    assert(first.ok && first.created, 'запис в сегмент 1 (чакалня + мач 1)')
    const duplicate = store.recordSpeakingGrant(id, 1, player, at(2))
    assert(duplicate.ok && !duplicate.created, 'идемпотентно')
    store.markInGame(id, 'server-g')
    assert(store.hasSpeakingGrant(id, 1, player), 'старт на играта не прекъсва grace')
    const restarted = await openStore(path)
    assert(restarted.hasSpeakingGrant(id, 1, player), 'след рестарт (нова връзка)')
    const advanced = restarted.advanceMatchSeq(id, 1)
    assert(advanced.ok && advanced.advanced && advanced.matchSeq === 2, JSON.stringify(advanced))
    const duplicateAdvance = store.advanceMatchSeq(id, 1)
    assert(duplicateAdvance.ok && !duplicateAdvance.advanced && duplicateAdvance.matchSeq === 2, 'дублиран replay')
    assert(!store.hasSpeakingGrant(id, 1, player) && !store.hasSpeakingGrant(id, 2, player), 'нов мач -> без grace')
    assertEqual(store.listSpeakingGrants(id).length, 0, 'старите редове са изчистени')
    const stale = store.recordSpeakingGrant(id, 1, player)
    assert(!stale.ok && stale.code === 'stale_match', 'стар сегмент')
    assert(store.recordSpeakingGrant(id, 2, player).ok && store.hasSpeakingGrant(id, 2, player), 'нов запис за мач 2')
    store.releaseVoiceTable(id, 'server_room_removed')
    assert(!store.hasSpeakingGrant(id, 2, player), 'освободена маса')
    const afterRelease = store.recordSpeakingGrant(id, 2, player)
    assert(!afterRelease.ok && afterRelease.code === 'not_active', 'без запис след release')
  })

  await check('[S11] Генерации: една жива; оттеглената влиза в durable DeleteRoom опашка; неуспех/успех; име никога не се връща', async () => {
    const { raw, store } = await freshDatabase()
    forceMode(store, 'public')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('резервация')
    const id = reserved.table.voiceTableId
    assertEqual(store.getLiveGeneration(id), null, 'без стая преди първия токен')
    const g1 = store.allocateGeneration(id, 'listen_revoked', at(1))
    assert(g1.ok && g1.generation === 1 && g1.retiredRoomName === null, JSON.stringify(g1))
    if (!g1.ok) return
    assert(store.isLiveRoomName(g1.roomName), 'g1 жива')
    const g2 = store.allocateGeneration(id, 'speak_revoked', at(2))
    assert(g2.ok && g2.generation === 2 && g2.retiredRoomName === g1.roomName, JSON.stringify(g2))
    if (!g2.ok) return
    assert(!store.isLiveRoomName(g1.roomName) && store.isLiveRoomName(g2.roomName), 'само g2 е жива')
    assertThrows(() => raw.prepare(`INSERT INTO voice_room_generations (livekit_room_name, voice_table_id, generation, status, created_at) VALUES ('pv_dup', ?, 99, 'live', 'x');`).run(id), 'UNIQUE', 'втора жива генерация')
    const due = store.listDueRoomDeletions({ now: at(2) })
    assert(due.length === 1 && due[0]!.livekitRoomName === g1.roomName && due[0]!.retireReason === 'speak_revoked', JSON.stringify(due))
    const failedAttempt = store.recordRoomDeletionAttempt(g1.roomName, { outcome: 'failed', error: 'timeout\nafter 3000ms', nextAttemptAt: at(60) }, at(3))
    assert(failedAttempt.ok && failedAttempt.status === 'delete_pending', 'неуспех')
    assertEqual(store.listDueRoomDeletions({ now: at(30) }).length, 0, 'backoff')
    const retry = store.listDueRoomDeletions({ now: at(61) })
    assert(retry.length === 1 && retry[0]!.deleteAttempts === 1 && retry[0]!.lastDeleteError === 'timeout after 3000ms', JSON.stringify(retry))
    assert(store.recordRoomDeletionAttempt(g1.roomName, { outcome: 'deleted' }, at(62)).ok, 'потвърден DeleteRoom')
    assertEqual(store.getGeneration(g1.roomName)?.status, 'deleted', 'deleted')
    const notPending = store.recordRoomDeletionAttempt(g1.roomName, { outcome: 'deleted' })
    assert(!notPending.ok && notPending.code === 'not_pending', 'двойно потвърждение')
    assert(!store.isLiveRoomName(g1.roomName), 'изтритото име не е живо')
    store.releaseVoiceTable(id, 'server_room_removed', at(70))
    assert(!store.isLiveRoomName(g2.roomName), 'освободена маса -> няма жива стая')
    assertEqual(store.getGeneration(g2.roomName)?.status, 'delete_pending', 'g2 чака DeleteRoom след release')
    assertEqual(store.countPendingRoomDeletions(), 1, 'отделно броене на чакащите стаи')
    assertEqual(store.countActiveVoiceTables(), 0, 'слотът е освободен независимо от стаите')
  })

  await check('[S12] Рестарт: чакалните и изчезналите стаи се освобождават; възстановените пазят слота и grace, живата стая се ротира', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const player = seedProfileIn(store, 'Boot')
    const ids: string[] = []
    for (let index = 0; index < 3; index += 1) {
      const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      if (!result.ok) throw new Error('резервация')
      ids.push(result.table.voiceTableId)
    }
    const [waiting, restored, missing] = ids as [string, string, string]
    store.markInGame(restored, 'server-restored')
    store.markInGame(missing, 'server-missing')
    const liveRestored = store.allocateGeneration(restored, 'listen_revoked')
    const liveMissing = store.allocateGeneration(missing, 'listen_revoked')
    if (!liveRestored.ok || !liveMissing.ok) throw new Error('генерации')
    store.recordSpeakingGrant(restored, 1, player)
    const reconciled = store.reconcileOnBoot({ restoredServerRoomIds: new Set(['server-restored', 'unrelated']), now: at(100) })
    assert(reconciled.ok, 'reconcile')
    if (!reconciled.ok) return
    assertEqual(reconciled.releasedVoiceTableIds.sort().join(','), [waiting, missing].sort().join(','), 'освободени')
    assertEqual(reconciled.retainedVoiceTableIds.join(','), restored, 'запазени')
    assertEqual(store.getVoiceTable(waiting)?.releaseReason, 'boot_waiting_room_lost', 'причина чакалня')
    assertEqual(store.getVoiceTable(missing)?.releaseReason, 'boot_server_room_missing', 'причина стая')
    assertEqual(store.countActiveVoiceTables(), 1, 'слотът на възстановената маса се пази')
    assert(!store.isLiveRoomName(liveRestored.roomName) && store.getGeneration(liveRestored.roomName)?.retireReason === 'boot_rotation', 'ротация')
    assertEqual(store.getLiveGeneration(restored), null, 'нова стая се създава lazy')
    assert(store.hasSpeakingGrant(restored, 1, player), 'grace преживява рестарт')
    const next = store.allocateGeneration(restored, 'boot_rotation')
    assert(next.ok && next.generation === 2, 'следващата генерация е монотонна')
  })

  await check('[S13] Чистене: само стари освободени маси без чакащи DeleteRoom', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const clean = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false, now: at(0) })
    const pending = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false, now: at(0) })
    if (!clean.ok || !pending.ok) throw new Error('резервации')
    store.allocateGeneration(pending.table.voiceTableId, 'listen_revoked')
    store.releaseVoiceTable(clean.table.voiceTableId, 'waiting_room_closed', at(10))
    store.releaseVoiceTable(pending.table.voiceTableId, 'waiting_room_closed', at(10))
    const purged = store.purgeReleasedVoiceTables({ releasedBefore: at(1000) })
    assert(purged.ok && purged.purged === 1, JSON.stringify(purged))
    assertEqual(store.getVoiceTable(clean.table.voiceTableId), null, 'изчистена')
    assert(store.getVoiceTable(pending.table.voiceTableId) !== null, 'с чакащ DeleteRoom остава')
  })

  await check('[S14] Заключена база (друг процес): бърз fail-closed "busy" без частични промени; event loop не чака 5 s', async () => {
    const { path, store } = await freshDatabase()
    forceMode(store, 'public')
    const locker = new sqliteModule.DatabaseSync(path, { open: true })
    locker.exec('BEGIN IMMEDIATE;')
    try {
      const started = performance.now()
      const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      const elapsed = performance.now() - started
      assert(!result.ok && result.code === 'busy', JSON.stringify(result))
      assert(elapsed < 1500, `чакане ${Math.round(elapsed)} ms`)
      console.log(`        (busy отказ след ${Math.round(elapsed)} ms при busy_timeout 200 ms)`)
      const modeResult = store.setMode('off', { profileId: null })
      assert(!modeResult.ok && modeResult.code === 'busy', 'setMode busy')
    } finally {
      locker.exec('ROLLBACK;')
      locker.close()
    }
    assertEqual(store.countActiveVoiceTables(), 0, 'нищо не е записано')
    assertEqual(store.getSettings().mode, 'public', 'режимът не е променен')
  })

  await check('[S15] Паралелни резервации от 6 отделни процеса × 5 опита при лимит 10 -> точно 10, без дубликати', async () => {
    const { path, store } = await freshDatabase()
    forceMode(store, 'public')
    const startAt = Date.now() + 3_000
    const childScript = join(sourceServerRoot, 'scripts', 'fixtures', 'voiceChatReserveChild.ts')
    const tsxCli = join(sourceServerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<{ reserved: string[]; capacity: number; busy: number }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [tsxCli, childScript, path, String(startAt), '5'], { cwd: sourceServerRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`child exit ${code}: ${stderr.slice(-400)}`))
        try { resolvePromise(JSON.parse(stdout.trim().split('\n').pop() ?? '{}')) } catch (error) { reject(error) }
      })
    })))
    const all = runs.flatMap((run) => run.reserved)
    assertEqual(all.length, 10, `общо резервации (по процеси: ${runs.map((run) => run.reserved.length).join('/')})`)
    assertEqual(new Set(all).size, 10, 'уникални')
    assertEqual(runs.reduce((sum, run) => sum + run.capacity, 0), 20, 'отказани заради капацитета')
    assertEqual(store.countActiveVoiceTables(), 10, 'в базата')
    console.log(`        (busy повторения между процесите: ${runs.reduce((sum, run) => sum + run.busy, 0)})`)
  })

  await check('[S16] Цена на резервация+освобождаване (200 цикъла, WAL, локален диск) — отчет', async () => {
    const { store } = await freshDatabase()
    forceMode(store, 'public')
    const samples: number[] = []
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now()
      const result = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      if (!result.ok) throw new Error(JSON.stringify(result))
      store.releaseVoiceTable(result.table.voiceTableId, 'waiting_room_closed')
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    const pick = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!.toFixed(2)
    console.log(`        (reserve+release: p50 ${pick(0.5)} ms, p95 ${pick(0.95)} ms, p99 ${pick(0.99)} ms, max ${samples[samples.length - 1]!.toFixed(2)} ms)`)
    assert(samples[samples.length - 1]! < 2_000, 'без патологично чакане')
  })

  // ═══ [R] Опашка за освобождаване ════════════════════════════════════════
  await check('[R1] Busy при освобождаване -> опашка, повтаря с backoff, никога не губи слота; dedupe', async () => {
    let busyLeft = 3
    let calls = 0
    const fakeStore = {
      releaseVoiceTable: () => {
        calls += 1
        if (busyLeft > 0) {
          busyLeft -= 1
          return { ok: false as const, code: 'busy' as const }
        }
        return { ok: true as const, released: true, table: null, retiredRoomNames: ['pv_x'] }
      },
    }
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    const scheduler: VoiceReleaseScheduler = {
      setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length },
      clearTimeout: () => {},
    }
    const released: string[] = []
    const queue = createVoiceTableReleaseQueue({ store: fakeStore, scheduler, baseDelayMs: 100, onReleased: (id) => released.push(id) })
    assertEqual(queue.release('t1', 'waiting_room_closed').status, 'queued', 'първи опит busy')
    assertEqual(queue.release('t1', 'waiting_room_closed').status, 'queued', 'dedupe')
    assertEqual(calls, 1, 'dedupe не вика store')
    while (timers.length > 0) timers.shift()!.callback()
    assertEqual(queue.pendingCount(), 0, 'изпразнена')
    assertEqual(released.join(','), 't1', 'освободена точно веднъж')
    assertEqual(calls, 4, '3 busy + 1 успех')
    queue.dispose()
  })

  await check('[R2] Опашката срещу реална заключена база: освобождава след отключване', async () => {
    const { path, store } = await freshDatabase()
    forceMode(store, 'public')
    const reserved = store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
    if (!reserved.ok) throw new Error('резервация')
    const fastStore = await openStore(path, 20)
    const timers: Array<() => void> = []
    const queue = createVoiceTableReleaseQueue({ store: fastStore, scheduler: { setTimeout: (callback) => { timers.push(callback); return 1 }, clearTimeout: () => {} } })
    const locker = new sqliteModule.DatabaseSync(path, { open: true })
    locker.exec('BEGIN IMMEDIATE;')
    assertEqual(queue.release(reserved.table.voiceTableId, 'waiting_room_closed').status, 'queued', 'заключено')
    locker.exec('COMMIT;')
    locker.close()
    timers.shift()!()
    assertEqual(queue.pendingCount(), 0, 'освободено')
    assertEqual(store.countActiveVoiceTables(), 0, 'слотът е свободен')
    queue.dispose()
  })

  // ═══ [A] Административно API ════════════════════════════════════════════
  const api = await freshDatabase()
  const apiAdmin = seedProfileIn(api.store, 'ApiAdmin')
  const SECRET = 'lk-secret-should-never-leak'
  const apiDeps: VoiceChatAdminApiDeps = {
    store: api.store,
    getFullAdminProfileId: (req: IncomingMessage) => (req.headers['x-test-admin'] === '1' ? apiAdmin : null),
    isAllowedOrigin: (req: IncomingMessage) => req.headers.origin === undefined || req.headers.origin === 'https://pika.bg',
    readJsonBody: async (req: IncomingMessage) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
    },
    resolveDisplayName: (profileId: string) => (profileId === apiAdmin ? 'Админ Тест' : null),
    env: { LIVEKIT_API_URL: 'https://voice.example', LIVEKIT_WS_URL: 'wss://voice.example', LIVEKIT_API_KEY: 'key-1', LIVEKIT_API_SECRET: SECRET },
    log: () => {},
  }
  const handler = createVoiceChatAdminRequestHandler(apiDeps)
  const server: Server = createServer((req, res) => {
    void handler(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) { res.writeHead(418); res.end() }
    })
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function call(path: string, init: { method?: string; admin?: boolean; origin?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown>; cache: string | null; text: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (init.admin !== false) headers['x-test-admin'] = '1'
    if (init.origin !== undefined) headers.origin = init.origin
    const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, cache: response.headers.get('cache-control'), text }
  }

  try {
    await check('[A1] Само пълен admin; останалите пътища не се засягат', async () => {
      const denied = await call('/api/admin/voice-chat', { admin: false })
      assert(denied.status === 403 && denied.cache === 'no-store', `${denied.status}`)
      const deniedPost = await call('/api/admin/voice-chat/mode', { method: 'POST', admin: false, body: { mode: 'public', confirm: true } })
      assertEqual(deniedPost.status, 403, 'POST без admin')
      assertEqual(api.store.getSettings().mode, 'off', 'непроменен')
      const other = await fetch(`${base}/api/admin/profile-customization`, { headers: { 'x-test-admin': '1' } })
      assertEqual(other.status, 418, 'чужд път не се обработва')
    })

    await check('[A2] GET: default OFF/10, ефективен режим, LiveKit само "configured" + имена — никога стойности', async () => {
      const result = await call('/api/admin/voice-chat')
      assert(result.status === 200 && result.cache === 'no-store', `${result.status}`)
      assert(result.json.mode === 'off' && result.json.effectiveMode === 'off' && result.json.maxTables === 10 && result.json.activeVoiceTables === 0, result.text)
      assertEqual(JSON.stringify(result.json.liveKit), JSON.stringify({ configured: true, missing: [] }), 'liveKit')
      assert(!result.text.includes(SECRET) && !result.text.includes('key-1') && !result.text.includes('voice.example'), 'без стойности')
    })

    await check('[A3] POST mode: confirm задължителен, невалиден режим, чужд origin, GET -> 405, непознат -> 404', async () => {
      assertEqual((await call('/api/admin/voice-chat/mode', { method: 'POST', body: { mode: 'public' } })).json.code, 'confirmation_required', 'confirm')
      assertEqual((await call('/api/admin/voice-chat/mode', { method: 'POST', body: { mode: 'on', confirm: true } })).json.code, 'invalid_mode', 'режим')
      assertEqual((await call('/api/admin/voice-chat/mode', { method: 'POST', origin: 'https://evil.example', body: { mode: 'public', confirm: true } })).status, 403, 'origin')
      assertEqual((await call('/api/admin/voice-chat/mode')).status, 405, 'GET на mode')
      assertEqual((await call('/api/admin/voice-chat/other', { method: 'POST', body: {} })).status, 404, 'непознат')
      assertEqual((await call('/api/admin/voice-chat/mode', { method: 'POST', body: [1] })).json.code, 'invalid_body', 'масив')
      assertEqual(api.store.getSettings().mode, 'off', 'непроменен')
    })

    await check('[A4] POST mode/limit: успех, одит с име, no-store; изключване освобождава масите', async () => {
      const toPublic = await call('/api/admin/voice-chat/mode', { method: 'POST', origin: 'https://pika.bg', body: { mode: 'public', confirm: true } })
      assert(toPublic.status === 200 && toPublic.json.changed === true && toPublic.json.mode === 'public' && toPublic.cache === 'no-store', toPublic.text)
      const reserved = api.store.reserveVoiceTable({ emergencyStop: false, requesterIsFullAdmin: false })
      assert(reserved.ok, 'резервация')
      const limit = await call('/api/admin/voice-chat/limit', { method: 'POST', body: { maxTables: 25 } })
      assert(limit.status === 200 && limit.json.maxTables === 25 && limit.json.activeVoiceTables === 1, limit.text)
      for (const bad of [-1, 1.5, '7', 1000]) {
        const result = await call('/api/admin/voice-chat/limit', { method: 'POST', body: { maxTables: bad } })
        assert(result.status === 400 && result.json.code === 'invalid_limit', `${String(bad)} -> ${result.status}`)
      }
      const off = await call('/api/admin/voice-chat/mode', { method: 'POST', body: { mode: 'off', confirm: true } })
      assert(off.status === 200 && off.json.releasedVoiceTables === 1 && off.json.activeVoiceTables === 0, off.text)
      const snapshot = await call('/api/admin/voice-chat')
      const history = snapshot.json.history as Array<Record<string, unknown>>
      assertEqual(history.length, 3, 'одит')
      assert(history.every((row) => row.changedByDisplayName === 'Админ Тест'), 'име')
      assertEqual(snapshot.json.modeChangedByDisplayName, 'Админ Тест', 'последна промяна')
    })

    await check('[A5] Авариен стоп от env се вижда като ефективен OFF; заета база -> 503', async () => {
      const stopHandler = createVoiceChatAdminRequestHandler({ ...apiDeps, env: { VOICE_CHAT_ENABLED: '0' } })
      api.store.setMode('public', { profileId: apiAdmin })
      const stopServer = createServer((req, res) => { void stopHandler(req, res, new URL(req.url ?? '/', 'http://localhost')) })
      await new Promise<void>((resolvePromise) => stopServer.listen(0, '127.0.0.1', resolvePromise))
      try {
        const response = await fetch(`http://127.0.0.1:${(stopServer.address() as AddressInfo).port}/api/admin/voice-chat`, { headers: { 'x-test-admin': '1' } })
        const json = await response.json() as Record<string, unknown>
        assert(json.mode === 'public' && json.effectiveMode === 'off' && json.emergencyStop === true, JSON.stringify(json))
        assertEqual(JSON.stringify(json.liveKit), JSON.stringify({ configured: false, missing: [...VOICE_CHAT_LIVEKIT_ENV_NAMES] }), 'без env')
      } finally {
        await new Promise<void>((resolvePromise) => stopServer.close(() => resolvePromise()))
      }
      const slowStore = await openStore(api.path, 20)
      const busyHandler = createVoiceChatAdminRequestHandler({ ...apiDeps, store: slowStore })
      const busyServer = createServer((req, res) => { void busyHandler(req, res, new URL(req.url ?? '/', 'http://localhost')) })
      await new Promise<void>((resolvePromise) => busyServer.listen(0, '127.0.0.1', resolvePromise))
      const locker = new sqliteModule.DatabaseSync(api.path, { open: true })
      locker.exec('BEGIN IMMEDIATE;')
      try {
        const response = await fetch(`http://127.0.0.1:${(busyServer.address() as AddressInfo).port}/api/admin/voice-chat/limit`, {
          method: 'POST', headers: { 'x-test-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ maxTables: 3 }),
        })
        assertEqual(response.status, 503, 'busy')
      } finally {
        locker.exec('ROLLBACK;')
        locker.close()
        await new Promise<void>((resolvePromise) => busyServer.close(() => resolvePromise()))
      }
    })
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  // ═══ [W] Свързване в index.ts (статично) ════════════════════════════════
  await check('[W1] index.ts: store + admin handler + router + close; без игрови куки и без LiveKit в Етап 2а', async () => {
    const source = await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')
    assert(source.includes('await createVoiceChatStore(databaseBootstrap.databaseFilePath)'), 'store')
    assert(/if \(await handleAdminVoiceChatRequest\(req, res, requestUrl\)\) \{/.test(source), 'router')
    assert(source.includes(`closeStore('voiceChatStore', () => voiceChatStore.close())`), 'close')
    const voiceUsages = (source.match(/voiceChatStore\.[a-zA-Z]+/g) ?? []).filter((usage) => usage !== 'voiceChatStore.js')
    assertEqual([...new Set(voiceUsages)].join(','), 'voiceChatStore.close', 'index.ts не вика игрови voice операции')
    for (const forbidden of ['livekit-server-sdk', 'livekit-client', 'reserveVoiceTable', 'AccessToken']) {
      assert(!source.includes(forbidden), forbidden)
    }
    const voiceDir = join(sourceServerRoot, 'src', 'voice')
    for (const file of await readdir(voiceDir)) {
      const text = await readFile(join(voiceDir, file), 'utf8')
      assert(!/from 'livekit|fetch\(|https?:\/\/voice/.test(text), `${file}: без LiveKit/мрежа`)
    }
  })
} finally {
  for (const store of storesToClose) {
    try { store.close() } catch { /* вече затворен */ }
  }
  for (const raw of rawToClose) {
    try { raw.close() } catch { /* вече затворен */ }
  }
  db.close()
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

/** Профил в същата база като store-а (FK към profiles). */
function seedProfileIn(store: VoiceChatStore, name: string): string {
  const path = storePaths.get(store)
  if (path === undefined) return seedProfile(name)
  const raw = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  try {
    const profileId = randomUUID()
    const accountId = randomUUID()
    raw.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
    raw.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, 'human');`).run(
      profileId, accountId, name, `${name.toLowerCase()}-${profileId.slice(0, 8)}`,
    )
    return profileId
  } finally {
    raw.close()
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
