#!/usr/bin/env node
// Целеви тест за prune-deploy-migration-backups.mjs (T2) — само във временна
// директория; никога върху реални файлове.
//
//   node ops/deploy-migration-backup-retention/check-prune-deploy-migration-backups.mjs

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, PROTECTED_LATEST_COUNT, parseBackupId, planPrune, run, scanBackups } from './prune-deploy-migration-backups.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let passed = 0
let failed = 0
async function check(label, fn) {
  try {
    await fn()
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

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const SHA = 'a'.repeat(64)
const MISSING_ROOT = join(tmpdir(), 'pika-t2-does-not-exist-xyz')

function idFor(daysAgo, sha = 'abc1234') {
  const d = new Date(NOW - daysAgo * DAY)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${sha}`
}

async function makeBackup(root, name, { db = 'SQLite format 3', sha = `${SHA}  belot-v2.sqlite\n`, extra = null, skipSha = false } = {}) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'belot-v2.sqlite'), db)
  if (!skipSha) await writeFile(join(dir, 'belot-v2.sqlite.sha256'), sha)
  if (extra !== null) await writeFile(join(dir, extra), 'manual note')
  return name
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'pika-t2-'))
  const root = join(base, 'backend-deploy-migration')
  const hourly = join(base, 'hourly-backups')
  await mkdir(root)
  await mkdir(hourly)
  await writeFile(join(hourly, 'belot-v2-20250101.sqlite.zst'), 'hourly backup')
  const names = {
    old200: await makeBackup(root, idFor(200, 'aaaa111')),
    old100: await makeBackup(root, idFor(100, 'bbbb222')),
    old10: await makeBackup(root, idFor(10, 'cccc333')),
    recent5: await makeBackup(root, idFor(5, 'c5c5c5c')),
    newest2: await makeBackup(root, idFor(2, 'dddd444')),
    manual: await makeBackup(root, 'manual-before-upgrade'),
    withExtra: await makeBackup(root, idFor(150, 'eeee555'), { extra: 'NOTES.txt' }),
    incomplete: await makeBackup(root, idFor(120, 'ffff666'), { skipSha: true }),
    badSha: await makeBackup(root, idFor(130, 'abab777'), { sha: 'garbage\n' }),
    future: await makeBackup(root, idFor(-5, 'cdcd888')),
  }
  await writeFile(join(root, 'README-manual.txt'), 'ръчна бележка')
  return { base, root, hourly, names }
}

console.log('\ncheck-prune-deploy-migration-backups\n')

await check('[P0] Политика: 7 дни по подразбиране, минимум 7, защитени са последните 2 успешни', () => {
  assert(DEFAULT_RETENTION_DAYS === 7 && MIN_RETENTION_DAYS === 7 && PROTECTED_LATEST_COUNT === 2, `${DEFAULT_RETENTION_DAYS}/${MIN_RETENTION_DAYS}/${PROTECTED_LATEST_COUNT}`)
})

await check('[P1] Име: само <UTC YYYYMMDDHHMMSS>-<sha>; невалидни дати се отхвърлят', () => {
  assert(parseBackupId('20261113120000-abc1234') === Date.UTC(2026, 10, 13, 12, 0, 0), 'валидно')
  assert(parseBackupId('20261332120000-abc1234') === null, 'невалиден месец/ден')
  assert(parseBackupId('20261113120000') === null, 'без sha')
  assert(parseBackupId('manual-20261113120000-abc1234') === null, 'префикс')
  assert(parseBackupId('20261113120000-ABC1234') === null, 'главни букви в sha')
})

await check('[P2] DRY-RUN по подразбиране: нищо не се изтрива; отчита кои биха се изтрили', async () => {
  const { base, root, names } = await fixture()
  try {
    const lines = []
    const result = await run({ root, nowMs: NOW, log: (line) => lines.push(line) })
    assert(result.mode === 'dry-run', 'режим')
    assert(result.wouldDelete.sort().join(',') === [names.old10, names.old100, names.old200].sort().join(','), `кандидати: ${result.wouldDelete.join(',')}`)
    const after = (await readdir(root)).sort()
    assert([names.old200, names.old100, names.old10].every((name) => after.includes(name)), 'файловете са непокътнати')
    assert(lines.some((line) => line.startsWith('WOULD-DELETE')), 'WOULD-DELETE редове')
    assert(lines.some((line) => line.includes(`protected=${names.newest2},${names.recent5}`)), 'обобщението показва двете защитени')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P3] --apply: изтрива само успешните автоматични копия >7 дни извън последните 2; ръчни, с допълнителни файлове, недовършени, невалиден SHA, бъдещи и файлове в корена остават; ежечасните не се докосват', async () => {
  const { base, root, hourly, names } = await fixture()
  try {
    const result = await run({ root, nowMs: NOW, apply: true, log: () => {} })
    assert(result.exitCode === 0 && result.errors.length === 0, 'без грешки')
    assert(result.deleted.sort().join(',') === [names.old10, names.old100, names.old200].sort().join(','), `изтрити: ${result.deleted.join(',')}`)
    const after = (await readdir(root)).sort()
    for (const keep of [names.recent5, names.newest2, names.manual, names.withExtra, names.incomplete, names.badSha, names.future, 'README-manual.txt']) {
      assert(after.includes(keep), `остава ${keep}`)
    }
    assert(!after.includes(names.old200) && !after.includes(names.old100) && !after.includes(names.old10), 'старите са изтрити')
    assert((await readdir(hourly)).length === 1, 'ежечасните backup-и са непокътнати')
    assert(result.protectedNames.join(',') === [names.newest2, names.recent5].join(','), `защитени: ${result.protectedNames.join(',')}`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P4] Защита на последните 2 успешни: ако всички са >7 дни, двете най-нови успешни остават (недовършените и невалидните не се броят)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pika-t2-'))
  const root = join(base, 'root')
  await mkdir(root)
  try {
    const a = await makeBackup(root, idFor(300, 'aaaa111'))
    const b = await makeBackup(root, idFor(200, 'bbbb222'))
    const c = await makeBackup(root, idFor(20, 'cccc333'))
    const badNewer = await makeBackup(root, idFor(15, 'dddd444'), { sha: 'nope' })
    const incompleteNewest = await makeBackup(root, idFor(10, 'eeee555'), { skipSha: true })
    const emptyDb = await makeBackup(root, idFor(9, 'ffff666'), { db: '' })
    const result = await run({ root, nowMs: NOW, apply: true, log: () => {} })
    assert(result.protectedNames.join(',') === [c, b].join(','), `защитени: ${result.protectedNames.join(',')}`)
    const after = (await readdir(root)).sort()
    assert(after.includes(c) && after.includes(b), 'двете най-нови успешни остават, макар и >7 дни')
    assert(!after.includes(a), 'третото успешно (>7 дни) е изтрито')
    assert([badNewer, incompleteNewest, emptyDb].every((name) => after.includes(name)), 'невалидните/недовършените не се трият и не се броят за успешни')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P5] Чиста функция planPrune: граница 7 дни, защита на 2, keep/delete причини', () => {
  const at = (days) => ({ createdMs: NOW - days * DAY, ageDays: days })
  const items = [
    { name: 'd8', kind: 'automatic', ...at(8) },
    { name: 'e7', kind: 'automatic', ...at(7) },
    { name: 'k6', kind: 'automatic', ...at(6.9) },
    { name: 'p3', kind: 'automatic', ...at(3) },
    { name: 'p1', kind: 'automatic', ...at(1) },
    { name: 'i0', kind: 'incomplete', reason: 'missing_files', ...at(0.5) },
    { name: 'x', kind: 'skipped', reason: 'not_a_deploy_backup_name' },
  ]
  const { protectedNames, plan } = planPrune(items, 7)
  assert(protectedNames.join(',') === 'p1,p3', `защитени: ${protectedNames.join(',')}`)
  const byName = Object.fromEntries(plan.map((item) => [item.name, item]))
  assert(byName.d8.action === 'delete' && byName.d8.why === 'older_than_7_days', '8 дни -> delete')
  assert(byName.e7.action === 'keep' && byName.e7.why === 'within_retention', 'точно 7 дни -> keep')
  assert(byName.k6.action === 'keep' && byName.k6.why === 'within_retention', '6.9 дни -> keep')
  assert(byName.p1.why === 'latest_2_successful' && byName.p3.why === 'latest_2_successful', 'причина за защитата')
  assert(byName.i0.action === 'keep' && byName.x.action === 'keep', 'недовършените и пропуснатите остават')
  const single = planPrune([{ name: 'only', kind: 'automatic', ...at(400) }], 7)
  assert(single.protectedNames.join(',') === 'only' && single.plan[0].action === 'keep', 'единственото успешно копие остава')
  const none = planPrune([{ name: 'i', kind: 'incomplete', reason: 'missing_files', ...at(400) }], 7)
  assert(none.protectedNames.length === 0 && none.plan.every((item) => item.action === 'keep'), 'без успешни копия нищо не се трие')
})

await check('[P6] Symlink към директория се пропуска (не се следва)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pika-t2-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  try {
    await makeBackup(base, 'outside')
    await makeBackup(root, idFor(2, 'dddd444'))
    await makeBackup(root, idFor(1, 'dddd555'))
    let created = true
    try {
      await symlink(outside, join(root, idFor(200, 'aaaa111')), 'junction')
    } catch {
      created = false
    }
    if (!created) {
      console.log('        (symlink/junction не може да се създаде в тази среда — проверката е пропусната)')
      return
    }
    const items = await scanBackups(root, NOW)
    const link = items.find((item) => item.name === idFor(200, 'aaaa111'))
    assert(link?.kind === 'skipped' && link.reason === 'symlink', `symlink: ${JSON.stringify(link)}`)
    await run({ root, nowMs: NOW, apply: true, log: () => {} })
    assert((await readdir(outside)).length === 2, 'целта на symlink-а е непокътната')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P7] CLI/API: срок < 7 и непознат аргумент -> изход 2; 7 се приема; липсващ корен -> 0 без действия', async () => {
  const script = join(here, 'prune-deploy-migration-backups.mjs')
  const code = (args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' })
      return 0
    } catch (error) {
      return error.status
    }
  }
  assert(code(['--retention-days', '6', '--root', tmpdir()]) === 2, 'кратък срок')
  assert(code(['--retention-days', '7', '--root', MISSING_ROOT]) === 0, '7 дни се приемат')
  assert(code(['--bogus']) === 2, 'непознат аргумент')
  assert(code(['--root', MISSING_ROOT]) === 0, 'липсващ корен')
  let apiError = null
  try {
    await run({ root: MISSING_ROOT, retentionDays: 3, log: () => {} })
  } catch (error) {
    apiError = error
  }
  assert(apiError?.exitCode === 2, 'run() отказва срок < 7')
})

await check('[P8] systemd: веднъж дневно (Persistent), --apply със срока по подразбиране (без --retention-days/--root)', async () => {
  const service = await readFile(join(here, 'systemd', 'pikabg-deploy-backup-retention.service'), 'utf8')
  const timer = await readFile(join(here, 'systemd', 'pikabg-deploy-backup-retention.timer'), 'utf8')
  const exec = /^ExecStart=(.+)$/m.exec(service)?.[1]?.trim() ?? ''
  assert(exec.endsWith('prune-deploy-migration-backups.mjs --apply'), `ExecStart: ${exec}`)
  assert(!/--retention-days|--root/.test(service), 'без override на срока или корена')
  const calendars = timer.match(/^OnCalendar=.*$/gm) ?? []
  assert(calendars.length === 1 && /^OnCalendar=\*-\*-\* \d{2}:\d{2}:\d{2}\s*$/.test(calendars[0]), `един дневен OnCalendar: ${calendars.join(' | ')}`)
  assert(/^Persistent=true\s*$/m.test(timer), 'Persistent=true')
  assert(!/90/.test(service + timer), 'без стария срок 90 дни')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
