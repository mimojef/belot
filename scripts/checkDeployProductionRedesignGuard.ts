/**
 * checkDeployProductionRedesignGuard.ts
 *
 * Целеви тест за "Redesign WIP guard" в scripts/deploy-production.sh —
 * контролерът трябва да откаже всеки target commit, чието tree съдържа
 * проследявания sentinel .redesign-wip (feature/mobile-redesign).
 *
 * Изпълнява РЕАЛНИЯ контролер (целия файл, не извадка) в изолиран sandbox:
 * заменят се САМО трите абсолютни production пътя (PROJECT_ROOT,
 * DEPLOY_STATE_DIR, LOCK_FILE) с temp директории; worker-ите са fake
 * скриптове в sandbox repo-то, които само записват извикването си и
 * обновяват sandbox marker-ите. Никакъв реален build/deploy/PM2/nginx.
 *
 * Употреба: npx tsx scripts/checkDeployProductionRedesignGuard.ts
 *
 * Проверява:
 *   [S] Guard-ът е преди marker четенето и преди всяко worker извикване;
 *       sandbox скриптът няма останали /var/ пътища извън коментари.
 *   [R] Редизайнът се блокира: branch tip, detached HEAD, branch с
 *       "production" име, и target след вече-deploy-нат sentinel (случай,
 *       който classify_path() сам НЕ хваща — доказано с guard-less вариант).
 *       При блокиране: нула worker извиквания, marker-ите byte-identical,
 *       current junction непроменен, marker четенето не е започнало.
 *   [F] Fail-closed: провал на git ls-tree -> STOP.
 *   [A] Основният клон (FRONTEND ONLY) и hotfix в detached HEAD
 *       (BACKEND ONLY) се допускат.
 *   [E] Съществуващите механизми: FULL ред backend->frontend, MIGRATE
 *       потвърждение (прието/отказано), unclassified STOP, ancestry STOP,
 *       dirty tree STOP, NO RUNTIME DEPLOY, забранена промяна на стара
 *       миграция.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
const controllerSource = readFileSync(resolve(repoRoot, 'scripts/deploy-production.sh'), 'utf8').replace(/\r\n/g, '\n')

const GUARD_START = '# ─── Redesign WIP guard'
const GUARD_END_LINE = 'log "Redesign WIP guard: target не съдържа $REDESIGN_WIP_SENTINEL — OK"\n'
const GUARD_STOP_TEXT = 'Redesign WIP guard: target'
const MARKER_SECTION = 'section "Reading deployment state markers"'

const PRODUCTION_PATH_LINES = [
  'PROJECT_ROOT="/var/www/belot-v2"',
  'DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"',
  'LOCK_FILE="/var/lock/belot-v2-production.lock"',
] as const

// ─── Static ordering ────────────────────────────────────────────────────────
console.log('\n[S] Static ordering')

check('S1 guard block присъства точно веднъж', () => {
  assert(controllerSource.split(GUARD_START).length === 2, 'очаквах точно един guard блок')
  assert(controllerSource.split(GUARD_END_LINE).length === 2, 'очаквах точно един guard OK log ред')
})

check('S2 guard е след TARGET_SHA и преди marker четене и всеки worker', () => {
  const guardIdx = controllerSource.indexOf(GUARD_START)
  const targetIdx = controllerSource.indexOf('TARGET_SHA="$(git rev-parse HEAD)"')
  const markersIdx = controllerSource.indexOf(MARKER_SECTION)
  const firstWorkerIdx = Math.min(
    controllerSource.indexOf('bash "$FRONTEND_WORKER"'),
    controllerSource.indexOf('bash "$BACKEND_WORKER"'),
  )
  assert(targetIdx !== -1 && markersIdx !== -1 && firstWorkerIdx !== -1, 'липсва anchor')
  assert(targetIdx < guardIdx, 'guard е преди TARGET_SHA')
  assert(guardIdx < markersIdx, 'guard е след marker четенето')
  assert(guardIdx < firstWorkerIdx, 'guard е след worker извикване')
})

check('S3 guard проверява tree-то на TARGET_SHA (не branch име / working dir)', () => {
  const guardBlock = controllerSource.slice(controllerSource.indexOf(GUARD_START), controllerSource.indexOf(GUARD_END_LINE))
  assert(guardBlock.includes('git ls-tree --full-tree --name-only "$TARGET_SHA"'), 'очаквах git ls-tree срещу $TARGET_SHA')
  assert(!/symbolic-ref|rev-parse --abbrev-ref|branch --show-current|\[ -e|\[ -f/.test(guardBlock), 'guard не бива да зависи от branch име или файл в working dir')
})

// ─── Sandbox helpers ────────────────────────────────────────────────────────
function toPosixPath(winPath: string): string {
  return winPath.replace(/^([A-Za-z]):[\\/]/, (_m, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
}

const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

const FAKE_WORKER = (kind: 'frontend' | 'backend'): string => `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
printf '${kind} %s\\n' "$SHA" >> "$DEPLOY_TEST_WORKER_LOG"
${kind === 'frontend'
    ? `printf '{"gitSha":"%s","releasePath":"%s"}\\n' "$SHA" "$DEPLOY_TEST_RELEASE_PATH" > "$DEPLOY_TEST_STATE_DIR/frontend.json"`
    : `printf '{"gitSha":"%s","pm2Pid":"4242"}\\n' "$SHA" > "$DEPLOY_TEST_STATE_DIR/backend.json"`}
`

interface Sandbox {
  root: string
  repo: string
  state: string
  release: string
  current: string
  workerLog: string
  controller: string
  bin: string
  shas: Record<string, string>
  git: (...args: string[]) => string
}

function createSandbox(controllerText: string = controllerSource): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'belot-redesign-guard-'))
  const repo = join(root, 'repo')
  const state = join(root, 'state')
  const release = join(root, 'releases', 'r1')
  const bin = join(root, 'bin')
  for (const dir of [repo, state, release, bin]) mkdirSync(dir, { recursive: true })

  // Канонична bash форма (pwd -P) — контролерът сравнява точно с нея.
  const repoPosix = execFileSync('bash', ['-c', 'cd "$1" && pwd -P', '_', toPosixPath(repo)], { encoding: 'utf8' }).trim()
  const rootPosix = repoPosix.replace(/\/repo$/, '')

  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'v2-clean-architecture')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Guard Test')
  git('config', 'user.email', 'guard-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')

  const write = (rel: string, content: string): void => {
    const full = join(repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  const commit = (message: string): string => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }

  write('.gitignore', '/current\n')
  write('scripts/deploy-frontend-production.sh', FAKE_WORKER('frontend'))
  write('scripts/deploy-backend-production.sh', FAKE_WORKER('backend'))
  write('server/database/migrations/001_init.sql', 'CREATE TABLE t (id INTEGER);\n')
  write('server/src/index.ts', 'export const v = 1\n')
  write('src/app.ts', 'export const app = 1\n')
  write('docs/notes.md', '# notes\n')
  const base = commit('base')

  write('src/app.ts', 'export const app = 2\n')
  const main1 = commit('main: frontend fix')

  git('checkout', '-q', '-b', 'feature/mobile-redesign')
  write('.redesign-wip', 'WIP\n')
  write('src/landing.ts', 'export const landing = 1\n')
  const redesign1 = commit('redesign: sentinel + landing')
  write('src/landing.ts', 'export const landing = 2\n')
  const redesign2 = commit('redesign: more landing')

  git('checkout', '-q', '-b', 'hotfix/backend', base)
  write('server/src/index.ts', 'export const v = 2\n')
  const hotfix1 = commit('hotfix: backend')

  git('checkout', '-q', 'v2-clean-architecture')

  // Production-подобно състояние: двата marker-а на base, current -> r1.
  // releasePath = bash readlink -f форма (MSYS мапва temp към /tmp/...),
  // точно както контролерът сравнява с readlink -f current.
  const current = join(repo, 'current')
  symlinkSync(release, current, 'junction')
  const releasePosix = execFileSync('bash', ['-c', 'readlink -f "$1"', '_', `${repoPosix}/current`], { encoding: 'utf8' }).trim()
  writeFileSync(join(state, 'frontend.json'), JSON.stringify({ gitSha: base, releasePath: releasePosix }) + '\n')
  writeFileSync(join(state, 'backend.json'), JSON.stringify({ gitSha: base, pm2Pid: '4242' }) + '\n')

  writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(bin, 'flock'), 0o755)

  let sandboxed = controllerText.replace(/\r\n/g, '\n')
  const replacements: Record<(typeof PRODUCTION_PATH_LINES)[number], string> = {
    'PROJECT_ROOT="/var/www/belot-v2"': `PROJECT_ROOT="${repoPosix}"`,
    'DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"': `DEPLOY_STATE_DIR="${rootPosix}/state"`,
    'LOCK_FILE="/var/lock/belot-v2-production.lock"': `LOCK_FILE="${rootPosix}/controller.lock"`,
  }
  for (const line of PRODUCTION_PATH_LINES) {
    assert(sandboxed.split(line).length === 2, `production path ред не е намерен точно веднъж: ${line}`)
    sandboxed = sandboxed.replace(line, replacements[line])
  }
  const leakingLines = sandboxed.split('\n').filter((l) => !l.trimStart().startsWith('#') && l.includes('/var/'))
  assert(leakingLines.length === 0, `sandbox скриптът още сочи към /var/: ${leakingLines.join(' | ')}`)

  const controller = join(root, 'controller.sh')
  writeFileSync(controller, sandboxed, 'utf8')

  return {
    root, repo, state, release, current, bin, controller, git,
    workerLog: join(root, 'workers.log'),
    shas: { base, main1, redesign1, redesign2, hotfix1 },
  }
}

interface RunResult { code: number; out: string; workers: string[] }

function runController(sb: Sandbox, opts: { input?: string; extraBin?: string } = {}): RunResult {
  const pathPrefix = [opts.extraBin, sb.bin].filter((p): p is string => p !== undefined).map(toPosixPath).join(':')
  const result = spawnSync('bash', ['-c', `export PATH="${pathPrefix}:$PATH"; bash "$1"`, '_', toPosixPath(sb.controller)], {
    cwd: sb.root,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_TEST_WORKER_LOG: toPosixPath(sb.workerLog),
      DEPLOY_TEST_STATE_DIR: toPosixPath(sb.state),
      DEPLOY_TEST_RELEASE_PATH: JSON.parse(readFileSync(join(sb.state, 'frontend.json'), 'utf8')).releasePath,
    },
  })
  const workers = existsSync(sb.workerLog)
    ? readFileSync(sb.workerLog, 'utf8').split('\n').filter((l) => l.length > 0)
    : []
  return { code: result.status ?? -1, out: `${result.stdout}\n${result.stderr}`, workers }
}

interface ProductionSnapshot { files: Record<string, string>; mtimes: Record<string, number>; current: string; rootEntries: string[] }

function snapshotProduction(sb: Sandbox): ProductionSnapshot {
  const files: Record<string, string> = {}
  const mtimes: Record<string, number> = {}
  for (const name of readdirSync(sb.state)) {
    files[name] = readFileSync(join(sb.state, name), 'utf8')
    mtimes[name] = statSync(join(sb.state, name)).mtimeMs
  }
  return { files, mtimes, current: readlinkSync(sb.current), rootEntries: readdirSync(sb.root).sort() }
}

function assertNoProductionSideEffects(sb: Sandbox, before: ProductionSnapshot, run: RunResult): void {
  assert(run.workers.length === 0, `worker-и са извикани: ${run.workers.join(', ')}`)
  const after = snapshotProduction(sb)
  assert(JSON.stringify(after.files) === JSON.stringify(before.files), 'state marker файловете са променени')
  assert(JSON.stringify(after.mtimes) === JSON.stringify(before.mtimes), 'state marker файловете са пипнати (mtime)')
  assert(after.current === before.current, 'current junction е пренасочен')
  // controller.lock е единственият допустим нов файл (създава се преди
  // git проверките, както и досега).
  const newEntries = after.rootEntries.filter((e) => !before.rootEntries.includes(e) && e !== 'controller.lock')
  assert(newEntries.length === 0, `нови файлове в sandbox root: ${newEntries.join(', ')}`)
  assert(readdirSync(sb.release).length === 0, 'release директорията е променена')
}

function assertBlockedByGuard(sb: Sandbox, run: RunResult, before: ProductionSnapshot): void {
  assert(run.code !== 0, `очаквах STOP, exit=${run.code}`)
  assert(run.out.includes(GUARD_STOP_TEXT) && run.out.includes('.redesign-wip'), `липсва guard съобщение:\n${run.out}`)
  assert(!run.out.includes('Reading deployment state markers'), 'marker четенето е започнало преди guard STOP')
  assertNoProductionSideEffects(sb, before, run)
}

const sandboxes: Sandbox[] = []
function withSandbox(label: string, fn: (sb: Sandbox) => void, controllerText?: string): void {
  check(label, () => {
    const sb = createSandbox(controllerText)
    sandboxes.push(sb)
    fn(sb)
  })
}

// ─── Redesign blocked ───────────────────────────────────────────────────────
console.log('\n[R] Redesign се блокира')

withSandbox('R1 feature/mobile-redesign tip -> STOP без странични ефекти', (sb) => {
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const before = snapshotProduction(sb)
  assertBlockedByGuard(sb, runController(sb), before)
})

withSandbox('R2 redesign commit в detached HEAD -> STOP', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.redesign1)
  assert(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: sb.repo }).status !== 0, 'HEAD не е detached')
  const before = snapshotProduction(sb)
  assertBlockedByGuard(sb, runController(sb), before)
})

withSandbox('R3 redesign commit на branch с production име -> STOP (не зависи от името)', (sb) => {
  sb.git('checkout', '-q', '-B', 'v2-clean-architecture', sb.shas.redesign2)
  assert(sb.git('branch', '--show-current') === 'v2-clean-architecture', 'branch името не е подменено')
  const before = snapshotProduction(sb)
  assertBlockedByGuard(sb, runController(sb), before)
})

withSandbox('R4 marker-ите вече съдържат sentinel (bypass в миналото) -> guard пак STOP', (sb) => {
  for (const name of ['frontend.json', 'backend.json']) {
    const data = JSON.parse(readFileSync(join(sb.state, name), 'utf8'))
    data.gitSha = sb.shas.redesign1
    writeFileSync(join(sb.state, name), JSON.stringify(data) + '\n')
  }
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const before = snapshotProduction(sb)
  assertBlockedByGuard(sb, runController(sb), before)
})

// Контрола за R4: същият сценарий с контролер БЕЗ guard блока deploy-ва —
// доказва, че classify_path() сам не е достатъчен и guard-ът е реалната защита.
const controllerWithoutGuard = controllerSource.slice(0, controllerSource.indexOf(GUARD_START))
  + controllerSource.slice(controllerSource.indexOf(GUARD_END_LINE) + GUARD_END_LINE.length)
withSandbox('R5 контрола: без guard същият R4 сценарий БИ deploy-нал редизайна', (sb) => {
  for (const name of ['frontend.json', 'backend.json']) {
    const data = JSON.parse(readFileSync(join(sb.state, name), 'utf8'))
    data.gitSha = sb.shas.redesign1
    writeFileSync(join(sb.state, name), JSON.stringify(data) + '\n')
  }
  sb.git('checkout', '-q', 'feature/mobile-redesign')
  const run = runController(sb)
  assert(run.code === 0, `очаквах успех без guard, exit=${run.code}\n${run.out}`)
  assert(run.workers.join(',') === `frontend ${sb.shas.redesign2}`, `очаквах frontend worker за redesign2: ${run.workers.join(', ')}`)
}, controllerWithoutGuard)

// ─── Fail-closed ────────────────────────────────────────────────────────────
console.log('\n[F] Fail-closed')

withSandbox('F1 провал на git ls-tree -> STOP без странични ефекти', (sb) => {
  const fakeGitBin = join(sb.root, 'fakegit')
  mkdirSync(fakeGitBin)
  writeFileSync(join(fakeGitBin, 'git'), `#!/usr/bin/env bash\nif [ "\${1:-}" = "ls-tree" ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec "${REAL_GIT}" "$@"\n`)
  chmodSync(join(fakeGitBin, 'git'), 0o755)
  const before = snapshotProduction(sb)
  const run = runController(sb, { extraBin: fakeGitBin })
  assert(run.code !== 0, `очаквах STOP, exit=${run.code}`)
  assert(run.out.includes('Redesign WIP guard: git ls-tree се провали'), `липсва fail-closed съобщение:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

// ─── Allowed ────────────────────────────────────────────────────────────────
console.log('\n[A] Легитимни deploy-и се допускат')

withSandbox('A1 v2-clean-architecture -> FRONTEND ONLY, guard OK', (sb) => {
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('Redesign WIP guard: target не съдържа .redesign-wip — OK'), 'липсва guard OK log')
  assert(run.out.includes('РЕШЕНИЕ: FRONTEND ONLY'), 'очаквах FRONTEND ONLY')
  assert(run.workers.join(',') === `frontend ${sb.shas.main1}`, `worker-и: ${run.workers.join(', ')}`)
  assert(JSON.parse(readFileSync(join(sb.state, 'frontend.json'), 'utf8')).gitSha === sb.shas.main1, 'frontend marker не е обновен')
})

withSandbox('A2 hotfix в detached HEAD -> BACKEND ONLY, guard OK', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.hotfix1)
  assert(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: sb.repo }).status !== 0, 'HEAD не е detached')
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('Redesign WIP guard: target не съдържа .redesign-wip — OK'), 'липсва guard OK log')
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

function commitOnMain(sb: Sandbox, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(sb.repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  sb.git('add', '-A')
  sb.git('commit', '-q', '-m', message)
  return sb.git('rev-parse', 'HEAD')
}

withSandbox('E1 FULL: backend преди frontend', (sb) => {
  const sha = commitOnMain(sb, { 'server/src/index.ts': 'export const v = 3\n' }, 'full')
  const run = runController(sb)
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('РЕШЕНИЕ: FULL'), 'очаквах FULL')
  assert(run.workers.join(',') === `backend ${sha},frontend ${sha}`, `ред: ${run.workers.join(', ')}`)
})

withSandbox('E2 нова миграция + MIGRATE -> backend worker', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  const sha = commitOnMain(sb, { 'server/database/migrations/002_add.sql': 'ALTER TABLE t ADD c INTEGER;\n' }, 'migration')
  const run = runController(sb, { input: 'MIGRATE\n' })
  assert(run.code === 0, `exit=${run.code}\n${run.out}`)
  assert(run.out.includes('MIGRATIONS DETECTED IN DELTA') && run.out.includes('002_add.sql'), 'липсва migration confirmation')
  assert(run.workers.join(',') === `backend ${sha}`, `worker-и: ${run.workers.join(', ')}`)
})

withSandbox('E3 нова миграция без MIGRATE -> STOP, нищо не е изпълнено', (sb) => {
  sb.git('checkout', '-q', '--detach', sb.shas.base)
  commitOnMain(sb, { 'server/database/migrations/002_add.sql': 'ALTER TABLE t ADD c INTEGER;\n' }, 'migration')
  const before = snapshotProduction(sb)
  const run = runController(sb, { input: 'yes\n' })
  assert(run.code !== 0, 'очаквах STOP')
  assert(run.out.includes('Migration confirmation не е получено'), `липсва съобщение:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E4 unclassified файл -> STOP', (sb) => {
  commitOnMain(sb, { 'weird/unknown.bin': 'x\n' }, 'unclassified')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('weird/unknown.bin') && run.out.includes('не съвпадат с нито една позната'), `очаквах unclassified STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E5 marker не е ancestor на target -> STOP', (sb) => {
  for (const name of ['frontend.json', 'backend.json']) {
    const data = JSON.parse(readFileSync(join(sb.state, name), 'utf8'))
    data.gitSha = sb.shas.main1
    writeFileSync(join(sb.state, name), JSON.stringify(data) + '\n')
  }
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
  commitOnMain(sb, { 'docs/notes.md': '# notes 2\n' }, 'docs')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code === 0 && run.out.includes('РЕШЕНИЕ: NO RUNTIME DEPLOY'), `очаквах NO RUNTIME DEPLOY:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

withSandbox('E8 промяна на стара миграция -> STOP', (sb) => {
  commitOnMain(sb, { 'server/database/migrations/001_init.sql': 'CREATE TABLE t (id INTEGER, x TEXT);\n' }, 'edit old migration')
  const before = snapshotProduction(sb)
  const run = runController(sb)
  assert(run.code !== 0 && run.out.includes('Забранена промяна на historical migration'), `очаквах migration safety STOP:\n${run.out}`)
  assertNoProductionSideEffects(sb, before, run)
})

// ─── Cleanup ────────────────────────────────────────────────────────────────
for (const sb of sandboxes) {
  try { rmSync(sb.current, { force: true }) } catch { /* junction вече липсва */ }
  rmSync(sb.root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
