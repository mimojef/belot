/**
 * checkBackendDeployMigrationBackupFlow.ts
 *
 * Regression check за migration DB backup flow-а в
 * scripts/deploy-backend-production.sh.
 *
 * История: доказан production инцидент — `node:sqlite backup()` (online
 * backup API) се изпълняваше докато PM2 backend-ът ОЩЕ пишеше активно в
 * SQLite; API-то рестартира копирането при всяка промяна на source-а — на
 * ~369MB DB: ~99% CPU, >24min без завършване, ~1TB logical read I/O.
 * Временният fix спираше PM2 ПРЕДИ backup-а (backup времето влизаше в
 * downtime-а).
 *
 * Текущ flow (live consistent snapshot): RESTART confirmation → (ако pending
 * migrations) sqlite3 VACUUM INTO snapshot ДОКАТО backend-ът е ONLINE
 * (bounded timeout, nice/ionice, busy_timeout=10000, БЕЗ -readonly) → read-only verify
 * (non-empty, integrity_check = ok, foreign_key_check = 0, SHA256) → mv към
 * финалния raw .sqlite път → ЧАК ТОГАВА pm2 stop → bounded stop verify →
 * dist activation → финален pm2 restart (apply-ва migrations при startup).
 * Snapshot/verify failure → abort ПРЕДИ pm2 stop: backend остава ONLINE,
 * live dist/marker непипнати, temp артефакти изчистени. Failure СЛЕД stop,
 * но преди restart → cleanup() връща стария backend online (непроменено).
 *
 * Established harness convention (виж checkBackendDeployHealthRetry.ts):
 * тества РЕАЛНИЯ bash код от production скрипта — extract-ва стабилни
 * function/section блокове чрез anchor-based substring slicing (не
 * преписан duplicate) и ги изпълнява в изолирани bash процеси срещу
 * контролирани fake pm2/sqlite3/filesystem фикстури. Не spawn-ва целия
 * deploy-backend-production.sh. sqlite3 CLI shim-ът изпълнява SQL-а със
 * СЪЩИЯ SQLite engine (node:sqlite), така че VACUUM INTO семантиката
 * (consistency, WAL) е реална; реалният sqlite3 CLI не е наличен
 * на Windows dev machine-а.
 *
 * === Section A (executable): wait_for_pm2_stopped bounded retry ===
 * [A1]–[A4] — непроменени.
 *
 * === Section B (executable): temp sidecar cleanup (real code slice) ===
 * [B1]–[B5] — непроменени.
 *
 * === Section C (executable): bounded timeout механизъм ===
 * [C1] — непроменен.
 *
 * === Section D (static source-order assertions) ===
 * [D1] VACUUM INTO snapshot е ПРЕДИ pm2 stop
 * [D2] RESTART confirmation-declined клонът е ПРЕДИ секция 5
 * [D3] Секция 5 е изцяло gate-ната зад PENDING_MIGRATIONS
 * [D4] PM2_QUIESCED_FOR_BACKUP="true" е СЛЕД verified snapshot и веднага след pm2 stop
 * [D5] cleanup(): dist-restore клонът е ПРЕДИ PM2 recovery клона
 * [D6] Ред: snapshot exit → non-empty → integrity/FK → gates → SHA256 → mv → checksum файл → pm2 stop
 * [D7] cleanup() включва всичките 4 sidecar варианта
 * [D8] Никакъв wildcard/global delete по DB_BACKUP_ROOT/DIST_BACKUP_ROOT
 * [D9] timeout + nice/ionice + busy_timeout=10000, source invocation БЕЗ -readonly; verify bounded и read-only
 * [D10] Non-pending-migrations flow без pm2 stop извън guard-а
 * [D11] Никаква pm2 команда между началото на секция 5 и pm2 stop
 * [D12] sqlite3 >= 3.27.0 се проверява ПРЕДИ confirmation, само при pending migrations
 * [D13] Confirmation текстът: snapshot първо, backend ONLINE, НЕ zero downtime
 * [D14] Без cp на live DB и без node:sqlite backup()
 *
 * === Section E (executable): реалният snapshot/verify код срещу реални SQLite бази ===
 * [E1] успех: raw .sqlite, integrity ok, FK 0, SHA256 файл, 0 pm2 извиквания
 * [E1b] ionice argv, когато е наличен
 * [E2] writes по време на snapshot-а продължават без грешки; snapshot-ът е
 *      transactionally consistent и не съдържа по-късните writes
 * [E3]–[E7] timeout / sqlite3 грешка / празен файл / повреден файл / FK
 *      нарушение → abort ПРЕДИ pm2 stop, 0 pm2 извиквания, temp и staging
 *      изчистени, production DB непроменен
 * [E8] съществуваща per-run директория → отказ, чуждият backup непипнат
 * [E9] VACUUM INTO върху WAL база → самостоятелен файл (без sidecar-и)
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

const PROJECT_ROOT = resolve(process.cwd())
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'deploy-backend-production.sh')

async function extractBetween(startMarker: string, endMarker: string, mustInclude: string[]): Promise<string> {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  const startIdx = source.indexOf(startMarker)
  const endIdx = source.indexOf(endMarker)
  if (startIdx === -1) throw new Error(`start anchor не е намерен: "${startMarker}"`)
  if (endIdx === -1) throw new Error(`end anchor не е намерен: "${endMarker}"`)
  if (endIdx <= startIdx) throw new Error('end anchor е ПРЕДИ start anchor — файлова структура се е променила неочаквано.')
  const block = source.slice(startIdx, endIdx)
  for (const needle of mustInclude) {
    assert(block.includes(needle), `extracted блок не съдържа "${needle}" — extraction обхватът е грешен.`)
  }
  return block
}

async function runBashHarness(
  harnessBody: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-backend-migration-backup-'))
  const scriptFile = join(tmpDir, 'harness.sh')
  await writeFile(scriptFile, harnessBody, 'utf8')
  await chmod(scriptFile, 0o755)

  const start = Date.now()
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn('bash', [scriptFile, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
  const durationMs = Date.now() - start
  await rm(tmpDir, { recursive: true, force: true })
  return { ...result, durationMs }
}

// ─── Fake pm2 CLI stub (за wait_for_pm2_stopped tests) ─────────────────────
async function makeFakePm2(statusSequence: string[], appName: string): Promise<{ binDir: string; cleanup: () => Promise<void> }> {
  const binDir = await mkdtemp(join(tmpdir(), 'belot-fake-pm2-'))
  const counterFile = join(binDir, 'counter')
  await writeFile(counterFile, '0', 'utf8')
  const statusesLiteral = statusSequence.map((s) => `"${s}"`).join(' ')
  const script = `#!/usr/bin/env bash
STATUSES=(${statusesLiteral})
COUNTER_FILE="${counterFile}"
if [ "\${1:-}" = "jlist" ]; then
  N=0
  [ -f "$COUNTER_FILE" ] && N="$(cat "$COUNTER_FILE")"
  MAX=$((\${#STATUSES[@]} - 1))
  IDX=$N
  if [ "$IDX" -gt "$MAX" ]; then IDX=$MAX; fi
  echo $((N + 1)) > "$COUNTER_FILE"
  printf '[{"name":"${appName}","pm2_env":{"status":"%s"}}]' "\${STATUSES[$IDX]}"
  exit 0
fi
exit 1
`
  const pm2Path = join(binDir, 'pm2')
  await writeFile(pm2Path, script, 'utf8')
  await chmod(pm2Path, 0o755)
  return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) }
}

console.log('\ncheckBackendDeployMigrationBackupFlow\n')

console.log('=== Section A: wait_for_pm2_stopped (bounded retry, real extracted function) ===\n')

const pm2StopVerifyFunctions = await extractBetween(
  '# ─── PM2 stop verification (bounded)',
  '# ─── 0. Pre-flight',
  ['wait_for_pm2_stopped()', 'PM2_STOP_VERIFY_MAX_SECONDS'],
)

// Git Bash/MSYS не разпознава native Windows path-и (C:\Users\...) като
// валидни PATH записи (потвърдено директно — `which pm2` не намираше stub-а,
// PATH lookup мълчаливо се проваляше, каскадно чупейки downstream JSON parse
// в pm2 jlist pipe-а). MSYS очаква POSIX-style /c/Users/... форма — точно
// формата, ползвана от съществуващите PATH записи на тази машина.
function toPosixPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):\\/, (_m, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
}

async function runWaitForPm2Stopped(
  appName: string,
  pid: number,
  fakePm2BinDir: string,
  opts: { maxSeconds: number; intervalSeconds: number },
): Promise<{ result: 'success' | 'failure'; stderrLines: string[]; durationMs: number }> {
  const harness = `#!/usr/bin/env bash
set -uo pipefail
export PATH="${toPosixPath(fakePm2BinDir)}:$PATH"
${pm2StopVerifyFunctions}
if wait_for_pm2_stopped "$1" "$2"; then
  echo "RESULT=success"
else
  echo "RESULT=failure"
fi
`
  const { stdout, stderr, durationMs } = await runBashHarness(harness, [appName, String(pid)], {
    PM2_STOP_VERIFY_MAX_SECONDS: String(opts.maxSeconds),
    PM2_STOP_VERIFY_INTERVAL_SECONDS: String(opts.intervalSeconds),
  })
  const result = stdout.includes('RESULT=success') ? 'success' : 'failure'
  return { result, stderrLines: stderr.split('\n').filter((l) => l.length > 0), durationMs }
}

// Вариант за "PID е РЕАЛНО жив" сценария (A3) — sleeper-ът се spawn-ва (`&`)
// ВЪТРЕ В СЪЩИЯ bash процес, който после вика wait_for_pm2_stopped, вместо
// през Node.js child_process (cross-process PID reference между Node-spawned
// процес и ОТДЕЛЕН bash harness процес се оказа ненадеждно в Windows/Git-Bash
// test environment-а — потвърдено директно чрез debugging: `kill -0` не
// разпознава коректно "жив" за такъв cross-runtime PID). Production target е
// реален Linux VPS без тази граница; тук просто избягваме напълно
// cross-process PID boundary-a, за да тестваме РЕАЛНАТА "process still
// alive" семантика на wait_for_pm2_stopped надеждно.
async function runWaitForPm2StoppedWithOwnAliveSleeper(
  appName: string,
  fakePm2BinDir: string,
  opts: { maxSeconds: number; intervalSeconds: number },
): Promise<{ result: 'success' | 'failure'; stderrLines: string[]; durationMs: number }> {
  const harness = `#!/usr/bin/env bash
set -uo pipefail
export PATH="${toPosixPath(fakePm2BinDir)}:$PATH"
sleep 60 &
REAL_PID=$!
${pm2StopVerifyFunctions}
if wait_for_pm2_stopped "$1" "$REAL_PID"; then
  echo "RESULT=success"
else
  echo "RESULT=failure"
fi
kill -9 "$REAL_PID" 2>/dev/null || true
`
  const { stdout, stderr, durationMs } = await runBashHarness(harness, [appName], {
    PM2_STOP_VERIFY_MAX_SECONDS: String(opts.maxSeconds),
    PM2_STOP_VERIFY_INTERVAL_SECONDS: String(opts.intervalSeconds),
  })
  const result = stdout.includes('RESULT=success') ? 'success' : 'failure'
  return { result, stderrLines: stderr.split('\n').filter((l) => l.length > 0), durationMs }
}

// Фиксиран, гарантирано-невалиден PID за "мъртъв процес" сценариите —
// spawn-ване през Node.js и после kill -0 през ОТДЕЛЕН bash harness процес
// (cross-process PID reference) се оказа ненадеждно в Windows/Git-Bash test
// environment-а (потвърдено директно: kill -0 работи коректно за same-
// process spawn+kill+check, но НЕ през process boundary). Production target
// е реален Linux VPS, където този конкретен Node<->MSYS interop quirk не
// съществува — фиксираният sentinel тества точно същата "process not found"
// семантика на wait_for_pm2_stopped, без да зависи от cross-runtime PID
// interop, специфичен за Windows dev machine-а.
const DEFINITELY_DEAD_PID = 999999

await check('[A1] pm2 status="stopped" И PID вече не съществува -> success', async () => {
  const fakePm2 = await makeFakePm2(['online', 'stopped'], 'belot-v2-server')
  try {
    const { result } = await runWaitForPm2Stopped('belot-v2-server', DEFINITELY_DEAD_PID, fakePm2.binDir, { maxSeconds: 10, intervalSeconds: 1 })
    assertEqual(result, 'success', 'трябва да успее веднъж status=stopped И PID не съществува')
  } finally {
    await fakePm2.cleanup()
  }
})

await check('[A2] pm2 status остава "online" безкрайно -> bounded timeout, failure', async () => {
  const fakePm2 = await makeFakePm2(['online'], 'belot-v2-server')
  try {
    const { result, durationMs } = await runWaitForPm2Stopped('belot-v2-server', DEFINITELY_DEAD_PID, fakePm2.binDir, { maxSeconds: 3, intervalSeconds: 1 })
    assertEqual(result, 'failure', 'status никога не става "stopped" -> трябва да timeout-не с failure')
    assert(durationMs < 8000, `трябва да е bounded (~3s + tolerance), измерено ${durationMs}ms`)
  } finally {
    await fakePm2.cleanup()
  }
})

await check('[A3] pm2 status="stopped", но PID Е ОЩЕ РЕАЛНО ЖИВ -> bounded timeout, failure (проверяват се И ДВЕТЕ условия)', async () => {
  const fakePm2 = await makeFakePm2(['stopped'], 'belot-v2-server')
  try {
    // Умишлено НЕ убиваме sleeper-а — status е "stopped" от pm2 гледна точка,
    // но реалният OS процес продължава да тече (симулира graceful shutdown
    // lag/несъответствие между PM2 state и реалния процес). sleeper-ът е
    // spawn-нат ВЪТРЕ в СЪЩИЯ bash процес (виж runWaitForPm2StoppedWithOwnAliveSleeper).
    const { result, durationMs } = await runWaitForPm2StoppedWithOwnAliveSleeper('belot-v2-server', fakePm2.binDir, { maxSeconds: 3, intervalSeconds: 1 })
    assertEqual(result, 'failure', 'status=stopped САМО не е достатъчно — PID трябва РЕАЛНО да е мъртъв')
    assert(durationMs < 8000, `трябва да е bounded, измерено ${durationMs}ms`)
  } finally {
    await fakePm2.cleanup()
  }
})

await check('[A4] Retry интервалът се съобразява (не busy-loop) — 3 опита с 1s интервал отнема поне ~2s', async () => {
  const fakePm2 = await makeFakePm2(['online', 'online', 'stopped'], 'belot-v2-server')
  try {
    const { result, durationMs } = await runWaitForPm2Stopped('belot-v2-server', DEFINITELY_DEAD_PID, fakePm2.binDir, { maxSeconds: 30, intervalSeconds: 1 })
    assertEqual(result, 'success', 'третия опит трябва да success-не (status=stopped, PID не съществува)')
    assert(durationMs >= 1500, `2 неуспешни опита с 1s интервал трябва да отнемат поне ~2s (busy-loop би бил мигновен), измерено ${durationMs}ms`)
  } finally {
    await fakePm2.cleanup()
  }
})

console.log('\n=== Section B: temp sidecar cleanup (real extracted code slice) ===\n')

// extractBetween връща slice, КОЙТО ВКЛЮЧВА самия startMarker литерал
// ("cleanup() {") — за да repurpose-нем само ТЯЛОТО под ново функционално
// име (без nested/дублирана "cleanup() {" сигнатура), режем startMarker-а
// самия от началото на резултата преди да го обвием в собствена функция.
const tmpCleanupBlockRaw = await extractBetween('cleanup() {', 'if [ "$ACTIVATION_ARMED" = "true" ] && [ "$RESTART_STARTED" = "false" ]; then', [
  'ACTIVE_TMP_FILE',
  'DB_BACKUP_DIR',
])
const tmpCleanupBlock = tmpCleanupBlockRaw.slice('cleanup() {'.length)
const tmpCleanupFunctionSource = `cleanup_tmp_artifacts() {\n${tmpCleanupBlock}\n}`

async function runTmpCleanup(env: Record<string, string>): Promise<void> {
  const harness = `#!/usr/bin/env bash
set -uo pipefail
${tmpCleanupFunctionSource}
cleanup_tmp_artifacts
`
  const { code, stderr } = await runBashHarness(harness, [], env)
  assertEqual(code, 0, `cleanup_tmp_artifacts трябва да излезе с 0, stderr: ${stderr}`)
}

await check('[B1]+[B3] Всичките 4 sidecar варианта се премахват + празната DB_BACKUP_DIR се премахва', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'belot-tmp-cleanup-check-'))
  const backupDir = join(dir, 'run-1')
  await mkdir(backupDir, { recursive: true })
  const tmpBase = join(backupDir, 'belot-v2.sqlite.tmp')
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await writeFile(`${tmpBase}${suffix}`, 'x', 'utf8')
  }
  try {
    await runTmpCleanup({ ACTIVE_TMP_FILE: tmpBase, DB_BACKUP_DIR: backupDir })
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      assert(!existsSync(`${tmpBase}${suffix}`), `${tmpBase}${suffix} трябва да е премахнат`)
    }
    assert(!existsSync(backupDir), 'празната DB_BACKUP_DIR трябва да е премахната (rmdir)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('[B2] Липсващи sidecar-и не chупят cleanup-а (само базовият .tmp съществува)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'belot-tmp-cleanup-check-'))
  const backupDir = join(dir, 'run-1')
  await mkdir(backupDir, { recursive: true })
  const tmpBase = join(backupDir, 'belot-v2.sqlite.tmp')
  await writeFile(tmpBase, 'x', 'utf8')
  try {
    await runTmpCleanup({ ACTIVE_TMP_FILE: tmpBase, DB_BACKUP_DIR: backupDir })
    assert(!existsSync(tmpBase), 'базовият .tmp трябва да е премахнат')
    assert(!existsSync(backupDir), 'празната директория трябва да е премахната')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('[B4] НЕпразна DB_BACKUP_DIR (успешен завършен backup) НЕ се премахва', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'belot-tmp-cleanup-check-'))
  const backupDir = join(dir, 'run-1')
  await mkdir(backupDir, { recursive: true })
  const finalBackupFile = join(backupDir, 'belot-v2.sqlite')
  await writeFile(finalBackupFile, 'real backup content', 'utf8')
  try {
    // ACTIVE_TMP_FILE е "" (успешен run вече е clear-нал го) — само DB_BACKUP_DIR rmdir опитът се тества тук.
    await runTmpCleanup({ ACTIVE_TMP_FILE: '', DB_BACKUP_DIR: backupDir })
    assert(existsSync(backupDir), 'НЕпразната директория трябва да остане (rmdir отказва да я изтрие)')
    assert(existsSync(finalBackupFile), 'реалният backup файл трябва да остане непокътнат')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await check('[B5] Sibling backup директория от ДРУГ (по-стар, завършен) run остава напълно недокосната', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'belot-tmp-cleanup-check-'))
  const oldCompletedDir = join(dir, 'old-completed-run')
  await mkdir(oldCompletedDir, { recursive: true })
  const oldCompletedFile = join(oldCompletedDir, 'belot-v2.sqlite')
  await writeFile(oldCompletedFile, 'previously completed backup', 'utf8')

  const currentRunDir = join(dir, 'current-failed-run')
  await mkdir(currentRunDir, { recursive: true })
  const tmpBase = join(currentRunDir, 'belot-v2.sqlite.tmp')
  await writeFile(`${tmpBase}-journal`, 'x', 'utf8')
  try {
    await runTmpCleanup({ ACTIVE_TMP_FILE: tmpBase, DB_BACKUP_DIR: currentRunDir })
    assert(!existsSync(currentRunDir), 'текущата (failed) run директория трябва да е премахната')
    assert(existsSync(oldCompletedDir), 'sibling завършена backup директория НЕ трябва да е пипната')
    assert(existsSync(oldCompletedFile), 'sibling завършеният backup файл НЕ трябва да е пипнат')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log('\n=== Section C: bounded timeout механизъм ===\n')

await check('[C1] `timeout` командата реално bound-ва hanging процес (exit 124) в configured прозорец', async () => {
  const start = Date.now()
  const result = await new Promise<{ code: number }>((resolveRun) => {
    const child = spawn('timeout', ['2s', 'sleep', '30'])
    child.on('close', (code) => resolveRun({ code: code ?? -1 }))
  })
  const durationMs = Date.now() - start
  assertEqual(result.code, 124, 'timeout трябва да върне exit 124 при изтекъл timeout')
  assert(durationMs < 5000, `трябва да прекрати bounded (~2s), измерено ${durationMs}ms`)
})

console.log('\n=== Section D: static source-order assertions (пълния flow, mirror established [7]/[8] pattern) ===\n')

const FULL_SOURCE = await readFile(SCRIPT_PATH, 'utf8')
const SECTION_5_ANCHOR = '# ─── 5. Live consistent DB snapshot'
const SECTION_5C_ANCHOR = '# ─── 5c. Backend stop'
const SECTION_6_ANCHOR = '# ─── 6. Dist activation'
const VACUUM_CALL = `sqlite3 -bail -batch "$DB_FILE"`

await check('[D1] live VACUUM INTO snapshot е ПРЕДИ "pm2 stop $PM2_APP_NAME" в source реда (backup вече не е в downtime-а)', () => {
  const vacuumIdx = FULL_SOURCE.indexOf(VACUUM_CALL)
  const pmStopIdx = FULL_SOURCE.indexOf('if ! pm2 stop "$PM2_APP_NAME"; then')
  assert(vacuumIdx !== -1, 'sqlite3 VACUUM INTO call трябва да съществува')
  assert(pmStopIdx !== -1, '"pm2 stop $PM2_APP_NAME" call трябва да съществува')
  assert(vacuumIdx < pmStopIdx, 'VACUUM INTO snapshot трябва да е ПРЕДИ pm2 stop')
  assert(FULL_SOURCE.includes(`VACUUM INTO '%s';`), 'SQL-ът трябва да е VACUUM INTO към temp target')
})

await check('[D2] RESTART confirmation-declined клонът е ПРЕДИ секция 5 (отказ => никакъв snapshot/pm2 stop)', () => {
  const declineIdx = FULL_SOURCE.indexOf('if [ "$CONFIRMATION" != "RESTART" ]')
  const section5Idx = FULL_SOURCE.indexOf(SECTION_5_ANCHOR)
  assert(declineIdx !== -1 && section5Idx !== -1, 'anchor-ите трябва да съществуват')
  assert(declineIdx < section5Idx, 'confirmation decline клонът трябва да е ПРЕДИ snapshot/stop секцията')
})

await check('[D3] Секция 5 е изцяло gate-ната зад PENDING_MIGRATIONS (no pending -> без snapshot и без pm2 stop)', () => {
  const block = FULL_SOURCE.slice(FULL_SOURCE.indexOf(SECTION_5_ANCHOR), FULL_SOURCE.indexOf(SECTION_6_ANCHOR))
  const guardIdx = block.indexOf('if [ -n "$PENDING_MIGRATIONS" ]; then')
  assert(guardIdx !== -1, 'PENDING_MIGRATIONS guard трябва да съществува в секцията')
  assert(guardIdx < block.indexOf(VACUUM_CALL), 'guard-ът трябва да е ПРЕДИ snapshot-а')
  assert(guardIdx < block.indexOf('pm2 stop "$PM2_APP_NAME"'), 'guard-ът трябва да е ПРЕДИ pm2 stop-а')
})

await check('[D4] PM2_QUIESCED_FOR_BACKUP="true" е ВЕДНАГА след pm2 stop и ПРЕДИ bounded verify — и СЛЕД целия snapshot verify', () => {
  const pmStopIdx = FULL_SOURCE.indexOf('if ! pm2 stop "$PM2_APP_NAME"; then')
  const quiescedFlagIdx = FULL_SOURCE.indexOf('PM2_QUIESCED_FOR_BACKUP="true"', pmStopIdx)
  const verifyCallIdx = FULL_SOURCE.indexOf('wait_for_pm2_stopped "$PM2_APP_NAME" "$OLD_PID"')
  const snapshotMvIdx = FULL_SOURCE.indexOf('mv -f "$DB_BACKUP_TMP" "$DB_BACKUP_PATH"')
  assert(pmStopIdx !== -1 && quiescedFlagIdx !== -1 && verifyCallIdx !== -1 && snapshotMvIdx !== -1, 'всички anchor-и трябва да съществуват')
  assert(snapshotMvIdx < pmStopIdx, 'verified snapshot (mv към финалния път) трябва да е ПРЕДИ pm2 stop')
  assert(pmStopIdx < quiescedFlagIdx, 'флагът трябва да се сложи СЛЕД pm2 stop call-а')
  assert(quiescedFlagIdx < verifyCallIdx, 'флагът трябва да се сложи ПРЕДИ bounded stop verify-а')
  const beforeStop = FULL_SOURCE.slice(0, pmStopIdx)
  assert(!beforeStop.split('\n').some((line) => /^\s*PM2_QUIESCED_FOR_BACKUP="true"/.test(line)), 'флагът НЕ трябва да се присвоява никъде преди pm2 stop')
})

await check('[D5] cleanup(): dist-restore клонът е ПРЕДИ PM2 recovery клона', () => {
  const cleanupBody = FULL_SOURCE.slice(FULL_SOURCE.indexOf('cleanup() {'), FULL_SOURCE.indexOf('trap cleanup EXIT'))
  const activationIfIdx = cleanupBody.indexOf('if [ "$ACTIVATION_ARMED" = "true" ]')
  const quiescedIfIdx = cleanupBody.indexOf('if [ "$PM2_QUIESCED_FOR_BACKUP" = "true" ]')
  assert(activationIfIdx !== -1 && quiescedIfIdx !== -1, 'двата guard-а трябва да съществуват в cleanup()')
  assert(activationIfIdx < quiescedIfIdx, 'dist-restore клонът трябва да е ПРЕДИ PM2 recovery клона')
  assert(cleanupBody.includes('pm2 restart "$PM2_APP_NAME"'), 'recovery клонът трябва реално да вика pm2 restart')
  assert(cleanupBody.includes('RESTART_STARTED" = "false'), 'recovery клонът трябва да е gate-нат зад RESTART_STARTED="false"')
})

await check('[D6] Ред в секция 5: snapshot exit check -> non-empty -> integrity/FK verify -> gates -> SHA256 -> mv -> pm2 stop, всичко ПРЕДИ Dist activation', () => {
  const block = FULL_SOURCE.slice(FULL_SOURCE.indexOf(SECTION_5_ANCHOR), FULL_SOURCE.indexOf(SECTION_6_ANCHOR))
  const order = [
    'if [ "$SNAPSHOT_EXIT_CODE" -ne 0 ]',
    '[ -s "$DB_BACKUP_TMP" ]',
    "PRAGMA integrity_check",
    "PRAGMA foreign_key_check",
    'if [ "$INTEGRITY_RESULT" != "ok" ]',
    'if [ "$FOREIGN_KEY_VIOLATIONS" != "0" ]',
    'DB_BACKUP_SHA256="$(sha256_of "$DB_BACKUP_TMP")"',
    'mv -f "$DB_BACKUP_TMP" "$DB_BACKUP_PATH"',
    '> "$DB_BACKUP_CHECKSUM_FILE"',
    SECTION_5C_ANCHOR,
    'if ! pm2 stop "$PM2_APP_NAME"; then',
  ]
  let last = -1
  for (const needle of order) {
    const idx = block.indexOf(needle, last + 1)
    assert(idx !== -1, `липсва (или е в грешен ред): ${needle}`)
    assert(idx > last, `грешен ред при: ${needle}`)
    last = idx
  }
})

await check('[D7] cleanup() включва всичките 4 sidecar варианта', () => {
  const cleanupBody = FULL_SOURCE.slice(FULL_SOURCE.indexOf('cleanup() {'), FULL_SOURCE.indexOf('trap cleanup EXIT'))
  for (const needle of ['"$ACTIVE_TMP_FILE"', '"${ACTIVE_TMP_FILE}-journal"', '"${ACTIVE_TMP_FILE}-wal"', '"${ACTIVE_TMP_FILE}-shm"']) {
    assert(cleanupBody.includes(needle), `cleanup() трябва да включва ${needle}`)
  }
})

await check('[D8] Никакъв wildcard/global delete по DB_BACKUP_ROOT/DIST_BACKUP_ROOT', () => {
  assert(!/rm\s+-rf\s+"\$DB_BACKUP_ROOT/.test(FULL_SOURCE), 'НЕ трябва да има rm -rf върху DB_BACKUP_ROOT')
  assert(!/rm\s+-rf\s+"\$DIST_BACKUP_ROOT/.test(FULL_SOURCE), 'НЕ трябва да има rm -rf върху DIST_BACKUP_ROOT')
  assert(!FULL_SOURCE.includes('rm -rf "$DB_BACKUP_DIR"'), 'DB_BACKUP_DIR никога не се трие с rm -rf (само rmdir-ако-празна)')
})

await check('[D9] Snapshot: bounded timeout + nice/ionice + busy_timeout=10000, source invocation БЕЗ -readonly; verify bounded и read-only', () => {
  const snapshotLine = FULL_SOURCE.split('\n').find((line) => line.includes('sqlite3 -bail -batch') && line.includes('"$DB_FILE"'))
  assert(snapshotLine !== undefined, 'VACUUM INTO source invocation трябва да съществува')
  assert(!snapshotLine!.includes('-readonly'), `VACUUM INTO source invocation НЕ трябва да има -readonly (production A/B: 6s vs 54s, идентична schema): ${snapshotLine}`)
  assert(!/sqlite3 [^\n]*-readonly/.test(FULL_SOURCE.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')), 'никъде не трябва да има sqlite3 ... -readonly извън коментари')
  const verifyBlock = FULL_SOURCE.slice(FULL_SOURCE.indexOf('VERIFY_OUTPUT="$(timeout'), FULL_SOURCE.indexOf('if [ "$VERIFY_EXIT_CODE" -ne 0 ]'))
  assert(verifyBlock.includes("new DatabaseSync(process.argv[1], { open: true, readOnly: true })"), 'integrity_check/foreign_key_check върху snapshot-а трябва да са read-only')
  assert(FULL_SOURCE.includes('DB_BACKUP_TIMEOUT_SECONDS="${DB_BACKUP_TIMEOUT_SECONDS:-300}"'), 'configurable snapshot timeout (default 300)')
  assert(FULL_SOURCE.includes('DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS="${DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS:-600}"'), 'configurable verify timeout (default 600)')
  assert(FULL_SOURCE.includes(`| timeout "\${DB_BACKUP_TIMEOUT_SECONDS}s" "\${SNAPSHOT_PRIORITY[@]}" ${VACUUM_CALL}`), 'sqlite3 трябва да е обвит в timeout + priority prefix')
  assert(FULL_SOURCE.includes('SNAPSHOT_PRIORITY=(nice -n 10)'), 'nice трябва да е винаги в prefix-а')
  assert(FULL_SOURCE.includes('SNAPSHOT_PRIORITY=(ionice -c 2 -n 7 nice -n 10)'), 'ionice трябва да се добавя, ако е наличен')
  assert(FULL_SOURCE.includes('PRAGMA busy_timeout=10000;'), 'busy_timeout=10000')
  assert(FULL_SOURCE.includes('VERIFY_OUTPUT="$(timeout "${DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS}s" node'), 'verify трябва да е bounded')
})

await check('[D10] Non-pending-migrations flow: detection -> confirmation -> секция 5 -> activation, без pm2 stop извън guard-а', () => {
  const detectionIdx = FULL_SOURCE.indexOf('# ─── 3. Migration detection')
  const confirmationIdx = FULL_SOURCE.indexOf('# ─── 4. Explicit restart confirmation')
  const section5Idx = FULL_SOURCE.indexOf(SECTION_5_ANCHOR)
  const activationIdx = FULL_SOURCE.indexOf(SECTION_6_ANCHOR)
  assert(detectionIdx < confirmationIdx && confirmationIdx < section5Idx && section5Idx < activationIdx, 'грешен ред на секциите')
  const betweenConfirmationAndGuard = FULL_SOURCE.slice(confirmationIdx, FULL_SOURCE.indexOf('if [ -n "$PENDING_MIGRATIONS" ]; then', section5Idx))
  assert(!betweenConfirmationAndGuard.includes('pm2 stop "$PM2_APP_NAME"'), 'pm2 stop не трябва да съществува ИЗВЪН PENDING_MIGRATIONS guard-а')
})

await check('[D11] Между началото на секция 5 и pm2 stop няма НИКАКВА pm2 команда (snapshot/verify failure => backend остава online)', () => {
  const block = FULL_SOURCE.slice(FULL_SOURCE.indexOf(SECTION_5_ANCHOR), FULL_SOURCE.indexOf('if ! pm2 stop "$PM2_APP_NAME"; then'))
  const codeLines = block.split('\n').filter((line) => !/^\s*#/.test(line))
  assert(!codeLines.some((line) => /(^|[\s;|&(])pm2\s/.test(line.replace(/"[^"]*"/g, '""'))), 'не трябва да има pm2 команда преди stop-а в секция 5')
  assert(block.includes('snapshot_abort_backend_online()'), 'abort helper-ът за failure преди stop трябва да съществува')
  assert(block.includes('Backend остава ONLINE (PM2 НЕ е спиран)'), 'abort съобщението трябва да казва, че backend-ът остава ONLINE')
})

await check('[D12] sqlite3 CLI (>= 3.27.0) се проверява ПРЕДИ confirmation и само при pending migrations', () => {
  const sqliteCheckIdx = FULL_SOURCE.indexOf('if ! command -v sqlite3 >/dev/null 2>&1; then')
  const versionCheckIdx = FULL_SOURCE.indexOf('3.27.0')
  const confirmationIdx = FULL_SOURCE.indexOf('# ─── 4. Explicit restart confirmation')
  const detectionGuardIdx = FULL_SOURCE.indexOf('if [ -n "$PENDING_MIGRATIONS" ]; then', FULL_SOURCE.indexOf('# ─── 3. Migration detection'))
  assert(sqliteCheckIdx !== -1 && versionCheckIdx !== -1, 'sqlite3 наличност + версия трябва да се проверяват')
  assert(detectionGuardIdx < sqliteCheckIdx && sqliteCheckIdx < confirmationIdx, 'проверката трябва да е в pending-migrations клона на detection-а, ПРЕДИ confirmation')
})

await check('[D13] Confirmation съобщението казва: snapshot първо, backend ONLINE, stop само за activation/restart, НЕ zero downtime', () => {
  assert(FULL_SOURCE.includes('A live consistent DB snapshot (SQLite VACUUM INTO) will be taken FIRST, while the backend stays ONLINE.'), 'snapshot-first/online текст')
  assert(FULL_SOURCE.includes('STOPPED briefly for dist activation + restart'), 'stop само за activation/restart')
  assert(FULL_SOURCE.includes('This is NOT zero downtime.'), 'без обещание за zero downtime')
  assert(!FULL_SOURCE.includes('Backend will be STOPPED, a bounded DB backup will be taken'), 'старото съобщение трябва да е премахнато')
})

await check('[D14] Няма cp на live DB и няма online backup API (node:sqlite backup()) за migration backup-а', () => {
  assert(!/\bcp\b[^\n]*"\$DB_FILE"/.test(FULL_SOURCE), 'не трябва да има cp на $DB_FILE')
  assert(!FULL_SOURCE.includes('await backup(src'), 'node:sqlite backup() не трябва да се ползва повече')
})

console.log('\n=== Section E: реалният snapshot/verify код (extracted) срещу реални SQLite бази ===\n')

// Реалният код на секция 5 от началото до "5c. Backend stop" (т.е. целия
// snapshot + verify, БЕЗ pm2 stop частта), плюс реалните log/fail/section/
// sha256_of helper-и от скрипта. Затваряме отворения `if [ -n
// "$PENDING_MIGRATIONS" ]` блок с `fi` в harness-а.
const HELPERS = [
  await extractBetween("log() { printf '[deploy-backend] %s\\n' \"$1\"; }", '# ─── Own-temp/backup cleanup on interrupt', ['fail()', 'section()']),
  await extractBetween('sha256_of() {', 'http_status_for() {', ['CHECKSUM_TOOL']),
].join('\n')
const SNAPSHOT_SLICE = await extractBetween(SECTION_5_ANCHOR, SECTION_5C_ANCHOR, [VACUUM_CALL, 'snapshot_abort_backend_online', 'PRAGMA foreign_key_check'])

const fwd = (p: string) => p.replace(/\\/g, '/')

// Node-базиран sqlite3 shim: `sqlite3 -bail -batch FILE < script` —
// изпълнява SQL-а от stdin срещу FILE със СЪЩИЯ SQLite engine (node:sqlite),
// read-only само ако е подаден -readonly. SHIM_MODE управлява fault injection.
async function makeToolDir(): Promise<{ dir: string; pm2Log: string; ioniceLog: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-snapshot-tools-'))
  const pm2Log = join(dir, 'pm2-calls.log')
  const ioniceLog = join(dir, 'ionice-calls.log')
  const shimJs = join(dir, 'sqlite3-shim.mjs')
  await writeFile(shimJs, `
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('-'))
const sql = readFileSync(0, 'utf8')
const mode = process.env.SHIM_MODE ?? 'real'
const target = (sql.match(/VACUUM INTO '((?:[^']|'')*)'/) ?? [])[1]?.replace(/''/g, "'")
if (mode === 'hang') { setTimeout(() => {}, 600000) }
else if (mode === 'error') { process.stderr.write('Error: simulated sqlite3 failure\\n'); process.exit(1) }
else if (mode === 'empty') { writeFileSync(target, '') }
else if (mode === 'garbage') { writeFileSync(target, 'SQLite format 3\\u0000' + 'x'.repeat(8192)) }
else {
  const db = new DatabaseSync(file, { readOnly: args.includes('-readonly') })
  try { db.exec(sql) } catch (e) { process.stderr.write(String(e) + '\\n'); process.exit(1) } finally { db.close() }
}
`, 'utf8')
  await writeFile(join(dir, 'sqlite3'), `#!/usr/bin/env bash\nexec node "${fwd(shimJs)}" "$@"\n`, 'utf8')
  await writeFile(join(dir, 'pm2'), `#!/usr/bin/env bash\necho "pm2 $*" >> "${fwd(pm2Log)}"\nexit 0\n`, 'utf8')
  await writeFile(join(dir, 'ionice'), `#!/usr/bin/env bash\necho "ionice $*" >> "${fwd(ioniceLog)}"\nshift 4\nexec "$@"\n`, 'utf8')
  for (const tool of ['sqlite3', 'pm2', 'ionice']) await chmod(join(dir, tool), 0o755)
  return { dir, pm2Log, ioniceLog, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// Реална WAL SQLite база с две FK-свързани таблици (optional orphan за E6).
async function makeSourceDb(dir: string, rows: number, withFkViolation = false): Promise<string> {
  const dbPath = fwd(join(dir, 'belot-v2.sqlite'))
  const script = `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2])
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY, payload TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), payload TEXT);')
db.exec('CREATE TABLE pairs_a (id INTEGER PRIMARY KEY, batch INTEGER); CREATE TABLE pairs_b (id INTEGER PRIMARY KEY, batch INTEGER);')
db.exec('BEGIN')
const insP = db.prepare('INSERT INTO parent (payload) VALUES (?)'); const insC = db.prepare('INSERT INTO child (parent_id, payload) VALUES (?, ?)')
for (let i = 1; i <= ${rows}; i++) { insP.run('p'.repeat(200) + i); insC.run(i, 'c'.repeat(200) + i) }
db.exec('COMMIT')
if (${withFkViolation}) { db.exec('PRAGMA foreign_keys = OFF'); db.prepare('INSERT INTO child (parent_id, payload) VALUES (999999999, ?)').run('orphan') }
db.close()
`
  const scriptPath = join(dir, 'make-db.mjs')
  await writeFile(scriptPath, script, 'utf8')
  const code = await new Promise<number>((resolveRun) => spawn('node', [scriptPath, dbPath]).on('close', (c) => resolveRun(c ?? -1)))
  assert(code === 0, 'source DB setup failed')
  return dbPath
}

async function runSnapshotSlice(opts: {
  dbFile: string
  backupRoot: string
  tools: { dir: string }
  shimMode?: string
  timeoutSeconds?: number
  withIonice?: boolean
}): Promise<{ code: number; stdout: string; stderr: string; durationMs: number; backupPath: string; sha: string }> {
  const stagingDir = fwd(join(opts.backupRoot, 'staging-dist'))
  await mkdir(stagingDir, { recursive: true })
  const toolPath = toPosixPath(opts.tools.dir)
  // Без withIonice fake ionice shim-ът се маха от tool директорията (на
  // Windows dev machine реален ionice няма) — остава само nice. С withIonice
  // shim-ът записва argv и exec-ва останалата команда.
  const harness = `#!/usr/bin/env bash
set -euo pipefail
export PATH="${toolPath}:$PATH"
${opts.withIonice ? '' : `mv "${toolPath}/ionice" "${toolPath}/ionice.disabled" 2>/dev/null || true`}
CHECKSUM_TOOL=sha256sum
DB_FILE="${opts.dbFile}"
DB_BACKUP_ROOT="${fwd(opts.backupRoot)}/backend-deploy-migration"
STAGING_DIST_DIR="${stagingDir}"
GIT_SHORT_SHA="abc1234"
PENDING_MIGRATIONS="20990101_001_test.sql"
DB_BACKUP_TIMEOUT_SECONDS="${opts.timeoutSeconds ?? 60}"
DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS="60"
ACTIVE_TMP_FILE=""
DB_BACKUP_DIR=""
${HELPERS}
${SNAPSHOT_SLICE}
fi
echo "SNAPSHOT_OK path=$DB_BACKUP_PATH sha=$DB_BACKUP_SHA256"
`
  const env: Record<string, string> = {}
  if (opts.shimMode) env.SHIM_MODE = opts.shimMode
  const result = await runBashHarness(harness, [], env)
  const match = result.stdout.match(/SNAPSHOT_OK path=(\S+) sha=([0-9a-f]{64})/)
  return { ...result, backupPath: match?.[1] ?? '', sha: match?.[2] ?? '' }
}

async function readPm2Calls(pm2Log: string): Promise<string> {
  return existsSync(pm2Log) ? (await readFile(pm2Log, 'utf8')).trim() : ''
}

async function inspectDb(dbPath: string): Promise<{ integrity: string; fk: number; parent: number; child: number; pairsA: number; pairsB: number }> {
  const script = `
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.argv[2], { readOnly: true })
const n = (t) => db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n
process.stdout.write(JSON.stringify({ integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, fk: db.prepare('PRAGMA foreign_key_check').all().length,
  parent: n('parent'), child: n('child'), pairsA: n('pairs_a'), pairsB: n('pairs_b') }))
db.close()
`
  const dir = await mkdtemp(join(tmpdir(), 'belot-inspect-'))
  const scriptPath = join(dir, 'inspect.mjs')
  await writeFile(scriptPath, script, 'utf8')
  const out = await new Promise<string>((resolveRun) => {
    let s = ''
    const child = spawn('node', [scriptPath, dbPath])
    child.stdout.on('data', (d) => { s += d.toString() })
    child.on('close', () => resolveRun(s))
  })
  await rm(dir, { recursive: true, force: true })
  return JSON.parse(out)
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

await check('[E1] Успешен live snapshot: валиден файл, integrity ok, FK 0, SHA256 файл съвпада, НИКАКВО pm2 извикване, без temp остатъци', async () => {
  const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-e1-'))
  const tools = await makeToolDir()
  try {
    const dbFile = await makeSourceDb(work, 2000)
    const result = await runSnapshotSlice({ dbFile, backupRoot: work, tools })
    assertEqual(result.code, 0, `exit code (stderr: ${result.stderr})`)
    assert(result.backupPath.endsWith('/belot-v2.sqlite') && existsSync(result.backupPath), 'финалният backup трябва да съществува като raw .sqlite')
    assert(!existsSync(`${result.backupPath}.tmp`), 'temp файлът трябва да е преименуван')
    const inspected = await inspectDb(result.backupPath)
    assertEqual(inspected.integrity, 'ok', 'integrity_check')
    assertEqual(inspected.fk, 0, 'foreign_key_check')
    assertEqual(inspected.child, 2000, 'snapshot трябва да съдържа данните')
    const shaFile = (await readFile(`${result.backupPath}.sha256`, 'utf8')).trim()
    assertEqual(shaFile, `${await sha256File(result.backupPath)}  belot-v2.sqlite`, 'SHA256 файлът трябва да съвпада с реалния файл (sha256sum формат)')
    assertEqual(result.sha, await sha256File(result.backupPath), 'отчетеният SHA256')
    assertEqual(await readPm2Calls(tools.pm2Log), '', 'snapshot/verify частта НЕ трябва да вика pm2')
  } finally {
    await tools.cleanup()
    await rm(work, { recursive: true, force: true })
  }
})

await check('[E1b] ionice, ако е наличен: извиква се с -c 2 -n 7 и после nice -n 10 sqlite3', async () => {
  const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-e1b-'))
  const tools = await makeToolDir()
  try {
    const dbFile = await makeSourceDb(work, 50)
    const result = await runSnapshotSlice({ dbFile, backupRoot: work, tools, withIonice: true })
    assertEqual(result.code, 0, `exit code (stderr: ${result.stderr})`)
    const ioniceCalls = existsSync(tools.ioniceLog) ? (await readFile(tools.ioniceLog, 'utf8')).trim() : ''
    assert(ioniceCalls.startsWith('ionice -c 2 -n 7 nice -n 10 sqlite3 -bail -batch '), `ionice argv: "${ioniceCalls}"`)
    assert(!ioniceCalls.includes('-readonly'), `sqlite3 source invocation не трябва да има -readonly: "${ioniceCalls}"`)
  } finally {
    await tools.cleanup()
    await rm(work, { recursive: true, force: true })
  }
})

await check('[E2] Source продължава да приема writes ПО ВРЕМЕ на snapshot-а; snapshot-ът е transactionally consistent и не съдържа по-късните writes', async () => {
  const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-e2-'))
  const tools = await makeToolDir()
  try {
    const dbFile = await makeSourceDb(work, 60000)
    const writerScript = join(work, 'writer.mjs')
    const writerLog = fwd(join(work, 'writer.log'))
    // Всеки commit вмъква по един ред в pairs_a И pairs_b в една транзакция —
    // consistent snapshot трябва винаги да има равни бройки.
    await writeFile(writerScript, `
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync } from 'node:fs'
const db = new DatabaseSync(process.argv[2])
db.exec('PRAGMA busy_timeout = 10000')
const a = db.prepare('INSERT INTO pairs_a (batch) VALUES (?)'); const b = db.prepare('INSERT INTO pairs_b (batch) VALUES (?)')
const stopAt = Date.now() + Number(process.argv[4])
let i = 0, errors = 0
while (Date.now() < stopAt) {
  try { db.exec('BEGIN IMMEDIATE'); a.run(i); b.run(i); db.exec('COMMIT'); i++ } catch (e) { errors++; try { db.exec('ROLLBACK') } catch {} }
  if (i % 25 === 0) appendFileSync(process.argv[3], Date.now() + ' ' + i + '\\n')
}
appendFileSync(process.argv[3], 'DONE ' + i + ' errors=' + errors + '\\n')
db.close()
`, 'utf8')
    const writer = spawn('node', [writerScript, dbFile, writerLog, '6000'])
    const writerDone = new Promise<void>((resolveRun) => writer.on('close', () => resolveRun()))
    await new Promise((r) => setTimeout(r, 800))
    const snapshotStartMs = Date.now()
    const result = await runSnapshotSlice({ dbFile, backupRoot: work, tools })
    const snapshotEndMs = Date.now()
    await writerDone
    assertEqual(result.code, 0, `snapshot exit code (stderr: ${result.stderr})`)
    const logLines = (await readFile(writerLog, 'utf8')).trim().split('\n')
    const doneLine = logLines.find((line) => line.startsWith('DONE'))!
    const totalCommitted = Number(doneLine.split(' ')[1])
    assert(doneLine.includes('errors=0'), `writer-ът не трябва да получава грешки (SQLITE_BUSY) заради snapshot-а: ${doneLine}`)
    const progressDuringSnapshot = logLines.filter((line) => !line.startsWith('DONE')).map((line) => line.split(' ').map(Number))
      .filter(([at]) => at >= snapshotStartMs && at <= snapshotEndMs)
    assert(progressDuringSnapshot.length >= 2 && progressDuringSnapshot[progressDuringSnapshot.length - 1]![1]! > progressDuringSnapshot[0]![1]!,
      `writer-ът трябва да напредва ПО ВРЕМЕ на snapshot-а (${progressDuringSnapshot.length} точки)`)
    const snap = await inspectDb(result.backupPath)
    assertEqual(snap.integrity, 'ok', 'snapshot integrity_check')
    assertEqual(snap.pairsA, snap.pairsB, 'snapshot трябва да е transactionally consistent (pairs_a == pairs_b)')
    const source = await inspectDb(dbFile)
    assertEqual(source.pairsA, totalCommitted, 'source съдържа всички commit-нати writes')
    assert(snap.pairsA < source.pairsA, `по-късните writes не са в snapshot-а (snapshot=${snap.pairsA}, source=${source.pairsA})`)
    assertEqual(await readPm2Calls(tools.pm2Log), '', 'pm2 не трябва да се вика')
  } finally {
    await tools.cleanup()
    await rm(work, { recursive: true, force: true })
  }
})

async function expectAbortBackendOnline(label: string, opts: { shimMode?: string; timeoutSeconds?: number; fkViolation?: boolean; rows?: number }, messageNeedle: string): Promise<void> {
  await check(label, async () => {
    const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-abort-'))
    const tools = await makeToolDir()
    try {
      const dbFile = await makeSourceDb(work, opts.rows ?? 200, opts.fkViolation ?? false)
      const sourceShaBefore = await sha256File(dbFile)
      const result = await runSnapshotSlice({ dbFile, backupRoot: work, tools, shimMode: opts.shimMode, timeoutSeconds: opts.timeoutSeconds })
      assert(result.code !== 0, 'трябва да abort-не')
      assert(result.stderr.includes(messageNeedle), `съобщението трябва да съдържа "${messageNeedle}": ${result.stderr}`)
      assert(result.stderr.includes('Backend остава ONLINE (PM2 НЕ е спиран)'), 'съобщението трябва да казва, че backend-ът остава ONLINE')
      assertEqual(await readPm2Calls(tools.pm2Log), '', 'pm2 НЕ трябва да бъде извикван (нито stop, нито restart)')
      const backupRoot = join(work, 'backend-deploy-migration')
      const leftovers = existsSync(backupRoot) ? (await import('node:fs')).readdirSync(backupRoot) : []
      assertEqual(leftovers.length, 0, `не трябва да остават temp/per-run директории: ${JSON.stringify(leftovers)}`)
      assert(!existsSync(join(work, 'staging-dist')), 'staging build-ът трябва да е изчистен')
      assertEqual(await sha256File(dbFile), sourceShaBefore, 'production DB файлът не трябва да е променен')
    } finally {
      await tools.cleanup()
      await rm(work, { recursive: true, force: true })
    }
  })
}

await expectAbortBackendOnline('[E3] Snapshot TIMEOUT -> abort ПРЕДИ pm2 stop, temp изчистен, backend online', { shimMode: 'hang', timeoutSeconds: 2 }, 'DB snapshot TIMEOUT')
await expectAbortBackendOnline('[E4] sqlite3 грешка -> abort ПРЕДИ pm2 stop', { shimMode: 'error' }, 'VACUUM INTO snapshot се провали')
await expectAbortBackendOnline('[E5] Празен snapshot файл -> abort ПРЕДИ pm2 stop', { shimMode: 'empty' }, 'липсва или е празен')
await expectAbortBackendOnline('[E6] Повреден snapshot (integrity/verify failure) -> abort ПРЕДИ pm2 stop, невалидният файл изтрит', { shimMode: 'garbage' }, 'Snapshot')
await expectAbortBackendOnline('[E7] foreign_key_check > 0 -> abort ПРЕДИ pm2 stop', { fkViolation: true }, 'foreign_key_check върна "1"')

await check('[E8] Съществуваща per-run backup директория -> отказ, чуждият backup НЕ се пипа, pm2 не се вика', async () => {
  const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-e8-'))
  const tools = await makeToolDir()
  try {
    const dbFile = await makeSourceDb(work, 10)
    const backupRoot = fwd(join(work, 'backend-deploy-migration'))
    const runDir = `${backupRoot}/20990101000000-abc1234`
    await mkdir(runDir, { recursive: true })
    const foreignFile = `${runDir}/belot-v2.sqlite`
    await writeFile(foreignFile, 'foreign backup from another run', 'utf8')
    // Фиксиран `date` -> същият per-run път; mkdir без -p трябва да откаже.
    const harness = `#!/usr/bin/env bash
set -euo pipefail
export PATH="${toPosixPath(tools.dir)}:$PATH"
CHECKSUM_TOOL=sha256sum
DB_FILE="${dbFile}"
DB_BACKUP_ROOT="${backupRoot}"
STAGING_DIST_DIR="${fwd(join(work, 'staging-dist'))}"
GIT_SHORT_SHA="abc1234"
PENDING_MIGRATIONS="x.sql"
DB_BACKUP_TIMEOUT_SECONDS=60
DB_SNAPSHOT_VERIFY_TIMEOUT_SECONDS=60
ACTIVE_TMP_FILE=""
DB_BACKUP_DIR=""
date() { printf '20990101000000'; }
${HELPERS}
${SNAPSHOT_SLICE}
fi
echo SHOULD_NOT_REACH
`
    const result = await runBashHarness(harness, [], {})
    assert(result.code !== 0 && !result.stdout.includes('SHOULD_NOT_REACH'), 'трябва да откаже')
    assert(result.stderr.includes('вече съществува'), `съобщение: ${result.stderr}`)
    assert(result.stderr.includes('Backend остава ONLINE (PM2 НЕ е спиран)'), 'backend остава online')
    assert(existsSync(foreignFile) && (await readFile(foreignFile, 'utf8')) === 'foreign backup from another run', 'чуждият backup НЕ трябва да бъде пипнат')
    assertEqual(await readPm2Calls(tools.pm2Log), '', 'pm2 не трябва да се вика')
  } finally {
    await tools.cleanup()
    await rm(work, { recursive: true, force: true })
  }
})

await check('[E9] VACUUM INTO върху WAL база дава самостоятелен snapshot (без -wal/-shm)', async () => {
  const work = await mkdtemp(join(tmpdir(), 'belot-snapshot-e9-'))
  const tools = await makeToolDir()
  try {
    const dbFile = await makeSourceDb(work, 100)
    assert(existsSync(`${dbFile}-wal`) || existsSync(dbFile), 'source е WAL база')
    const result = await runSnapshotSlice({ dbFile, backupRoot: work, tools })
    assertEqual(result.code, 0, `exit (stderr: ${result.stderr})`)
    assert(!existsSync(`${result.backupPath}-wal`) && !existsSync(`${result.backupPath}-shm`), 'финалният snapshot е самостоятелен файл (без sidecar-и)')
  } finally {
    await tools.cleanup()
    await rm(work, { recursive: true, force: true })
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
