/**
 * checkBackendDeployMigrationBackupFlow.ts
 *
 * Regression check за доказан production инцидент: migration DB backup
 * (`node:sqlite backup()`) в scripts/deploy-backend-production.sh се
 * изпълняваше докато PM2 backend-ът ОЩЕ пишеше активно в SQLite. На ~369MB
 * production DB това доведе до ~99% CPU, >24min без завършване, .tmp файл
 * близо до пълния DB размер, ~1TB logical read I/O, постоянно променящ се
 * WAL. Ръчен "pm2 stop" ПРЕДИ backup-а реши проблема моментално.
 *
 * Fix-ът (deploy-backend-production.sh) reorder-ва flow-а: RESTART
 * confirmation → (ако pending migrations) pm2 stop → bounded verify stopped
 * → bounded (timeout) node:sqlite backup() → integrity_check → dist
 * activation → финален pm2 restart (apply-ва migrations при startup). Ако
 * backup-ът timeout-не/fail-не/бъде прекъснат ПРЕДИ финалния restart,
 * cleanup() trap-ът (PM2_QUIESCED_FOR_BACKUP && !RESTART_STARTED)
 * автоматично връща стария backend online.
 *
 * Established harness convention (виж checkBackendDeployHealthRetry.ts):
 * тества РЕАЛНИЯ bash код от production скрипта — extract-ва стабилни
 * function/constant блокове чрез anchor-based substring slicing (не
 * преписан duplicate) и ги source-ва в изолирани bash процеси срещу
 * контролирани fake pm2/PID/filesystem фикстури. Не spawn-ва целия
 * deploy-backend-production.sh (би изисквало mock на git/npm/tsc/pm2
 * process-management/interactive confirmation/реален SQLite backup — извън
 * обхвата на този конкретен fix) — за орkestration reda, който е непрактично
 * safe да се изпълни изолирано (RESTART confirmation gating, secion
 * ordering), използва static source-order assertions, mirror на
 * established [7]/[8] checks в checkBackendDeployHealthRetry.ts.
 *
 * === Section A (executable): wait_for_pm2_stopped bounded retry ===
 * [A1] pm2 status става "stopped" И реалният PID реално умира -> success (exit 0)
 * [A2] pm2 status остава "online" безкрайно -> bounded timeout, failure (exit 1)
 * [A3] pm2 status "stopped", но PID е ОЩЕ реално жив -> bounded timeout, failure
 *      (доказва, че се проверяват И ДВЕТЕ условия, не само едното)
 * [A4] Retry интервалът се съобразява (не busy-loop) при бавна transition
 *
 * === Section B (executable): temp sidecar cleanup (real code slice) ===
 * [B1] Всичките 4 sidecar varianta (.tmp/.tmp-journal/.tmp-wal/.tmp-shm) се премахват
 * [B2] Липсващи sidecar-и не chупят cleanup-а (rm -f no-op safe)
 * [B3] Празна DB_BACKUP_DIR (след sidecar cleanup) се премахва (rmdir)
 * [B4] НЕпразна DB_BACKUP_DIR (симулира успешен завършен backup) НЕ се премахва
 * [B5] Sibling backup директория от ДРУГ (по-стар, завършен) run остава напълно недокосната
 *
 * === Section C (executable): bounded timeout мехнизъм ===
 * [C1] `timeout` командата реално bound-ва хvнещ процес (exit 124) в configured прозорец
 *
 * === Section D (static source-order assertions) ===
 * [D1] "pm2 stop $PM2_APP_NAME" е ПРЕДИ node:sqlite backup() извикването в source реда
 * [D2] RESTART confirmation-declined клонът е ПРЕДИ "Backend quiesce" секцията
 * [D3] "Backend quiesce" секцията е изцяло gate-ната зад PENDING_MIGRATIONS (no pending -> no quiesce/backup)
 * [D4] PM2_QUIESCED_FOR_BACKUP="true" е ВЕДНАГА след pm2 stop, ПРЕДИ bounded verify/backup
 * [D5] cleanup(): dist-restore клонът е ПРЕДИ PM2 quiesce-recovery клона (dist коректен ПРЕДИ backend online)
 * [D6] Ред в "Backend quiesce": backup exit-code check -> integrity_check -> mv, всичко ПРЕДИ "Dist activation"
 * [D7] cleanup() включва всичките 4 sidecar варианта
 * [D8] Никакъв wildcard/global delete по DB_BACKUP_ROOT/DIST_BACKUP_ROOT
 * [D9] node:sqlite backup() е обвит в `timeout "${DB_BACKUP_TIMEOUT_SECONDS}s"` (default 300)
 * [D10] Non-pending-migrations normal deploy flow остава непроменен (без quiesce/backup секция преди Dist activation)
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

await check('[D1] "pm2 stop $PM2_APP_NAME" е ПРЕДИ node:sqlite backup() извикването в source реда', () => {
  const pmStopIdx = FULL_SOURCE.indexOf('pm2 stop "$PM2_APP_NAME"')
  const backupCallIdx = FULL_SOURCE.indexOf('await backup(src, process.argv[2])')
  assert(pmStopIdx !== -1, '"pm2 stop $PM2_APP_NAME" call трябва да съществува')
  assert(backupCallIdx !== -1, 'node:sqlite backup() call трябва да съществува')
  assert(pmStopIdx < backupCallIdx, 'pm2 stop трябва да е ПРЕДИ node:sqlite backup() в source реда')
})

await check('[D2] RESTART confirmation-declined клонът е ПРЕДИ "Backend quiesce" секцията', () => {
  const declineIdx = FULL_SOURCE.indexOf('if [ "$CONFIRMATION" != "RESTART" ]')
  const quiesceSectionIdx = FULL_SOURCE.indexOf('# ─── 5. Backend quiesce')
  assert(declineIdx !== -1, 'confirmation decline branch трябва да съществува')
  assert(quiesceSectionIdx !== -1, '"Backend quiesce" секцията трябва да съществува')
  assert(declineIdx < quiesceSectionIdx, 'confirmation decline клонът трябва да е ПРЕДИ backend quiesce секцията (отказ => никакъв pm2 stop/backup)')
})

await check('[D3] "Backend quiesce" секцията е изцяло gate-ната зад PENDING_MIGRATIONS', () => {
  const quiesceSectionIdx = FULL_SOURCE.indexOf('# ─── 5. Backend quiesce')
  const distActivationIdx = FULL_SOURCE.indexOf('# ─── 6. Dist activation')
  const block = FULL_SOURCE.slice(quiesceSectionIdx, distActivationIdx)
  const guardIdx = block.indexOf('if [ -n "$PENDING_MIGRATIONS" ]; then')
  const pmStopIdxInBlock = block.indexOf('pm2 stop "$PM2_APP_NAME"')
  assert(guardIdx !== -1, 'PENDING_MIGRATIONS guard трябва да съществува в тази секция')
  assert(pmStopIdxInBlock !== -1, 'pm2 stop трябва да е в тази секция')
  assert(guardIdx < pmStopIdxInBlock, 'guard-ът трябва да отваря ПРЕДИ pm2 stop-а (no pending migrations -> няма quiesce/backup path)')
})

await check('[D4] PM2_QUIESCED_FOR_BACKUP="true" е ВЕДНАГА след pm2 stop, ПРЕДИ bounded verify/backup', () => {
  // indexOf(..., pmStopIdx) нарочно прескача по-ранното упоменаване на
  // "PM2_QUIESCED_FOR_BACKUP=\"true\"" в doc коментара над самата секция
  // (обяснява механизма преди кода) — търсим РЕАЛНОТО присвояване, което е
  // логически СЛЕД действителния "pm2 stop" call, не първото text срещане.
  const pmStopIdx = FULL_SOURCE.indexOf('if ! pm2 stop "$PM2_APP_NAME"; then')
  const quiescedFlagIdx = FULL_SOURCE.indexOf('PM2_QUIESCED_FOR_BACKUP="true"', pmStopIdx)
  const verifyCallIdx = FULL_SOURCE.indexOf('wait_for_pm2_stopped "$PM2_APP_NAME" "$OLD_PID"')
  const backupCallIdx = FULL_SOURCE.indexOf('await backup(src, process.argv[2])')
  assert(pmStopIdx !== -1 && quiescedFlagIdx !== -1 && verifyCallIdx !== -1 && backupCallIdx !== -1, 'всички anchor-и трябва да съществуват')
  assert(pmStopIdx < quiescedFlagIdx, 'флагът трябва да се сложи СЛЕД pm2 stop call-а')
  assert(quiescedFlagIdx < verifyCallIdx, 'флагът трябва да се сложи ПРЕДИ bounded verify-а')
  assert(verifyCallIdx < backupCallIdx, 'bounded verify трябва да е ПРЕДИ backup() извикването')
})

await check('[D5] cleanup(): dist-restore клонът е ПРЕДИ PM2 quiesce-recovery клона', () => {
  const cleanupStartIdx = FULL_SOURCE.indexOf('cleanup() {')
  const cleanupEndIdx = FULL_SOURCE.indexOf('trap cleanup EXIT')
  const cleanupBody = FULL_SOURCE.slice(cleanupStartIdx, cleanupEndIdx)
  const activationIfIdx = cleanupBody.indexOf('if [ "$ACTIVATION_ARMED" = "true" ]')
  const quiescedIfIdx = cleanupBody.indexOf('if [ "$PM2_QUIESCED_FOR_BACKUP" = "true" ]')
  assert(activationIfIdx !== -1, 'ACTIVATION_ARMED guard трябва да съществува в cleanup()')
  assert(quiescedIfIdx !== -1, 'PM2_QUIESCED_FOR_BACKUP guard трябва да съществува в cleanup()')
  assert(activationIfIdx < quiescedIfIdx, 'dist-restore клонът трябва да е ПРЕДИ PM2 quiesce-recovery клона (dist коректен ПРЕДИ backend online)')
  assert(cleanupBody.includes('pm2 restart "$PM2_APP_NAME"'), 'recovery клонът трябва реално да вика pm2 restart')
  assert(cleanupBody.includes('RESTART_STARTED" = "false'), 'recovery клонът трябва да е gate-нат зад RESTART_STARTED="false" (никога след реалния restart)')
})

await check('[D6] Ред в "Backend quiesce": backup exit-code check -> integrity_check -> mv, всичко ПРЕДИ "Dist activation"', () => {
  const quiesceIdx = FULL_SOURCE.indexOf('# ─── 5. Backend quiesce')
  const activationIdx = FULL_SOURCE.indexOf('# ─── 6. Dist activation')
  const block = FULL_SOURCE.slice(quiesceIdx, activationIdx)
  const backupExitCheckIdx = block.indexOf('if [ "$BACKUP_EXIT_CODE" -ne 0 ]')
  const integrityCheckIdx = block.indexOf('PRAGMA integrity_check')
  const integrityGateIdx = block.indexOf('if [ "$INTEGRITY_RESULT" != "ok" ]')
  const mvIdx = block.lastIndexOf('mv -f "$DB_BACKUP_TMP" "$DB_BACKUP_PATH"')
  assert(backupExitCheckIdx !== -1 && integrityCheckIdx !== -1 && integrityGateIdx !== -1 && mvIdx !== -1, 'всички anchor-и трябва да съществуват')
  assert(backupExitCheckIdx < integrityCheckIdx, 'backup exit-code check трябва да е ПРЕДИ integrity_check-а')
  assert(integrityCheckIdx < integrityGateIdx, 'integrity_check изпълнението трябва да е ПРЕДИ неговия резултатен gate')
  assert(integrityGateIdx < mvIdx, 'integrity gate трябва да е ПРЕДИ финалния mv на backup файла')
})

await check('[D7] cleanup() включва всичките 4 sidecar варианта', () => {
  const cleanupStartIdx = FULL_SOURCE.indexOf('cleanup() {')
  const cleanupEndIdx = FULL_SOURCE.indexOf('trap cleanup EXIT')
  const cleanupBody = FULL_SOURCE.slice(cleanupStartIdx, cleanupEndIdx)
  for (const needle of ['"$ACTIVE_TMP_FILE"', '"${ACTIVE_TMP_FILE}-journal"', '"${ACTIVE_TMP_FILE}-wal"', '"${ACTIVE_TMP_FILE}-shm"']) {
    assert(cleanupBody.includes(needle), `cleanup() трябва да включва ${needle}`)
  }
})

await check('[D8] Никакъв wildcard/global delete по DB_BACKUP_ROOT/DIST_BACKUP_ROOT', () => {
  assert(!/rm\s+-rf\s+"\$DB_BACKUP_ROOT/.test(FULL_SOURCE), 'НЕ трябва да има rm -rf върху DB_BACKUP_ROOT')
  assert(!/rm\s+-rf\s+"\$DIST_BACKUP_ROOT/.test(FULL_SOURCE), 'НЕ трябва да има rm -rf върху DIST_BACKUP_ROOT')
  assert(!FULL_SOURCE.includes('rm -rf "$DB_BACKUP_DIR"'), 'DB_BACKUP_DIR никога не се трие с rm -rf (само rmdir-ако-празна)')
})

await check('[D9] node:sqlite backup() е обвит в bounded `timeout "${DB_BACKUP_TIMEOUT_SECONDS}s"` (default 300)', () => {
  assert(FULL_SOURCE.includes('DB_BACKUP_TIMEOUT_SECONDS="${DB_BACKUP_TIMEOUT_SECONDS:-300}"'), 'configurable default трябва да е 300s')
  assert(/timeout "\$\{DB_BACKUP_TIMEOUT_SECONDS\}s" node --input-type=module/.test(FULL_SOURCE), 'backup() извикването трябва да е обвито в timeout')
})

await check('[D10] Non-pending-migrations normal deploy flow остава непроменен (без quiesce/backup секция преди Dist activation)', () => {
  const detectionIdx = FULL_SOURCE.indexOf('# ─── 3. Migration detection')
  const confirmationIdx = FULL_SOURCE.indexOf('# ─── 4. Explicit restart confirmation')
  const quiesceIdx = FULL_SOURCE.indexOf('# ─── 5. Backend quiesce')
  const activationIdx = FULL_SOURCE.indexOf('# ─── 6. Dist activation')
  assert(detectionIdx < confirmationIdx, 'detection трябва да е ПРЕДИ confirmation')
  assert(confirmationIdx < quiesceIdx, 'confirmation трябва да е ПРЕДИ quiesce секцията')
  assert(quiesceIdx < activationIdx, 'quiesce секцията трябва да е ПРЕДИ dist activation')
  // Между confirmation и guard-а НЕ трябва да съществува РЕАЛНО извикване на
  // pm2 stop (търсим точния command literal, не bare думите "pm2 stop" —
  // последното се появява легитимно и в doc коментара, обясняващ flow-а над
  // самата "# ─── 5. Backend quiesce" секция) — вече проверено structурно
  // от [D3] (guard-ът обгражда РЕАЛНИЯ call), тук потвърждаваме че извън
  // guard-натия блок (преди "if [ -n \"$PENDING_MIGRATIONS\" ]; then" реда)
  // няма нито един реален "pm2 stop" command call.
  const betweenConfirmationAndGuard = FULL_SOURCE.slice(confirmationIdx, FULL_SOURCE.indexOf('if [ -n "$PENDING_MIGRATIONS" ]; then', quiesceIdx))
  assert(!betweenConfirmationAndGuard.includes('pm2 stop "$PM2_APP_NAME"'), 'pm2 stop команден call не трябва да съществува ИЗВЪН PENDING_MIGRATIONS guard-а')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
