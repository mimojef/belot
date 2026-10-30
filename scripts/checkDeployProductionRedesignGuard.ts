/**
 * checkDeployProductionRedesignGuard.ts
 *
 * Целеви тест за "Redesign WIP guard" (scripts/lib/redesignWipGuard.sh) във
 * всички production deploy entrypoint-и — всеки трябва да откаже commit,
 * чието tree съдържа проследявания sentinel .redesign-wip
 * (feature/mobile-redesign), ПРЕДИ каквато и да е production промяна.
 *
 * Изпълнява РЕАЛНИТЕ скриптове (целите файлове, не извадки) в изолирани
 * sandbox-и. Заменят се САМО абсолютните production пътища/URL-и
 * (/var/www, /var/lib, /var/lock, https://www.pika.bg) с temp директории и
 * недостъпен localhost; npm/npx/pm2/curl/flock са fake CLI-и, които само
 * записват извикването си (и, освен flock, се провалят). Никакъв реален
 * build/deploy/PM2/nginx/HTTP към production.
 *
 * Употреба: npx tsx scripts/checkDeployProductionRedesignGuard.ts
 *
 * Проверява:
 *   [S] Статичен ред: всеки entrypoint source-ва библиотеката и вика guard-а
 *       точно веднъж, след определянето на commit-а и преди първата
 *       production стъпка; библиотеката не зависи от branch име.
 *   [R] deploy-production.sh: редизайнът се блокира (branch tip, detached,
 *       branch с production име, marker-и вече със sentinel — случай, който
 *       classify_path() сам НЕ хваща, доказано с guard-less контрола).
 *   [F] Fail-closed: провал на git ls-tree, липсваща библиотека.
 *   [A] deploy-production.sh допуска основния клон, hotfix в detached HEAD и
 *       hotfix merge-нат обратно.
 *   [E] Съществуващите smart deploy механизми (FULL, MIGRATE, unclassified,
 *       ancestry, dirty, NO RUNTIME, стара миграция, temp/*.png с кирилско име).
 *   [W] deploy-frontend-production.sh и deploy-backend-production.sh като
 *       ДИРЕКТНИ entrypoint-и: блокиране без странични ефекти (без
 *       npm/pm2/curl, state/releases/assets/DB/dist непроменени) и допускане
 *       на hotfix в detached HEAD до следващата стъпка (build / pm2 describe).
 *   [D] deployFrontendAtomic.sh: блокиране (tree, detached, sentinel в
 *       working dir, не-git PROJECT_ROOT, липсваща библиотека) без странични
 *       ефекти; hotfix допуснат до build; --list не се блокира.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

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

console.log('\ncheckDeployProductionRedesignGuard')

const repoRoot = resolve(process.cwd())
const readLf = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')
const controllerSource = readLf('scripts/deploy-production.sh')
const frontendWorkerSource = readLf('scripts/deploy-frontend-production.sh')
const backendWorkerSource = readLf('scripts/deploy-backend-production.sh')
const atomicSource = readLf('scripts/deployFrontendAtomic.sh')
const guardLibSource = readLf('scripts/lib/redesignWipGuard.sh')
const ATOMIC_SCRIPT_PATH = resolve(repoRoot, 'scripts/deployFrontendAtomic.sh')

const GUARD_BLOCKED = /Redesign WIP guard: target [0-9a-f]{7} съдържа \.redesign-wip/
const GUARD_OK = /Redesign WIP guard: target [0-9a-f]{7} не съдържа \.redesign-wip — OK/
const LIB_SOURCE_LINE = '. "$REDESIGN_WIP_GUARD_LIB"'
const CONTROLLER_GUARD_CALL = 'assert_target_not_redesign_wip "$PROJECT_ROOT" "$TARGET_SHA"'
const WORKER_GUARD_CALL = 'assert_target_not_redesign_wip "$PROJECT_ROOT" "$GIT_SHA"'
const ATOMIC_GUARD_CALL = 'assert_target_not_redesign_wip "$PROJECT_ROOT" "$GUARD_TARGET_SHA"'

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}
function indexOrThrow(haystack: string, needle: string, label: string): number {
  const idx = haystack.indexOf(needle)
  assert(idx !== -1, `${label}: anchor не е намерен: ${needle}`)
  return idx
}

// ─── [S] Static ordering ────────────────────────────────────────────────────
console.log('\n[S] Статичен ред във всеки entrypoint')

check('S1 библиотеката: ls-tree върху подадения commit, cat-file проверка, без branch логика', () => {
  assert(guardLibSource.includes('git -C "$repo_dir" ls-tree --full-tree --name-only "$commit" -- "$REDESIGN_WIP_SENTINEL"'), 'липсва ls-tree върху $commit')
  assert(guardLibSource.includes('cat-file -e "${commit}^{commit}"'), 'липсва проверка за валиден commit')
  assert(!/symbolic-ref|--abbrev-ref|branch --show-current|for-each-ref/.test(guardLibSource), 'библиотеката не бива да зависи от branch име')
})

check('S2 deploy-production.sh: guard след TARGET_SHA, преди marker четене и worker-и', () => {
  assert(countOf(controllerSource, LIB_SOURCE_LINE) === 1 && countOf(controllerSource, CONTROLLER_GUARD_CALL) === 1, 'очаквах точно един source + извикване')
  const guard = indexOrThrow(controllerSource, CONTROLLER_GUARD_CALL, 'controller')
  assert(indexOrThrow(controllerSource, 'TARGET_SHA="$(git rev-parse HEAD)"', 'controller') < guard, 'guard е преди TARGET_SHA')
  assert(guard < indexOrThrow(controllerSource, 'section "Reading deployment state markers"', 'controller'), 'guard е след marker четенето')
  assert(guard < indexOrThrow(controllerSource, 'bash "$FRONTEND_WORKER"', 'controller'), 'guard е след frontend worker')
  assert(guard < indexOrThrow(controllerSource, 'bash "$BACKEND_WORKER"', 'controller'), 'guard е след backend worker')
})

check('S3 deploy-frontend-production.sh: guard след GIT_SHA, преди state preflight/build/release/switch', () => {
  const src = frontendWorkerSource
  assert(countOf(src, LIB_SOURCE_LINE) === 1 && countOf(src, WORKER_GUARD_CALL) === 1, 'очаквах точно един source + извикване')
  const guard = indexOrThrow(src, WORKER_GUARD_CALL, 'frontend')
  assert(indexOrThrow(src, 'GIT_SHA="$(git rev-parse HEAD)"', 'frontend') < guard, 'guard е преди GIT_SHA')
  for (const anchor of ['mkdir -p "$DEPLOY_STATE_DIR"', 'npm run build\n', 'cp -a "$DIST_DIR"/. "$NEW_RELEASE"/']) {
    assert(guard < indexOrThrow(src, anchor, 'frontend'), `guard е след "${anchor.trim()}"`)
  }
})

check('S4 deploy-backend-production.sh: guard след GIT_SHA, преди PM2/health/state/backup/restart', () => {
  const src = backendWorkerSource
  assert(countOf(src, LIB_SOURCE_LINE) === 1 && countOf(src, WORKER_GUARD_CALL) === 1, 'очаквах точно един source + извикване')
  const guard = indexOrThrow(src, WORKER_GUARD_CALL, 'backend')
  const preflight = indexOrThrow(src, 'section "Pre-flight checks"', 'backend')
  assert(indexOrThrow(src, 'GIT_SHA="$(git rev-parse HEAD)"', 'backend') < guard, 'guard е преди GIT_SHA')
  for (const anchor of ['if ! pm2 describe', 'PRE_HEALTH_CODE=', 'mkdir -p "$DEPLOY_STATE_DIR"']) {
    assert(guard < indexOrThrow(src, anchor, 'backend'), `guard е след "${anchor}"`)
  }
  // Всяка реална pm2/npm/curl/mkdir/mv/cp команда в main flow-а е СЛЕД guard-а.
  const mainFlow = src.slice(preflight, guard).split('\n').filter((l) => !l.trimStart().startsWith('#'))
  const mutating = mainFlow.filter((l) => /(^|[\s;|&(])(pm2|npm|curl|mkdir|mv|cp|rm|sqlite3)\s/.test(l.replace(/"[^"]*"/g, '""')) && !/command -v/.test(l))
  assert(mutating.length === 0, `production команди преди guard-а: ${mutating.join(' | ')}`)
})

check('S5 deployFrontendAtomic.sh: guard след --list/--rollback/--gc-assets, преди mktemp/build/publish', () => {
  const src = atomicSource
  assert(countOf(src, LIB_SOURCE_LINE) === 1 && countOf(src, ATOMIC_GUARD_CALL) === 1, 'очаквах точно един source + извикване')
  const guard = indexOrThrow(src, ATOMIC_GUARD_CALL, 'atomic')
  assert(indexOrThrow(src, 'if [ "$ACTION" = "gc-assets" ]', 'atomic') < guard, 'guard е преди --gc-assets клона (би блокирал maintenance)')
  for (const anchor of ['BUILD_DIR="$(mktemp -d', 'npx tsc', 'mkdir -p "$SHARED_ASSETS_DIR"', 'mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"\n  log "Rollback']) {
    const idx = src.indexOf(anchor)
    if (anchor.includes('Rollback')) {
      assert(idx !== -1 && idx < guard, 'rollback клонът трябва да е ПРЕДИ guard-а (не се блокира)')
    } else {
      assert(guard < indexOrThrow(src, anchor, 'atomic'), `guard е след "${anchor}"`)
    }
  }
})

// ─── Sandbox helpers ────────────────────────────────────────────────────────
function toPosixPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):[\\/]/, (_m, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
}

const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

const FAKE_CONTROLLER_WORKER = (kind: 'frontend' | 'backend'): string => `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
printf '${kind} %s\\n' "$SHA" >> "$DEPLOY_TEST_WORKER_LOG"
${kind === 'frontend'
    ? `printf '{"gitSha":"%s","releasePath":"%s"}\\n' "$SHA" "$DEPLOY_TEST_RELEASE_PATH" > "$DEPLOY_TEST_STATE_DIR/frontend.json"`
    : `printf '{"gitSha":"%s","pm2Pid":"4242"}\\n' "$SHA" > "$DEPLOY_TEST_STATE_DIR/backend.json"`}
`

const FAKE_CLI = `#!/usr/bin/env bash
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$DEPLOY_TEST_SIDE_EFFECT_LOG"
exit 1
`

interface Sandbox {
  root: string
  rootPosix: string
  repo: string
  repoPosix: string
  state: string
  release: string
  current: string
  bin: string
  workerLog: string
  sideEffectLog: string
  shas: Record<string, string>
  git: (...args: string[]) => string
  writeAndCommit: (files: Record<string, string>, message: string) => string
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'belot-redesign-guard-'))
  const repo = join(root, 'repo')
  const state = join(root, 'state')
  const release = join(root, 'releases', 'r1')
  const bin = join(root, 'bin')
  for (const dir of [repo, state, release, bin, join(root, 'tmp')]) mkdirSync(dir, { recursive: true })

  // Канонична bash форма (pwd -P) — скриптовете сравняват точно с нея.
  const repoPosix = execFileSync('bash', ['-c', 'cd "$1" && pwd -P', '_', toPosixPath(repo)], { encoding: 'utf8' }).trim()
  const rootPosix = repoPosix.replace(/\/repo$/, '')

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'v2-clean-architecture')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Guard Test')
  git('config', 'user.email', 'guard-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')

  const writeAndCommit = (files: Record<string, string>, message: string): string => {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(repo, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }

  const base = writeAndCommit({
    '.gitignore': '/current\n/releases/\n/assets/\n/dist/\n/server/dist/\n/server/database/data/\n/server/database/backups/\n',
    'scripts/deploy-frontend-production.sh': FAKE_CONTROLLER_WORKER('frontend'),
    'scripts/deploy-backend-production.sh': FAKE_CONTROLLER_WORKER('backend'),
    'scripts/lib/redesignWipGuard.sh': guardLibSource,
    'server/database/migrations/001_init.sql': 'CREATE TABLE t (id INTEGER);\n',
    'server/src/index.ts': 'export const v = 1\n',
    'server/package.json': '{ "name": "server" }\n',
    'src/app.ts': 'export const app = 1\n',
    'docs/notes.md': '# notes\n',
  }, 'base')
  const main1 = writeAndCommit({ 'src/app.ts': 'export const app = 2\n' }, 'main: frontend fix')

  git('checkout', '-q', '-b', 'feature/mobile-redesign')
  const redesign1 = writeAndCommit({ '.redesign-wip': 'WIP\n', 'src/landing.ts': 'export const landing = 1\n' }, 'redesign: sentinel + landing')
  const redesign2 = writeAndCommit({ 'src/landing.ts': 'export const landing = 2\n' }, 'redesign: more landing')

  git('checkout', '-q', '-b', 'hotfix/backend', base)
  const hotfix1 = writeAndCommit({ 'server/src/index.ts': 'export const v = 2\n' }, 'hotfix: backend')

  git('checkout', '-q', 'v2-clean-architecture')

  // Production-подобно състояние: двата marker-а на base, current -> r1.
  // releasePath = bash readlink -f форма (MSYS мапва temp към /tmp/...).
  const current = join(repo, 'current')
  symlinkSync(release, current, 'junction')
  const releasePosix = execFileSync('bash', ['-c', 'readlink -f "$1"', '_', `${repoPosix}/current`], { encoding: 'utf8' }).trim()
  writeFileSync(join(state, 'frontend.json'), JSON.stringify({ gitSha: base, releasePath: releasePosix }) + '\n')
  writeFileSync(join(state, 'backend.json'), JSON.stringify({ gitSha: base, pm2Pid: '4242' }) + '\n')

  writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n')
  for (const name of ['npm', 'npx', 'pm2', 'curl']) writeFileSync(join(bin, name), FAKE_CLI)
  for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755)

  return {
    root, rootPosix, repo, repoPosix, state, release, current, bin, git, writeAndCommit,
    workerLog: join(root, 'workers.log'),
    sideEffectLog: join(root, 'side-effects.log'),
    shas: { base, main1, redesign1, redesign2, hotfix1 },
  }
}

function sandboxScript(sb: Sandbox, name: string, source: string, replacements: Record<string, string>): string {
  let text = source
  for (const [from, to] of Object.entries(replacements)) {
    assert(countOf(text, from) === 1, `${name}: production ред не е намерен точно веднъж: ${from}`)
    text = text.replace(from, to)
  }
  const leaking = text.split('\n').filter((l) => !l.trimStart().startsWith('#') && (l.includes('/var/') || l.includes('pika.bg')))
  assert(leaking.length === 0, `${name}: sandbox скриптът още сочи към production: ${leaking.join(' | ')}`)
  const path = join(sb.root, name)
  writeFileSync(path, text, 'utf8')
  return path
}

interface RunResult { code: number; out: string; workers: string[]; sideEffects: string[] }

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0) : []
}

function runBash(sb: Sandbox, scriptPath: string, opts: { args?: string[]; input?: string; extraBin?: string; env?: Record<string, string>; cwd?: string } = {}): RunResult {
  const pathPrefix = [opts.extraBin, sb.bin].filter((p): p is string => p !== undefined).map(toPosixPath).join(':')
  const result = spawnSync('bash', ['-c', `export PATH="${pathPrefix}:$PATH"; script="$1"; shift; bash "$script" "$@"`, '_', toPosixPath(scriptPath), ...(opts.args ?? [])], {
    cwd: opts.cwd ?? sb.root,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_TEST_WORKER_LOG: toPosixPath(sb.workerLog),
      DEPLOY_TEST_SIDE_EFFECT_LOG: toPosixPath(sb.sideEffectLog),
      DEPLOY_TEST_STATE_DIR: toPosixPath(sb.state),
      DEPLOY_TEST_RELEASE_PATH: JSON.parse(readFileSync(join(sb.state, 'frontend.json'), 'utf8')).releasePath,
      ...opts.env,
    },
  })
  return { code: result.status ?? -1, out: `${result.stdout}\n${result.stderr}`, workers: readLines(sb.workerLog), sideEffects: readLines(sb.sideEffectLog) }
}

function setMarkers(sb: Sandbox, sha: string): void {
  for (const name of ['frontend.json', 'backend.json']) {
    const data = JSON.parse(readFileSync(join(sb.state, name), 'utf8'))
    data.gitSha = sha
    writeFileSync(join(sb.state, name), JSON.stringify(data) + '\n')
  }
}

function isDetached(sb: Sandbox): boolean {
  return spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: sb.repo }).status !== 0
}

// Пълна снимка на всичко, което някой deploy entrypoint може да промени.
function listTree(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) { out.push(`${relative(dir, full)}/`); walk(full) } else out.push(relative(dir, full))
    }
  }
  walk(dir)
  return out.sort()
}
function fileFingerprint(path: string): string {
  if (!existsSync(path)) return '(липсва)'
  return `${createHash('sha256').update(readFileSync(path)).digest('hex')}@${statSync(path).mtimeMs}`
}

interface ProductionSnapshot { data: string }

// Файлове, които пише САМИЯТ тест harness (sandbox копията на скриптовете и
// fake git), не скриптът под тест — изключват се от sandbox root сравнението.
const HARNESS_ROOT_ENTRIES = new Set(['controller.sh', 'frontend-worker.sh', 'backend-worker.sh', 'fakegit'])

function snapshotProduction(sb: Sandbox, extraDirs: string[] = []): ProductionSnapshot {
  const ignoredInRepo = ['releases', 'assets', 'dist', join('server', 'dist'), join('server', 'database', 'data'), join('server', 'database', 'backups')]
  const parts: Record<string, unknown> = {
    stateFiles: Object.fromEntries(readdirSync(sb.state).map((n) => [n, fileFingerprint(join(sb.state, n))])),
    release: listTree(sb.release),
    current: readlinkSync(sb.current),
    gitStatus: sb.git('status', '--porcelain', '--ignored'),
    head: sb.git('rev-parse', 'HEAD'),
    repoIgnored: Object.fromEntries(ignoredInRepo.map((d) => [d, listTree(join(sb.repo, d))])),
    db: fileFingerprint(join(sb.repo, 'server', 'database', 'data', 'belot-v2.sqlite')),
    // *.lock: празен flock файл, създаван от всеки скрипт преди git
    // проверките (както и преди guard-а) — не е production промяна.
    rootEntries: readdirSync(sb.root).filter((e) => !e.endsWith('.lock') && !HARNESS_ROOT_ENTRIES.has(e)).sort(),
    tmp: listTree(join(sb.root, 'tmp')),
    extra: Object.fromEntries(extraDirs.map((d) => [d, listTree(d)])),
  }
  return { data: JSON.stringify(parts, null, 1) }
}

function assertNoProductionSideEffects(sb: Sandbox, before: ProductionSnapshot, run: RunResult, extraDirs: string[] = []): void {
  assert(run.workers.length === 0, `worker-и са извикани: ${run.workers.join(', ')}`)
  assert(run.sideEffects.length === 0, `npm/npx/pm2/curl са извикани: ${run.sideEffects.join(', ')}`)
  const after = snapshotProduction(sb, extraDirs)
  if (after.data !== before.data) {
    throw new Error(`production състоянието е променено:\nПРЕДИ ${before.data}\nСЛЕД ${after.data}`)
  }
}

function assertBlockedByGuard(run: RunResult): void {
  assert(run.code !== 0, `очаквах STOP, exit=${run.code}`)
  assert(GUARD_BLOCKED.test(run.out), `липсва guard съобщение:\n${run.out}`)
}

const sandboxes: Sandbox[] = []
function withSandbox(label: string, fn: (sb: Sandbox) => void): void {
  check(label, () => {
    const sb = createSandbox()
    sandboxes.push(sb)
    fn(sb)
  })
}

// ─── deploy-production.sh в sandbox ─────────────────────────────────────────
function controllerFor(sb: Sandbox, source: string = controllerSource): string {
  return sandboxScript(sb, 'controller.sh', source, {
    'PROJECT_ROOT="/var/www/belot-v2"': `PROJECT_ROOT="${sb.repoPosix}"`,
    'DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"': `DEPLOY_STATE_DIR="${sb.rootPosix}/state"`,
    'LOCK_FILE="/var/lock/belot-v2-production.lock"': `LOCK_FILE="${sb.rootPosix}/controller.lock"`,
  })
}
const runController = (sb: Sandbox, opts: { input?: string; extraBin?: string; source?: string } = {}): RunResult =>
  runBash(sb, controllerFor(sb, opts.source), opts)

function assertControllerBlocked(sb: Sandbox): void {
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assertBlockedByGuard(run)
  assert(!run.out.includes('Reading deployment state markers'), 'marker четенето е започнало преди guard STOP')
  assertNoProductionSideEffects(sb, before, run)
}

console.log('\n[R] deploy-production.sh: редизайнът се блокира')

withSandbox('R1 feature/mobile-redesign tip -> STOP без странични ефекти', (sb) => {
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  assertControllerBlocked(sb)
})

withSandbox('R2 redesign commit в detached HEAD -> STOP', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.redesign1)
  assert(isDetached(sb), 'HEAD не е detached')
  assertControllerBlocked(sb)
})

withSandbox('R3 redesign commit на branch с production име -> STOP (не зависи от името)', (sb) => {
  sb.git('checkout', '-q', '-B', 'v2-clean-architecture', sb.shas.redesign2)
  assert(sb.git('branch', '--show-current') === 'v2-clean-architecture', 'branch името не е подменено')
  assertControllerBlocked(sb)
})

withSandbox('R4 marker-ите вече съдържат sentinel (bypass в миналото) -> guard пак STOP', (sb) => {
  setMarkers(sb, sb.shas.redesign1)
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  assertControllerBlocked(sb)
})

// Контрола за R4: същият сценарий с контролер БЕЗ guard блока deploy-ва —
// доказва, че classify_path() сам не е достатъчен и guard-ът е реалната защита.
withSandbox('R5 контрола: без guard същият R4 сценарий БИ deploy-нал редизайна', (sb) => {
  const start = indexOrThrow(controllerSource, '# ─── Redesign WIP guard', 'controller')
  const callEnd = indexOrThrow(controllerSource, CONTROLLER_GUARD_CALL, 'controller') + CONTROLLER_GUARD_CALL.length + 1
  const withoutGuard = controllerSource.slice(0, start) + controllerSource.slice(callEnd)
  setMarkers(sb, sb.shas.redesign1)
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const run = runController(sb, { source: withoutGuard })
  assert(run.code === 0, `очаквах успех без guard, exit=${run.code}\n${run.out}`)
  assert(run.workers.join(',') === `frontend ${sb.shas.redesign2}`, `очаквах frontend worker за redesign2: ${run.workers.join(', ')}`)
})

// ─── Fail-closed ────────────────────────────────────────────────────────────
console.log('\n[F] Fail-closed')

function makeFailingLsTreeGit(sb: Sandbox): string {
  const dir = join(sb.root, 'fakegit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'git'), `#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = "ls-tree" ]; then echo "fatal: simulated" >&2; exit 128; fi; done\nexec "${REAL_GIT}" "$@"\n`)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

withSandbox('F1 провал на git ls-tree -> STOP без странични ефекти', (sb) => {
  const before = snapshotProduction(sb)
  const run = runController(sb, { extraBin: makeFailingLsTreeGit(sb) })
  assert(run.code !== 0, `очаквах STOP, exit=${run.code}`)
  assert(run.out.includes('Redesign WIP guard: git ls-tree се провали'), `липсва fail-closed съобщение:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('F2 target без scripts/lib/redesignWipGuard.sh -> STOP (fail-closed)', (sb) => {
  sb.git('rm', '-q', 'scripts/lib/redesignWipGuard.sh')
  sb.git('commit', '-q', '-m', 'drop guard lib')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('Redesign WIP guard библиотеката липсва'), `очаквах STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

// ─── Allowed ────────────────────────────────────────────────────────────────
console.log('\n[A] deploy-production.sh: легитимни deploy-и се допускат')

withSandbox('A1 v2-clean-architecture -> FRONTEND ONLY, guard OK', (sb) => {
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(GUARD_OK.test(run.out), 'липсва guard OK log')
  assert(run.out.includes('РЕШЕНИЕ: FRONTEND ONLY'), 'очаквах FRONTEND ONLY')
  assert(run.workers.join(',') === `frontend ${sb.shas.main1}`, `worker-и: ${run.workers.join(', ')}`)
  assert(JSON.parse(readFileSync(join(sb.state, 'frontend.json'), 'utf8')).gitSha === sb.shas.main1, 'frontend marker не е обновен')
})

withSandbox('A2 hotfix в detached HEAD -> BACKEND ONLY, guard OK', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
  assert(isDetached(sb), 'HEAD не е detached')
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(GUARD_OK.test(run.out), 'липсва guard OK log')
  assert(run.out.includes('РЕШЕНИЕ: BACKEND ONLY'), 'очаквах BACKEND ONLY')
  assert(run.workers.join(',') === `backend ${sb.shas.hotfix1}`, `worker-и: ${run.workers.join(', ')}`)
})

withSandbox('A3 hotfix merge-нат в v2-clean-architecture след hotfix deploy -> ancestry OK', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
  assert(runController(sb).code === 0, 'hotfix deploy-ът се провали')
  sb.git('checkout', '-q', 'v2-clean-architecture')
  sb.git('merge', '-q', '--no-edit', 'hotfix/backend')
  const merged = sb.git('rev-parse', 'HEAD')
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('РЕШЕНИЕ: FRONTEND ONLY'), `очаквах FRONTEND ONLY:\n${run.out}`)
  assert(run.workers[run.workers.length - 1] === `frontend ${merged}`, `worker-и: ${run.workers.join(', ')}`)
})

// ─── Existing smart-deploy mechanisms ───────────────────────────────────────
console.log('\n[E] Съществуващите smart deploy механизми')

withSandbox('E1 FULL: backend преди frontend', (sb) => {
  const sha = sb.writeAndCommit({ 'server/src/index.ts': 'export const v = 3\n' }, 'full')
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('РЕШЕНИЕ: FULL'), 'очаквах FULL')
  assert(run.workers.join(',') === `backend ${sha},frontend ${sha}`, `ред: ${run.workers.join(', ')}`)
})

withSandbox('E2 нова миграция + MIGRATE -> backend worker', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  const sha = sb.writeAndCommit({ 'server/database/migrations/002_add.sql': 'ALTER TABLE t ADD c INTEGER;\n' }, 'migration')
  const run = runController(sb, { input: 'MIGRATE\n' })
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('MIGRATIONS DETECTED IN DELTA') && run.out.includes('002_add.sql'), 'липсва migration confirmation')
  assert(run.workers.join(',') === `backend ${sha}`, `worker-и: ${run.workers.join(', ')}`)
})

withSandbox('E3 нова миграция без MIGRATE -> STOP, нищо не е изпълнено', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  sb.writeAndCommit({ 'server/database/migrations/002_add.sql': 'ALTER TABLE t ADD c INTEGER;\n' }, 'migration')
  const before = snapshotProduction(sb)
  const run = runController(sb, { input: 'yes\n' })
  assert(run.code !== 0 && run.out.includes('Migration confirmation не е получено'), `очаквах STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E4 unclassified файл -> STOP', (sb) => {
  sb.writeAndCommit({ 'weird/unknown.bin': 'x\n' }, 'unclassified')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('weird/unknown.bin') && run.out.includes('не съвпадат с нито една позната'), `очаквах unclassified STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E5 marker не е ancestor на target -> STOP', (sb) => {
  setMarkers(sb, sb.shas.main1)
  sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('НЕ Е ancestor'), `очаквах ancestry STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E6 dirty working tree -> STOP', (sb) => {
  writeFileSync(join(sb.repo, 'src/app.ts'), 'export const app = 99\n')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('Git working tree не е clean'), `очаквах dirty STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E7 само docs -> NO RUNTIME DEPLOY', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  sb.writeAndCommit({ 'docs/notes.md': '# notes 2\n' }, 'docs')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code === 0 && run.out.includes('РЕШЕНИЕ: NO RUNTIME DEPLOY'), `очаквах NO RUNTIME DEPLOY:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E8 промяна на стара миграция -> STOP', (sb) => {
  sb.writeAndCommit({ 'server/database/migrations/001_init.sql': 'CREATE TABLE t (id INTEGER, x TEXT);\n' }, 'edit old migration')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('Забранена промяна на historical migration'), `очаквах migration safety STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E9 само temp/*.png (вкл. кирилско име и поддиректория) -> NO RUNTIME DEPLOY', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  sb.writeAndCommit({
    'temp/icon-a.png': 'png',
    'temp/sub/dir/icon-b.png': 'png',
    'temp/Гланцирана икона за приложение.png': 'png',
  }, 'design pngs')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code === 0 && run.out.includes('РЕШЕНИЕ: NO RUNTIME DEPLOY'), `очаквах NO RUNTIME DEPLOY:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E10 не-PNG под temp/ -> STOP (unclassified)', (sb) => {
  sb.writeAndCommit({ 'temp/script.js': 'x\n' }, 'temp js')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('temp/script.js') && run.out.includes('не съвпадат с нито една позната'), `очаквах unclassified STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

// ─── Direct worker entrypoints ──────────────────────────────────────────────
console.log('\n[W] Директни worker entrypoint-и')

function prepareWorkerProduction(sb: Sandbox): void {
  for (const d of ['releases', 'assets', join('server', 'database', 'data')]) mkdirSync(join(sb.repo, d), { recursive: true })
  writeFileSync(join(sb.repo, 'server', 'database', 'data', 'belot-v2.sqlite'), 'production-db-bytes')
}

function frontendWorkerFor(sb: Sandbox): string {
  return sandboxScript(sb, 'frontend-worker.sh', frontendWorkerSource, {
    'PROJECT_ROOT="/var/www/belot-v2"': `PROJECT_ROOT="${sb.repoPosix}"`,
    'PUBLIC_BASE_URL="https://www.pika.bg"': 'PUBLIC_BASE_URL="http://127.0.0.1:9"',
    'LOCK_FILE="/var/lock/belot-v2-frontend-production.lock"': `LOCK_FILE="${sb.rootPosix}/frontend.lock"`,
    'DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"': `DEPLOY_STATE_DIR="${sb.rootPosix}/state"`,
  })
}
function backendWorkerFor(sb: Sandbox): string {
  return sandboxScript(sb, 'backend-worker.sh', backendWorkerSource, {
    'PROJECT_ROOT="/var/www/belot-v2"': `PROJECT_ROOT="${sb.repoPosix}"`,
    'PUBLIC_BASE_URL="https://www.pika.bg"': 'PUBLIC_BASE_URL="http://127.0.0.1:9"',
    'LOCK_FILE="/var/lock/belot-v2-backend-production.lock"': `LOCK_FILE="${sb.rootPosix}/backend.lock"`,
    'DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"': `DEPLOY_STATE_DIR="${sb.rootPosix}/state"`,
  })
}

const workers = [
  { name: 'frontend', scriptFor: frontendWorkerFor, nextStep: 'npm run build', nextLog: 'npm run build (tsc + vite build)...' },
  { name: 'backend', scriptFor: backendWorkerFor, nextStep: 'pm2 describe belot-v2-server', nextLog: 'PM2 app "belot-v2-server" не съществува' },
] as const

for (const w of workers) {
  withSandbox(`W-${w.name}-1 директно на feature/mobile-redesign -> STOP без странични ефекти`, (sb) => {
    prepareWorkerProduction(sb)
    sb.git('checkout', '-q', 'feature/mobile-redesign')
    const script = w.scriptFor(sb)
    const before = snapshotProduction(sb)
    const run = runBash(sb, script)
    assertBlockedByGuard(run)
    assertNoProductionSideEffects(sb, before, run)
  })

  withSandbox(`W-${w.name}-2 директно, redesign в detached HEAD -> STOP без странични ефекти`, (sb) => {
    prepareWorkerProduction(sb)
    sb.git('checkout', '-q', '--detach', sb.shas.redesign2)
    assert(isDetached(sb), 'HEAD не е detached')
    const script = w.scriptFor(sb)
    const before = snapshotProduction(sb)
    const run = runBash(sb, script)
    assertBlockedByGuard(run)
    assertNoProductionSideEffects(sb, before, run)
  })

  withSandbox(`W-${w.name}-3 директно, target без guard библиотеката -> STOP (fail-closed)`, (sb) => {
    prepareWorkerProduction(sb)
    sb.git('rm', '-q', 'scripts/lib/redesignWipGuard.sh')
    sb.git('commit', '-q', '-m', 'drop guard lib')
    const script = w.scriptFor(sb)
    const before = snapshotProduction(sb)
    const run = runBash(sb, script)
    assert(run.code !== 0 && run.out.includes('Redesign WIP guard библиотеката липсва'), `очаквах STOP:\n${run.out}`)
    assertNoProductionSideEffects(sb, before, run)
  })

  withSandbox(`W-${w.name}-4 директно, провал на git ls-tree -> STOP без странични ефекти`, (sb) => {
    prepareWorkerProduction(sb)
    const script = w.scriptFor(sb)
    const before = snapshotProduction(sb)
    const run = runBash(sb, script, { extraBin: makeFailingLsTreeGit(sb) })
    assert(run.code !== 0 && run.out.includes('Redesign WIP guard: git ls-tree се провали'), `очаквах STOP:\n${run.out}`)
    assertNoProductionSideEffects(sb, before, run)
  })

  withSandbox(`W-${w.name}-5 директно, hotfix в detached HEAD -> допуснат до "${w.nextStep}"`, (sb) => {
    prepareWorkerProduction(sb)
    sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
    assert(isDetached(sb), 'HEAD не е detached')
    const run = runBash(sb, w.scriptFor(sb))
    assert(GUARD_OK.test(run.out), `липсва guard OK log:\n${run.out}`)
    assert(!GUARD_BLOCKED.test(run.out), 'guard-ът блокира легитимен hotfix')
    assert(run.out.includes(w.nextLog), `не е стигнал до следващата стъпка ("${w.nextLog}"):\n${run.out}`)
    assert(run.sideEffects.join(',') === w.nextStep, `очаквах точно "${w.nextStep}" (fake, проваля се), получих: ${run.sideEffects.join(', ')}`)
  })
}

// ─── deployFrontendAtomic.sh ────────────────────────────────────────────────
console.log('\n[D] deployFrontendAtomic.sh (npm run deploy:frontend)')

function atomicEnv(sb: Sandbox, projectRootPosix: string = sb.repoPosix): Record<string, string> {
  return {
    PROJECT_ROOT: projectRootPosix,
    DEPLOY_ROOT: `${sb.rootPosix}/deploy`,
    TMPDIR: `${sb.rootPosix}/tmp`,
    VERIFY_BASE_URL: '',
  }
}
const deployRootOf = (sb: Sandbox): string => join(sb.root, 'deploy')

function assertAtomicBlocked(sb: Sandbox, run: RunResult, before: ProductionSnapshot, expected: RegExp | string): void {
  assert(run.code !== 0, `очаквах STOP, exit=${run.code}`)
  assert(typeof expected === 'string' ? run.out.includes(expected) : expected.test(run.out), `липсва очакваното съобщение (${String(expected)}):\n${run.out}`)
  assert(!existsSync(deployRootOf(sb)), 'DEPLOY_ROOT е създаден (releases/assets/current)')
  assertNoProductionSideEffects(sb, before, run)
}

withSandbox('D1 feature/mobile-redesign tip -> STOP без build/publish', (sb) => {
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const before = snapshotProduction(sb)
  assertAtomicBlocked(sb, runBash(sb, ATOMIC_SCRIPT_PATH, { env: atomicEnv(sb) }), before, GUARD_BLOCKED)
})

withSandbox('D2 redesign в detached HEAD -> STOP', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.redesign1)
  assert(isDetached(sb), 'HEAD не е detached')
  const before = snapshotProduction(sb)
  assertAtomicBlocked(sb, runBash(sb, ATOMIC_SCRIPT_PATH, { env: atomicEnv(sb) }), before, GUARD_BLOCKED)
})

withSandbox('D3 --adopt на redesign checkout -> STOP', (sb) => {
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const adoptDist = join(sb.root, 'adopt-dist')
  mkdirSync(adoptDist)
  writeFileSync(join(adoptDist, 'index.html'), '<!doctype html>')
  const before = snapshotProduction(sb, [adoptDist])
  const run = runBash(sb, ATOMIC_SCRIPT_PATH, { args: ['--adopt', toPosixPath(adoptDist)], env: atomicEnv(sb) })
  assert(run.code !== 0 && GUARD_BLOCKED.test(run.out), `очаквах guard STOP:\n${run.out}`)
  assert(!existsSync(deployRootOf(sb)), 'DEPLOY_ROOT е създаден')
  assertNoProductionSideEffects(sb, before, run, [adoptDist])
})

withSandbox('D4 untracked .redesign-wip в working dir при чист main HEAD -> STOP', (sb) => {
  writeFileSync(join(sb.repo, '.redesign-wip'), 'WIP\n')
  const before = snapshotProduction(sb)
  assertAtomicBlocked(sb, runBash(sb, ATOMIC_SCRIPT_PATH, { env: atomicEnv(sb) }), before, 'съществува в working directory-то')
})

withSandbox('D5 PROJECT_ROOT без git -> STOP (fail-closed)', (sb) => {
  const plain = join(sb.root, 'plain-project')
  mkdirSync(join(plain, 'src'), { recursive: true })
  writeFileSync(join(plain, 'package.json'), '{}')
  const before = snapshotProduction(sb, [plain])
  const run = runBash(sb, ATOMIC_SCRIPT_PATH, { env: { ...atomicEnv(sb, toPosixPath(plain)), GIT_CEILING_DIRECTORIES: sb.rootPosix } })
  assert(run.code !== 0 && run.out.includes('няма валиден git HEAD'), `очаквах fail-closed STOP:\n${run.out}`)
  assert(!existsSync(deployRootOf(sb)), 'DEPLOY_ROOT е създаден')
  assertNoProductionSideEffects(sb, before, run, [plain])
})

withSandbox('D6 скрипт без lib/redesignWipGuard.sh до него -> STOP (fail-closed)', (sb) => {
  const copyDir = join(sb.root, 'scripts-copy')
  mkdirSync(copyDir)
  copyFileSync(ATOMIC_SCRIPT_PATH, join(copyDir, 'deployFrontendAtomic.sh'))
  const before = snapshotProduction(sb, [copyDir])
  const run = runBash(sb, join(copyDir, 'deployFrontendAtomic.sh'), { env: atomicEnv(sb) })
  assert(run.code !== 0 && run.out.includes('Redesign WIP guard библиотеката липсва'), `очаквах STOP:\n${run.out}`)
  assert(!existsSync(deployRootOf(sb)), 'DEPLOY_ROOT е създаден')
  assertNoProductionSideEffects(sb, before, run, [copyDir])
})

withSandbox('D7 hotfix в detached HEAD -> допуснат до build (npx tsc)', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
  assert(isDetached(sb), 'HEAD не е detached')
  const run = runBash(sb, ATOMIC_SCRIPT_PATH, { env: atomicEnv(sb) })
  assert(GUARD_OK.test(run.out) && !GUARD_BLOCKED.test(run.out), `липсва guard OK log:\n${run.out}`)
  assert(run.sideEffects[0] === 'npx tsc', `очаквах build стъпката "npx tsc" (fake, проваля се), получих: ${run.sideEffects.join(', ')}`)
  assert(listTree(join(sb.root, 'tmp')).length === 0, 'временната build директория не е почистена')
})

withSandbox('D8 v2-clean-architecture -> допуснат до build (npx tsc)', (sb) => {
  const run = runBash(sb, ATOMIC_SCRIPT_PATH, { env: atomicEnv(sb) })
  assert(GUARD_OK.test(run.out), `липсва guard OK log:\n${run.out}`)
  assert(run.sideEffects[0] === 'npx tsc', `получих: ${run.sideEffects.join(', ')}`)
})

withSandbox('D9 --list на redesign checkout НЕ се блокира (не публикува нищо)', (sb) => {
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  mkdirSync(join(deployRootOf(sb), 'releases'), { recursive: true })
  const run = runBash(sb, ATOMIC_SCRIPT_PATH, { args: ['--list'], env: atomicEnv(sb) })
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(!run.out.includes('Redesign WIP guard'), 'guard-ът не бива да участва в --list')
  assert(run.sideEffects.length === 0, `странични ефекти: ${run.sideEffects.join(', ')}`)
})

// ─── Cleanup ────────────────────────────────────────────────────────────────
for (const sb of sandboxes) {
  try { rmSync(sb.current, { force: true }) } catch { /* junction вече липсва */ }
  rmSync(sb.root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
