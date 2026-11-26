/**
 * checkHeldPayoutJournalBackupRestoreStage3B2.ts — backup + restore на
 * файловия журнал на задържаните изплащания (Етап 3Б.2) с ИСТИНСКИТЕ
 * ops/pikabg-backup/scripts/pikabg-db-backup и pikabg-restore.
 *
 * Сценарий:
 *   - „жива“ временна база + журнал: случай A е САМО в журнала (регистърът
 *     отказва), случай B също е в журнала, случай C е нормално в регистъра;
 *   - backup (PIKABG_BACKUP_LOCAL_ONLY=1); тестовият hook между snapshot-а на
 *     журнала и DB snapshot-а прехвърля B в SQLite и трие файла му
 *     (състезанието „прехвърляне по време на backup“);
 *   - restore на базата + uploads + журнала в scratch директория;
 *   - възстановените файлове → нов изолиран сървър → компилиран старт ×2.
 *
 * Инструменти: zstd/sqlite3/flock/ionice липсват на Windows dev машината —
 * както в ops/pikabg-backup/README.md („Test methodology“) се ползват
 * временни stub-ове САМО за този тест (passthrough компресия, node:sqlite за
 * VACUUM INTO/PRAGMA). Bash логиката на скриптовете е истинската.
 *
 * Изисква актуален dist: `npm run build`.
 * Пускане: npx tsx scripts/checkHeldPayoutJournalBackupRestoreStage3B2.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
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
import { createHeldPayoutJournal, heldPayoutJournalId } from '../src/economy/heldPayoutJournal.js'

const SERVER_ROOT = join(import.meta.dirname, '..')
const OPS_SCRIPTS = join(SERVER_ROOT, '..', 'ops', 'pikabg-backup', 'scripts')
const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const JOURNAL_NAME = 'belot-v2.held-payout-journal'

// ─── Режим „inject“: извиква се от тестовия hook на backup скрипта ────────
// Прехвърля даден случай от журнала в SQLite и трие файла (същото като
// replayHeldPayoutJournalOnBoot), МЕЖДУ snapshot-а на журнала и DB snapshot-а.
if (process.argv[2] === '--inject-transfer') {
  const [, , , dbPath, journalDir, scope] = process.argv
  const db = new DatabaseSync(dbPath!)
  db.exec('DROP TRIGGER IF EXISTS fail_b;')
  db.close()
  const journal = createHeldPayoutJournal(journalDir!)
  const economy = await createMatchEconomyStore(dbPath!)
  const target = journal.scan().entries.find((e) => e.entry.matchScope === scope)
  if (!target) throw new Error('inject: entry not found')
  const r = economy.recordHeldPayout(target.entry.record, { replay: true })
  if (!r.ok) throw new Error(`inject: ${r.message}`)
  const removed = journal.removeFiles(target.files)
  if (!removed.ok) throw new Error(`inject: ${removed.message}`)
  economy.close()
  process.stdout.write('[inject] transferred B into SQLite and removed its journal file\n')
  process.exit(0)
}

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 2000)}`}`)
  }
}

/** Път за bash (Git Bash на Windows приема /c/... форма). */
function sh(p: string): string {
  if (process.platform !== 'win32') return p
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
}

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'
}

