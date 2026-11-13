#!/usr/bin/env node
// Целеви тест за prune-deploy-migration-backups.mjs (T2) — само във временна
// директория; никога върху реални файлове.
//
//   node ops/deploy-migration-backup-retention/check-prune-deploy-migration-backups.mjs

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBackupId, planPrune, run, scanBackups } from './prune-deploy-migration-backups.mjs'

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
    recent10: await makeBackup(root, idFor(10, 'cccc333')),
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
    assert(result.wouldDelete.sort().join(',') === [names.old100, names.old200].sort().join(','), `кандидати: ${result.wouldDelete.join(',')}`)
    const after = (await readdir(root)).sort()
    assert(after.includes(names.old200) && after.includes(names.old100), 'файловете са непокътнати')
    assert(lines.some((line) => line.startsWith('WOULD-DELETE')), 'WOULD-DELETE редове')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P3] --apply: изтрива само успешните автоматични копия >90 дни; ръчни, с допълнителни файлове, недовършени, невалиден SHA, бъдещи и файлове в корена остават; ежечасните не се докосват', async () => {
  const { base, root, hourly, names } = await fixture()
  try {
    const result = await run({ root, nowMs: NOW, apply: true, log: () => {} })
    assert(result.exitCode === 0 && result.errors.length === 0, 'без грешки')
    assert(result.deleted.sort().join(',') === [names.old100, names.old200].sort().join(','), `изтрити: ${result.deleted.join(',')}`)
    const after = (await readdir(root)).sort()
    for (const keep of [names.recent10, names.newest2, names.manual, names.withExtra, names.incomplete, names.badSha, names.future, 'README-manual.txt']) {
      assert(after.includes(keep), `остава ${keep}`)
    }
    assert(!after.includes(names.old200) && !after.includes(names.old100), 'старите са изтрити')
    assert((await readdir(hourly)).length === 1, 'ежечасните backup-и са непокътнати')
    assert(result.protectedName === names.newest2, 'защитено е най-новото успешно')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P4] Защита на последното успешно копие: ако всички са >90 дни, най-новото успешно остава (невалидните не се броят за успешни)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pika-t2-'))
  const root = join(base, 'root')
  await mkdir(root)
  try {
    const a = await makeBackup(root, idFor(300, 'aaaa111'))
    const b = await makeBackup(root, idFor(200, 'bbbb222'))
    const badNewest = await makeBackup(root, idFor(150, 'cccc333'), { sha: 'nope' })
    const result = await run({ root, nowMs: NOW, apply: true, log: () => {} })
    assert(result.protectedName === b, `защитено: ${result.protectedName}`)
    const after = (await readdir(root)).sort()
    assert(after.includes(b), 'най-новото успешно остава')
    assert(!after.includes(a), 'по-старото успешно е изтрито')
    assert(after.includes(badNewest), 'невалидното не се трие и не се брои за успешно')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

await check('[P5] Чиста функция planPrune: граница 90 дни, keep/delete причини', () => {
  const items = [
    { name: 'n1', kind: 'automatic', createdMs: NOW - 91 * DAY, ageDays: 91 },
    { name: 'n2', kind: 'automatic', createdMs: NOW - 89 * DAY, ageDays: 89 },
    { name: 'n3', kind: 'automatic', createdMs: NOW - 1 * DAY, ageDays: 1 },
    { name: 'x', kind: 'skipped', reason: 'not_a_deploy_backup_name' },
  ]
  const { protectedName, plan } = planPrune(items, 90)
  assert(protectedName === 'n3', 'защитено')
  const byName = Object.fromEntries(plan.map((item) => [item.name, item]))
  assert(byName.n1.action === 'delete', '91 дни -> delete')
  assert(byName.n2.action === 'keep' && byName.n2.why === 'within_retention', '89 дни -> keep')
  assert(byName.x.action === 'keep', 'пропуснатите остават')
})

await check('[P6] Symlink към директория се пропуска (не се следва)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pika-t2-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  try {
    await makeBackup(base, 'outside')
    await makeBackup(root, idFor(2, 'dddd444'))
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

await check('[P7] CLI: --retention-days < 30 и непознат аргумент -> изход 2; липсващ корен -> 0 без действия', async () => {
  const script = join(here, 'prune-deploy-migration-backups.mjs')
  const code = (args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' })
      return 0
    } catch (error) {
      return error.status
    }
  }
  assert(code(['--retention-days', '7', '--root', tmpdir()]) === 2, 'кратък срок')
  assert(code(['--bogus']) === 2, 'непознат аргумент')
  assert(code(['--root', join(tmpdir(), 'pika-t2-does-not-exist-xyz')]) === 0, 'липсващ корен')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
