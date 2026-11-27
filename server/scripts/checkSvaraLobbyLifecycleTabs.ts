/**
 * checkSvaraLobbyLifecycleTabs.ts — целеви проверки за разделите
 * „Чакащи“ / „Играещи“ / „Приключили“ в лобито на „Свара“: данните идват от
 * съществуващия svara_tables_list (lobby / in-progress) и от записаните
 * приключили мачове (svara_match_snapshots, последните 2 часа). Само временна база.
 *
 * Пускане: npx tsx scripts/checkSvaraLobbyLifecycleTabs.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraLobby, SVARA_FINISHED_VISIBILITY_HOURS } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'

/** Фалшив часовник (като в checkSvaraPaidEconomyStage3V2) — за реалния таймерен път към „приключил“. */
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
const clock = new Clock()

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 600)}`}`) }
}
process.env.SVARA_TEST_ENABLED = '1'
const dir = mkdtempSync(join(tmpdir(), 'svara-tabs-'))
const dbPath = join(dir, 'svara.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
const raw = new DatabaseSync(dbPath)
const store = await createSvaraMatchSnapshotStore(dbPath)
const lobby = createSvaraLobby({
  persistence: store, clock, hasOtherGameCommitment: () => false, onError: () => {},
  getPublicProfile: (id: string) => ({ displayName: `Име ${id}`, avatarUrl: null, gender: null }),
} as never)
lobby.initializeRecovery()
const frames = new Map<string, any[]>()
const attach = (id: string, role: 'admin' | 'user' = 'admin') => {
  raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  frames.set(id, [])
  lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role }, profile: { profileId: id } }) as SvaraAccessSession, send: (f) => frames.get(id)!.push(typeof f === 'string' ? JSON.parse(f) : f) })
}
const lastList = (id: string) => frames.get(id)!.findLast((f) => f.type === 'svara_tables_list')
const counts = (list: any) => list ? { waiting: list.tables.filter((t: any) => t.phase === 'lobby').length, playing: list.tables.filter((t: any) => t.phase === 'in-progress').length, finished: (list.finished ?? []).length } : null

console.log('\n[1] Чакащи / Играещи — от съществуващия svara_tables_list')
attach('viewer'); attach('a1'); attach('a2'); attach('a3'); attach('plain', 'user')
lobby.handle('viewer', { type: 'request_svara_tables_list' } as never)
check('начало: 0 / 0 / 0, finished присъства (празен списък)', JSON.stringify(counts(lastList('viewer'))) === '{"waiting":0,"playing":0,"finished":0}' && Array.isArray(lastList('viewer')?.finished))
lobby.handle('a1', { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee: 5000, entryPercent: 1, startMode: 'auto' } as never)
check('създаване → абонатът получава обновен списък: 1 чакаща', JSON.stringify(counts(lastList('viewer'))) === '{"waiting":1,"playing":0,"finished":0}', counts(lastList('viewer')))
const matchId = frames.get('a1')!.findLast((f) => f.type === 'svara_table_updated')?.table.matchId as string
lobby.handle('a2', { type: 'join_svara_table', matchId, requestId: randomUUID() } as never)
check('пълна маса → старт → 0 чакащи, 1 играеща', JSON.stringify(counts(lastList('viewer'))) === '{"waiting":0,"playing":1,"finished":0}', counts(lastList('viewer')))
lobby.handle('a3', { type: 'create_svara_table', requestId: randomUUID(), capacity: 3, entryFee: 8000, entryPercent: 1, startMode: 'manual' } as never)
const second = frames.get('a3')!.findLast((f) => f.type === 'svara_table_updated')?.table.matchId as string
check('втора маса → 1 чакаща, 1 играеща', JSON.stringify(counts(lastList('viewer'))) === '{"waiting":1,"playing":1,"finished":0}', counts(lastList('viewer')))
lobby.handle('a3', { type: 'leave_svara_table', matchId: second, requestId: randomUUID() } as never)
check('освобождаване (създателят напуска) → 0 чакащи, закритата маса не е в „Приключили“', JSON.stringify(counts(lastList('viewer'))) === '{"waiting":0,"playing":1,"finished":0}', counts(lastList('viewer')))