function writeStubs(binDir: string): void {
  mkdirSync(binDir, { recursive: true })
  const zstdStub = join(binDir, 'zstd-stub.cjs')
  writeFileSync(zstdStub, `
const fs = require('fs')
const args = process.argv.slice(2)
let out = null
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { out = args[++i]; continue }
  if (args[i].startsWith('-')) continue
  positional.push(args[i])
}
const flags = args.filter((a) => a.startsWith('-'))
if (flags.includes('-t')) { for (const p of positional) fs.accessSync(p, fs.constants.R_OK); process.exit(0) }
if (flags.includes('-dc') || (flags.includes('-d') && flags.includes('-c'))) { process.stdout.write(fs.readFileSync(positional[0])); process.exit(0) }
const data = positional.length > 0 ? fs.readFileSync(positional[0]) : fs.readFileSync(0)
fs.writeFileSync(out, data)
`)
  const sqliteStub = join(binDir, 'sqlite3-stub.cjs')
  writeFileSync(sqliteStub, `
const fs = require('fs')
const { DatabaseSync } = require('node:sqlite')
const args = process.argv.slice(2)
const readOnly = args.includes('-readonly')
const positional = args.filter((a) => !a.startsWith('-'))
let sql = positional[1] ?? fs.readFileSync(0, 'utf8')
// Git Bash не превежда /c/... пътища ВЪТРЕ в SQL текста (VACUUM INTO '...').
if (process.platform === 'win32') sql = sql.replace(/'\\/([a-zA-Z])\\//g, (_m, d) => "'" + d.toUpperCase() + ':/')
const db = new DatabaseSync(positional[0], { readOnly })
if (/^\\s*PRAGMA\\s+(integrity_check|foreign_key_check)/i.test(sql)) {
  for (const row of db.prepare(sql).all()) process.stdout.write(Object.values(row).join('|') + '\\n')
} else {
  db.exec(sql)
}
db.close()
`)
  const nodeWin = process.execPath
  const wrap = (name: string, stub: string) => {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\nexec "${sh(nodeWin)}" "${sh(stub)}" "$@"\n`)
    chmodSync(join(binDir, name), 0o755)
    writeFileSync(join(binDir, `${name}.cmd`), `@"${nodeWin}" "${stub}" %*\r\n`)
  }
  wrap('zstd', zstdStub)
  wrap('sqlite3', sqliteStub)
  writeFileSync(join(binDir, 'flock'), '#!/usr/bin/env bash\nexit 0\n')
  writeFileSync(join(binDir, 'ionice'), '#!/usr/bin/env bash\nwhile [[ "$1" == -* ]]; do shift; done\nexec "$@"\n')
  chmodSync(join(binDir, 'flock'), 0o755)
  chmodSync(join(binDir, 'ionice'), 0o755)
}

function copyScriptLf(name: string, destDir: string): string {
  const dest = join(destDir, name)
  writeFileSync(dest, readFileSync(join(OPS_SCRIPTS, name), 'utf8').replace(/\r\n/g, '\n'))
  chmodSync(dest, 0o755)
  return dest
}

function runBash(script: string, args: string[], env: Record<string, string>, binDir: string): { code: number | null; out: string } {
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const r = spawnSync(bashExecutable(), [sh(script), ...args], {
    env: { ...process.env, ...env, PATH: `${binDir}${pathSep}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function heldRoom(economy: MatchEconomyStore, db: DatabaseSync, prefix: string): ServerRoom {
  let room = createServerRoom({ config: { allowBots: false, isPrivate: true, stakeAmount: 5_000 } })
  for (const seat of SEATS) {
    const id = `${prefix}-${seat}`
    db.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
    db.prepare('INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000)').run(id)
    room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId: id, displayName: id } }))
  }
  if (!economy.collectRoomStakes(room, 5_000).ok) throw new Error('debit')
  return {
    ...room,
    config: { ...room.config, financialTerms: { rulesVersion: 'belot-legacy-fixed-prize-v1', prizePerWinner: 'corrupted' } as unknown as BelotFinancialTerms },
    game: { ...room.game, stateVersion: 25, authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never },
  }
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

