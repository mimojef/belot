/**
 * checkSvaraPublicAccessAndHeldStage5.ts — целеви проверки:
 *   • двата режима на достъп до „Свара“ (служебни роли / всички регистрирани)
 *     чрез админ настройката „Свара — Достъпна за всички“ — HTTP, WebSocket, старт;
 *   • при изключване: започнатите (платени) мачове продължават до край и се изплащат;
 *   • една и съща реална икономика в двата режима;
 *   • ръчно уреждане на задържани изплащания: одит, без двойно изплащане.
 * Само временна база.
 *
 * Пускане: npx tsx scripts/checkSvaraPublicAccessAndHeldStage5.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createSvaraEconomyStore } from '../src/db/svaraEconomyStore.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { handleSvaraHttpRequest } from '../src/games/svara/handleSvaraHttpRequest.js'
import { evaluateSvaraAccess, setSvaraPublicAccessProvider, type SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 600)}`}`) }
}
class Clock implements SvaraClock {
  constructor(public time = 1_800_000_000_000) {}
  jobs: Array<{ at: number; active: boolean; callback: () => void }> = []
  now = () => this.time
  schedule = (callback: () => void, delay: number) => { const job = { at: this.time + delay, active: true, callback }; this.jobs.push(job); return () => { job.active = false } }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let count = 0; count < 5_000; count++) {
      const job = this.jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!job) break
      this.time = job.at; job.active = false; job.callback()
    }
    this.time = end
  }
}

process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-public-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const START = 1_000_000
const profile = (id: string) => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, START)
}
const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
const roles = new Map<string, string>([['admin1', 'admin'], ['p1', 'player'], ['p2', 'player'], ['p3', 'player'], ['p4', 'player']])
const session = (id: string): SvaraAccessSession => ({ account: { role: roles.get(id)! }, profile: { profileId: id } })

console.log('\n[1] Правилото за достъп и настройката')
const settings = await createAdminSettingsStore(dbPath)
let publicAccess = settings.getSettings().svaraPublicAccessEnabled
setSvaraPublicAccessProvider(() => publicAccess)
const setPublic = (value: boolean) => {
  const result = settings.updateSettings({ svaraPublicAccessEnabled: value })
  if (!result.ok) throw new Error(result.message)
  publicAccess = result.settings.svaraPublicAccessEnabled
}
{
  check('по подразбиране: изключено (затворен режим)', publicAccess === false)
  check('затворен: admin ✓, обикновен профил ✗ (forbidden_role)', evaluateSvaraAccess(session('admin1')).allowed && evaluateSvaraAccess(session('p1')).allowed === false
    && (evaluateSvaraAccess(session('p1')) as { reason: string }).reason === 'forbidden_role')
  setPublic(true)
  check('публичен: обикновен профил ✓; без профил ✗; флагът SVARA_TEST_ENABLED остава първи', evaluateSvaraAccess(session('p1')).allowed
    && !evaluateSvaraAccess({ account: { role: 'player' }, profile: { profileId: null } }).allowed && !evaluateSvaraAccess(session('p1'), () => false).allowed)
  const reopened = await createAdminSettingsStore(dbPath)
  check('настройката се пази устойчиво (нова връзка вижда „включено“)', reopened.getSettings().svaraPublicAccessEnabled === true)
  check('невалидна стойност → отказ', !settings.updateSettings({ svaraPublicAccessEnabled: 'yes' as never }).ok)
  setPublic(false)
  check('изключване → обратно затворен режим', !evaluateSvaraAccess(session('p1')).allowed && (await createAdminSettingsStore(dbPath)).getSettings().svaraPublicAccessEnabled === false)
}

console.log('\n[2] WebSocket лоби и реална икономика в двата режима')
const economy = await createSvaraEconomyStore(dbPath)
const snapshots = await createSvaraMatchSnapshotStore(dbPath)
const clock = new Clock()
const lobby = createSvaraLobby({ persistence: snapshots, clock, hasOtherGameCommitment: () => false, onError: () => {},
  svaraConfig: economy, paidEconomy: economy, getProfileRole: (id: string) => roles.get(id) ?? null } as never)
lobby.initializeRecovery()
const frames = new Map<string, any[]>()
for (const id of roles.keys()) {
  profile(id)
  frames.set(id, [])
  lobby.attachConnection(id, { profileId: id, getSession: () => session(id), send: (f) => frames.get(id)!.push(typeof f === 'string' ? JSON.parse(f) : f) })
}
const last = (id: string, type?: string) => frames.get(id)!.findLast((f) => !type || f.type === type)
const MAIN = new Set(['svara_table_updated', 'svara_table_left', 'svara_lobby_error', 'svara_match_snapshot', 'svara_tables_list'])
const send = (id: string, message: Record<string, unknown>) => { frames.set(id, []); lobby.handle(id, { requestId: randomUUID(), ...message } as never); return frames.get(id)!.find((f) => MAIN.has(f.type)) }
let paidMatch = ''
{
  check('затворен: обикновен профил не може да създаде маса', send('p1', { type: 'create_svara_table', capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' })?.code === 'forbidden_role')
  check('затворен: обикновен профил не получава списък с маси', send('p1', { type: 'request_svara_tables_list' })?.type === 'svara_lobby_error')
  setPublic(true)
  const created = send('p1', { type: 'create_svara_table', capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  check('публичен: обикновен профил създава маса — без deploy/рестарт', created?.type === 'svara_table_updated', created)
  paidMatch = created.table.matchId
  send('p2', { type: 'join_svara_table', matchId: paidMatch })
  const finance = economy.getFinance(paidMatch)
  check('публичен: реално удържане от двамата (−5 000), фиксирани условия (награда 8 000)', finance?.status === 'collected' && balance('p1') === START - 5000 && balance('p2') === START - 5000
    && JSON.parse(finance.termsJson).prizes[0] === 8000, finance)
  setPublic(false)
  const state = send('p1', { type: 'request_svara_table_state', matchId: paidMatch })
  check('след изключване: участникът продължава собствения си мач (получава състоянието)', state?.type === 'svara_match_snapshot', state?.type)
  check('след изключване: нова маса / списък — отказ', send('p1', { type: 'create_svara_table', capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' })?.code === 'forbidden_role'
    && send('p3', { type: 'request_svara_tables_list' })?.type === 'svara_lobby_error')
  // Мачът приключва (изход + срок) и се изплаща, въпреки че публичният достъп е изключен.
  send('p1', { type: 'leave_svara_table', matchId: paidMatch })
  clock.advance(10 * 60_000)
  const settled = economy.getFinance(paidMatch)
  check('започнатият платен мач приключва и се изплаща (победител p2: +8 000)', settled?.status === 'paid' && settled.winnerProfileId === 'p2' && balance('p2') === START - 5000 + 8000, { settled, b: balance('p2') })
}

console.log('\n[3] Нов мач само ако всички човешки участници имат достъп')
{
  setPublic(true)
  const waiting = send('p3', { type: 'create_svara_table', capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  setPublic(false)
  const joined = send('admin1', { type: 'join_svara_table', matchId: waiting.table.matchId })
  check('публичният достъп е изключен, обикновен играч чака → admin не може да стартира мача с него', joined?.code === 'not_allowed' && balance('p3') === START && economy.getFinance(waiting.table.matchId) === null, joined)
  const left = send('p3', { type: 'leave_svara_table', matchId: waiting.table.matchId })
  check('…а обикновеният играч може само да напусне чакащата маса', left?.type === 'svara_table_left', left)
  check('…и не може да се присъедини към друга', send('p4', { type: 'join_svara_table', matchId: waiting.table.matchId })?.code === 'forbidden_role')
}

console.log('\n[4] HTTP /api/games/svara/access')
{
  const http = (id: string) => {
    let status = 0; let body: any = null
    handleSvaraHttpRequest({ method: 'GET' } as IncomingMessage, {} as ServerResponse, '/api/games/svara/access', {
      getSessionFromRequest: () => session(id), sendJsonResponse: (_res, code, payload) => { status = code; body = payload },
      isContinuingParticipant: (profileId) => lobby.isContinuingParticipant(profileId),
    })
    return { status, body }
  }
  check('затворен: обикновен профил без мач → 403', http('p4').status === 403)
  setPublic(true)
  check('публичен: обикновен профил → 200 granted с опции за маса', http('p4').status === 200 && http('p4').body.access === 'granted' && Array.isArray(http('p4').body.creationOptions?.entries))
  const t = send('p3', { type: 'create_svara_table', capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  send('p4', { type: 'join_svara_table', matchId: t.table.matchId })
  setPublic(false)
  const cont = http('p4')
  check('изключен, но в започнат мач → 200 само за довършване (continueOnly, без опции за нова маса)', cont.status === 200 && cont.body.continueOnly === true && cont.body.creationOptions === undefined, cont)
}

console.log('\n[5] Задържани изплащания: преглед и ръчно уреждане')
{
  for (const id of ['h1', 'h2', 'h3', 'h4']) profile(id)
  economy.collectEntries({ matchId: 'held-a', entryFee: 10_000, participantIds: ['h1', 'h2'] })
  economy.settleMatch('held-a', null)
  economy.collectEntries({ matchId: 'held-b', entryFee: 10_000, participantIds: ['h3', 'h4'] })
  economy.settleMatch('held-b', null)
  const list = economy.listHeldCases()
  const a = list.held.find((c) => c.matchId === 'held-a')
  check('преглед: задържаните (no-winner) с входовете и фиксираните условия (награда 16 000)', list.held.length === 2 && a?.heldReason === 'no-winner' && a.terms?.prize === 16_000 && a.debits.length === 2, a)
  const bad = [
    economy.settleHeldCase({ matchId: 'held-a', action: 'payout', winnerProfileId: 'h1', resolvedBy: 'admin1', note: 'ok', evidence: '' }),
    economy.settleHeldCase({ matchId: 'held-a', action: 'payout', winnerProfileId: 'h9', resolvedBy: 'admin1', note: 'ok', evidence: 'видео' }),
    economy.settleHeldCase({ matchId: 'held-a', action: 'refund', resolvedBy: 'admin1', note: ' ' }),
  ]
  check('без доказателство / победител извън мача / без бележка → отказ, без движение', bad.every((r) => !r.ok) && balance('h1') === START - 10_000 && balance('h2') === START - 10_000, bad)
  const paid = economy.settleHeldCase({ matchId: 'held-a', action: 'payout', winnerProfileId: 'h2', resolvedBy: 'admin1', note: 'проверен запис', evidence: 'журнал на мача' })
  check('изплащане по фиксираните условия: h2 +16 000, status paid', paid.ok && paid.status === 'paid' && balance('h2') === START - 10_000 + 16_000 && economy.getFinance('held-a')?.status === 'paid', paid)
  const again = economy.settleHeldCase({ matchId: 'held-a', action: 'refund', resolvedBy: 'admin1', note: 'повторно' })
  const payouts = (raw.prepare(`SELECT COUNT(*) AS n FROM svara_match_economy_ledger WHERE match_id LIKE 'held-a:%' AND entry_type IN ('svara_winner_payout', 'svara_entry_refund')`).get() as { n: number }).n
  check('повторно уреждане → отказ (not-held); само едно движение в ledger-а', !again.ok && again.code === 'not-held' && payouts === 1 && balance('h1') === START - 10_000)
  const refunded = economy.settleHeldCase({ matchId: 'held-b', action: 'refund', resolvedBy: 'admin1', note: 'спорен мач' })
  check('връщане на входовете: h3/h4 обратно на 1 000 000, status refunded', refunded.ok && balance('h3') === START && balance('h4') === START && economy.getFinance('held-b')?.status === 'refunded')
  const audit = economy.listHeldCases().resolved.find((c) => c.matchId === 'held-a')?.resolution
  check('одит: кой, кога, действие, бележка, доказателство, първоначалната причина', audit?.resolvedBy === 'admin1' && audit.action === 'payout' && audit.note === 'проверен запис' && audit.evidence === 'журнал на мача' && audit.heldReason === 'no-winner' && !!audit.resolvedAt, audit)
  // Невалидни условия → само връщане.
  economy.collectEntries({ matchId: 'held-c', entryFee: 10_000, participantIds: ['h1', 'h3'] })
  raw.prepare(`UPDATE svara_match_finance SET status = 'held', held_reason = 'invalid-terms', terms_json = '{"broken":1}' WHERE match_id = 'held-c'`).run()
  const refused = economy.settleHeldCase({ matchId: 'held-c', action: 'payout', winnerProfileId: 'h1', resolvedBy: 'admin1', note: 'x', evidence: 'y' })
  check('невалидни фиксирани условия → изплащане отказано, връщането е допустимо', !refused.ok && refused.code === 'invalid-terms'
    && economy.settleHeldCase({ matchId: 'held-c', action: 'refund', resolvedBy: 'admin1', note: 'невалидни условия' }).ok)
}

console.log('\n[6] Свързване (статично)')
{
  const index = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
  const handler = /async function handleAdminSvaraHeldPayoutsRequest[\s\S]*?\n}\r?\n/.exec(index)?.[0] ?? ''
  check('админ: само пълен admin; GET преглед / POST уреждане', handler.includes('isFullAdminSession(session)') && handler.includes("req.method === 'GET'") && handler.includes("req.method === 'POST'") && handler.includes('settleHeldCase('))
  check('настройката: кеш + provider, обновява се при запис', index.includes('setSvaraPublicAccessProvider(() => svaraPublicAccessEnabled)') && index.includes('svaraPublicAccessEnabled = result.settings.svaraPublicAccessEnabled'))
  check('лобито проверява ролята на участниците при старт', index.includes('getProfileRole: (profileId) => authStore.getAccountRoleForProfile(profileId)'))
  check('платеният режим остава зад SVARA_PAID_MATCHES_ENABLED (по подразбиране изключен)', /return process\.env\[ENV_FLAG_NAME\] === '1'/.test(readFileSync(join(import.meta.dirname, '../src/games/svara/svaraPaidEconomy.ts'), 'utf8')))
}

lobby.shutdown()
raw.close()
economy.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
