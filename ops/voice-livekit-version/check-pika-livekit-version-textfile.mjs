#!/usr/bin/env node
// Целеви тест за pika-livekit-version-textfile — само във временна директория,
// с TEST-ONLY stub за `docker` (истински docker не се вика). Stub-ът записва
// точните аргументи и връща сценарий според PIKA_TEST_DOCKER_MODE.
//
//   node ops/voice-livekit-version/check-pika-livekit-version-textfile.mjs

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'pika-livekit-version-textfile')
let passed = 0
let failed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const STUB = `#!/usr/bin/env bash
# TEST-ONLY docker stub (never committed to a VPS).
printf '%s\\n' "$*" >> "$PIKA_TEST_DOCKER_LOG"
case "$1" in
  inspect)
    case "$PIKA_TEST_DOCKER_MODE" in
      stopped) echo false ;;
      missing) echo "Error: No such object: $4" >&2; exit 1 ;;
      *) echo true ;;
    esac ;;
  exec)
    case "$PIKA_TEST_DOCKER_MODE" in
      ok) echo "livekit-server version 1.13.11" ;;
      okv) printf 'livekit-server version v1.14.0-rc.1\\r\\nextra line\\n' ;;
      garbage) echo 'livekit-server version 1.13.11"} 1' ;;
      empty) ;;
      hang) sleep 5; echo "livekit-server version 1.13.11" ;;
      execfail) echo "OCI runtime exec failed" >&2; exit 126 ;;
    esac ;;
esac
`

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'pika-lkv-'))
  const bin = join(base, 'bin')
  const dir = join(base, 'textfile')
  mkdirSync(bin)
  mkdirSync(dir)
  writeFileSync(join(bin, 'docker'), STUB)
  chmodSync(join(bin, 'docker'), 0o755)
  return { base, dir, log: join(base, 'docker.log') }
}

function run(ctx, mode, env = {}) {
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(ctx.base, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      PIKA_TEXTFILE_DIR: ctx.dir,
      PIKA_TEST_DOCKER_MODE: mode,
      PIKA_TEST_DOCKER_LOG: ctx.log,
      PIKA_LIVEKIT_VERSION_TIMEOUT: '2',
      ...env,
    },
  })
  return { code: result.status, stderr: result.stderr }
}

const out = (ctx) => readFileSync(join(ctx.dir, 'pika_livekit_version.prom'), 'utf8')
const files = (ctx) => readdirSync(ctx.dir).sort()
const metricLines = (text) => text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))

function withCtx(fn) {
  const ctx = setup()
  try {
    fn(ctx)
  } finally {
    rmSync(ctx.base, { recursive: true, force: true })
  }
}

console.log('\ncheck-pika-livekit-version-textfile\n')

check('[S1] Работещ контейнер -> pika_livekit_build_info{version="1.13.11"} 1, success 1, timestamp; точни docker команди; без остатъчни temp файлове', () => withCtx((ctx) => {
  const before = Math.floor(Date.now() / 1000)
  const { code } = run(ctx, 'ok')
  assert(code === 0, `изход ${code}`)
  const lines = metricLines(out(ctx))
  assert(lines[0] === 'pika_livekit_build_info{version="1.13.11"} 1', `ред: ${lines[0]}`)
  assert(lines[1] === 'pika_livekit_version_check_success 1', `ред: ${lines[1]}`)
  const ts = Number(/^pika_livekit_version_check_timestamp_seconds (\d+)$/.exec(lines[2] ?? '')?.[1])
  assert(ts >= before - 1 && ts <= Math.floor(Date.now() / 1000) + 1, `timestamp ${lines[2]}`)
  assert(lines.length === 3, `точно 3 метрики, имам ${lines.length}`)
  assert(files(ctx).join(',') === 'pika_livekit_version.prom', `файлове: ${files(ctx).join(',')}`)
  const calls = readFileSync(ctx.log, 'utf8').trim().split('\n')
  assert(calls[0] === 'inspect --format {{.State.Running}} lk-server', `inspect: ${calls[0]}`)
  assert(calls[1] === 'exec lk-server /livekit-server --version', `exec: ${calls[1]}`)
  assert(calls.length === 2, 'само две docker извиквания')
}))

check('[S2] Префикс v и CRLF/допълнителни редове се нормализират; PIKA_LIVEKIT_CONTAINER се спазва', () => withCtx((ctx) => {
  const { code } = run(ctx, 'okv', { PIKA_LIVEKIT_CONTAINER: 'lk_server-2.prod' })
  assert(code === 0, `изход ${code}`)
  assert(metricLines(out(ctx))[0] === 'pika_livekit_build_info{version="1.14.0-rc.1"} 1', metricLines(out(ctx))[0])
  assert(readFileSync(ctx.log, 'utf8').includes('exec lk_server-2.prod /livekit-server --version'), 'името на контейнера')
}))

