#!/usr/bin/env node
// pikabg-backup-verify-consistency.mjs
//
// Споделен helper между pikabg-db-backup (retry-on-race loop, Фаза 10.1 §3)
// и pikabg-restore (post-restore валидация, §4) — ЕДИН source of truth за
// "кое броим за реферирано качено изображение", за да не се разминават
// двата consumer-а. Node, не Python — сървърът вече зависи от Node+
// node:sqlite (виж server/src/*, вкл. Фаза 10's уже написаните test
// scripts), затова тук не се добавя НОВА runtime зависимост за VPS-а,
// за разлика от Python (само pikabg-db-retention го ползва, legacy избор,
// непипнат — виж README.md).
//
// Проверява: всяка URL/filename стойност в SQLite snapshot-а, която
// реферира нещо под server/uploads/, реално съществува — или в даден
// uploads tar.zst архив (--uploads-archive, listing БЕЗ extraction —
// "Възможност за проверка на съдържанието без реално възстановяване",
// Фаза 10.1 §3), или в реално извлечена uploads/ директория
// (--uploads-dir, pikabg-restore §4 post-restore валидация).
//
// Два вида референции в схемата (виж Фаза 10.1 §1 проучването):
//   A) "*_url" колони с пълен "/uploads/..." път (campaigns.unit_icon_url,
//      gift_items.image_url, profiles.avatar_url, profile_gallery_images.*,
//      ad_campaigns.image_url, и т.н.) — генерично, работи и за бъдещи
//      нови такива колони без промяна в тоя script.
//   B) "storage_filename" колони (chat/support/topic attachments) —
//      реферират само по bare filename, не пълен URL; живеят под ПОЗНАТИ
//      3 поддиректории (не са публично URL-served, виж server/src/index.ts
//      коментарите за PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS). Проверени
//      ОТДЕЛНО, като WARNING (не твърд fail/retry trigger) — виж §1
//      рационалето в финалния отчет защо тук умишлено е по-мек от A.
//
// Изключение от A: исторически редове (показани известия за подаръци,
// изтрити подаръци — виж HISTORICAL_URL_ROWS) са само WARNING.
//
// Излиза с JSON резултат на stdout; exit code 0 = консистентно, 1 =
// намерени липсващи категория-A референции (retry-able), 2 = грешка.

import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const STORAGE_FILENAME_SUBDIRS = {
  friend_chat_attachments: 'chat-attachments',
  support_message_attachments: 'support-attachments',
  topic_message_attachments: 'topic-attachments',
}

function parseArgs(argv) {
  const out = { db: null, uploadsArchive: null, uploadsDir: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') out.db = argv[++i]
    else if (arg === '--uploads-archive') out.uploadsArchive = argv[++i]
    else if (arg === '--uploads-dir') out.uploadsDir = argv[++i]
  }
  return out
}

// shell: true — на production (Linux) е поведенчески идентично на директен
// PATH-resolved spawn за тая проста команда (няма shell metacharacters във
// файловите пътища), затова е безопасно; едновременно позволява коректно
// намиране на .cmd/.bat shim-ове под Windows dev тестова среда (виж
// README.md "Тестова методология" секцията).
function listTarEntries(archivePath) {
  const zstd = spawnSync('zstd', ['-dc', archivePath], { maxBuffer: 1024 * 1024 * 1024, shell: true })
  if (zstd.status !== 0) {
    throw new Error(`zstd -dc failed: ${zstd.stderr?.toString() ?? zstd.status}`)
  }
  const tar = spawnSync('tar', ['-tf', '-'], { input: zstd.stdout, maxBuffer: 1024 * 1024 * 1024, shell: true })
  if (tar.status !== 0) {
    throw new Error(`tar -tf failed: ${tar.stderr?.toString() ?? tar.status}`)
  }
  const lines = tar.stdout.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  return new Set(lines)
}

function listDirectoryEntries(uploadsParentDir) {
  const entries = new Set()
  const uploadsRoot = join(uploadsParentDir, 'uploads')
  function walk(dir) {
    let stat
    try {
      stat = lstatSync(dir)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      // lstat — symlink НЕ се брои за наличен файл/директория (Фаза 12.1:
      // symlink към външен файл не бива да "удовлетворява" DB референция).
      const s = lstatSync(full)
      if (s.isDirectory()) {
        walk(full)
      } else if (s.isFile()) {
        const rel = relative(uploadsParentDir, full).split(sep).join('/')
        entries.add(rel)
      }
    }
  }
  walk(uploadsRoot)
  return entries
}

