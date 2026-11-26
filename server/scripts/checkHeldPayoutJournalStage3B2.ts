/**
 * checkHeldPayoutJournalStage3B2.ts — резервен файлов журнал (write-ahead)
 * за задържаните изплащания (Етап 3Б.2, вариант А).
 *
 *   [1] Нормален случай: журнал → регистър → файлът се изтрива.
 *   [2] Отказ на SQLite: файлът остава с пълния запис; без движение на жълтици.
 *   [3] Рестарт при още счупена база → файлът остава; след оправяне → прехвърлен.
 *   [4] Повторен рестарт / срив между записа в регистъра и изтриването → без дубликат.
 *   [5] Прекъсване по време на записа на файла (временни файлове, отрязан файл).
 *   [6] Отказ и на журнала: ясна грешка, случаят остава в RAM; fsync грешка.
 *   [7] Guard: успешен повторен опит изтрива файла.
 *   [8] Свързване в index.ts (статично).
 *   [9] Истински срив (SIGKILL на дъщерен процес) + компилиран сървър
 *       (`node dist/index.js`): счупена база → файлът остава; оправена →
 *       прехвърлен (журналът печели пред диагностиката); трети старт — нищо.
 *
 * Изисква актуален dist за [9]: `npm run build`.
 * Пускане: npx tsx scripts/checkHeldPayoutJournalStage3B2.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, getRoomStakeLedgerScope, type MatchEconomyStore } from '../src/db/matchEconomyStore.js'
import type { BelotFinancialTerms } from '../src/economy/belotFinancialTerms.js'
import { createHeldPayoutJournal, heldPayoutJournalId, type HeldPayoutJournalFs } from '../src/economy/heldPayoutJournal.js'
import { createHeldPayoutRegistrationGuard } from '../src/economy/heldPayoutRegistrationGuard.js'

const SERVER_ROOT = join(import.meta.dirname, '..')
const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const START = 100_000

function seedProfile(db: DatabaseSync, id: string): void {
  db.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
  db.prepare('INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(id, START)
}

function heldRoom(economy: MatchEconomyStore, db: DatabaseSync, prefix: string, stake = 5_000): ServerRoom {
  let room = createServerRoom({ config: { allowBots: false, isPrivate: true, stakeAmount: stake } })
  for (const seat of SEATS) {
    const id = `${prefix}-${seat}`
    seedProfile(db, id)
    room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId: id, displayName: id } }))
  }
  if (!economy.collectRoomStakes(room, stake).ok) throw new Error('debit')
  return {
    ...room,
    config: { ...room.config, financialTerms: { rulesVersion: 'belot-legacy-fixed-prize-v1', prizePerWinner: 'corrupted' } as unknown as BelotFinancialTerms },
    game: { ...room.game, stateVersion: 25, authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never },
  }
}

// ─── Дъщерен процес за [9]: задържане при счупена база → SIGKILL ─────────
if (process.argv[2] === '--crash-child') {
  const [, , , dbPath, journalDir] = process.argv
  const journal = createHeldPayoutJournal(journalDir!)
  const economy = await createMatchEconomyStore(dbPath!, { heldPayoutJournal: journal })
  const db = new DatabaseSync(dbPath!)
  const room = heldRoom(economy, db, 'crash')
  // Запис за завършен мач (както recordCompletedMatch преди изплащането).
  const scope = getRoomStakeLedgerScope(room)
  const insert = db.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at) VALUES (?, ?, ?, ?, ?, 5000, datetime('now'))`)
  for (const seat of SEATS) insert.run(scope, `crash-${seat}`, room.id, seat === 'bottom' || seat === 'top' ? 'A' : 'B', seat === 'bottom' || seat === 'top' ? 1 : 0)
  const original = console.error
  console.error = () => {}
  const payout = economy.payoutMatchWinners(room)
  console.error = original
  writeSync(1, `${JSON.stringify({ scope, roomId: room.id, payout: payout.ok ? null : { recorded: payout.held?.recorded, journaled: payout.held?.journaled } })}\n`)
  // Срив веднага след връщането — без шанс за RAM повторни опити.
  process.kill(process.pid, 'SIGKILL')
  await sleep(10_000)
}

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const captureErrors = <T>(fn: () => T): { value: T; errors: string[] } => {
  const original = console.error
  const errors: string[] = []
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try { return { value: fn(), errors } } finally { console.error = original }
}

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => done(port))
    })
  })
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'held-journal-3b2-'))
  try {
    const dbPath = join(root, 'economy.sqlite')
    const journalDir = join(root, 'economy.held-payout-journal')
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const journal = createHeldPayoutJournal(journalDir)
    const economy = await createMatchEconomyStore(dbPath, { heldPayoutJournal: journal })
    const raw = new DatabaseSync(dbPath)
    const files = () => (existsSync(journalDir) ? readdirSync(journalDir) : [])
    const heldRow = (scope: string) => raw.prepare('SELECT hold_reason, status, hold_count FROM belot_held_payouts WHERE match_scope = ?').get(scope) as { hold_reason: string; status: string; hold_count: number } | undefined
    const coinMoves = () => (raw.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE entry_type IN ('winner_payout', 'stake_refund')`).get() as { n: number }).n
    const wallets = (prefix: string) => SEATS.map((s) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(`${prefix}-${s}`) as { b: number }).b)
    const failRegistry = () => raw.exec(`CREATE TRIGGER fail_held BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'database disk image is malformed (simulated)'); END;`)
    const fixRegistry = () => raw.exec('DROP TRIGGER IF EXISTS fail_held;')

    console.log('\n[1] Нормален случай: журнал → регистър → файлът се изтрива')
    {
      const room = heldRoom(economy, raw, 'n1')
      const p = captureErrors(() => economy.payoutMatchWinners(room)).value
      check('recorded=true, journaled=true', !p.ok && p.held?.recorded === true && p.held.journaled === true)
      check('регистърът има реда, журналът е празен', heldRow(getRoomStakeLedgerScope(room))?.status === 'pending_review' && files().length === 0)
    }

    console.log('\n[2] Отказ на SQLite → устойчив резервен запис')
    let scope2 = ''
    {
      const room = heldRoom(economy, raw, 's2')
      scope2 = getRoomStakeLedgerScope(room)
      failRegistry()
      const before = wallets('s2')
      const moves = coinMoves()
      const p = captureErrors(() => economy.payoutMatchWinners(room)).value
      check('recorded=false, journaled=true', !p.ok && p.held?.recorded === false && p.held.journaled === true, p)
      const file = join(journalDir, `held-${heldPayoutJournalId(scope2)}.json`)
      check('един файл със стабилно име (sha256 на match_scope)', files().length === 1 && existsSync(file))
      const entry = JSON.parse(readFileSync(file, 'utf8')) as { matchScope: string; record: { holdReason: string; winners: unknown[]; stakeDebits: unknown[]; financialTermsJson: string; participants: unknown[] } }
      check('файлът съдържа пълния запис (причина, победители, входове, условия, участници)', entry.matchScope === scope2 && entry.record.holdReason === 'invalid'
        && entry.record.winners.length === 2 && entry.record.stakeDebits.length === 4 && entry.record.participants.length === 4 && entry.record.financialTermsJson.includes('corrupted'))
      check('без ред в регистъра, без движение на жълтици', heldRow(scope2) === undefined && coinMoves() === moves && JSON.stringify(wallets('s2')) === JSON.stringify(before))
      const p2 = captureErrors(() => economy.payoutMatchWinners(room)).value
      check('повторно задържане на същия мач → пак един файл', !p2.ok && files().length === 1)
    }

    console.log('\n[3] Рестарт: счупена база → файлът остава; оправена → прехвърлен')
    {
      const replay = (j = createHeldPayoutJournal(journalDir)) => {
        const scan = j.scan()
        let transferred = 0
        for (const { files: fs, entry } of scan.entries) {
          if (economy.recordHeldPayout(entry.record, { replay: true }).ok) {
            transferred += 1
            j.removeFiles(fs)
          }
        }
        return { entries: scan.entries.length, transferred, unreadable: scan.unreadable.length }
      }
      const r1 = replay()
      check('базата още е счупена → нищо не е прехвърлено, файлът остава', r1.entries === 1 && r1.transferred === 0 && files().length === 1 && heldRow(scope2) === undefined)
      fixRegistry()
      const r2 = replay()
      check('базата е оправена → прехвърлен, файлът е изтрит', r2.transferred === 1 && files().length === 0)
      check('ред: invalid, pending_review, hold_count = 1', heldRow(scope2)?.hold_reason === 'invalid' && heldRow(scope2)?.status === 'pending_review' && heldRow(scope2)?.hold_count === 1)

      console.log('\n[4] Без дубликати: повторен рестарт и срив между запис и изтриване')
      const r3 = replay()
      check('повторен рестарт: нищо за прехвърляне', r3.entries === 0 && heldRow(scope2)?.hold_count === 1)
      // Срив СЛЕД записа в регистъра, ПРЕДИ изтриването на файла.
      const room = heldRoom(economy, raw, 's4')
      const scope4 = getRoomStakeLedgerScope(room)
      captureErrors(() => economy.payoutMatchWinners(room))
      check('нормално записан', heldRow(scope4)?.hold_count === 1 && files().length === 0)
      const journalDirect = createHeldPayoutJournal(journalDir)
      const rec4 = economy.getHeldPayout(scope4)!
      journalDirect.write({ ...rec4, context: rec4.context })
      check('файлът е „възкресен“ (симулира срив преди изтриването)', files().length === 1)
      const r4 = replay()
      check('прехвърляне → без нов ред, hold_count остава 1, файлът е изтрит', r4.transferred === 1 && heldRow(scope4)?.hold_count === 1 && files().length === 0)

      console.log('\n[5] Прекъсване по време на записа на файла')
      const room5 = heldRoom(economy, raw, 's5')
      const scope5 = getRoomStakeLedgerScope(room5)
      failRegistry()
      captureErrors(() => economy.payoutMatchWinners(room5))
      fixRegistry()
      const final5 = join(journalDir, `held-${heldPayoutJournalId(scope5)}.json`)
      // Цял временен файл (срив след fsync, преди rename) + отрязан временен файл.
      writeFileSync(`${final5}.tmp-999-complete`, readFileSync(final5, 'utf8'))
      writeFileSync(`${final5}.tmp-999-truncated`, readFileSync(final5, 'utf8').slice(0, 40))
      const scan5 = createHeldPayoutJournal(journalDir).scan()
      check('scan: един случай с 2 файла (финален + цял временен), отрязаният → unreadable', scan5.entries.length === 1 && scan5.entries[0]!.files.length === 2 && scan5.unreadable.length === 1)
      const r5 = replay()
      check('прехвърлен веднъж; цял временен файл също изтрит; отрязаният се пази за проверка', r5.transferred === 1 && heldRow(scope5)?.hold_count === 1
        && files().length === 1 && files()[0]!.endsWith('.tmp-999-truncated'))
      // Само временен файл (срив преди rename) → също се прехвърля.
      const room5b = heldRoom(economy, raw, 's5b')
      const scope5b = getRoomStakeLedgerScope(room5b)
      failRegistry()
      captureErrors(() => economy.payoutMatchWinners(room5b))
      fixRegistry()
      const final5b = join(journalDir, `held-${heldPayoutJournalId(scope5b)}.json`)
      writeFileSync(`${final5b}.tmp-1-only`, readFileSync(final5b, 'utf8'))
      ;(await import('node:fs')).unlinkSync(final5b)
      const r5b = replay()
      check('само цял временен файл → прехвърлен, изтрит', r5b.transferred === 1 && heldRow(scope5b)?.hold_count === 1 && !files().some((f) => f.includes(heldPayoutJournalId(scope5b))))
      ;(await import('node:fs')).unlinkSync(join(journalDir, files()[0]!))
    }

    console.log('\n[6] Отказ и на журнала → ясна грешка, без тихо изчезване')
    {
      // Журнал към път, който е ФАЙЛ (не директория) → mkdir/open гърмят.
      const blocker = join(root, 'not-a-directory')
      writeFileSync(blocker, 'x')
      const brokenJournal = createHeldPayoutJournal(join(blocker, 'journal'))
      const economyBroken = await createMatchEconomyStore(dbPath, { heldPayoutJournal: brokenJournal })
      const room = heldRoom(economyBroken, raw, 's6')
      failRegistry()
      const moves = coinMoves()
      const { value: p, errors } = captureErrors(() => economyBroken.payoutMatchWinners(room))
      check('recorded=false, journaled=false', !p.ok && p.held?.recorded === false && p.held.journaled === false)
      check('ясна грешка HELD PAYOUT UNPROTECTED с пълния запис', errors.some((e) => e.includes('HELD PAYOUT UNPROTECTED') && e.includes('"holdReason":"invalid"')))
      check('случаят е върнат за RAM повторни опити (held.record), без движение на жълтици', !p.ok && p.held?.recorded === false && p.held.record.winners.length === 2 && coinMoves() === moves)
      fixRegistry()
      // SQLite ок, журналът не → регистърът е достатъчен.
      const room6b = heldRoom(economyBroken, raw, 's6b')
      const p6b = captureErrors(() => economyBroken.payoutMatchWinners(room6b)).value
      check('журналът отказва, SQLite работи → recorded=true, journaled=false', !p6b.ok && p6b.held?.recorded === true && p6b.held.journaled === false)
      economyBroken.close()

      // fsync грешка → write връща ok:false и не оставя временен файл.
      const fsyncFailDir = join(root, 'fsync-fail')
      const real = await import('node:fs')
      const failingFs: HeldPayoutJournalFs = { ...real, fsyncSync: (() => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }) }) as typeof real.fsyncSync }
      const r = createHeldPayoutJournal(fsyncFailDir, failingFs).write(economy.getHeldPayout(getRoomStakeLedgerScope(room6b))!)
      check('fsync грешка → ok:false, без остатъчен временен файл', !r.ok && r.message.includes('EIO') && readdirSync(fsyncFailDir).length === 0)
    }

    console.log('\n[7] Guard: успешен повторен опит изтрива файла')
    {
      const room = heldRoom(economy, raw, 's7')
      const scope = getRoomStakeLedgerScope(room)
      failRegistry()
      const p = captureErrors(() => economy.payoutMatchWinners(room)).value
      const guard = createHeldPayoutRegistrationGuard({
        recordHeldPayout: (r) => economy.recordHeldPayout(r, { replay: true }),
        removeRoomSnapshot: () => {},
        isRoomActive: () => true,
        afterRecorded: (s) => { journal.remove(s) },
        log: () => {},
        error: () => {},
      })
      if (!p.ok && p.held?.recorded === false) guard.enqueue(p.held.record, p.held.error)
      guard.retryNow()
      check('базата още отказва → файлът и RAM записът остават', files().length === 1 && guard.pendingMatchScopes().includes(scope))
      fixRegistry()
      guard.retryNow()
      check('успех → ред в регистъра, файлът е изтрит, guard-ът е празен', heldRow(scope)?.hold_count === 1 && files().length === 0 && guard.pendingMatchScopes().length === 0)
    }

    console.log('\n[8] Свързване в index.ts (статично)')
    {
      const src = readFileSync(join(SERVER_ROOT, 'src/index.ts'), 'utf8')
      check('журналът е до файла на базата (<db>.held-payout-journal)', src.includes('.held-payout-journal`') && src.includes('dirname(databaseBootstrap.databaseFilePath)'))
      check('store-ът получава журнала', src.includes('createMatchEconomyStore(databaseBootstrap.databaseFilePath, { heldPayoutJournal })'))
      const boot = /function registerHeldPayoutsForRestoredRoomsOnBoot[\s\S]*?\n}\r?\n/.exec(src)?.[0] ?? ''
      const replayAt = boot.indexOf('replayHeldPayoutJournalOnBoot()')
      check('при старт: журнал → възстановени маси → диагностика', replayAt > 0 && replayAt < boot.indexOf('registerHeldPayoutForRestoredRoom(room)') && boot.indexOf('registerHeldPayoutForRestoredRoom(room)') < boot.indexOf('registerMissingPayoutsFromCompletionLedger()'))
      check('повторните опити са replay и трият файла', src.includes('matchEconomyStore.recordHeldPayout(record, { replay: true })') && src.includes('heldPayoutJournal.remove(matchScope)'))
      const store = readFileSync(join(SERVER_ROOT, 'src/db/matchEconomyStore.ts'), 'utf8')
      const writeAt = store.indexOf('heldPayoutJournal.write(record)')
      const recordAt = store.indexOf('const recorded = recordHeldPayout(record)', writeAt)
      const removeAt = store.indexOf('heldPayoutJournal!.remove(matchScope)', recordAt)
      check('write-ahead ред в store-а: журнал → регистър → изтриване', writeAt > 0 && recordAt > writeAt && removeAt > recordAt)
      check('журналът не движи жълтици', !/credit|wallet|ledger/i.test(readFileSync(join(SERVER_ROOT, 'src/economy/heldPayoutJournal.ts'), 'utf8').replace(/\/\/.*$/gm, '')))
    }
    raw.close()
    economy.close()

    console.log('\n[9] Истински срив (SIGKILL) + компилиран сървър')
    {
      const dist = readFileSync(join(SERVER_ROOT, 'dist', 'index.js'), 'utf8')
      check('dist е актуален (replayHeldPayoutJournalOnBoot)', dist.includes('replayHeldPayoutJournalOnBoot()'))
      const serverDir = join(root, 'server')
      await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
      await cp(join(SERVER_ROOT, 'dist'), join(serverDir, 'dist'), { recursive: true })
      await cp(join(SERVER_ROOT, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
      await cp(join(SERVER_ROOT, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true })
      await cp(join(SERVER_ROOT, 'package.json'), join(serverDir, 'package.json'))
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      await symlink(join(SERVER_ROOT, 'node_modules'), join(serverDir, 'node_modules'), linkType)
      await symlink(join(SERVER_ROOT, '..', 'node_modules'), join(root, 'node_modules'), linkType)
      const ready = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
      const sDb = ready.databaseFilePath
      const sJournal = join(dirname(sDb), 'belot-v2.held-payout-journal')
      check('временна база и журнал в изолирания root', sDb.startsWith(root) && sJournal.startsWith(root))
      const db = new DatabaseSync(sDb)
      db.exec(`CREATE TRIGGER fail_held BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END;`)

      const child = spawn(process.execPath, [join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(SERVER_ROOT, 'scripts', 'checkHeldPayoutJournalStage3B2.ts'), '--crash-child', sDb, sJournal], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c })
      child.stderr.setEncoding('utf8').on('data', () => {})
      const exit = await new Promise<{ code: number | null; signal: string | null }>((done) => child.once('exit', (code, signal) => done({ code, signal })))
      const childResult = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { scope: string; roomId: string; payout: { recorded: boolean; journaled: boolean } | null }
      check('дъщерният процес е убит (SIGKILL) след задържането', exit.signal === 'SIGKILL' || (exit.code !== 0 && exit.code !== null), exit)
      check('в момента на срива: recorded=false, journaled=true', childResult.payout?.recorded === false && childResult.payout.journaled === true, childResult)
      const sFiles = () => (existsSync(sJournal) ? readdirSync(sJournal) : [])
      const sRow = () => db.prepare('SELECT hold_reason, hold_count FROM belot_held_payouts WHERE match_scope = ?').get(childResult.scope) as { hold_reason: string; hold_count: number } | undefined
      const sWallets = () => SEATS.map((s) => (db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(`crash-${s}`) as { b: number }).b)
      check('след срива: файлът е на диска, регистърът е празен', sFiles().length === 1 && sRow() === undefined)
      const walletsAfterCrash = JSON.stringify(sWallets())

      const runServer = async (): Promise<string> => {
        const port = await freePort()
        const chunks: string[] = []
        const proc = spawn(process.execPath, [join('dist', 'index.js')], {
          cwd: serverDir,
          env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1', PASSWORD_RESET_RATE_LIMIT_SECRET: 'stage3b2-journal-check-secret-0123456789' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        proc.stdout.setEncoding('utf8').on('data', (c: string) => chunks.push(c))
        proc.stderr.setEncoding('utf8').on('data', (c: string) => chunks.push(c))
        const deadline = Date.now() + 60_000
        let up = false
        while (Date.now() < deadline && proc.exitCode === null) {
          try { if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) { up = true; break } } catch { /* not yet */ }
          await sleep(150)
        }
        proc.kill('SIGTERM')
        await new Promise<void>((done) => { const t = setTimeout(() => { proc.kill('SIGKILL'); done() }, 10_000); proc.once('exit', () => { clearTimeout(t); done() }) })
        if (!up) throw new Error(`server did not start\n${chunks.join('')}`)
        return chunks.join('')
      }

      const out1 = await runServer()
      check('старт 1 (базата още отказва): сървърът тръгва, файлът остава, няма ред', sFiles().length === 1 && sRow() === undefined)
      check('старт 1: логва неуспешното прехвърляне', out1.includes('held payout journal replay entries=1 transferred=0'))
      db.exec('DROP TRIGGER fail_held;')
      const out2 = await runServer()
      check('старт 2 (базата е оправена): прехвърлен, файлът е изтрит', out2.includes('held payout journal replay entries=1 transferred=1') && sFiles().length === 0)
      check('журналът печели пред диагностиката: причина invalid (не payout-missing), hold_count = 1', sRow()?.hold_reason === 'invalid' && sRow()?.hold_count === 1)
      const out3 = await runServer()
      check('старт 3: нищо за прехвърляне, без дубликат', !out3.includes('held payout journal replay') && sRow()?.hold_count === 1
        && (db.prepare('SELECT COUNT(*) AS n FROM belot_held_payouts WHERE match_scope = ?').get(childResult.scope) as { n: number }).n === 1)
      check('без автоматично движение на жълтици', JSON.stringify(sWallets()) === walletsAfterCrash
        && (db.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE entry_type IN ('winner_payout', 'stake_refund')`).get() as { n: number }).n === 0)
      db.close()
    }
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

if (process.argv[2] !== '--crash-child') {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
