/**
 * checkFrontendDeployPermissions.ts — права на публичните файлове при
 * scripts/deploy-frontend-production.sh (инцидент при deploy на aa92906:
 * наследен umask 0077 -> нови публични JS файлове 600 -> nginx 403).
 *
 * Пуска ИСТИНСКИЯ скрипт (копие с пренасочени PROJECT_ROOT / LOCK_FILE /
 * DEPLOY_STATE_DIR / PUBLIC_BASE_URL) в изолиран sandbox под umask 077.
 * Dev машината (Git Bash върху NTFS noacl) не прилага POSIX права, затова
 * TEST-ONLY stub-ове емулират точно Linux семантиката, която скриптът
 * ползва: mkdir/cp (режим = 0777|0666 или изходния режим & ~umask),
 * cp -a (запазва режима), ln (hard link = същият режим), chmod (числов и
 * a+r / a+rx), stat -c %a. Режимите се пазят в „база“ (TSV). Локален HTTP
 * сървър играе nginx: 403, ако файлът не е четим за others.
 * Stub-овете се създават само във временна директория на теста.
 *
 *   [P0] контрола: стария скрипт (git HEAD) под umask 077 -> 403 -> STOP
 *        (тестът възпроизвежда инцидента);
 *   [P1] нов скрипт, umask 077: release 755/644, shared assets 644, вкл.
 *        lazy chunk; deploy минава; chmod САМО по публичните пътища; частни
 *        файлове (база, .env, backup, deployment state) без промяна;
 *   [P2] вече наличен shared asset със същия checksum, но 600, и assets/ 700
 *        -> a+r / a+rx, deploy минава;
 *   [P3] наличен shared asset с РАЗЛИЧЕН checksum -> STOP (immutable
 *        conflict) както преди, без switch;
 *   [P4] нормална сесия (umask 022) -> deploy минава без корекции.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkFrontendDeployPermissions.ts
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
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

const bashPath = (winPath: string): string => spawnSync('cygpath', ['-u', winPath], { encoding: 'utf8' }).stdout.trim()

// ─── TEST-ONLY stub-ове (емулация на POSIX права) ────────────────────────────
const STUB_LIB = String.raw`
norm() { printf '%s' "$1" | sed -e 's#//*#/#g' -e 's#/\./#/#g' -e 's#/\.$##' -e 's#\(.\)/$#\1#'; }
record() { printf '%s\t%s\n' "$1" "$(norm "$2")" >> "$PERM_DB"; }
lookup() { local p; p="$(norm "$1")"; awk -F'\t' -v p="$p" '$2==p {m=$1} END {if (m != "") print m}' "$PERM_DB"; }
mode_or_real() { local m; m="$(lookup "$1")"; if [ -n "$m" ]; then printf '%s' "$m"; else /usr/bin/stat -c '%a' "$1"; fi; }
masked() { printf '%o' $(( 8#$1 & ~8#$(umask) & 8#7777 )); }
`
const STUBS: Record<string, string> = {
  stat: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
# Само формата, която скриптът ползва: stat -c '%a' PATH / stat -f '%Lp' PATH
path="${'$'}{@: -1}"
m="$(lookup "$path")"
if [ -n "$m" ]; then printf '%s\n' "$m"; else exec /usr/bin/stat "$@"; fi
`,
  chmod: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
spec="$1"; shift
[ "${'$'}{1:-}" = "--" ] && shift
for path in "$@"; do
  old="$(mode_or_real "$path")"
  if [[ "$spec" =~ ^[0-7]+$ ]]; then
    new="$spec"
  elif [[ "$spec" =~ ^a\+([rwx]+)$ ]]; then
    add=0
    [[ "${'$'}{BASH_REMATCH[1]}" == *r* ]] && add=$(( add | 8#444 ))
    [[ "${'$'}{BASH_REMATCH[1]}" == *w* ]] && add=$(( add | 8#222 ))
    [[ "${'$'}{BASH_REMATCH[1]}" == *x* ]] && add=$(( add | 8#111 ))
    new="$(printf '%o' $(( 8#$old | add )))"
  else
    echo "chmod stub: неподдържан режим $spec" >&2; exit 2
  fi
  [ -e "$path" ] || { echo "chmod: cannot access '$path'" >&2; exit 1; }
  record "$new" "$path"
  printf '%s\t%s\n' "$spec" "$(norm "$path")" >> "$CHMOD_LOG"
done
`,
  mkdir: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
paths=(); for a in "$@"; do [[ "$a" == -* ]] || paths+=("$a"); done
missing=()
for p in "${'$'}{paths[@]}"; do
  q="$(norm "$p")"
  while [ -n "$q" ] && [ ! -e "$q" ]; do missing+=("$q"); q="$(dirname "$q")"; done
done
/usr/bin/mkdir "$@" || exit $?
for q in "${'$'}{missing[@]}"; do record "$(masked 777)" "$q"; done
`,
  cp: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
if [ "$1" = "-a" ]; then
  src="$2"; dest="$3"
  /usr/bin/cp -a "$src" "$dest" || exit $?
  record "$(mode_or_real "$src")" "$dest"
  (cd "$src" && /usr/bin/find . -mindepth 1) | while IFS= read -r rel; do
    rel="${'$'}{rel#./}"
    record "$(mode_or_real "$src/$rel")" "$dest/$rel"
  done
else
  src="$1"; dest="$2"
  /usr/bin/cp "$src" "$dest" || exit $?
  record "$(masked "$(mode_or_real "$src")")" "$dest"
fi
`,
  ln: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
if [ "$1" = "-sfn" ]; then
  # Симлинк без привилегии на тази машина: файл с пътя (readlink stub-ът го чете).
  rm -f "$3"; printf '%s' "$2" > "$3"; exit 0
fi
/usr/bin/ln "$@" || exit $?
record "$(mode_or_real "$1")" "$2"
`,
  readlink: String.raw`#!/usr/bin/env bash
if [ "$1" = "-f" ] && [ -f "$2" ]; then
  target="$(cat "$2")"
  if [ -d "$target" ]; then printf '%s\n' "$target"; exit 0; fi
fi
exec /usr/bin/readlink "$@"
`,
  flock: `#!/usr/bin/env bash\nexit 0\n`,
  // umask-ът в момента на всеки mv (атомарният запис на deployment state е mv).
  mv: String.raw`#!/usr/bin/env bash
printf '%s\t%s\n' "$(umask)" "${'$'}{@: -1}" >> "$MV_LOG"
exec /usr/bin/mv "$@"
`,
  npm: String.raw`#!/usr/bin/env bash
. "$STUB_LIB"
[ "$1 $2" = "run build" ] || { echo "npm stub: само run build" >&2; exit 2; }
/usr/bin/rm -rf dist
mkdir -p dist/assets
for d in "$PWD/dist" "$PWD/dist/assets"; do record "$(masked 777)" "$d"; done
emit() { printf '%s' "$2" > "$PWD/dist/$1"; record "$(masked 666)" "$PWD/dist/$1"; }
emit index.html '<!doctype html><script type="module" src="/assets/index-Ab12Cd34.js"></script><link rel="stylesheet" href="/assets/index-Ef56Gh78.css">'
emit assets/index-Ab12Cd34.js 'console.log("main")'
emit assets/index-Ef56Gh78.css 'body{}'
emit assets/voice-voiceRuntime-Ij90Kl12.js 'export const lazy = 1'
emit sw.js 'self.x=1'
`,
}

const ENTRY_JS = 'index-Ab12Cd34.js'
const ENTRY_CSS = 'index-Ef56Gh78.css'
const LAZY_JS = 'voice-voiceRuntime-Ij90Kl12.js'

type Sandbox = {
  root: string
  bash: { www: string; state: string; db: string; chmodLog: string; lock: string; stubs: string; lib: string }
  win: { www: string; state: string; db: string; chmodLog: string }
}

function readDb(dbWin: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(dbWin)) return map
  for (const line of readFileSync(dbWin, 'utf8').split('\n')) {
    const [mode, path] = line.split('\t')
    if (mode && path) map.set(path, mode)
  }
  return map
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'pika-deploy-perm-'))
  const win = { www: join(root, 'www'), state: join(root, 'state'), db: join(root, 'perm.tsv'), chmodLog: join(root, 'chmod.log') }
  mkdirSync(win.www)
  mkdirSync(join(root, 'stubs'))
  const bashRoot = bashPath(root)
  const bash = {
    www: `${bashRoot}/www`, state: `${bashRoot}/state`, db: `${bashRoot}/perm.tsv`, chmodLog: `${bashRoot}/chmod.log`,
    lock: `${bashRoot}/deploy.lock`, stubs: `${bashRoot}/stubs`, lib: `${bashRoot}/stub-lib.sh`,
  }
  writeFileSync(join(root, 'stub-lib.sh'), STUB_LIB)
  for (const [name, body] of Object.entries(STUBS)) writeFileSync(join(root, 'stubs', name), body, { mode: 0o755 })
  writeFileSync(win.db, '')
  writeFileSync(win.chmodLog, '')
  // Production repo checkout (минимален) + публични и частни директории.
  mkdirSync(join(win.www, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(win.www, 'scripts', 'lib', 'redesignWipGuard.sh'), readFileSync('scripts/lib/redesignWipGuard.sh', 'utf8'))
  writeFileSync(join(win.www, 'README.md'), 'sandbox\n')
  writeFileSync(join(win.www, '.gitignore'), 'dist/\nreleases/\nassets/\ncurrent\ncurrent.new\nserver/data/\nserver/.env\nbackups/\n')
  for (const dir of ['releases', 'assets', 'server/data', 'backups']) mkdirSync(join(win.www, dir), { recursive: true })
  writeFileSync(join(win.www, 'server', 'data', 'belot.sqlite'), 'private-db')
  writeFileSync(join(win.www, 'server', '.env'), 'LIVEKIT_API_SECRET=private')
  writeFileSync(join(win.www, 'backups', 'db-2026.tar.zst'), 'private-backup')
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=sandbox', '-c', 'user.email=sandbox@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: win.www, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'sandbox')
  // Начални режими: публичните директории 755, частните файлове 600/700.
  const db = (mode: string, path: string) => writeFileSync(win.db, `${mode}\t${path}\n`, { flag: 'a' })
  db('755', `${bash.www}/releases`)
  db('755', `${bash.www}/assets`)
  db('700', `${bash.www}/server/data`)
  db('600', `${bash.www}/server/data/belot.sqlite`)
  db('600', `${bash.www}/server/.env`)
  db('700', `${bash.www}/backups`)
  db('600', `${bash.www}/backups/db-2026.tar.zst`)
  return { root, bash, win }
}

/** Копие на скрипта: само четирите константи за пътища/URL са пренасочени. */
function sandboxScript(source: string, box: Sandbox, port: number): string {
  let text = source.replace(/\r\n/g, '\n')
  const swap = (from: string, to: string) => {
    assert(text.split(from).length === 2, `очаквах точно едно „${from}“ в скрипта`)
    text = text.replace(from, to)
  }
  swap('PROJECT_ROOT="/var/www/belot-v2"', `PROJECT_ROOT="${box.bash.www}"`)
  swap('PUBLIC_BASE_URL="https://www.pika.bg"', `PUBLIC_BASE_URL="http://127.0.0.1:${port}"`)
  swap('LOCK_FILE="/var/lock/belot-v2-frontend-production.lock"', `LOCK_FILE="${box.bash.lock}"`)
  swap('DEPLOY_STATE_DIR="/var/lib/belot-v2/deploy-state"', `DEPLOY_STATE_DIR="${box.bash.state}"`)
  const path = join(box.root, 'deploy.sh')
  writeFileSync(path, text)
  return bashPath(path)
}

