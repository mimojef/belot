/**
 * checkBackendDeployHealthRetry.ts
 *
 * Regression check за доказания production инцидент: първият реален FULL
 * backend deploy получи временен HTTP 502 на ЕДИНСТВЕНАТА post-restart
 * public /health проверка (PM2 вече "online", nginx/upstream все още
 * establish-ваха връзка) — deploy-ът STOP-на false-negative, въпреки че
 * ~2 минути по-късно PM2/port/local-health/public-health/gameplay бяха
 * напълно здрави. Fix-ът заменя единичния check с bounded retry/warm-up
 * loop (scripts/deploy-backend-production.sh, wait_for_public_health_200).
 *
 * Тества РЕАЛНИЯ bash код от deploy-backend-production.sh — extract-ва
 * http_status_for/cache_bust_query/wait_for_public_health_200 функциите
 * директно от production скрипта (sed между стабилни anchor коментари,
 * не преписан duplicate) и ги source-ва в изолиран bash процес срещу
 * mock HTTP сървър с конфигурируема последователност от статус кодове.
 * Не spawn-ва целия deploy-backend-production.sh (би изисквало mock на
 * git/npm/tsc/pm2/SQLite/interactive confirmation — извън обхвата на този
 * конкретен fix) — изолира и доказва точно retry loop-а, който е
 * действителната промяна.
 *
 * [1] 502, 502, после 200 -> retry loop-ът успява (HTTP 200), 3 опита
 * [2] Постоянен 502 -> retry loop-ът връща последния наблюдаван non-200
 *     статус след timeout (bounded, не безкраен)
 * [3] Пръв опит директно 200 -> успех без излишни retry-и (1 опит)
 * [4] Всеки опит използва РАЗЛИЧЕН cache-busted URL (никакъв повторен
 *     query string между опитите)
 * [5] Retry интервалът се съобразява (не busy-loop, не blind single sleep)
 * [6] Постоянен failure timeout остава в рамките на configured max +
 *     interval толеранс (bounded, не открит-край)
 * [7] deploy-backend-production.sh реално вика wait_for_public_health_200
 *     за post-restart проверката (не единичен http_status_for call)
 * [8] Marker (persistent deployment state) записът е СЛЕД post-restart
 *     health блока в source реда на файла (запис само след успешен
 *     post-check, никога преди)
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

// ─── Extract реалните функции от production скрипта ────────────────────────
// Стабилни anchor-и: започва от "http_status_for() {" (първата дефиниция в
// файла), приключва на затварящата "}" на wait_for_public_health_200 (открита
// чрез намиране на реда, съдържащ самото затваряне след последното "done"/"fi"
// в тази функция) — по-просто и надеждно: extract-ваме от началния anchor до
// следващия секционен коментар ("# ─── 0. Pre-flight"), който е строго СЛЕД
// края на функциите в текущата структура на файла.
async function extractHealthRetryFunctions(): Promise<string> {
  const source = await readFile(SCRIPT_PATH, 'utf8')
  const startMarker = 'http_status_for() {'
  const endMarker = '# ─── 0. Pre-flight'
  const startIdx = source.indexOf(startMarker)
  const endIdx = source.indexOf(endMarker)
  if (startIdx === -1) throw new Error('http_status_for() anchor не е намерен в deploy-backend-production.sh — extraction невъзможен.')
  if (endIdx === -1) throw new Error('"# ─── 0. Pre-flight" anchor не е намерен в deploy-backend-production.sh — extraction невъзможен.')
  if (endIdx <= startIdx) throw new Error('Anchor редът за края е ПРЕДИ началния anchor — файлова структура се е променила неочаквано.')
  const block = source.slice(startIdx, endIdx)
  assert(block.includes('wait_for_public_health_200()'), 'extracted блок не съдържа wait_for_public_health_200 — extraction обхватът е грешен.')
  assert(block.includes('cache_bust_query()'), 'extracted блок не съдържа cache_bust_query.')
  return block
}

// ─── Mock /health origin — configurable статус-код последователност ────────
type MockHealthServer = {
  url: string
  close: () => Promise<void>
  setSequence: (codes: number[]) => void
  getRequestUrls: () => string[]
}

async function startMockHealthServer(): Promise<MockHealthServer> {
  let sequence: number[] = [200]
  let callIndex = 0
  const requestUrls: string[] = []

  const server: Server = createHttpServer((req, res) => {
    requestUrls.push(req.url ?? '')
    const code = sequence[Math.min(callIndex, sequence.length - 1)] ?? 200
    callIndex++
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: code === 200 }))
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    setSequence: (codes: number[]) => { sequence = codes; callIndex = 0; requestUrls.length = 0 },
    getRequestUrls: () => [...requestUrls],
  }
}

// ─── Изпълнение на extracted функциите в изолиран bash процес ──────────────
async function runWaitForHealth200(
  functionsSource: string,
  baseUrl: string,
  opts: { maxSeconds: number; intervalSeconds: number },
): Promise<{ stdoutStatus: string; stderrLines: string[]; durationMs: number }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-backend-health-retry-'))
  const scriptFile = join(tmpDir, 'harness.sh')
  const harness = `#!/usr/bin/env bash
set -euo pipefail
${functionsSource}
wait_for_public_health_200 "$1"
`
  await writeFile(scriptFile, harness, 'utf8')
  await chmod(scriptFile, 0o755)

  const start = Date.now()
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn('bash', [scriptFile, baseUrl], {
      env: {
        ...process.env,
        POST_RESTART_HEALTH_RETRY_MAX_SECONDS: String(opts.maxSeconds),
        POST_RESTART_HEALTH_RETRY_INTERVAL_SECONDS: String(opts.intervalSeconds),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }))
  })
  const durationMs = Date.now() - start
  await rm(tmpDir, { recursive: true, force: true })

  return {
    stdoutStatus: result.stdout.trim(),
    stderrLines: result.stderr.split('\n').filter((l) => l.length > 0),
    durationMs,
  }
}

console.log('\ncheckBackendDeployHealthRetry\n')

let mockServer: MockHealthServer | null = null

try {
  mockServer = await startMockHealthServer()
  const functionsSource = await extractHealthRetryFunctions()

  await check('[1] 502, 502, после 200 -> retry loop-ът успява (HTTP 200), 3 опита', async () => {
    mockServer!.setSequence([502, 502, 200])
    const result = await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds: 30, intervalSeconds: 1 })
    assertEqual(result.stdoutStatus, '200', 'финален статус трябва да е 200')
    const attemptLines = result.stderrLines.filter((l) => l.includes('Post-restart /health опит'))
    assertEqual(attemptLines.length, 3, 'трябва да има точно 3 опита (502, 502, 200)')
    assert(attemptLines[2]!.includes('-> 200'), 'третият опит трябва да покаже 200')
  })

  await check('[2] Постоянен 502 -> връща последния наблюдаван non-200 статус след bounded timeout', async () => {
    mockServer!.setSequence([502])
    const result = await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds: 3, intervalSeconds: 1 })
    assertEqual(result.stdoutStatus, '502', 'финалният статус трябва да е последният наблюдаван (502), не 200')
    const attemptLines = result.stderrLines.filter((l) => l.includes('Post-restart /health опит'))
    assert(attemptLines.length >= 2, `трябва да има поне 2 опита в 3s прозорец с 1s интервал, получени: ${attemptLines.length}`)
    assert(attemptLines.every((l) => l.includes('-> 502')), 'всички опити трябва да покажат 502 (никога 200)')
  })

  await check('[3] Пръв опит директно 200 -> успех без излишни retry-и (1 опит)', async () => {
    mockServer!.setSequence([200])
    const result = await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds: 30, intervalSeconds: 2 })
    assertEqual(result.stdoutStatus, '200', 'финален статус трябва да е 200')
    const attemptLines = result.stderrLines.filter((l) => l.includes('Post-restart /health опит'))
    assertEqual(attemptLines.length, 1, 'пръв опит директно 200 не трябва да prави допълнителни retry-и')
  })

  await check('[4] Всеки опит използва РАЗЛИЧЕН cache-busted URL (никакъв повторен query между опити)', async () => {
    mockServer!.setSequence([502, 502, 200])
    await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds: 30, intervalSeconds: 1 })
    const urls = mockServer!.getRequestUrls()
    assertEqual(urls.length, 3, 'трябва да има точно 3 реални HTTP заявки')
    const uniqueUrls = new Set(urls)
    assertEqual(uniqueUrls.size, 3, 'всеки от 3-те заявени URL-а трябва да е уникален (cache-busted)')
    for (const u of urls) {
      assert(/[?&]_cb=/.test(u), `URL трябва да съдържа _cb cache-bust query параметър: ${u}`)
    }
  })

  await check('[5] Retry интервалът се съобразява (не busy-loop) — 502,502,200 с 2s интервал отнема поне ~4s', async () => {
    mockServer!.setSequence([502, 502, 200])
    const result = await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds: 30, intervalSeconds: 2 })
    assertEqual(result.stdoutStatus, '200', 'финален статус трябва да е 200')
    assert(result.durationMs >= 3500, `2 неуспешни опита с 2s интервал трябва да отнемат поне ~4s (busy-loop би бил почти мигновен), измерено: ${result.durationMs}ms`)
  })

  await check('[6] Постоянен failure timeout остава bounded (в рамките на max + interval толеранс, не открит-край)', async () => {
    mockServer!.setSequence([502])
    const maxSeconds = 3
    const intervalSeconds = 1
    const result = await runWaitForHealth200(functionsSource, mockServer!.url, { maxSeconds, intervalSeconds })
    assertEqual(result.stdoutStatus, '502', 'финалният статус трябва да остане 502')
    const toleranceMs = (maxSeconds + intervalSeconds + 2) * 1000
    assert(result.durationMs <= toleranceMs, `retry loop-ът трябва да спре bounded в рамките на ~${toleranceMs}ms, измерено: ${result.durationMs}ms`)
  })

  await check('[7] deploy-backend-production.sh реално вика wait_for_public_health_200 за post-restart /health (не единичен http_status_for call)', async () => {
    const source = await readFile(SCRIPT_PATH, 'utf8')
    const postRestartSectionIdx = source.indexOf('# ─── 8. Post-restart verification')
    const migrationSectionIdx = source.indexOf('# ─── 9. Migration verification')
    assert(postRestartSectionIdx !== -1, 'Post-restart verification секция трябва да съществува')
    assert(migrationSectionIdx !== -1, 'Migration verification секция трябва да съществува')
    const postRestartSection = source.slice(postRestartSectionIdx, migrationSectionIdx)
    assert(postRestartSection.includes('wait_for_public_health_200'), 'Post-restart verification секцията трябва да вика wait_for_public_health_200 (retry loop), не единичен check')
    assert(!/POST_HEALTH_CODE="\$\(http_status_for/.test(postRestartSection), 'Post-restart verification НЕ трябва да прави единичен http_status_for call директно (old false-negative bug) — трябва да минава през retry loop-а')
  })

  await check('[8] Marker (persistent deployment state) записът е СЛЕД post-restart health блока в source реда (запис само след успешен post-check)', async () => {
    const source = await readFile(SCRIPT_PATH, 'utf8')
    const postRestartSectionIdx = source.indexOf('# ─── 8. Post-restart verification')
    const stateSectionIdx = source.indexOf('# ─── 10. Persistent deployment state')
    assert(postRestartSectionIdx !== -1, 'Post-restart verification секция трябва да съществува')
    assert(stateSectionIdx !== -1, 'Persistent deployment state секция трябва да съществува')
    assert(stateSectionIdx > postRestartSectionIdx, 'Persistent deployment state записът трябва да е СЛЕД post-restart health verification-а в source реда')
    const healthGateIdx = source.indexOf('post_restart_fail "/health след restart не върна HTTP 200')
    assert(healthGateIdx !== -1, 'health gate fail call трябва да съществува')
    assert(healthGateIdx < stateSectionIdx, 'health gate-ът трябва да е ПРЕДИ marker записа в source реда')
  })
} finally {
  if (mockServer) await mockServer.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
