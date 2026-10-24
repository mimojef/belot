/**
 * checkProfileDeletionLedgerConcurrency.ts
 *
 * Самоизтриване, Етап 4J1A — регистърът на изтриванията при конкуренция
 * между ОТДЕЛНИ процеси и при срив по време на запис.
 *
 * Всеки конкурентен участник е отделен Node процес
 * (scripts/fixtures/ledgerConcurrencyChild.ts) с production функциите.
 * Само временни бази и регистри.
 *
 * [L] Заключване: едновременни append-и, логически дубликати, прекъснат ред
 *     + два конкурентни опита за възстановяване, срив по време на запис,
 *     убит процес със заключването, fail-closed при изтекло чакане,
 *     append + offsite snapshot/confirm, потвърденият префикс, без deadlock
 *     с основната база, повреден/липсващ регистър.
 * Сривовете около необратимото изтриване, restore и шлюзът на историята са в
 * checkProfileDeletionDisasterRecovery.ts (Етап 4J1B).
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionLedgerConcurrency.ts --server-root=.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ensureProfileDeletionLedgerEntry,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  parseProfileDeletionLedgerBuffer,
  readProfileDeletionLedger,
  getProfileDeletionLedgerOffsiteAckPath,
  readProfileDeletionLedgerOffsiteAck,
} from '../src/db/profileDeletionLedger.js'
import { confirmLedgerSnapshotOffsite, createLedgerSnapshot, verifyLedgerSnapshot, readLedgerSnapshotManifest } from '../src/ops/profileDeletionLedgerArchive.js'
import { writeTestLedgerAck } from './fixtures/profileDeletionCancellationKit.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SECRET = 'profile-deletion-ledger-concurrency-secret-0123456789'
const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const TSX_CLI = join(sourceServerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CHILD = join(sourceServerRoot, 'scripts', 'fixtures', 'ledgerConcurrencyChild.ts')

console.log('\ncheckProfileDeletionLedgerConcurrency')
console.log(`Server root: ${sourceServerRoot}`)

type Child = { done: Promise<{ code: number | null; output: string }>; kill: () => void; pid: number | undefined }
function runChild(mode: string, args: Record<string, unknown>): Child {
  const child = spawn(process.execPath, [TSX_CLI, CHILD, mode, JSON.stringify(args)], { cwd: sourceServerRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const done = new Promise<{ code: number | null; output: string }>((res) => child.once('exit', (code) => res({ code, output })))
  return { done, kill: () => child.kill('SIGKILL'), pid: child.pid }
}
async function waitFile(path: string, timeoutMs = 60_000): Promise<void> {
  const limit = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > limit) throw new Error(`timeout: ${path}`)
    await sleep(20)
  }
}
/** Стартира процесите, изчаква всички да са готови и ги пуска едновременно. */
async function runSimultaneously(dir: string, specs: Array<{ mode: string; args: Record<string, unknown> }>): Promise<Array<{ code: number | null; output: string }>> {
  const goFile = join(dir, `go-${randomUUID()}`)
  const children = specs.map((spec, index) => {
    const readyFile = join(dir, `ready-${index}-${randomUUID()}`)
    return { readyFile, child: runChild(spec.mode, { ...spec.args, goFile, readyFile }) }
  })
  for (const { readyFile } of children) await waitFile(readyFile)
  writeFileSync(goFile, 'go')
  return await Promise.all(children.map(({ child }) => child.done))
}