async function prepareServerDir(serverDir: string, rootForModules: string): Promise<void> {
  mkdirSync(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(SERVER_ROOT, 'dist'), join(serverDir, 'dist'), { recursive: true })
  await cp(join(SERVER_ROOT, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(SERVER_ROOT, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true })
  await cp(join(SERVER_ROOT, 'package.json'), join(serverDir, 'package.json'))
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(SERVER_ROOT, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  if (!existsSync(join(rootForModules, 'node_modules'))) {
    await symlink(join(SERVER_ROOT, '..', 'node_modules'), join(rootForModules, 'node_modules'), linkType)
  }
}

async function runServer(serverDir: string): Promise<string> {
  const port = await freePort()
  const chunks: string[] = []
  const proc = spawn(process.execPath, [join('dist', 'index.js')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1', PASSWORD_RESET_RATE_LIMIT_SECRET: 'stage3b2-backup-restore-secret-012345' },
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

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'held-journal-backup-3b2-'))
  try {
    const binDir = join(root, 'bin')
    writeStubs(binDir)
    const opsDir = join(root, 'ops')
    mkdirSync(opsDir)
    const backupScript = copyScriptLf('pikabg-db-backup', opsDir)
    const restoreScript = copyScriptLf('pikabg-restore', opsDir)
    copyScriptLf('pikabg-backup-verify-consistency.mjs', opsDir)

    console.log('\n[1] „Жива“ база + журнал (временни)')
    const liveServer = join(root, 'live', 'server')
    mkdirSync(join(liveServer, 'uploads', 'avatars'), { recursive: true })
    writeFileSync(join(liveServer, 'uploads', 'avatars', 'keep.txt'), 'x')
    await cp(join(SERVER_ROOT, 'database', 'migrations'), join(liveServer, 'database', 'migrations'), { recursive: true })
    const ready = await ensureServerDatabaseReady({ serverRootOverride: liveServer })
    const liveDb = ready.databaseFilePath
    const liveJournal = join(dirname(liveDb), JOURNAL_NAME)
    check('временна база в изолирания root', liveDb.startsWith(root))
    const journal = createHeldPayoutJournal(liveJournal)
    const economy = await createMatchEconomyStore(liveDb, { heldPayoutJournal: journal })
    const db = new DatabaseSync(liveDb)

    const roomA = heldRoom(economy, db, 'a')
    const roomB = heldRoom(economy, db, 'b')
    const roomC = heldRoom(economy, db, 'c')
    const [scopeA, scopeB, scopeC] = [roomA, roomB, roomC].map(getRoomStakeLedgerScope)
    db.exec(`CREATE TRIGGER fail_a BEFORE INSERT ON belot_held_payouts WHEN NEW.match_scope = '${scopeA}' BEGIN SELECT RAISE(ABORT, 'simulated'); END;`)
    db.exec(`CREATE TRIGGER fail_b BEFORE INSERT ON belot_held_payouts WHEN NEW.match_scope = '${scopeB}' BEGIN SELECT RAISE(ABORT, 'simulated'); END;`)
    const silenceErr = console.error
    console.error = () => {}
    const pA = economy.payoutMatchWinners(roomA)
    const pB = economy.payoutMatchWinners(roomB)
    const pC = economy.payoutMatchWinners(roomC)
    console.error = silenceErr
    check('A и B — само в журнала; C — в регистъра', !pA.ok && pA.held?.recorded === false && !pB.ok && pB.held?.recorded === false && !pC.ok && pC.held?.recorded === true)
    check('журналът има 2 файла', readdirSync(liveJournal).filter((f) => f.startsWith('held-')).length === 2)
    const walletsBefore = JSON.stringify(db.prepare(`SELECT profile_id, yellow_coins_balance FROM profile_wallets WHERE profile_id GLOB '[abc]-*' ORDER BY profile_id`).all())

    console.log('\n[2] Backup с прехвърляне на B МЕЖДУ snapshot-а на журнала и DB snapshot-а')
    const backupRoot = join(root, 'backups')
    const tsxCli = join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const injectCmd = `"${sh(process.execPath)}" "${sh(tsxCli)}" "${sh(join(SERVER_ROOT, 'scripts', 'checkHeldPayoutJournalBackupRestoreStage3B2.ts'))}" --inject-transfer "${sh(liveDb)}" "${sh(liveJournal)}" "${scopeB}"`
    const backup = runBash(backupScript, [], {
      PIKABG_DB_PATH: sh(liveDb),
      PIKABG_UPLOADS_DIR: sh(join(liveServer, 'uploads')),
      PIKABG_HELD_PAYOUT_JOURNAL_DIR: sh(liveJournal),
      PIKABG_LOCAL_ROOT: sh(backupRoot),
      PIKABG_LOCK_FILE: sh(join(root, 'backup.lock')),
      PIKABG_BACKUP_LOCAL_ONLY: '1',
      PIKABG_TEST_RACE_INJECT_CMD: injectCmd,
      PIKABG_TEST_RACE_INJECT_ON_ATTEMPT: '1',
    }, binDir)
    check('backup: SUCCESS (local-only)', backup.code === 0 && backup.out.includes('[backup] SUCCESS (local-only)'), backup.out.slice(-3000))
    const journalAt = backup.out.indexOf('Archiving held payout journal (before the DB snapshot)')
    const injectAt = backup.out.indexOf('[inject] transferred B')
    const snapshotAt = backup.out.indexOf('Creating live SQLite snapshot')
    check('ред: журнал → прехвърляне на B → DB snapshot', journalAt > 0 && journalAt < injectAt && injectAt < snapshotAt, { journalAt, injectAt, snapshotAt })
    const files = readdirSync(backupRoot)
    const journalArchive = files.find((f) => f.endsWith('-held-payout-journal.tar.zst'))
    const dbArchive = files.find((f) => /^belot-v2-\d{8}T\d{6}Z\.sqlite\.zst$/.test(f))
    const uploadsArchive = files.find((f) => f.endsWith('-uploads.tar.zst'))
    const manifestFile = files.find((f) => f.endsWith('.manifest.json'))
    check('архиви: база, uploads, журнал + .sha256 + манифест', !!journalArchive && !!dbArchive && !!uploadsArchive && !!manifestFile
      && files.includes(`${journalArchive}.sha256`) && files.includes(`${dbArchive}.sha256`))
    const manifest = JSON.parse(readFileSync(join(backupRoot, manifestFile!), 'utf8')) as Record<string, unknown>
    check('манифест: held_payout_journal в scope, 2 файла, ред „преди DB“', (manifest.scope as string[]).includes('held_payout_journal')
      && manifest.held_payout_journal_file_count === 2 && manifest.held_payout_journal_order === 'archived_before_db_snapshot', manifest)
    // Stub-ът на zstd е passthrough → архивите са сурови tar / sqlite.
    const snapDb = new DatabaseSync(join(backupRoot, dbArchive!), { readOnly: true })
    const inSnapshot = (scope: string) => snapDb.prepare('SELECT COUNT(*) AS n FROM belot_held_payouts WHERE match_scope = ?').get(scope) as { n: number }
    check('DB snapshot: B (прехвърлен по време на backup-а) и C — да; A — не', inSnapshot(scopeB).n === 1 && inSnapshot(scopeC).n === 1 && inSnapshot(scopeA).n === 0)
    snapDb.close()
    // Git `tar` чете „C:\…“ като host:path → bash с /c/… пътища.
    const tarList = spawnSync(bashExecutable(), ['-c', `tar -tf "${sh(join(backupRoot, journalArchive!))}"`], { encoding: 'utf8' }).stdout
    check('архив на журнала: A и B (B — копиран преди прехвърлянето)', tarList.includes(`held-${heldPayoutJournalId(scopeA)}.json`) && tarList.includes(`held-${heldPayoutJournalId(scopeB)}.json`))
    check('живият журнал след backup-а: само A', readdirSync(liveJournal).filter((f) => f.startsWith('held-')).length === 1)

    console.log('\n[3] Restore в scratch директория (база + uploads + журнал)')
    const target = join(root, 'restore-target')
    const restore = runBash(restoreScript, [
      '--db-archive', sh(join(backupRoot, dbArchive!)),
      '--uploads-archive', sh(join(backupRoot, uploadsArchive!)),
      '--journal-archive', sh(join(backupRoot, journalArchive!)),
      '--target-dir', sh(target),
    ], {}, binDir)
    check('restore: SUCCESS', restore.code === 0 && restore.out.includes('[restore] SUCCESS'), restore.out.slice(-3000))
    check('restore: журналът е възстановен (2 файла) + инструкция за права', restore.out.includes('restored_journal_file_count=2') && restore.out.includes('chown -R <node user>'))
    check('restore: файловете на журнала са в target', readdirSync(join(target, JOURNAL_NAME)).length === 2)

    const noJournal = runBash(restoreScript, [
      '--db-archive', sh(join(backupRoot, dbArchive!)),
      '--uploads-archive', sh(join(backupRoot, uploadsArchive!)),
      '--target-dir', sh(join(root, 'restore-no-journal')),
    ], {}, binDir)
    check('restore без --journal-archive: успех + изрично ПРЕДУПРЕЖДЕНИЕ', noJournal.code === 0 && noJournal.out.includes('WARNING: no --journal-archive given'))

    // Злонамерен архив на журнала (член извън директорията) → отказ преди запис.
    const evilDir = join(root, 'evil')
    mkdirSync(join(evilDir, 'other'), { recursive: true })
    writeFileSync(join(evilDir, 'other', 'x.json'), '{}')
    const evilArchive = join(root, 'evil-held-payout-journal.tar.zst')
    spawnSync(bashExecutable(), ['-c', `tar -cf "${sh(evilArchive)}" -C "${sh(evilDir)}" other && cd "${sh(root)}" && sha256sum evil-held-payout-journal.tar.zst > evil-held-payout-journal.tar.zst.sha256`])
    const evil = runBash(restoreScript, [
      '--db-archive', sh(join(backupRoot, dbArchive!)),
      '--uploads-archive', sh(join(backupRoot, uploadsArchive!)),
      '--journal-archive', sh(evilArchive),
      '--target-dir', sh(join(root, 'restore-evil')),
    ], {}, binDir)
    check('restore: архив на журнала с чужд член → отказ', evil.code !== 0 && evil.out.includes('held payout journal archive contains unexpected members'), evil.out.slice(-1500))

    console.log('\n[4] Бедствие → възстановени файлове → компилиран сървър')
    db.close()
    economy.close()
    const dist = readFileSync(join(SERVER_ROOT, 'dist', 'index.js'), 'utf8')
    check('dist е актуален (verifyWritable)', dist.includes('heldPayoutJournal.verifyWritable()'))
    const newServer = join(root, 'new', 'server')
    await prepareServerDir(newServer, join(root, 'new'))
    await cp(join(target, 'belot-v2.sqlite'), join(newServer, 'database', 'data', 'belot-v2.sqlite'))
    await cp(join(target, JOURNAL_NAME), join(newServer, 'database', 'data', JOURNAL_NAME), { recursive: true })
    // Тестовото скеле (тригерите, симулирали отказ на регистъра) е влязло в
    // snapshot-а заедно с данните — маха се от възстановеното копие; в
    // реалност такива тригери няма.
    const scaffold = new DatabaseSync(join(newServer, 'database', 'data', 'belot-v2.sqlite'))
    scaffold.exec('DROP TRIGGER IF EXISTS fail_a; DROP TRIGGER IF EXISTS fail_b;')
    scaffold.close()
    const out1 = await runServer(newServer)
    const rdb = new DatabaseSync(join(newServer, 'database', 'data', 'belot-v2.sqlite'))
    const row = (scope: string) => rdb.prepare('SELECT COUNT(*) AS n, MAX(hold_count) AS c, MAX(hold_reason) AS r FROM belot_held_payouts WHERE match_scope = ?').get(scope) as { n: number; c: number; r: string }
    check('A (само в журнала при backup-а) → регистриран', row(scopeA).n === 1 && row(scopeA).c === 1 && row(scopeA).r === 'invalid')
    check('B (в журнала И в базата) → един ред, hold_count = 1 (без дубликат)', row(scopeB).n === 1 && row(scopeB).c === 1)
    check('C → непроменен', row(scopeC).n === 1 && row(scopeC).c === 1)
    check('журналът е изпразнен след потвърдения запис', readdirSync(join(newServer, 'database', 'data', JOURNAL_NAME)).filter((f) => f.startsWith('held-')).length === 0)
    check('лог: entries=2 transferred=2, без NOT WRITABLE', out1.includes('held payout journal replay entries=2 transferred=2') && !out1.includes('HELD PAYOUT JOURNAL NOT WRITABLE'))
    const coinMoves = () => (rdb.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE entry_type IN ('winner_payout', 'stake_refund')`).get() as { n: number }).n
    const wallets = () => JSON.stringify(rdb.prepare(`SELECT profile_id, yellow_coins_balance FROM profile_wallets WHERE profile_id GLOB '[abc]-*' ORDER BY profile_id`).all())
    check('без автоматично движение на жълтици (портфейлите = преди backup-а)', coinMoves() === 0 && wallets() === walletsBefore, { coinMoves: coinMoves(), before: walletsBefore.slice(0, 300), after: wallets().slice(0, 300) })
    const out2 = await runServer(newServer)
    check('повторен старт: нищо за прехвърляне, без дубликати', !out2.includes('held payout journal replay')
      && row(scopeA).n === 1 && row(scopeA).c === 1 && row(scopeB).c === 1 && coinMoves() === 0)
    rdb.close()

    console.log('\n[5] Права за достъп и пазене')
    const blocker = join(root, 'blocker-file')
    writeFileSync(blocker, 'x')
    const bad = createHeldPayoutJournal(join(blocker, 'journal')).verifyWritable()
    check('недостъпна директория → ok:false + команда за поправка', !bad.ok && bad.fix.includes('chown -R <PM2 user>') && bad.fix.includes('chmod 700'))
    const good = createHeldPayoutJournal(join(root, 'fresh-journal')).verifyWritable()
    check('нова директория → ok, създадена, тестовият файл е изтрит', good.ok && existsSync(join(root, 'fresh-journal')) && readdirSync(join(root, 'fresh-journal')).length === 0)
    const journalSrc = readFileSync(join(SERVER_ROOT, 'src', 'economy', 'heldPayoutJournal.ts'), 'utf8')
    check('POSIX: затягане 0700/0600 и проверка на собственика (статично)', journalSrc.includes('fs.chmodSync(directory, 0o700)') && journalSrc.includes('fs.chmodSync(file, 0o600)') && journalSrc.includes('stat.uid !== uid'))
    const { createRequire } = await import('node:module')
    const retention = createRequire(import.meta.url)(join(OPS_SCRIPTS, 'pikabg-db-retention')) as { dbJournalPaths: (p: string) => string[] }
    check('отдалечено пазене: архивът на журнала се трие заедно с DB архива', JSON.stringify(retention.dbJournalPaths('2026-11-26/belot-v2-20261126T104100Z.sqlite.zst'))
      === JSON.stringify(['2026-11-26/belot-v2-20261126T104100Z-held-payout-journal.tar.zst', '2026-11-26/belot-v2-20261126T104100Z-held-payout-journal.tar.zst.sha256']))
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break } catch { await sleep(300) }
    }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

if (process.argv[2] !== '--inject-transfer') {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