// Исторически записи, които по дизайн НЕ пазят файла на диска (сървърът
// изтрива изображението, щом никой актуален запис не го ползва — виж
// giftItemStore.isImageUrlRetentionReferenced и tryFinalizeDeletedGiftImage
// в server/src/index.ts):
//   - gift_item_delivery_log с shown_at NOT NULL — вече показано известие,
//     snapshot на image_url към момента на подаряването;
//   - gift_items с deleted_at NOT NULL — логически изтрит (tombstone) подарък.
// Липса на файл САМО от такива редове е предупреждение, не fail/retry.
// Непоказаните известия (shown_at IS NULL) и живите подаръци остават строги.
// Ако колоната-условие липсва в схемата, всичко от таблицата остава строго.
const HISTORICAL_URL_ROWS = {
  'gift_item_delivery_log.image_url': { column: 'shown_at', condition: '"shown_at" IS NOT NULL' },
  'gift_items.image_url': { column: 'deleted_at', condition: '"deleted_at" IS NOT NULL' },
}

function collectUrlReferences(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const strict = {}
  const historical = {}
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
      .all()
      .map((r) => r.name)

    const selectValues = (table, column, extraWhere) => db
      .prepare(`SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" LIKE '/uploads/%'${extraWhere};`)
      .all()
      .map((r) => r.v)
      .filter(Boolean)

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info('${table}');`).all().map((r) => r.name)
      for (const column of columns) {
        if (!column.endsWith('_url')) continue
        const source = `${table}.${column}`
        const rule = HISTORICAL_URL_ROWS[source]
        if (rule && columns.includes(rule.column)) {
          const strictValues = selectValues(table, column, ` AND NOT (${rule.condition})`)
          if (strictValues.length > 0) strict[source] = strictValues
          // URL, който е и в актуален ред, се проверява само строго.
          const strictSet = new Set(strictValues)
          const historicalValues = selectValues(table, column, ` AND (${rule.condition})`).filter((v) => !strictSet.has(v))
          if (historicalValues.length > 0) historical[source] = historicalValues
          continue
        }
        const values = selectValues(table, column, '')
        if (values.length > 0) strict[source] = values
      }
    }
  } finally {
    db.close()
  }
  return { strict, historical }
}

function collectStorageFilenameReferences(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const out = {}
  try {
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all().map((r) => r.name),
    )
    for (const [table, subdir] of Object.entries(STORAGE_FILENAME_SUBDIRS)) {
      if (!existingTables.has(table)) continue
      const rows = db
        .prepare(`SELECT DISTINCT storage_filename AS v FROM "${table}" WHERE storage_filename IS NOT NULL;`)
        .all()
      const values = rows.map((r) => `uploads/${subdir}/${r.v}`).filter(Boolean)
      if (values.length > 0) out[`${table}.storage_filename`] = values
    }
  } finally {
    db.close()
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.db || (!args.uploadsArchive && !args.uploadsDir) || (args.uploadsArchive && args.uploadsDir)) {
    console.log(JSON.stringify({
      ok: false,
      error: 'Usage: --db <path> (--uploads-archive <path> | --uploads-dir <path>)',
    }))
    process.exit(2)
  }

  let entries
  try {
    entries = args.uploadsArchive ? listTarEntries(args.uploadsArchive) : listDirectoryEntries(args.uploadsDir)
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `failed to list archive/dir: ${error.message}` }))
    process.exit(2)
  }

  let urlRefs
  let historicalUrlRefs
  let filenameRefs
  try {
    ;({ strict: urlRefs, historical: historicalUrlRefs } = collectUrlReferences(args.db))
    filenameRefs = collectStorageFilenameReferences(args.db)
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `sqlite error: ${error.message}` }))
    process.exit(2)
  }

  const missingHard = {}
  let checkedHard = 0
  for (const [source, urls] of Object.entries(urlRefs)) {
    for (const url of urls) {
      checkedHard += 1
      const relativePath = url.replace(/^\/+/, '')
      if (!entries.has(relativePath)) {
        ;(missingHard[source] ??= []).push(url)
      }
    }
  }

  const missingHistorical = {}
  let checkedHistorical = 0
  for (const [source, urls] of Object.entries(historicalUrlRefs)) {
    for (const url of urls) {
      checkedHistorical += 1
      if (!entries.has(url.replace(/^\/+/, ''))) {
        ;(missingHistorical[source] ??= []).push(url)
      }
    }
  }

  const missingSoft = {}
  let checkedSoft = 0
  for (const [source, paths] of Object.entries(filenameRefs)) {
    for (const path of paths) {
      checkedSoft += 1
      if (!entries.has(path)) {
        ;(missingSoft[source] ??= []).push(path)
      }
    }
  }

  const result = {
    ok: Object.keys(missingHard).length === 0,
    checked_url_references: checkedHard,
    missing_url_references: missingHard,
    checked_historical_url_references: checkedHistorical,
    missing_historical_url_references_warning_only: missingHistorical,
    checked_storage_filename_references: checkedSoft,
    missing_storage_filename_references_warning_only: missingSoft,
    archive_entry_count: entries.size,
  }
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main()
