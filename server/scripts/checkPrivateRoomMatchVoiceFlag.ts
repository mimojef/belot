/**
 * checkPrivateRoomMatchVoiceFlag.ts — индикатор за гласов чат в „Играещи“ /
 * „Приключили“: миграция 20261117_003 и privateRoomMatchStore. Само
 * изолирани временни бази.
 *
 *   [M1] миграцията: колона voice_enabled INTEGER NULL; CHECK отказва други стойности;
 *   [M2] стара база с вече записан мач -> след миграцията редът е NULL (без backfill) -> без индикатор;
 *   [M3] записване с глас / без глас / без стойност -> true / false / false (NULL в базата);
 *   [M4] списъците „Играещи“ и „Приключили“ носят флага;
 *   [M5] преиграване (същата стая): флагът се пази; историята (един ред) — непроменена.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomMatchVoiceFlag.ts   (от server/)
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPrivateRoomMatchStore, type PrivateRoomMatchOccupant } from '../src/db/privateRoomMatchStore.js'

const MIGRATION = '20261117_003_private_room_match_voice_enabled.sql'

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

const sourceMigrations = join(resolve(process.cwd()), 'database', 'migrations')
const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const toClose: Array<{ close: () => void }> = []

async function makeRoot(options: { withVoiceMigration: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-private-match-voice-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.sql') continue
    if (!options.withVoiceMigration && entry.name === MIGRATION) continue
    await cp(join(sourceMigrations, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  return root
}

const team = (prefix: string): [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant] => [
  { profileId: `${prefix}-1`, displayName: `${prefix} 1`, avatarUrl: null, isBot: false },
  { profileId: null, displayName: 'Бот', avatarUrl: null, isBot: true },
]

console.log('\ncheckPrivateRoomMatchVoiceFlag\n')

await check('[M1] миграцията: voice_enabled INTEGER NULL; CHECK отказва стойности извън 0/1', async () => {
  const root = await makeRoot({ withVoiceMigration: true })
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path)
  toClose.push(raw)
  const column = (raw.prepare(`PRAGMA table_info(private_room_matches);`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>)
    .find((c) => c.name === 'voice_enabled')
  assert(column !== undefined && column.type.toUpperCase() === 'INTEGER' && column.notnull === 0 && column.dflt_value === null, JSON.stringify(column))
  const applied = raw.prepare(`SELECT filename FROM server_migrations WHERE filename = ?`).get(MIGRATION)
  assert(applied !== undefined, 'миграцията не е в ledger-а')
  let rejected = false
  try {
    raw.prepare(`INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json, voice_enabled) VALUES (?, ?, 'playing', 5000, '[]', '[]', 2)`).run(randomUUID(), randomUUID())
  } catch {
    rejected = true
  }
  assert(rejected, 'CHECK не отказа стойност 2')
})

await check('[M2] стара база с вече записан мач: след миграцията редът остава NULL (без backfill) -> без индикатор', async () => {
  const root = await makeRoot({ withVoiceMigration: false })
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const raw = new sqliteModule.DatabaseSync(path)
  const oldRoomId = randomUUID()
  raw.prepare(`INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json) VALUES (?, ?, 'finished', 5000, ?, ?)`)
    .run(oldRoomId, randomUUID(), JSON.stringify(team('a')), JSON.stringify(team('b')))
  raw.close()
  await cp(join(sourceMigrations, MIGRATION), join(root, 'database', 'migrations', MIGRATION))
  const second = await ensureServerDatabaseReady({ serverRootOverride: root })
  assert(second.appliedMigrations.some((m) => m.filename === MIGRATION), 'миграцията не е приложена към старата база')
  const raw2 = new sqliteModule.DatabaseSync(path)
  toClose.push(raw2)
  const value = (raw2.prepare(`SELECT voice_enabled FROM private_room_matches WHERE room_id = ?`).get(oldRoomId) as { voice_enabled: number | null }).voice_enabled
  assert(value === null, `стар ред: ${value}`)
  const store = await createPrivateRoomMatchStore(path)
  toClose.push(store)
  assert(store.getMatch(oldRoomId)?.voiceEnabled === false, 'стар ред е обозначен като гласов')
})

await check('[M3]-[M5] запис с/без глас и без стойност; списъците носят флага; преиграването го пази', async () => {
  const root = await makeRoot({ withVoiceMigration: true })
  const { databaseFilePath: path } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const store = await createPrivateRoomMatchStore(path)
  toClose.push(store)
  const raw = new sqliteModule.DatabaseSync(path)
  toClose.push(raw)
  const [voiceRoom, plainRoom, unknownRoom] = [randomUUID(), randomUUID(), randomUUID()]
  store.recordMatchStarted({ roomId: voiceRoom, privateRoomId: randomUUID(), stake: 5000, teamA: team('a'), teamB: team('b'), voiceEnabled: true })
  store.recordMatchStarted({ roomId: plainRoom, privateRoomId: randomUUID(), stake: 5000, teamA: team('c'), teamB: team('d'), voiceEnabled: false })
  store.recordMatchStarted({ roomId: unknownRoom, privateRoomId: randomUUID(), stake: 5000, teamA: team('e'), teamB: team('f') })
  const dbValue = (id: string) => (raw.prepare(`SELECT voice_enabled FROM private_room_matches WHERE room_id = ?`).get(id) as { voice_enabled: number | null }).voice_enabled
  assert(dbValue(voiceRoom) === 1 && dbValue(plainRoom) === 0 && dbValue(unknownRoom) === null, `база: ${dbValue(voiceRoom)}, ${dbValue(plainRoom)}, ${dbValue(unknownRoom)}`)
  const playing = new Map(store.listPlayingMatches().map((m) => [m.roomId, m.voiceEnabled]))
  assert(playing.get(voiceRoom) === true && playing.get(plainRoom) === false && playing.get(unknownRoom) === false, `„Играещи“: ${JSON.stringify([...playing])}`)
  store.recordMatchFinished(voiceRoom, 151, 98)
  store.recordMatchFinished(plainRoom, 80, 151)
  const finished = new Map(store.listFinishedMatches(2).map((m) => [m.roomId, m.voiceEnabled]))
  assert(finished.get(voiceRoom) === true && finished.get(plainRoom) === false, `„Приключили“: ${JSON.stringify([...finished])}`)
  // Преиграване: същата стая — score update-ите/повторният край не пипат флага; повторен
  // recordMatchStarted за същата стая е no-op (историята остава един ред).
  store.recordMatchScoreUpdate(voiceRoom, 20, 10)
  store.recordMatchStarted({ roomId: voiceRoom, privateRoomId: randomUUID(), stake: 5000, teamA: team('a'), teamB: team('b'), voiceEnabled: false })
  store.recordMatchFinished(voiceRoom, 151, 120)
  const rows = (raw.prepare(`SELECT COUNT(*) AS n FROM private_room_matches WHERE room_id = ?`).get(voiceRoom) as { n: number }).n
  assert(rows === 1, `редове за стаята: ${rows}`)
  assert(store.getMatch(voiceRoom)?.voiceEnabled === true && dbValue(voiceRoom) === 1, 'флагът е загубен след преиграване')
})

for (const item of toClose) {
  try { item.close() } catch { /* затворена */ }
}
for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
console.log(`\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