for (const [mode, label] of [
  ['stopped', 'спрян контейнер'],
  ['missing', 'липсващ контейнер'],
  ['garbage', 'неочакван изход (опит за инжекция в етикета)'],
  ['empty', 'празен изход'],
  ['execfail', 'docker exec грешка'],
  ['hang', 'timeout на docker exec'],
]) {
  check(`[S3:${mode}] ${label} -> изход 1; старата версия е ПРЕЗАПИСАНА: без build_info, success 0, нов timestamp`, () => withCtx((ctx) => {
    assert(run(ctx, 'ok').code === 0, 'първо успешно записване')
    const { code, stderr } = run(ctx, mode)
    assert(code === 1, `изход ${code}`)
    const text = out(ctx)
    assert(!text.includes('pika_livekit_build_info'), 'няма остаряла версия')
    assert(metricLines(text)[0] === 'pika_livekit_version_check_success 0', metricLines(text)[0])
    assert(/^pika_livekit_version_check_timestamp_seconds \d+$/m.test(text), 'timestamp')
    assert(files(ctx).join(',') === 'pika_livekit_version.prom', `файлове: ${files(ctx).join(',')}`)
    assert(/проверката е неуспешна \((container_not_running|unexpected_version_output)\)/.test(stderr), `stderr: ${stderr}`)
  }))
}

check('[S4] Грешна конфигурация -> изход 2 и нищо не се записва (липсваща директория, невалидно име, невалиден timeout)', () => withCtx((ctx) => {
  assert(run(ctx, 'ok', { PIKA_TEXTFILE_DIR: join(ctx.base, 'missing') }).code === 2, 'липсваща директория')
  assert(run(ctx, 'ok', { PIKA_LIVEKIT_CONTAINER: 'lk;rm -rf /' }).code === 2, 'невалидно име на контейнер')
  assert(run(ctx, 'ok', { PIKA_LIVEKIT_CONTAINER: '-lk' }).code === 2, 'име, започващо с тире')
  assert(run(ctx, 'ok', { PIKA_LIVEKIT_VERSION_TIMEOUT: '0' }).code === 2, 'timeout 0')
  assert(files(ctx).length === 0, `файлове: ${files(ctx).join(',')}`)
  let docker = ''
  try { docker = readFileSync(ctx.log, 'utf8') } catch { docker = '' }
  assert(docker === '', 'docker не е извикван')
}))

check('[S5] Имената и TYPE редовете в изхода съвпадат с тези, които чете backend-ът (voiceVpsMetrics.ts)', () => withCtx((ctx) => {
  run(ctx, 'ok')
  const backend = readFileSync(join(here, '..', '..', 'server', 'src', 'voice', 'voiceVpsMetrics.ts'), 'utf8')
  for (const name of ['pika_livekit_build_info', 'pika_livekit_version_check_success', 'pika_livekit_version_check_timestamp_seconds']) {
    assert(out(ctx).includes(`# TYPE ${name} gauge`), `TYPE за ${name}`)
    assert(backend.includes(`'${name}'`), `backend чете ${name}`)
  }
}))

check('[S6] systemd: oneshot с правилния път/контейнер/директория; таймер на всеки 5 минути', () => {
  const service = readFileSync(join(here, 'systemd', 'pika-livekit-version.service'), 'utf8')
  const timer = readFileSync(join(here, 'systemd', 'pika-livekit-version.timer'), 'utf8')
  assert(/^Type=oneshot$/m.test(service), 'oneshot')
  assert(/^ExecStart=\/usr\/local\/sbin\/pika-livekit-version-textfile$/m.test(service), 'ExecStart')
  assert(/^Environment=PIKA_LIVEKIT_CONTAINER=lk-server$/m.test(service), 'контейнер')
  assert(/^Environment=PIKA_TEXTFILE_DIR=\/var\/lib\/prometheus\/node-exporter$/m.test(service), 'textfile директория')
  assert(!/restart|docker (start|stop|restart)/i.test(service.replace(/^Description=.*$/m, '')), 'без рестарт на услуги')
  const calendars = timer.match(/^OnCalendar=.*$/gm) ?? []
  assert(calendars.length === 1 && calendars[0] === 'OnCalendar=*:0/5', `OnCalendar: ${calendars.join(' | ')}`)
  assert(/^Unit=pika-livekit-version\.service$/m.test(timer) && /^WantedBy=timers\.target$/m.test(timer), 'Unit/WantedBy')
  const scriptText = readFileSync(script, 'utf8')
  assert(!scriptText.includes('\r'), 'скриптът е с LF')
  assert(!/docker"? (start|stop|restart|kill|rm)\b/.test(scriptText) && !/systemctl/.test(scriptText), 'скриптът не рестартира нищо')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