const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const closers: Array<() => void> = []

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-4j1a-'))
  tempRoots.push(root)
  const ledgerDir = join(root, 'ledgers')
  await mkdir(ledgerDir, { recursive: true })
  const newLedger = () => join(ledgerDir, `ledger-${randomUUID().slice(0, 8)}`, 'profile-deletions.jsonl')
  const keyLines = (ledgerPath: string, needle: string) => readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.includes(needle)).length

  // ═══ [L] Заключване ═════════════════════════════════════════════════════
  console.log('\n[L] Междупроцесно заключване на регистъра')

  await check('[L1] Два процеса × 150 едновременни append-а: 300 валидни реда, без повреда, загуба или дубликати', async () => {
    const ledgerPath = newLedger()
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'append', args: { ledgerPath, count: 150, tag: 'a' } },
      { mode: 'append', args: { ledgerPath, count: 150, tag: 'b' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    const parsed = readProfileDeletionLedger(ledgerPath)
    assertEqual(parsed.invalidLineCount + parsed.conflictingDuplicateCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.lineCount, 300, 'редове')
    assertEqual(parsed.entries.length, 300, 'записи')
    for (const tag of ['a', 'b']) {
      const order = parsed.entries.filter((e) => e.requestId.startsWith(`${tag}-`)).map((e) => Number(e.requestId.split('-')[1]))
      assert(order.every((value, index) => value === index), `пренареждане в ${tag}`)
    }
  })

  await check('[L2] Един и същ запис от два процеса едновременно (ensure × 40 всеки): точно един ред', async () => {
    const ledgerPath = newLedger()
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'ensure-same', args: { ledgerPath, count: 40, requestId: 'same-request' } },
      { mode: 'ensure-same', args: { ledgerPath, count: 40, requestId: 'same-request' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    assertEqual(keyLines(ledgerPath, '"requestId":"same-request"'), 1, 'логически дубликат')
  })

  await check('[L3] Прекъснат последен ред + два конкурентни процеса, които "възстановяват" и дописват: опашката изчезва точно веднъж, завършените редове са непокътнати', async () => {
    const ledgerPath = newLedger()
    for (let i = 0; i < 20; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`base-${i}`))
    const completePrefix = readFileSync(ledgerPath)
    appendFileSync(ledgerPath, '{"v":1,"requestId":"torn-tail-from-crash","prof')
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'append', args: { ledgerPath, count: 60, tag: 'x' } },
      { mode: 'append', args: { ledgerPath, count: 60, tag: 'y' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    const buffer = readFileSync(ledgerPath)
    assert(buffer.subarray(0, completePrefix.length).equals(completePrefix), 'завършен ред е засегнат')
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    assertEqual(parsed.invalidLineCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.entries.length, 140, 'записи')
    assert(!buffer.toString('utf8').includes('torn-tail-from-crash'), 'опашката остана')
  })

  await check('[L4] Срив по време на запис (процесът умира със заключването и половин ред): заключването е освободено от ОС; следващият запис отрязва само опашката; потвърденият префикс е непроменен', async () => {
    const ledgerPath = newLedger()
    for (let i = 0; i < 5; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`pre-${i}`))
    writeTestLedgerAck(ledgerPath)
    const acked = readFileSync(ledgerPath)
    const crashed = await runChild('crash-mid-write', { ledgerPath }).done
    assertEqual(crashed.code, 9, `изход: ${crashed.output}`)
    assert(readProfileDeletionLedger(ledgerPath).trailingPartialBytes > 0, 'половин ред')
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('after-crash'))
    assert(Date.now() - started < 3000, 'заключването не е освободено')
    const buffer = readFileSync(ledgerPath)
    assert(buffer.subarray(0, acked.length).equals(acked), 'потвърденият префикс е променен')
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    assertEqual(parsed.invalidLineCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.entries.length, 6, 'записи')
    for (let i = 0; i < 5; i += 1) assert(isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, `pre-${i}`), `потвърждение pre-${i}`)
  })

  await check('[L5] Процес, убит (SIGKILL) докато държи заключването: друг процес го получава веднага (няма "заседнал" lock)', async () => {
    const ledgerPath = newLedger()
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock-forever', { ledgerPath, readyFile })
    await waitFile(readyFile)
    holder.kill()
    await holder.done
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('after-kill'))
    assert(Date.now() - started < 3000, `чакане ${Date.now() - started} ms`)
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 1, 'записът')
  })

  await check('[L6] Докато друг процес държи заключването, записът чака (не пише паралелно) и после успява', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('first'))
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock', { ledgerPath, readyFile, ms: 2500 })
    await waitFile(readyFile)
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('second'))
    const waited = Date.now() - started
    await holder.done
    assert(waited >= 1500, `не изчака заключването (${waited} ms)`)
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 2, 'записи')
  })

  await check('[L7] Изтекло чакане (заключването е заето > 15 s): записът се отказва с грешка (fail-closed), файлът е непроменен', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('only'))
    const before = readFileSync(ledgerPath)
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock', { ledgerPath, readyFile, ms: 19_000 })
    await waitFile(readyFile)
    let thrown = ''
    try {
      ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('blocked'))
    } catch (error) {
      thrown = String(error)
    }
    await holder.done
    assert(/locked|busy/i.test(thrown), `грешка: ${thrown}`)
    assert(readFileSync(ledgerPath).equals(before), 'файлът е променен')
  })

  await check('[L8] Конкурентен append (отделен процес) и offsite snapshot + confirm: всеки snapshot е валиден префикс; ack-ът остава валиден и след още записи', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('seed'))
    const ackPath = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)
    const outDir = join(ledgerDir, `snapshots-${randomUUID().slice(0, 6)}`)
    const appender = runChild('append', { ledgerPath, count: 250, tag: 'snap' })
    let snapshots = 0
    let exited = false
    void appender.done.then(() => { exited = true })
    while (!exited) {
      const result = createLedgerSnapshot({ ledgerPath, outDir, ackPath })
      if (result.status === 'created') {
        verifyLedgerSnapshot(result.snapshotPath, readLedgerSnapshotManifest(result.manifestPath))
        confirmLedgerSnapshotOffsite({ ledgerPath, snapshotPath: result.snapshotPath, manifestPath: result.manifestPath, remotePath: 'test-offsite:/x', ackPath })
        snapshots += 1
      }
      await sleep(5)
    }
    assertEqual((await appender.done).code, 0, 'appender')
    assert(snapshots >= 2, `snapshot-и: ${snapshots}`)
    const ack = readProfileDeletionLedgerOffsiteAck(ackPath)!
    const buffer = readFileSync(ledgerPath)
    assert(createHash('sha256').update(buffer.subarray(0, ack.bytes)).digest('hex') === ack.sha256, 'потвърденият префикс е променен')
    assert(isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, 'seed'), 'seed е потвърден')
    assertEqual(parseProfileDeletionLedgerBuffer(buffer).entries.length, 251, 'записи')
  })

  await check('[L9] Без deadlock с основната база: процесът държи writer lock-а на SQLite и пише в регистъра, докато друг процес също пише', async () => {
    const ledgerPath = newLedger()
    const dbPath = join(ledgerDir, `main-${randomUUID().slice(0, 6)}.sqlite`)
    const mainDb: SqliteDatabase = new sqliteModule.DatabaseSync(dbPath)
    mainDb.exec('CREATE TABLE t (x INTEGER); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);')
    try {
      const other = runChild('append', { ledgerPath, count: 50, tag: 'other' })
      for (let i = 0; i < 50; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`main-${i}`))
      assertEqual((await other.done).code, 0, 'другият процес')
    } finally {
      mainDb.exec('COMMIT;')
      mainDb.close()
    }
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 100, 'записи')
  })

  await check('[L10] Повреден регистър: ensure отказва (fail-closed), нищо не се дописва; липсващ — създава се', () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('ok'))
    appendFileSync(ledgerPath, 'not-json\n')
    const before = readFileSync(ledgerPath)
    let thrown = ''
    try { ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('next')) } catch (error) { thrown = String(error) }
    assert(thrown.includes('profile_deletion_ledger_corrupt'), thrown)
    assert(readFileSync(ledgerPath).equals(before), 'дописване в повреден регистър')
    const missing = newLedger()
    ensureProfileDeletionLedgerEntry(missing, intentFor('fresh'))
    assertEqual(readProfileDeletionLedger(missing).entries.length, 1, 'нов регистър')
  })

} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function intentFor(requestId: string): Parameters<typeof ensureProfileDeletionLedgerEntry>[1] {
  return {
    v: 1, requestId, profileId: `profile-${requestId}`, accountIdSnapshot: `account-${requestId}`, profileCreatedAtSnapshot: '2026-01-01 00:00:00',
    requestedAt: '2026-01-01T00:00:00.000Z', scheduledFor: '2026-01-31T00:00:00.000Z', recordedAt: new Date().toISOString(),
  }
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
