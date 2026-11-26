/**
 * checkSvaraAdminEntriesStage4V.ts — целеви проверки за Етап 4В:
 * „Стаи за мач → Свара“ (входове, активност, комисиона, награда) върху
 * общата финансова конфигурация от 3В, показване в лобито/формата и
 * неизменност на започнали мачове. Само временна база.
 *
 * Пускане: npx tsx scripts/checkSvaraAdminEntriesStage4V.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { parseSvaraLobbyMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import { getSvaraTableCreationOptions } from '../src/games/svara/svaraTableCreationOptions.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import { renderAdminMatchRoomsTabs, renderAdminSvaraEntriesSection } from '../../src/app/lobby/adminSvaraEntries.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 700)}`}`) }
}
const SERVER_ROOT = join(import.meta.dirname, '..')
process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-admin-4v-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const store = await createSvaraEconomyStore(dbPath)
store.ensureDefaultConfig()
const list = () => { const r = store.listSvaraEntries(); if (!r.ok) throw new Error(r.message); return r.value }
const entry = (fee: number) => list().entries.find((e) => e.entryFee === fee)

console.log('\n[1] Зареждане на конфигурираните 13 входа (без повторно създаване)')
{
  const v = list()
  check('13 входа, всички активни, 20% по подразбиране', v.entries.length === 13 && v.entries.every((e) => e.isEnabled && e.commissionBps === 2_000 && e.commissionSource === 'default'))
  check('наградата се вижда: 5 000 → 8 000 / 12 000 / 16 000', JSON.stringify(entry(5_000)?.prizeByCapacity) === JSON.stringify({ 2: 8_000, 3: 12_000, 4: 16_000 }))
  store.ensureDefaultConfig(); store.ensureDefaultConfig()
  check('повторно „създаване“ на началните стойности → пак 13, без дубликати', list().entries.length === 13 && (raw.prepare(`SELECT COUNT(*) AS n FROM game_financial_configs WHERE game_key = 'svara'`).get() as { n: number }).n === 1)
}

console.log('\n[2] Добавяне и редакция')
{
  const added = store.upsertSvaraEntry({ entryFee: 250_000, isEnabled: true, commissionPercent: null })
  check('нов вход 250 000 → добавен, активен, награда 400 000 при 2 играчи', added.ok && entry(250_000)?.isEnabled === true && entry(250_000)?.prizeByCapacity[2] === 400_000)
  const again = store.upsertSvaraEntry({ entryFee: 250_000, isEnabled: true, commissionPercent: null })
  check('същият вход отново → редакция, не дубликат (14 входа)', again.ok && list().entries.length === 14 && list().entries.filter((e) => e.entryFee === 250_000).length === 1)
  const versionBefore = list().configVersion
  const edited = store.upsertSvaraEntry({ entryFee: 20_000, isEnabled: true, commissionPercent: '25' })
  check('комисиона за конкретен вход 20 000 → 25% (entry); наградите 30 000 / 45 000 / 60 000', edited.ok && entry(20_000)?.commissionBps === 2_500 && entry(20_000)?.commissionSource === 'entry'
    && JSON.stringify(entry(20_000)?.prizeByCapacity) === JSON.stringify({ 2: 30_000, 3: 45_000, 4: 60_000 }))
  check('другите входове остават с 20%', entry(15_000)?.commissionBps === 2_000)
  check('версията на конфигурацията се сменя при запис', list().configVersion !== versionBefore && list().configVersion.startsWith('admin-'))
  const reset = store.upsertSvaraEntry({ entryFee: 20_000, isEnabled: true, commissionPercent: '' })
  check('празна комисиона → обратно по подразбиране', reset.ok && entry(20_000)?.commissionSource === 'default' && entry(20_000)?.commissionBps === 2_000)
  const decimal = store.upsertSvaraEntry({ entryFee: 40_000, isEnabled: true, commissionPercent: '12,5' })
  check('12,5% за 40 000 → приема се (70 000 / 105 000 / 140 000)', decimal.ok && entry(40_000)?.commissionBps === 1_250 && JSON.stringify(entry(40_000)?.prizeByCapacity) === JSON.stringify({ 2: 70_000, 3: 105_000, 4: 140_000 }), decimal)
  const inexact = store.upsertSvaraEntry({ entryFee: 50_000, isEnabled: true, commissionPercent: '12,5' })
  check('12,5% за 50 000 → отказ (131 250 при 3 играчи не е кратно на закръглянето)', !inexact.ok && entry(50_000)?.commissionSource === 'default', inexact)
}

console.log('\n[3] Валидиране (нищо не се записва при грешка)')
{
  const before = JSON.stringify(list().entries)
  const cases: Array<[string, Record<string, unknown>]> = [
    ['4 900 (под минимума)', { entryFee: 4_900, isEnabled: true, commissionPercent: null }],
    ['5 500 (не е кратно на 1 000)', { entryFee: 5_500, isEnabled: true, commissionPercent: null }],
    ['1 000 001 000 (над максимума)', { entryFee: 1_000_001_000, isEnabled: true, commissionPercent: null }],
    ['комисиона 9,99%', { entryFee: 30_000, isEnabled: true, commissionPercent: '9,99' }],
    ['комисиона 50,01%', { entryFee: 30_000, isEnabled: true, commissionPercent: '50.01' }],
    ['комисиона 12,345%', { entryFee: 30_000, isEnabled: true, commissionPercent: '12,345' }],
    ['активност като низ', { entryFee: 30_000, isEnabled: 'yes', commissionPercent: null }],
    ['неточно разпределение (12,34% за 5 000)', { entryFee: 5_000, isEnabled: true, commissionPercent: '12,34' }],
  ]
  for (const [label, input] of cases) {
    const r = store.upsertSvaraEntry(input as never)
    check(`${label} → отказ`, !r.ok, r)
  }
  check('след отказите конфигурацията е непроменена', JSON.stringify(list().entries) === before)
}

console.log('\n[4] Изключване / включване и показване в лобито')
const snapshots = await createSvaraMatchSnapshotStore(dbPath)
const lobby = createSvaraLobby({ persistence: snapshots, hasOtherGameCommitment: () => false, svaraConfig: store, onError: () => {} })
lobby.initializeRecovery()
const frames = new Map<string, any[]>()
const attach = (id: string) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  frames.set(id, [])
  lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: 'admin' }, profile: { profileId: id } }) as SvaraAccessSession, send: (f) => frames.get(id)!.push(typeof f === 'string' ? JSON.parse(f) : f) })
}
const create = (id: string, entryFee: number) => {
  frames.set(id, [])
  lobby.handle(id, { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee, entryPercent: 1, startMode: 'manual' } as never)
  const own = frames.get(id)!
  return own.findLast((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')
}
{
  attach('u1'); attach('u2'); attach('u3')
  const created = create('u1', 20_000)
  check('маса с 20 000 (активен) → създадена, наградата от сървъра 32 000', created?.type === 'svara_table_updated' && created.table.prizeAmount === 32_000, created)
  const disabled = store.upsertSvaraEntry({ entryFee: 20_000, isEnabled: false, commissionPercent: null })
  check('изключване на 20 000 → isEnabled=false, остава в списъка', disabled.ok && entry(20_000)?.isEnabled === false && list().entries.some((e) => e.entryFee === 20_000))
  const refused = create('u2', 20_000)
  check('нова маса с изключения вход → отказ (invalid_input), без маса', refused?.type === 'svara_lobby_error' && refused.code === 'invalid_input' && lobby.findCommitment('u2') === null)
  const options = getSvaraTableCreationOptions(lobby.creationPrize)
  check('формата „Създай игра“: без 20 000, с новия 250 000 и наградата му', !options.entries.some((e) => e.entryFee === 20_000) && options.entries.some((e) => e.entryFee === 250_000 && e.prizeByCapacity?.[3] === 600_000))
  check('вече създадената чакаща маса с 20 000 остава и запазва входа си', lobby.findCommitment('u1') !== null && frames.get('u1')!.findLast((f) => f.type === 'svara_table_updated')?.table.entryFee === 20_000)
  const newFee = create('u3', 250_000)
  check('нова маса с добавения вход 250 000 → създадена без deploy', newFee?.type === 'svara_table_updated' && newFee.table.entryFee === 250_000, newFee)
  const enabled = store.upsertSvaraEntry({ entryFee: 20_000, isEnabled: true, commissionPercent: null })
  check('повторно включване на 20 000 → отново в формата', enabled.ok && getSvaraTableCreationOptions(lobby.creationPrize).entries.some((e) => e.entryFee === 20_000))
  for (const fee of list().entries.map((e) => e.entryFee).filter((fee) => fee !== 5_000)) store.upsertSvaraEntry({ entryFee: fee, isEnabled: false, commissionPercent: entry(fee)!.commissionSource === 'entry' ? String(entry(fee)!.commissionBps / 100) : null })
  const last = store.upsertSvaraEntry({ entryFee: 5_000, isEnabled: false, commissionPercent: null })
  check('последният активен вход не може да се изключи', !last.ok && entry(5_000)?.isEnabled === true)
  for (const fee of list().entries.map((e) => e.entryFee)) store.upsertSvaraEntry({ entryFee: fee, isEnabled: true, commissionPercent: entry(fee)!.commissionSource === 'entry' ? String(entry(fee)!.commissionBps / 100).replace('.', ',') : null })
  check('всички отново активни', list().entries.every((e) => e.isEnabled))
  lobby.shutdown()
}

console.log('\n[5] Започнали мачове пазят условията си')
{
  for (const id of ['f1', 'f2']) {
    raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
    raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = 1000000').run(id)
  }
  const collected = store.collectEntries({ matchId: 'started-1', entryFee: 35_000, participantIds: ['f1', 'f2'] })
  store.upsertSvaraEntry({ entryFee: 35_000, isEnabled: false, commissionPercent: '30' })
  const settled = store.settleMatch('started-1', 'f1')
  check('платен мач, започнал при 20%: след смяна на 30% и изключване → изплатено 56 000 (80%)', collected.ok && settled.ok && settled.prize === 56_000)
  store.upsertSvaraEntry({ entryFee: 35_000, isEnabled: true, commissionPercent: null })
  // Чакаща маса с вход, изключен след създаването ѝ, може да започне (условията се фиксират при старта).
  store.upsertSvaraEntry({ entryFee: 60_000, isEnabled: false, commissionPercent: null })
  const waitingStart = store.collectEntries({ matchId: 'waiting-1', entryFee: 60_000, participantIds: ['f1', 'f2'] })
  check('чакаща маса с вход, изключен след създаването ѝ → може да започне', waitingStart.ok)
  store.upsertSvaraEntry({ entryFee: 60_000, isEnabled: true, commissionPercent: null })
}

console.log('\n[6] Парсер, Белот, HTTP и клиент')
{
  const parse = (entryFee: number) => parseSvaraLobbyMessage({ type: 'create_svara_table', requestId: 'r', capacity: 2, entryFee, entryPercent: 1, startMode: 'auto' })
  check('парсерът приема нов вход 250 000 (решава lobby-то по базата)', parse(250_000) !== null)
  check('парсерът отказва 5 500 / 4 000 / 1 000 001 000', parse(5_500) === null && parse(4_000) === null && parse(1_000_001_000) === null)
  const index = readFileSync(join(SERVER_ROOT, 'src/index.ts'), 'utf8')
  const handler = /async function handleAdminSvaraEntriesRequest[\s\S]*?\n}\r?\n/.exec(index)?.[0] ?? ''
  check('админ endpoint: само пълен admin, GET/POST, без изтриване', handler.includes('isFullAdminSession(session)') && handler.includes("req.method === 'GET'") && handler.includes("req.method === 'POST'") && !handler.includes('DELETE'))
  const belotNow = /async function handleAdminMatchRoomsRequest[\s\S]*?\n}\r?\n/.exec(index)?.[0]?.replace(/\r\n/g, '\n')
  const belotHead = /async function handleAdminMatchRoomsRequest[\s\S]*?\n}\r?\n/.exec(execFileSync('git', ['show', 'HEAD:server/src/index.ts'], { cwd: SERVER_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))?.[0]?.replace(/\r\n/g, '\n')
  check('Белот: /api/admin/rooms handler — без промени', !!belotNow && belotNow === belotHead)
  check('Белот: matchRoomsStore — без промени', execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src/db/matchRoomsStore.ts', 'src/db/matchEconomyStore.ts'], { cwd: SERVER_ROOT, encoding: 'utf8' }).trim() === '')
  const html = renderAdminSvaraEntriesSection({ game: 'svara', entries: list(), loading: false, errorText: null, edit: null })
  check('админ изглед: редове с вход, комисиона и награда при 2/3/4 играчи + бутоните', html.includes('data-admin-svara-entry="250000"') && html.includes('Награда — 2 играчи: 400') && html.includes('data-admin-svara-toggle') && html.includes('+ Добави вход'))
  check('превключвател Белот/Свара', renderAdminMatchRoomsTabs('svara').includes('data-admin-match-game="belot"') && renderAdminMatchRoomsTabs('svara').includes('data-admin-match-game="svara"'))
  const screen = readFileSync(join(SERVER_ROOT, '../src/app/lobby/renderLobbyScreen.ts'), 'utf8')
  check('„Стаи за мач“: Белот изгледът е запазен и се показва при избран Белот', screen.includes("state.adminSvara.game === 'svara' ? renderAdminSvaraEntriesSection(state.adminSvara) :") && screen.includes('data-admin-room-new="1"'))
  const svaraClient = readFileSync(join(SERVER_ROOT, '../src/app/games/svara/createSvaraLobbyController.ts'), 'utf8')
  check('формата избира първия разрешен вход от сървъра, ако избраният е изключен', svaraClient.includes('!result.entries.some((entry) => entry.entryFee === createDraft.entryFee)'))
}

raw.close()
store.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
