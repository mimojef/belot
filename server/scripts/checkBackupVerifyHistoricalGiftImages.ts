// Regression: pikabg-backup-verify-consistency.mjs не бива да проваля backup-а
// заради липсващи изображения, реферирани САМО от исторически записи
// (показани gift_item_delivery_log редове, изтрити gift_items). Актуалните
// препратки (живи подаръци, непоказани известия, други *_url колони) остават
// строги. Ползва --uploads-dir режима (без zstd/tar).
//
// Пускане: cd server && npx tsx scripts/checkBackupVerifyHistoricalGiftImages.ts

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const VERIFIER = resolve(import.meta.dirname, '..', '..', 'ops', 'pikabg-backup', 'scripts', 'pikabg-backup-verify-consistency.mjs')

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  PASS ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}`, detail ?? '')
  }
}

type Row = { table: 'gift_items' | 'delivery' | 'profiles'; url: string; historical?: boolean }

function runCase(name: string, rows: Row[], presentFiles: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'pikabg-verify-'))
  try {
    const dbPath = join(root, 'db.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE gift_items (gift_item_id TEXT PRIMARY KEY, image_url TEXT NOT NULL, deleted_at TEXT DEFAULT NULL);
      CREATE TABLE gift_item_delivery_log (transaction_id TEXT PRIMARY KEY, image_url TEXT NOT NULL, shown_at TEXT DEFAULT NULL);
      CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, avatar_url TEXT);
    `)
    rows.forEach((row, i) => {
      const flag = row.historical ? '2026-01-01 00:00:00' : null
      if (row.table === 'gift_items') db.prepare('INSERT INTO gift_items VALUES (?, ?, ?)').run(`g${i}`, row.url, flag)
      else if (row.table === 'delivery') db.prepare('INSERT INTO gift_item_delivery_log VALUES (?, ?, ?)').run(`t${i}`, row.url, flag)
      else db.prepare('INSERT INTO profiles VALUES (?, ?)').run(`p${i}`, row.url)
    })
    db.close()

    for (const file of presentFiles) {
      const full = join(root, file)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x')
    }
    mkdirSync(join(root, 'uploads'), { recursive: true })

    const r = spawnSync(process.execPath, [VERIFIER, '--db', dbPath, '--uploads-dir', root], { encoding: 'utf8' })
    let json: any = null
    try {
      json = JSON.parse(r.stdout)
    } catch {
      /* оставя json = null */
    }
    console.log(`\n[${name}]`)
    return { status: r.status, json, stderr: r.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const A = '/uploads/gift-items/a.webp'
const B = '/uploads/gift-items/b.webp'
const C = '/uploads/gift-items/c.webp'
const LIVE = '/uploads/gift-items/live.webp'

// 1) Производственият случай: 3 липсващи изображения само в показани известия.
{
  const rows: Row[] = [
    { table: 'gift_items', url: LIVE },
    { table: 'delivery', url: LIVE, historical: true },
    { table: 'delivery', url: A, historical: true },
    { table: 'delivery', url: A, historical: true },
    { table: 'delivery', url: B, historical: true },
    { table: 'delivery', url: C, historical: true },
  ]
  const r = runCase('показани известия с липсващи изображения', rows, ['uploads/gift-items/live.webp'])
  check('exit 0', r.status === 0, r)
  check('ok:true', r.json?.ok === true, r.json)
  check('няма строги липси', Object.keys(r.json?.missing_url_references ?? {}).length === 0, r.json)
  const warned = r.json?.missing_historical_url_references_warning_only?.['gift_item_delivery_log.image_url'] ?? []
  check('3-те липси са в предупрежденията', warned.length === 3 && [A, B, C].every((u) => warned.includes(u)), warned)
}

// 2) Непоказано известие (shown_at IS NULL) с липсващ файл — строго.
{
  const r = runCase('непоказано известие с липсващ файл', [{ table: 'delivery', url: A }], [])
  check('exit 1', r.status === 1, r)
  check('ok:false', r.json?.ok === false, r.json)
  check('липсата е строга', (r.json?.missing_url_references?.['gift_item_delivery_log.image_url'] ?? []).includes(A), r.json)
}

// 3) Същият URL е и в показано, и в непоказано известие — строго.
{
  const r = runCase('URL в показано и непоказано известие', [
    { table: 'delivery', url: A, historical: true },
    { table: 'delivery', url: A },
  ], [])
  check('exit 1', r.status === 1, r)
  check('не е в предупрежденията', Object.keys(r.json?.missing_historical_url_references_warning_only ?? {}).length === 0, r.json)
}

// 4) Жив подарък в каталога с липсващ файл — строго.
{
  const r = runCase('жив подарък с липсващ файл', [{ table: 'gift_items', url: LIVE }], [])
  check('exit 1', r.status === 1, r)
  check('липсата е строга', (r.json?.missing_url_references?.['gift_items.image_url'] ?? []).includes(LIVE), r.json)
}

// 5) Изтрит (tombstone) подарък с липсващ файл — предупреждение.
{
  const r = runCase('изтрит подарък с липсващ файл', [{ table: 'gift_items', url: A, historical: true }], [])
  check('exit 0', r.status === 0, r)
  check('в предупрежденията', (r.json?.missing_historical_url_references_warning_only?.['gift_items.image_url'] ?? []).includes(A), r.json)
}

// 6) Друга *_url колона (аватар) с липсващ файл, заедно с исторически липси — строго.
{
  const r = runCase('липсващ аватар + исторически липси', [
    { table: 'profiles', url: '/uploads/avatars/x.webp' },
    { table: 'delivery', url: B, historical: true },
  ], [])
  check('exit 1', r.status === 1, r)
  check('само аватарът е строг', JSON.stringify(Object.keys(r.json?.missing_url_references ?? {})) === '["profiles.avatar_url"]', r.json)
  check('историческата липса остава предупреждение', (r.json?.missing_historical_url_references_warning_only?.['gift_item_delivery_log.image_url'] ?? []).includes(B), r.json)
}

// 7) Всичко налично — без предупреждения.
{
  const r = runCase('всички файлове налични', [
    { table: 'gift_items', url: LIVE },
    { table: 'delivery', url: LIVE, historical: true },
  ], ['uploads/gift-items/live.webp'])
  check('exit 0', r.status === 0, r)
  check('без предупреждения', Object.keys(r.json?.missing_historical_url_references_warning_only ?? {}).length === 0, r.json)
  check('проверени: 1 строга, 1 историческа', r.json?.checked_url_references === 1 && r.json?.checked_historical_url_references === 1, r.json)
}

console.log(failures === 0 ? '\nВсички проверки минаха.' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