console.log('\n[2] Приключили — от записаните snapshot-и (последните 2 часа)')
{
  const row = raw.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string }
  const asFinished = (id: string, finishedAgo: string) => {
    const snap = JSON.parse(row.snapshot_json)
    snap.matchId = id; snap.state.phase = 'finished'; snap.state.winnerId = 'a2'
    raw.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json, finished_at) VALUES (?, 1, ?, 'finished', ?, datetime('now', ?))`)
      .run(id, snap.revision, JSON.stringify(snap), finishedAgo)
  }
  asFinished('fin-recent', '-10 minutes')
  asFinished('fin-old', `-${SVARA_FINISHED_VISIBILITY_HOURS + 1} hours`)
  raw.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json, finished_at) VALUES ('fin-broken', 1, 0, 'finished', '{"bad":1}', CURRENT_TIMESTAMP)`).run()
  lobby.handle('viewer', { type: 'request_svara_tables_list' } as never)
  const list = lastList('viewer')
  check('1 приключил (последните 2 часа); старият и повреденият не се показват', list?.finished?.length === 1 && list.finished[0].matchId === 'fin-recent', list?.finished)
  const fin = list?.finished?.[0]
  check('данни: вход, играчи с имена, победител, време на приключване', fin?.entryFee === 5000 && fin.capacity === 2 && fin.winnerId === 'a2'
    && JSON.stringify(fin.players.map((p: any) => p.displayName).sort()) === JSON.stringify(['Име a1', 'Име a2']) /* игровият ред е случаен (разбъркване при старта) */ && Math.abs(Date.now() - 10 * 60_000 - fin.finishedAt) < 5 * 60_000, fin)
  const json = JSON.stringify(fin)
  check('без карти, банки и вътрешно състояние', !/hand|card|deck|stack|round|ledger|seed|absence/i.test(json), json)
}

console.log('\n[2б] Реално приключване → автоматично обновяване')
{
  lobby.handle('a1', { type: 'leave_svara_table', matchId, requestId: randomUUID() } as never)
  clock.advance(10 * 60_000)
  const list = lastList('viewer')
  const status = (raw.prepare('SELECT match_status AS s FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { s: string }).s
  check('играч напуска играещия мач → мачът приключва; абонатът получава 0 играещи и мача в „Приключили“',
    status === 'finished' && counts(list)?.playing === 0 && list.finished.some((m: any) => m.matchId === matchId && m.winnerId === 'a2'), { status, counts: counts(list), finished: list?.finished?.map((m: any) => m.matchId) })
}

console.log('\n[2в] Всички мачове от последните 2 часа (без лимит 30), най-новите първи, без измислен победител')
{
  const row = raw.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string }
  const insert = raw.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json, finished_at) VALUES (?, 1, ?, 'finished', ?, datetime('now', ?))`)
  for (let i = 0; i < 35; i++) {
    const snap = JSON.parse(row.snapshot_json)
    snap.matchId = `bulk-${String(i).padStart(2, '0')}`; snap.state.winnerId = i === 0 ? null : 'a1'
    insert.run(snap.matchId, snap.revision, JSON.stringify(snap), `-${20 + i * 2} minutes`)
  }
  lobby.handle('viewer', { type: 'request_svara_tables_list' } as never)
  const finished = lastList('viewer')?.finished ?? []
  const total = (raw.prepare(`SELECT count(*) AS c FROM svara_match_snapshots WHERE match_status = 'finished' AND match_id <> 'fin-broken' AND finished_at >= datetime('now', '-${SVARA_FINISHED_VISIBILITY_HOURS} hours')`).get() as { c: number }).c
  check(`брояч = действителен брой (${total} > 30)`, total > 30 && finished.length === total, { total, got: finished.length })
  check('най-новите първи', finished.every((m: any, i: number) => i === 0 || finished[i - 1].finishedAt >= m.finishedAt))
  const noWinner = finished.find((m: any) => m.matchId === 'bulk-00')
  check('мач без определен победител → winnerId null (не се измисля)', noWinner !== undefined && noWinner.winnerId === null, noWinner)
}

console.log('\n[3] Ограничен достъп')
{
  const before = frames.get('plain')!.length
  lobby.handle('plain', { type: 'request_svara_tables_list' } as never)
  const got = frames.get('plain')!.slice(before)
  check('обикновен профил не получава списъци и приключили мачове', !got.some((f) => f.type === 'svara_tables_list') && got.some((f) => f.type === 'svara_lobby_error'), got)
}

console.log('\n[4] Клиент (статично)')
{
  const src = readFileSync(join(import.meta.dirname, '../../src/app/games/svara/createSvaraLobbyController.ts'), 'utf8')
  check('три раздела с реални броячи (lobby / in-progress / finished)', src.includes("lifecycleTabButtonHtml('waiting', 'Чакащи', waiting.length)") && src.includes("lifecycleTabButtonHtml('playing', 'Играещи', playing.length)") && src.includes("lifecycleTabButtonHtml('finished', 'Приключили', finishedMatches.length)"))
  check('победител: 🏆 до името + ред „Победител:“; иначе „Няма определен победител“', src.includes("'<span aria-label=\"Победител\" style=\"flex-shrink:0;\">🏆</span>'") && src.includes('🏆 Победител: ') && src.includes('Няма определен победител'))
  check('стиловете на табовете са тези на Ludo (тъмен и светъл)', src.includes("rgba(212,165,32,0.18)") && src.includes("#F4F0FF") && src.includes('grid-template-areas:"playing finished" "waiting waiting"'))
}

lobby.shutdown()
raw.close()
store.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows */ }
console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
