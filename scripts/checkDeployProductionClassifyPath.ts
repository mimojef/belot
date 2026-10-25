/**
 * checkDeployProductionClassifyPath.ts
 *
 * Целеви тест за classify_path() в scripts/deploy-production.sh —
 * поправка, която добавя ТОЧНО enumerated non-runtime класификация за
 * backup/restore скриптовете под ops/pikabg-backup/scripts/ (бяха
 * "unclassified" -> hard-STOP на целия deploy, заради промените от Фаза
 * 10.1/реставрационния hardening). Извлича РЕАЛНАТА функция от самия .sh
 * файл (не копие/реимплементация) и я изпълнява през bash — тестът се чупи,
 * ако някой на практика промени classify_path() по начин, който тихо го
 * разминава с очакваното поведение.
 *
 * Проверява:
 *   [1] РЕАЛНАТА git delta 9e8761f..HEAD не съдържа нито един unclassified
 *       path (точно обратното на дефекта, който се поправя тук).
 *   [2] Същата delta класифицира коректно: 8 миграции -> "migration",
 *       backend/frontend кода -> съответните категории, точно 4-те
 *       enumerated backup скрипта -> "non-runtime".
 *   [3] Нов/непознат файл под ops/ (вкл. под ops/pikabg-backup/scripts/ с
 *       различно име) продължава да пада в "unclassified" — доказва, че
 *       поправката е точен enumerated allow-list, НЕ "ops/*" wildcard.
 *   [5] Deletion ledger tooling (2 скрипта + systemd service/timer) е
 *       "non-runtime"; реалната delta от production frontend marker-а
 *       (38770ac) няма unclassified path, а тази от backend marker-а
 *       (c0311e6) няма backend/migration path -> FRONTEND ONLY.
 *
 * [1]/[2] са закрепени към delta-та на оригиналната поправка (9e8761f..bb971a4).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let passed = 0
let failed = 0

function pass(label: string): void { passed += 1; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed += 1
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (error) { fail(label, error) }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

console.log('\ncheckDeployProductionClassifyPath')

const repoRoot = resolve(process.cwd())
const deployScriptPath = resolve(repoRoot, 'scripts/deploy-production.sh')
const deployScriptSource = readFileSync(deployScriptPath, 'utf8')

// Извлича ТОЧНО функцията classify_path() { ... } (до затварящата й `}` на
// собствен ред) — байт-за-байт каквото реално ще изпълни production
// контролерът, не реконструкция по памет.
const functionMatch = /^classify_path\(\) \{[\s\S]*?\r?\n\}\r?\n/m.exec(deployScriptSource)
if (functionMatch === null) {
  throw new Error('Не успях да извлека classify_path() от scripts/deploy-production.sh — форматът на функцията изглежда променен.')
}
const classifyPathFunctionSource = functionMatch[0]

function classifyPaths(paths: string[]): Map<string, string> {
  const harness = `${classifyPathFunctionSource}\nwhile IFS= read -r p; do [ -z "$p" ] && continue; printf '%s\\t%s\\n' "$p" "$(classify_path "$p")"; done`
  const output = execFileSync('bash', ['-c', harness], {
    input: paths.join('\n') + '\n',
    encoding: 'utf8',
  })
  const result = new Map<string, string>()
  for (const line of output.split('\n')) {
    if (line.length === 0) continue
    const [p, category] = line.split('\t')
    if (p !== undefined && category !== undefined) result.set(p, category)
  }
  return result
}

function gitDiffNameOnly(fromRef: string, toRef: string): string[] {
  const output = execFileSync('git', ['diff', '--name-only', fromRef, toRef], { cwd: repoRoot, encoding: 'utf8' })
  return output.split('\n').filter((line) => line.length > 0)
}

const PRODUCTION_REF = '9e8761f'
const ORIGINAL_FIX_REF = 'bb971a4'
const realDelta = gitDiffNameOnly(PRODUCTION_REF, ORIGINAL_FIX_REF)

check('[1] Реалната 9e8761f..bb971a4 delta не съдържа нито един "unclassified" path', () => {
  assert(realDelta.length > 0, 'delta-та е празна — нищо за тестване, нещо е грешно в тестовото обкръжение')
  const classified = classifyPaths(realDelta)
  const unclassified = realDelta.filter((p) => classified.get(p) === 'unclassified')
  assert(
    unclassified.length === 0,
    `${unclassified.length} unclassified path(и): ${unclassified.join(', ')}`,
  )
})

check('[2a] 8-те campaign миграции класифицират коректно като "migration"', () => {
  const migrationPaths = realDelta.filter((p) => p.startsWith('server/database/migrations/') && p.endsWith('.sql'))
  assert(migrationPaths.length === 8, `очаквах точно 8 migration файла в delta-та, намерих ${migrationPaths.length}`)
  const classified = classifyPaths(migrationPaths)
  for (const p of migrationPaths) {
    assert(classified.get(p) === 'migration', `${p} -> ${classified.get(p)}, очаквах "migration"`)
  }
})

check('[2b] server/src/** campaign файлове класифицират като "backend"', () => {
  const backendPaths = realDelta.filter((p) => p.startsWith('server/src/'))
  assert(backendPaths.length > 0, 'очаквах поне един server/src/* файл в delta-та')
  const classified = classifyPaths(backendPaths)
  for (const p of backendPaths) {
    assert(classified.get(p) === 'backend', `${p} -> ${classified.get(p)}, очаквах "backend"`)
  }
})

check('[2c] src/** клиентски campaign файлове класифицират като "frontend"', () => {
  const frontendPaths = realDelta.filter((p) => p.startsWith('src/'))
  assert(frontendPaths.length > 0, 'очаквах поне един src/* файл в delta-та')
  const classified = classifyPaths(frontendPaths)
  for (const p of frontendPaths) {
    assert(classified.get(p) === 'frontend', `${p} -> ${classified.get(p)}, очаквах "frontend"`)
  }
})

check('[2d] Точно 4-те enumerated ops/pikabg-backup/ скрипта класифицират като "non-runtime"', () => {
  const expected = [
    'ops/pikabg-backup/scripts/pikabg-db-backup',
    'ops/pikabg-backup/scripts/pikabg-db-retention',
    'ops/pikabg-backup/scripts/pikabg-restore',
    'ops/pikabg-backup/scripts/pikabg-backup-verify-consistency.mjs',
  ]
  const opsPathsInDelta = realDelta.filter((p) => p.startsWith('ops/'))
  assert(
    opsPathsInDelta.length === 5 && opsPathsInDelta.includes('ops/pikabg-backup/README.md'),
    `очаквах точно 5 ops/ файла в delta-та (4 скрипта + README.md), намерих: ${opsPathsInDelta.join(', ')}`,
  )
  const classified = classifyPaths(expected)
  for (const p of expected) {
    assert(classified.get(p) === 'non-runtime', `${p} -> ${classified.get(p)}, очаквах "non-runtime"`)
  }
})

check('[3] Непознат файл под ops/ (НЕ едно от 4-те enumerated имена) продължава да е "unclassified"', () => {
  const unknownPaths = [
    'ops/pikabg-backup/scripts/pikabg-db-backup-v2',
    'ops/pikabg-backup/scripts/new-mystery-tool.sh',
    'ops/pikabg-backup/README2.txt',
    'ops/something-else/file.txt',
    'ops/pikabg-backup/scripts/pikabg-restore.bak',
    'ops/pikabg-backup/scripts/pikabg-ledger-backup.old',
    'ops/pikabg-backup/systemd/pikabg-ledger-backup.service.d/override.conf',
    'ops/pikabg-backup/systemd/other.timer',
  ]
  const classified = classifyPaths(unknownPaths)
  for (const p of unknownPaths) {
    assert(
      classified.get(p) === 'unclassified',
      `${p} -> ${classified.get(p)}, очаквах "unclassified" (доказва че поправката е ТОЧЕН enumerated list, не "ops/*" wildcard)`,
    )
  }
})

check('[4] bash -n синтактична проверка на scripts/deploy-production.sh', () => {
  execFileSync('bash', ['-n', deployScriptPath], { cwd: repoRoot, encoding: 'utf8' })
})

const LEDGER_TOOLING = [
  'ops/pikabg-backup/scripts/pikabg-ledger-backup',
  'ops/pikabg-backup/scripts/pikabg-ledger-restore',
  'ops/pikabg-backup/systemd/pikabg-ledger-backup.service',
  'ops/pikabg-backup/systemd/pikabg-ledger-backup.timer',
]
const FRONTEND_MARKER_REF = '38770ac'
const BACKEND_MARKER_REF = 'c0311e6'

check('[5a] Deletion ledger tooling (2 скрипта + service/timer) класифицира като "non-runtime"', () => {
  const classified = classifyPaths(LEDGER_TOOLING)
  for (const p of LEDGER_TOOLING) {
    assert(classified.get(p) === 'non-runtime', `${p} -> ${classified.get(p)}, очаквах "non-runtime"`)
  }
})

check('[5b] Delta-та от production frontend marker-а (38770ac..HEAD) няма "unclassified" path и съдържа ledger tooling-а', () => {
  const delta = gitDiffNameOnly(FRONTEND_MARKER_REF, 'HEAD')
  const classified = classifyPaths(delta)
  const unclassified = delta.filter((p) => classified.get(p) === 'unclassified')
  assert(unclassified.length === 0, `${unclassified.length} unclassified path(и): ${unclassified.join(', ')}`)
  for (const p of LEDGER_TOOLING) assert(delta.includes(p), `${p} липсва в delta-та`)
  assert(delta.some((p) => classified.get(p) === 'frontend'), 'очаквах frontend промени')
})

check('[5c] Delta-та от production backend marker-а (c0311e6..HEAD) няма backend/migration path -> решение FRONTEND ONLY', () => {
  const delta = gitDiffNameOnly(BACKEND_MARKER_REF, 'HEAD')
  const classified = classifyPaths(delta)
  const backendImpact = delta.filter((p) => classified.get(p) === 'backend' || classified.get(p) === 'migration' || classified.get(p) === 'unclassified')
  assert(backendImpact.length === 0, `backend-impact path(и): ${backendImpact.join(', ')}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
