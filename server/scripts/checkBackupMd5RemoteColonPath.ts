// Regression: MD5 проверката в ops/pikabg-backup/scripts/pikabg-db-backup
// трябва да подава на `rclone md5sum` ПЪЛНИЯ remote път, включително
// "pikabg-drive:" префикса (преди разделянето по ':' го премахваше).
// Изрязва реалния блок от скрипта (от "Verifying uploaded archives via MD5"
// до "Health after") и го пуска в bash със stub rclone.
//
// Пускане: cd server && npx tsx scripts/checkBackupMd5RemoteColonPath.ts

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BACKUP_SCRIPT = resolve(import.meta.dirname, '..', '..', 'ops', 'pikabg-backup', 'scripts', 'pikabg-db-backup')

function sh(p: string): string {
  if (process.platform !== 'win32') return p
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
}

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash'
  for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
    if (existsSync(candidate)) return candidate
  }
  return 'bash'
}

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}`, detail ?? '')
  }
}

const source = readFileSync(BACKUP_SCRIPT, 'utf8').replace(/\r\n/g, '\n')
const start = source.indexOf('echo "[backup] Verifying uploaded archives via MD5..."')
const end = source.indexOf('echo "[backup] Health after:"')
if (start < 0 || end < 0 || end <= start) {
  console.log('FAIL: не е намерен MD5 блокът в pikabg-db-backup')
  process.exit(1)
}
const md5Block = source.slice(start, end)

const REMOTE = 'pikabg-drive'
const REMOTE_DB_DIR = `${REMOTE}:pikabg-backups/database/2026-11-26`
const REMOTE_UPLOADS_DIR = `${REMOTE}:pikabg-backups/uploads/2026-11-26`
const NAMES = {
  db: 'belot-v2-20261126.sqlite.zst',
  uploads: 'belot-v2-20261126-uploads.tar.zst',
  journal: 'belot-v2-20261126-held-payout-journal.tar.zst',
}

function runCase(name: string, corruptRemote: keyof typeof NAMES | null) {
  const root = mkdtempSync(join(tmpdir(), 'pikabg-md5-'))
  try {
    const local = join(root, 'local')
    const remoteRoot = join(root, 'remote')
    const bin = join(root, 'bin')
    for (const d of [local, join(remoteRoot, 'pikabg-backups', 'database', '2026-11-26'), join(remoteRoot, 'pikabg-backups', 'uploads', '2026-11-26'), bin]) {
      mkdirSync(d, { recursive: true })
    }
    const remoteDir = { db: 'database', uploads: 'uploads', journal: 'database' } as const
    for (const key of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
      writeFileSync(join(local, NAMES[key]), `content-${key}`)
      writeFileSync(
        join(remoteRoot, 'pikabg-backups', remoteDir[key], '2026-11-26', NAMES[key]),
        key === corruptRemote ? `corrupt-${key}` : `content-${key}`,
      )
    }

    // Stub: приема само "<remote>:<път>"; без префикс не отпечатва нищо
    // (както при грешно подаден път — празен remote MD5).
    const log = join(root, 'rclone.log')
    writeFileSync(join(bin, 'rclone'), [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${sh(log)}"`,
      '[ "$1" = "md5sum" ] || exit 2',
      `case "$2" in`,
      `  ${REMOTE}:*) f="${sh(remoteRoot)}/\${2#${REMOTE}:}"; [ -f "$f" ] && md5sum "$f" | awk '{print $1"  x"}' ;;`,
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'))
    chmodSync(join(bin, 'rclone'), 0o755)

    const script = [
      'set -Eeuo pipefail',
      `export PATH="${sh(bin)}:$PATH"`,
      `DB_ARCHIVE="${sh(join(local, NAMES.db))}"`,
      `UPLOADS_ARCHIVE="${sh(join(local, NAMES.uploads))}"`,
      `JOURNAL_ARCHIVE="${sh(join(local, NAMES.journal))}"`,
      `REMOTE_DB_DIR="${REMOTE_DB_DIR}"`,
      `REMOTE_UPLOADS_DIR="${REMOTE_UPLOADS_DIR}"`,
      md5Block,
      'echo "[test] MD5 block finished"',
      '',
    ].join('\n')
    const scriptPath = join(root, 'run.sh')
    writeFileSync(scriptPath, script)

    const r = spawnSync(bashExecutable(), [sh(scriptPath)], { encoding: 'utf8' })
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    console.log(`\n[${name}]`)
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

{
  const r = runCase('remote път с ":" — всички MD5 съвпадат', null)
  check('exit 0', r.status === 0, r.out)
  check('блокът стига до края', r.out.includes('[test] MD5 block finished'), r.out)
  check('rclone получава пълните remote пътища', JSON.stringify(r.calls) === JSON.stringify([
    `md5sum ${REMOTE_DB_DIR}/${NAMES.db}`,
    `md5sum ${REMOTE_UPLOADS_DIR}/${NAMES.uploads}`,
    `md5sum ${REMOTE_DB_DIR}/${NAMES.journal}`,
  ]), r.calls)
  check('няма ERROR', !r.out.includes('ERROR'), r.out)
}

{
  const r = runCase('несъответствие в uploads архива', 'uploads')
  check('exit 1', r.status === 1, r.out)
  check('ERROR за uploads архива', r.out.includes(`ERROR: uploaded file checksum mismatch for ${NAMES.uploads}`), r.out)
  check('спира веднага (журналът не се проверява)', r.calls.length === 2 && !r.out.includes('[test] MD5 block finished'), r.calls)
}

console.log(failures === 0 ? '\nВсички проверки минаха.' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