/** „nginx“: 403, ако файлът (или пътят до него) не е четим за others. */
function startNginx(box: Sandbox): Promise<{ server: Server; port: number; log: string[] }> {
  const log: string[] = []
  const worldReadable = (mode: string | undefined, dir: boolean) => mode !== undefined && (parseInt(mode, 8) & (dir ? 0o005 : 0o004)) === (dir ? 0o005 : 0o004)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const db = readDb(box.win.db)
    let status = 200
    if (url.pathname === '/health') status = 200
    else if (url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice('/assets/'.length)
      const file = `${box.bash.www}/assets/${name}`
      if (!existsSync(join(box.win.www, 'assets', name))) status = 404
      else if (!worldReadable(db.get(`${box.bash.www}/assets`), true) || !worldReadable(db.get(file), false)) status = 403
    } else if (url.pathname === '/') {
      const current = join(box.win.www, 'current')
      const target = existsSync(current) ? readFileSync(current, 'utf8') : ''
      status = target !== '' && worldReadable(db.get(`${target}/index.html`), false) ? 200 : 403
    } else status = 404
    log.push(`${url.pathname} ${status}`)
    res.writeHead(status).end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, log })))
}

function runScript(box: Sandbox, script: string, umask: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', `umask ${umask}; export PATH="${box.bash.stubs}:$PATH"; bash "${script}"`], {
      cwd: box.win.www,
      env: { ...process.env, PERM_DB: box.bash.db, CHMOD_LOG: box.bash.chmodLog, MV_LOG: box.bash.chmodLog.replace(/chmod\.log$/, 'mv.log'), STUB_LIB: box.bash.lib },
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

async function deploy(source: string, umask: string, prepare?: (box: Sandbox) => void) {
  const box = createSandbox()
  prepare?.(box)
  const nginx = await startNginx(box)
  try {
    const script = sandboxScript(source, box, nginx.port)
    const result = await runScript(box, script, umask)
    const db = readDb(box.win.db)
    const chmods = readFileSync(box.win.chmodLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t')[1]!)
    const releases = readdirSync(join(box.win.www, 'releases'))
    const mvLog = join(box.root, 'mv.log')
    const stateUmask = existsSync(mvLog) ? readFileSync(mvLog, 'utf8').split('\n').filter((l) => l.endsWith('/frontend.json')).map((l) => l.split('\t')[0]).at(-1) : undefined
    return { box, ...result, db, chmods, releases, http: nginx.log, stateUmask }
  } finally {
    nginx.server.close()
  }
}

const tail = (output: string) => output.split('\n').filter((l) => /STOP|ERROR|права|umask/.test(l)).slice(-6).join(' | ')

const newSource = readFileSync('scripts/deploy-frontend-production.sh', 'utf8')
const oldSource = spawnSync('git', ['show', 'HEAD:scripts/deploy-frontend-production.sh'], { encoding: 'utf8' }).stdout

console.log('\ncheckFrontendDeployPermissions\n')

const cleanup: string[] = []

await check('[P0] Контрола: досегашният скрипт под umask 077 възпроизвежда инцидента (публичният JS е 600 -> 403 -> STOP преди switch)', async () => {
  const run = await deploy(oldSource, '077')
  cleanup.push(run.box.root)
  assert(run.code !== 0, `очаквах STOP, exit ${run.code}`)
  assert(/Public HTTP pre-switch проверка неуспешна/.test(run.output) && /HTTP 403/.test(run.output), `очаквах 403 в pre-switch проверката: ${tail(run.output)}`)
  assert(run.db.get(`${run.box.bash.www}/assets/${ENTRY_JS}`) === '600', `публичният JS при старото поведение: ${run.db.get(`${run.box.bash.www}/assets/${ENTRY_JS}`)}`)
  assert(!existsSync(join(run.box.win.www, 'current')), 'без switch')
})

await check('[P1] Нов скрипт, umask 077: release 755/644, shared assets 644 (вкл. lazy chunk), deploy минава; chmod само по публичните пътища; частните файлове и deployment state не са пипнати', async () => {
  const run = await deploy(newSource, '077')
  cleanup.push(run.box.root)
  assert(run.code === 0, `deploy се провали: ${tail(run.output)}`)
  assert(/umask за публичните файлове: 022 \(наследен: 0077\)/.test(run.output), 'изричен umask 022 в лога')
  const www = run.box.bash.www
  assert(run.releases.length === 1, 'един release')
  const release = `${www}/releases/${run.releases[0]}`
  for (const [path, mode] of [
    [release, '755'], [`${release}/assets`, '755'], [`${release}/index.html`, '644'], [`${release}/sw.js`, '644'],
    [`${release}/assets/${ENTRY_JS}`, '644'], [`${release}/assets/${LAZY_JS}`, '644'],
    [`${www}/assets/${ENTRY_JS}`, '644'], [`${www}/assets/${ENTRY_CSS}`, '644'], [`${www}/assets/${LAZY_JS}`, '644'],
  ] as const) {
    assert(run.db.get(path) === mode, `${path.slice(www.length)}: очаквах ${mode}, получено ${run.db.get(path)}`)
  }
  assert(run.http.some((l) => l === `/assets/${ENTRY_JS} 200`) && run.http.some((l) => l === '/ 200'), `HTTP: ${run.http.join(', ')}`)
  const publicPrefixes = [`${release}`, `${www}/assets/`]
  const publicDirs = new Set([`${www}/releases`, `${www}/assets`])
  const outside = run.chmods.filter((p) => !publicDirs.has(p) && !publicPrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(prefix)))
  assert(outside.length === 0, `chmod извън публичните пътища: ${outside.join(', ')}`)
  for (const [path, mode] of [[`${www}/server/data/belot.sqlite`, '600'], [`${www}/server/.env`, '600'], [`${www}/backups/db-2026.tar.zst`, '600'], [`${www}/server/data`, '700'], [`${www}/backups`, '700']] as const) {
    assert(run.db.get(path) === mode, `частен път ${path.slice(www.length)} е променен: ${run.db.get(path)}`)
  }
  assert(!run.chmods.some((p) => p.startsWith(run.box.bash.state) || p === run.box.bash.lock), 'deployment state/lock не се chmod-ват')
  // Deployment state: наследеният umask (0077) -> директорията се създава като 700, както преди промяната.
  assert(run.db.get(run.box.bash.state) === '700', `deployment state директорията: ${run.db.get(run.box.bash.state)} (очаквах 700 при наследен umask 0077)`)
  assert(existsSync(join(run.box.win.state, 'frontend.json')), 'frontend.json е записан')
  assert(run.stateUmask === '0077', `frontend.json е записан с umask ${run.stateUmask} (очаквах наследения 0077)`)
})

await check('[P2] Вече наличен shared asset със същия checksum, но 600, и assets/ 700 -> a+r / a+rx, deploy минава', async () => {
  const run = await deploy(newSource, '077', (box) => {
    writeFileSync(join(box.win.www, 'assets', ENTRY_JS), 'console.log("main")')
    writeFileSync(box.win.db, `600\t${box.bash.www}/assets/${ENTRY_JS}\n700\t${box.bash.www}/assets\n`, { flag: 'a' })
  })
  cleanup.push(run.box.root)
  assert(run.code === 0, `deploy се провали: ${tail(run.output)}`)
  const www = run.box.bash.www
  assert(run.db.get(`${www}/assets/${ENTRY_JS}`) === '644', `наличният asset: ${run.db.get(`${www}/assets/${ENTRY_JS}`)}`)
  assert(run.db.get(`${www}/assets`) === '755', `assets/: ${run.db.get(`${www}/assets`)}`)
  assert(/права коригирани \(600 -> 644\), checksum непроменен: index-Ab12Cd34\.js/.test(run.output), 'лог за коригирания asset')
  assert(/Права на публична директория коригирани \(700 -> 755\)/.test(run.output), 'лог за директорията')
  assert(readFileSync(join(run.box.win.www, 'assets', ENTRY_JS), 'utf8') === 'console.log("main")', 'съдържанието е непроменено')
})

await check('[P3] Наличен shared asset с РАЗЛИЧЕН checksum -> STOP (immutable conflict), без switch и без chmod на чуждия файл', async () => {
  const run = await deploy(newSource, '077', (box) => {
    writeFileSync(join(box.win.www, 'assets', ENTRY_JS), 'different-content')
    writeFileSync(box.win.db, `600\t${box.bash.www}/assets/${ENTRY_JS}\n`, { flag: 'a' })
  })
  cleanup.push(run.box.root)
  assert(run.code !== 0 && /Immutable asset conflict/.test(run.output), `очаквах immutable conflict: ${tail(run.output)}`)
  assert(!existsSync(join(run.box.win.www, 'current')), 'без switch')
  assert(run.db.get(`${run.box.bash.www}/assets/${ENTRY_JS}`) === '600' && !run.chmods.includes(`${run.box.bash.www}/assets/${ENTRY_JS}`), 'конфликтният файл не е пипнат')
})

await check('[P4] Нормална сесия (umask 022): deploy минава без корекции на права', async () => {
  const run = await deploy(newSource, '022')
  cleanup.push(run.box.root)
  assert(run.code === 0, `deploy се провали: ${tail(run.output)}`)
  assert(/umask за публичните файлове: 022 \(наследен: 0022\)/.test(run.output), 'лог за umask')
  assert(!/права коригирани|Права на публична директория коригирани/.test(run.output), 'без корекции')
  assert(run.stateUmask === '0022', `frontend.json: umask ${run.stateUmask}`)
})

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
