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
 *   [6] temp/*.png (вкл. поддиректории) е "non-runtime" — дизайн source
 *       изображения, не build/runtime вход. Commit 3574009 (27 PNG) и
 *       изображенията на mobile redesign-а са изцяло non-runtime; всеки
 *       друг файл под temp/ (код, svg, json, .PNG, ...) и .redesign-wip
 *       остават "unclassified"; src/ и public/ PNG-та остават "frontend".
 *   [7] DB backup/retention systemd unit-ите са "non-runtime" (промяна на
 *       графика не STOP-ва Smart Deploy); drop-in пътища остават
 *       "unclassified"; в Git няма drop-in; pikabg-db-backup.timer има един
 *       OnCalendar=*-*-* *:41:00 без конфликт с ledger/retention/cron.hourly.
 *
 * [1]/[2] са закрепени към delta-та на оригиналната поправка (9e8761f..bb971a4).
 * [5c] е закрепен към 89b8a99 — commit-а, в който е написан: решението
 * "FRONTEND ONLY" се отнася за конкретния deploy от 2026-10-25, не за всеки
 * бъдещ HEAD (всеки по-късен backend commit би го "счупил" без дефект).
 * [5b] остава срещу HEAD — инвариант: основният клон никога не натрупва
 * unclassified path спрямо 38770ac.
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

// Същото извикване като fetch_changed_files_output() в контролера (виж [6h]).
function gitDiffNameOnly(fromRef: string, toRef: string): string[] {
  const output = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', fromRef, toRef], { cwd: repoRoot, encoding: 'utf8' })
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

// Commit-ът, в който [5] е написан (fix(deploy): classify deletion ledger
// tooling as non-runtime) — виж бележката за [5c] в началото на файла.
const LEDGER_FIX_REF = '89b8a99'

check(`[5c] Delta-та от production backend marker-а (c0311e6..${LEDGER_FIX_REF}) няма backend/migration path -> решение FRONTEND ONLY`, () => {
  const delta = gitDiffNameOnly(BACKEND_MARKER_REF, LEDGER_FIX_REF)
  const classified = classifyPaths(delta)
  const backendImpact = delta.filter((p) => classified.get(p) === 'backend' || classified.get(p) === 'migration' || classified.get(p) === 'unclassified')
  assert(backendImpact.length === 0, `backend-impact path(и): ${backendImpact.join(', ')}`)
})

// ─── [6] temp/*.png ─────────────────────────────────────────────────────────
const ICONS_COMMIT_REF = '3574009'

check('[6a] Commit 3574009 съдържа точно 27 PNG под temp/ и ВСИЧКИ са "non-runtime"', () => {
  const delta = gitDiffNameOnly(`${ICONS_COMMIT_REF}^`, ICONS_COMMIT_REF)
  assert(delta.length === 27, `очаквах 27 файла в ${ICONS_COMMIT_REF}, получих ${delta.length}`)
  assert(delta.every((p) => p.startsWith('temp/') && p.endsWith('.png')), `не всички са temp/*.png: ${delta.join(', ')}`)
  const classified = classifyPaths(delta)
  const wrong = delta.filter((p) => classified.get(p) !== 'non-runtime')
  assert(wrong.length === 0, `не са "non-runtime": ${wrong.map((p) => `${p} -> ${classified.get(p)}`).join(', ')}`)
})

check('[6b] Delta само с 3574009 -> решение NO RUNTIME DEPLOY (нито frontend, нито backend impact)', () => {
  const classified = classifyPaths(gitDiffNameOnly(`${ICONS_COMMIT_REF}^`, ICONS_COMMIT_REF))
  const runtime = [...classified.entries()].filter(([, c]) => c !== 'non-runtime')
  assert(runtime.length === 0, `runtime/unclassified path(и): ${runtime.map(([p, c]) => `${p} -> ${c}`).join(', ')}`)
})

check('[6c] PNG в поддиректории на temp/ (вкл. интервали/кирилица) -> "non-runtime"', () => {
  const paths = [
    'temp/a.png',
    'temp/redesign/landing/art.png',
    'temp/a/b/c/d.png',
    'temp/icon-learn-belot (1).png',
    'temp/Гланцирана икона.png',
  ]
  const classified = classifyPaths(paths)
  for (const p of paths) assert(classified.get(p) === 'non-runtime', `${p} -> ${classified.get(p)}`)
})

check('[6d] Всичко друго под temp/ остава "unclassified" (тясно правило, не temp/* wildcard)', () => {
  const paths = [
    'temp/x.ts',
    'temp/x.js',
    'temp/x.mjs',
    'temp/x.sh',
    'temp/x.svg',
    'temp/x.json',
    'temp/x.webp',
    'temp/x.jpg',
    'temp/x.PNG',
    'temp/x.png.ts',
    'temp/png',
    'temp/sub/x.html',
    'temp',
  ]
  const classified = classifyPaths(paths)
  for (const p of paths) assert(classified.get(p) === 'unclassified', `${p} -> ${classified.get(p)}, очаквах "unclassified"`)
})

check('[6e] PNG извън temp/ не е засегнат: src/ и public/ -> "frontend", друг корен -> "unclassified"', () => {
  const classified = classifyPaths(['src/assets/x.png', 'public/assets/lobby/x.png', 'public/temp/x.png', 'src/temp/x.png', 'x.png', 'tempx/a.png', 'server/temp/a.png'])
  assert(classified.get('src/assets/x.png') === 'frontend', 'src/assets/x.png')
  assert(classified.get('public/assets/lobby/x.png') === 'frontend', 'public/assets/lobby/x.png')
  assert(classified.get('public/temp/x.png') === 'frontend', 'public/temp/x.png')
  assert(classified.get('src/temp/x.png') === 'frontend', 'src/temp/x.png')
  for (const p of ['x.png', 'tempx/a.png', 'server/temp/a.png']) {
    assert(classified.get(p) === 'unclassified', `${p} -> ${classified.get(p)}, очаквах "unclassified"`)
  }
})

check('[6f] .redesign-wip sentinel остава "unclassified" (първият слой защита не е отслабен)', () => {
  assert(classifyPaths(['.redesign-wip']).get('.redesign-wip') === 'unclassified', '.redesign-wip не е unclassified')
})

check('[6h] Контролерът вика двата git diff-а с core.quotePath=false (иначе кирилският PNG от 3574009 идва в кавички -> unclassified)', () => {
  const src = deployScriptSource.replace(/\r\n/g, '\n')
  assert(src.includes('git -c core.quotePath=false diff --name-only "$from_sha" "$TARGET_SHA"'), 'delta diff-ът не е с core.quotePath=false')
  assert(src.includes('git -c core.quotePath=false diff --name-status "$BACKEND_SHA" "$TARGET_SHA" -- "server/database/migrations/"'), 'migration diff-ът не е с core.quotePath=false')
  // Изрично core.quotePath=true (git default-ът, т.е. production без флага) —
  // иначе глобален core.quotepath=false на машината на разработчика скрива ефекта.
  const quoted = execFileSync('git', ['-c', 'core.quotePath=true', 'diff', '--name-only', `${ICONS_COMMIT_REF}^`, ICONS_COMMIT_REF], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter((l) => l.startsWith('"'))
  assert(quoted.length === 1, `очаквах точно 1 quote-нат path без флага (кирилското име), получих ${quoted.length}`)
  assert(classifyPaths(quoted).get(quoted[0]!) === 'unclassified', 'quote-натият path би трябвало да е unclassified (доказва нуждата от флага)')
})

check('[6g] Изображенията на mobile redesign-а (45c73ac..ba00c14, 14 PNG) са "non-runtime", ако commit-ът е наличен', () => {
  let delta: string[]
  try {
    delta = gitDiffNameOnly('45c73ac', 'ba00c14')
  } catch {
    // Клонинг без feature/mobile-redesign историята — нищо за проверка.
    return
  }
  assert(delta.length === 14, `очаквах 14 файла, получих ${delta.length}`)
  const classified = classifyPaths(delta)
  const wrong = delta.filter((p) => classified.get(p) !== 'non-runtime')
  assert(wrong.length === 0, `не са "non-runtime": ${wrong.join(', ')}`)
})

// ─── [7] DB backup/retention systemd unit-и + часов график ─────────────────
// Графикът на pikabg-db-backup се определя САМО от основния timer в Git
// (без schedule.conf drop-in). Промяна по unit-ите не трябва да STOP-ва
// Smart Deploy, но drop-in и непознати имена остават "unclassified".
const DB_BACKUP_UNITS = [
  'ops/pikabg-backup/systemd/pikabg-db-backup.service',
  'ops/pikabg-backup/systemd/pikabg-db-backup.timer',
  'ops/pikabg-backup/systemd/pikabg-db-retention.service',
  'ops/pikabg-backup/systemd/pikabg-db-retention.timer',
]
const SYSTEMD_DIR = 'ops/pikabg-backup/systemd'

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function timerDirective(source: string, key: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1))
}

check('[7a] DB backup/retention service+timer (4 unit-а) класифицират като "non-runtime"', () => {
  const classified = classifyPaths(DB_BACKUP_UNITS)
  for (const p of DB_BACKUP_UNITS) {
    assert(classified.get(p) === 'non-runtime', `${p} -> ${classified.get(p)}, очаквах "non-runtime"`)
  }
})

check('[7b] Drop-in-и и сходни имена под systemd/ остават "unclassified" (точен списък, не wildcard)', () => {
  const paths = [
    'ops/pikabg-backup/systemd/pikabg-db-backup.timer.d/schedule.conf',
    'ops/pikabg-backup/systemd/pikabg-db-backup.service.d/override.conf',
    'ops/pikabg-backup/systemd/pikabg-db-retention.timer.d/schedule.conf',
    'ops/pikabg-backup/systemd/pikabg-db-backup.timer.bak',
    'ops/pikabg-backup/systemd/pikabg-db-backup2.timer',
    'ops/pikabg-backup/systemd/pikabg-db-backup.path',
    'ops/pikabg-backup/systemd/schedule.conf',
  ]
  const classified = classifyPaths(paths)
  for (const p of paths) {
    assert(classified.get(p) === 'unclassified', `${p} -> ${classified.get(p)}, очаквах "unclassified"`)
  }
})

check('[7c] Всеки tracked файл под ops/pikabg-backup/systemd/ е "non-runtime" и няма drop-in директория в Git', () => {
  const tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', SYSTEMD_DIR], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter((line) => line.length > 0)
  assert(tracked.length === 6, `очаквах 6 unit файла (db-backup, db-retention, ledger-backup × service/timer), намерих ${tracked.length}: ${tracked.join(', ')}`)
  const dropIns = tracked.filter((p) => /\.d\//.test(p))
  assert(dropIns.length === 0, `drop-in файлове в Git (графикът трябва да е само в основния timer): ${dropIns.join(', ')}`)
  const classified = classifyPaths(tracked)
  const wrong = tracked.filter((p) => classified.get(p) !== 'non-runtime')
  assert(wrong.length === 0, `не са "non-runtime": ${wrong.map((p) => `${p} -> ${classified.get(p)}`).join(', ')}`)
})

check('[7d] pikabg-db-backup.timer: единствен OnCalendar=*-*-* *:41:00, Persistent/AccuracySec/Unit непроменени', () => {
  const timer = readRepoFile(`${SYSTEMD_DIR}/pikabg-db-backup.timer`)
  const onCalendar = timerDirective(timer, 'OnCalendar')
  assert(onCalendar.length === 1 && onCalendar[0] === '*-*-* *:41:00', `OnCalendar редове: ${JSON.stringify(onCalendar)}`)
  assert(JSON.stringify(timerDirective(timer, 'Persistent')) === '["true"]', 'Persistent трябва да е true')
  assert(JSON.stringify(timerDirective(timer, 'AccuracySec')) === '["1s"]', 'AccuracySec трябва да е 1s')
  assert(JSON.stringify(timerDirective(timer, 'Unit')) === '["pikabg-db-backup.service"]', 'Unit трябва да е pikabg-db-backup.service')
  assert(timerDirective(timer, 'RandomizedDelaySec').length === 0, 'не очаквам RandomizedDelaySec (детерминистичен график)')
  assert(/^WantedBy=timers\.target$/m.test(timer), 'липсва WantedBy=timers.target')
})

check('[7e] Минута :41 не съвпада с ledger (*:0/5), retention (03:20) и cron.hourly (:17)', () => {
  const ledger = timerDirective(readRepoFile(`${SYSTEMD_DIR}/pikabg-ledger-backup.timer`), 'OnCalendar')
  assert(JSON.stringify(ledger) === '["*:0/5"]', `ledger графикът е променен: ${JSON.stringify(ledger)} — преизчисли конфликтите`)
  const retention = timerDirective(readRepoFile(`${SYSTEMD_DIR}/pikabg-db-retention.timer`), 'OnCalendar')
  assert(JSON.stringify(retention) === '["*-*-* 03:20:00"]', `retention графикът е променен: ${JSON.stringify(retention)} — преизчисли конфликтите`)
  const minute = 41
  assert(minute % 5 !== 0, 'съвпада с ledger минута')
  assert(minute !== 20, 'съвпада с retention минута')
  assert(minute !== 17, 'съвпада с cron.hourly')
  assert(minute !== 0, 'съвпада с :00')
})

check('[7f] Текущите (некоммитнати) промени спрямо HEAD нямат "unclassified" path', () => {
  const delta = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter((line) => line.length > 0)
  const classified = classifyPaths(delta)
  const unclassified = delta.filter((p) => classified.get(p) === 'unclassified')
  assert(unclassified.length === 0, `${unclassified.length} unclassified path(и): ${unclassified.join(', ')}`)
})

// ─── [8] Гласов чат: ops/ инструменти (T2, LiveKit IT, Caddy метрики) ──────
// Smart Deploy спря при b4ab687 с точно тези 11 unclassified файла. Всички са
// non-runtime: не са build вход, worker-ите не ги пускат/инсталират.
const VOICE_OPS_NON_RUNTIME = [
  'ops/deploy-migration-backup-retention/check-prune-deploy-migration-backups.mjs',
  'ops/deploy-migration-backup-retention/prune-deploy-migration-backups.mjs',
  'ops/deploy-migration-backup-retention/systemd/pikabg-deploy-backup-retention.service',
  'ops/deploy-migration-backup-retention/systemd/pikabg-deploy-backup-retention.timer',
  'ops/voice-livekit-it/.gitignore',
  'ops/voice-livekit-it/package-lock.json',
  'ops/voice-livekit-it/package.json',
  'ops/voice-livekit-it/run.mjs',
  'ops/voice-metrics-caddy/Caddyfile.snippet',
  'ops/voice-metrics-caddy/caddy-http-server.json',
  'ops/voice-metrics-caddy/caddy-yaml-block.yaml',
]
const VOICE_OPS_DIRS = ['ops/deploy-migration-backup-retention', 'ops/voice-livekit-it', 'ops/voice-metrics-caddy', 'ops/voice-production-env']
const VOICE_DEPLOY_TARGET_REF = 'b4ab687'

check('[8a] 11-те файла от STOP-а при b4ab687 класифицират като "non-runtime"', () => {
  const classified = classifyPaths(VOICE_OPS_NON_RUNTIME)
  for (const p of VOICE_OPS_NON_RUNTIME) {
    assert(classified.get(p) === 'non-runtime', `${p} -> ${classified.get(p)}, очаквах "non-runtime"`)
  }
})

check('[8b] Сходни/нови имена под същите папки остават "unclassified" (точен списък, не wildcard)', () => {
  const paths = [
    'ops/deploy-migration-backup-retention/systemd/pikabg-deploy-backup-retention.timer.d/override.conf',
    'ops/deploy-migration-backup-retention/systemd/pikabg-deploy-backup-retention.service.d/override.conf',
    'ops/deploy-migration-backup-retention/systemd/other.timer',
    'ops/deploy-migration-backup-retention/prune-deploy-migration-backups.mjs.bak',
    'ops/deploy-migration-backup-retention/new-tool.sh',
    'ops/voice-livekit-it/results/run-1.json',
    'ops/voice-livekit-it/node_modules/livekit-server-sdk/index.js',
    'ops/voice-livekit-it/other.mjs',
    'ops/voice-livekit-it/.env',
    'ops/voice-metrics-caddy/Caddyfile',
    'ops/voice-metrics-caddy/other.yaml',
    'ops/voice-production-env/server.env',
    'ops/voice-production-env/install.sh',
    'ops/voice-new-tool/run.mjs',
  ]
  const classified = classifyPaths(paths)
  for (const p of paths) {
    assert(classified.get(p) === 'unclassified', `${p} -> ${classified.get(p)}, очаквах "unclassified"`)
  }
})

check('[8c] Всеки tracked файл в гласовите ops/ папки е "non-runtime" (README.md по общия *.md шаблон)', () => {
  const tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', ...VOICE_OPS_DIRS], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter((line) => line.length > 0)
  assert(tracked.length === 15, `очаквах 15 tracked файла (11 + 4 README.md), намерих ${tracked.length}: ${tracked.join(', ')}`)
  const classified = classifyPaths(tracked)
  const wrong = tracked.filter((p) => classified.get(p) !== 'non-runtime')
  assert(wrong.length === 0, `не са "non-runtime": ${wrong.map((p) => `${p} -> ${classified.get(p)}`).join(', ')}`)
})

check('[8d] Не са build вход: без npm workspaces, tsconfig include само src, без импорти от ops/ в src/ и server/src/', () => {
  for (const pkg of ['package.json', 'server/package.json']) {
    assert(!('workspaces' in JSON.parse(readRepoFile(pkg))), `${pkg} има workspaces`)
  }
  assert(/"include":\s*\["src"\]/.test(readRepoFile('tsconfig.json')), 'root tsconfig include')
  assert(/"include":\s*\["src\/\*\*\/\*\.ts"\]/.test(readRepoFile('server/tsconfig.json')), 'server tsconfig include')
  assert(!/ops\//.test(readRepoFile('vite.config.ts')), 'vite.config.ts реферира ops/')
  let importsFromOps = ''
  try {
    importsFromOps = execFileSync('git', ['grep', '-nE', `(from|import\\()\\s*['"][^'"]*ops/`, VOICE_DEPLOY_TARGET_REF, '--', 'src', 'server/src'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    // git grep: изход 1 = няма съвпадения (очакваното); друго е истинска грешка.
    if ((error as { status?: number }).status !== 1) throw error
  }
  assert(importsFromOps.length === 0, `импорти от ops/: ${importsFromOps}`)
})

// fdb8697 = родителят на 7fa9fa9 (добавя ops/voice-livekit-it/). Delta-та
// fdb8697..b4ab687 съдържа точно 11-те файла от STOP-а — production marker-ите
// са на или преди fdb8697. Закрепено към b4ab687 (по-късни commit-и не го чупят).
const VOICE_PRE_TOOLING_REF = 'fdb8697'

check(`[8e] Delta ${VOICE_PRE_TOOLING_REF}..${VOICE_DEPLOY_TARGET_REF}: 0 "unclassified", съдържа 11-те файла, frontend + backend impact -> решение FULL`, () => {
  const delta = gitDiffNameOnly(VOICE_PRE_TOOLING_REF, VOICE_DEPLOY_TARGET_REF)
  const classified = classifyPaths(delta)
  const unclassified = delta.filter((p) => classified.get(p) === 'unclassified')
  assert(unclassified.length === 0, `${unclassified.length} unclassified path(и): ${unclassified.join(', ')}`)
  const opsNonMd = delta.filter((p) => p.startsWith('ops/') && !p.endsWith('.md')).sort()
  assert(opsNonMd.join('|') === [...VOICE_OPS_NON_RUNTIME].sort().join('|'), `ops/ файлове в delta-та: ${opsNonMd.join(', ')}`)
  const frontendImpact = delta.some((p) => classified.get(p) === 'frontend')
  const backendImpact = delta.some((p) => classified.get(p) === 'backend' || classified.get(p) === 'migration')
  assert(frontendImpact && backendImpact, `frontend=${frontendImpact} backend=${backendImpact}`)
  assert(delta.includes('src/app/lobby/publicLegalPages.ts') && delta.includes('server/src/voice/voiceRetentionSweeper.ts'), 'правните текстове и T1 са в delta-та')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
