#!/usr/bin/env node
// Pika.bg — T2: срок от 7 дни за автоматичните snapshot-и преди миграции,
// създадени от scripts/deploy-backend-production.sh в
//   /var/www/belot-v2/server/database/backups/backend-deploy-migration/<ID>/
// където <ID> = <UTC YYYYMMDDHHMMSS>-<git short sha>, а директорията съдържа
// точно `belot-v2.sqlite` и `belot-v2.sqlite.sha256`.
//
// ПРАВИЛА (консервативни):
//   * По подразбиране DRY-RUN — нищо не се изтрива. Изтриване само с --apply.
//   * Обработват се САМО преки поддиректории на корена с името на deploy
//     скрипта и с точно двата очаквани файла. Всичко друго (ръчни архиви,
//     други имена, допълнителни файлове, symlink-ове, недовършени snapshot-и)
//     се ПРОПУСКА и само се отчита.
//   * Възрастта е по времето в ИМЕТО (UTC), не по mtime. Име в бъдещето ->
//     пропуска се.
//   * Последните ДВЕ УСПЕШНИ копия (и двата файла, валиден SHA256 ред,
//     непразна база) са ЗАЩИТЕНИ независимо от възрастта. Недовършените и
//     пропуснатите не се броят за успешни.
//   * Срокът не може да е под 7 дни (MIN_RETENTION_DAYS).
//   * Изтриване: двата известни файла поотделно + rmdir (НЕ рекурсивно) —
//     ако междувременно се появи друг файл, rmdir отказва и нищо друго не се
//     губи.
//   * Ежечасните backup-и (ops/pikabg-backup) са в други директории и не се
//     докосват — скриптът работи само в посочения корен.
//
//   node prune-deploy-migration-backups.mjs [--root <dir>] [--retention-days 7] [--apply] [--json]
//
// Изход: 0 — успех (вкл. dry-run); 1 — грешка при изтриване; 2 — грешни аргументи / корен.

import { lstat, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_ROOT = '/var/www/belot-v2/server/database/backups/backend-deploy-migration'
export const DEFAULT_RETENTION_DAYS = 7
export const MIN_RETENTION_DAYS = 7
/** Колко от най-новите успешни копия са защитени независимо от възрастта. */
export const PROTECTED_LATEST_COUNT = 2
export const DB_FILE = 'belot-v2.sqlite'
export const SHA_FILE = 'belot-v2.sqlite.sha256'
const ID_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-([0-9a-f]{4,40})$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Времето от името (UTC) или null при невалидна дата. */
export function parseBackupId(name) {
  const match = ID_PATTERN.exec(name)
  if (match === null) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const date = new Date(ms)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getUTCHours() !== h || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== s) return null
  return ms
}

/**
 * Класифицира съдържанието на корена (само четене).
 * kind: 'automatic' (успешно копие на deploy скрипта) | 'incomplete' | 'skipped'
 */
export async function scanBackups(root, nowMs) {
  const entries = await readdir(root, { withFileTypes: false })
  const items = []
  for (const name of entries.sort()) {
    const path = join(root, name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) { items.push({ name, kind: 'skipped', reason: 'symlink' }); continue }
    if (!info.isDirectory()) { items.push({ name, kind: 'skipped', reason: 'not_a_directory' }); continue }
    const createdMs = parseBackupId(name)
    if (createdMs === null) { items.push({ name, kind: 'skipped', reason: 'not_a_deploy_backup_name' }); continue }
    if (createdMs > nowMs + 60_000) { items.push({ name, kind: 'skipped', reason: 'timestamp_in_future', createdMs }); continue }
    const files = (await readdir(path)).sort()
    const expected = [DB_FILE, SHA_FILE].sort()
    const ageDays = (nowMs - createdMs) / DAY_MS
    const extra = files.filter((file) => !expected.includes(file))
    if (extra.length > 0) { items.push({ name, kind: 'skipped', reason: 'unexpected_files', extra, createdMs, ageDays }); continue }
    if (files.length !== expected.length) { items.push({ name, kind: 'incomplete', reason: 'missing_files', createdMs, ageDays }); continue }
    const dbInfo = await lstat(join(path, DB_FILE))
    const shaInfo = await lstat(join(path, SHA_FILE))
    if (!dbInfo.isFile() || !shaInfo.isFile()) { items.push({ name, kind: 'skipped', reason: 'not_regular_files', createdMs, ageDays }); continue }
    const sha = (await readFile(join(path, SHA_FILE), 'utf8')).trim()
    const shaValid = new RegExp(`^[0-9a-f]{64}  ${DB_FILE.replace('.', '\\.')}$`).test(sha)
    if (!shaValid || dbInfo.size === 0) { items.push({ name, kind: 'incomplete', reason: shaValid ? 'empty_database' : 'invalid_checksum_file', createdMs, ageDays }); continue }
    items.push({ name, kind: 'automatic', createdMs, ageDays, sizeBytes: dbInfo.size })
  }
  return items
}

/** Решение какво се изтрива (чиста функция). */
export function planPrune(items, retentionDays) {
  const successful = items
    .filter((item) => item.kind === 'automatic')
    .sort((a, b) => b.createdMs - a.createdMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  const protectedNames = successful.slice(0, PROTECTED_LATEST_COUNT).map((item) => item.name)
  const plan = items.map((item) => {
    if (item.kind !== 'automatic') return { ...item, action: 'keep', why: item.kind === 'incomplete' ? `incomplete:${item.reason}` : `skipped:${item.reason}` }
    if (protectedNames.includes(item.name)) return { ...item, action: 'keep', why: `latest_${PROTECTED_LATEST_COUNT}_successful` }
    if (item.ageDays > retentionDays) return { ...item, action: 'delete', why: `older_than_${retentionDays}_days` }
    return { ...item, action: 'keep', why: 'within_retention' }
  })
  return { protectedNames, plan }
}

async function deleteBackup(root, name) {
  const path = join(root, name)
  // Повторна проверка непосредствено преди изтриване (TOCTOU).
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${name}: вече не е обикновена директория`)
  const files = (await readdir(path)).sort()
  if (files.join('|') !== [DB_FILE, SHA_FILE].sort().join('|')) throw new Error(`${name}: съдържанието се е променило`)
  await unlink(join(path, SHA_FILE))
  await unlink(join(path, DB_FILE))
  await rmdir(path)
}

export async function run({ root = DEFAULT_ROOT, retentionDays = DEFAULT_RETENTION_DAYS, apply = false, nowMs = Date.now(), log = console.log } = {}) {
  const absoluteRoot = resolve(root)
  const rootInfo = await lstat(absoluteRoot).catch(() => null)
  if (!Number.isInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw Object.assign(new Error(`retentionDays трябва да е цяло число >= ${MIN_RETENTION_DAYS}`), { exitCode: 2 })
  }
  if (rootInfo === null) return { exitCode: 0, mode: apply ? 'apply' : 'dry-run', root: absoluteRoot, note: 'root_missing', protectedNames: [], plan: [], deleted: [], wouldDelete: [], errors: [] }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw Object.assign(new Error(`коренът не е обикновена директория: ${absoluteRoot}`), { exitCode: 2 })
  const items = await scanBackups(absoluteRoot, nowMs)
  const { protectedNames, plan } = planPrune(items, retentionDays)
  const deleted = []
  const errors = []
  for (const item of plan) {
    const age = item.ageDays === undefined ? '' : ` age=${item.ageDays.toFixed(1)}d`
    log(`${item.action === 'delete' ? (apply ? 'DELETE' : 'WOULD-DELETE') : 'KEEP'}  ${item.name}${age}  (${item.why})`)
    if (item.action !== 'delete' || !apply) continue
    try {
      await deleteBackup(absoluteRoot, item.name)
      deleted.push(item.name)
    } catch (error) {
      errors.push({ name: item.name, error: error instanceof Error ? error.message : String(error) })
      log(`ERROR  ${item.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const wouldDelete = plan.filter((item) => item.action === 'delete').map((item) => item.name)
  log(`mode=${apply ? 'apply' : 'dry-run'} root=${absoluteRoot} retentionDays=${retentionDays} protected=${protectedNames.length > 0 ? protectedNames.join(',') : '(none)'} ` +
    `${apply ? `deleted=${deleted.length}` : `wouldDelete=${wouldDelete.length}`} kept=${plan.length - wouldDelete.length} errors=${errors.length}`)
  return { exitCode: errors.length > 0 ? 1 : 0, mode: apply ? 'apply' : 'dry-run', root: absoluteRoot, protectedNames, plan, deleted, wouldDelete, errors }
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, retentionDays: DEFAULT_RETENTION_DAYS, apply: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (arg === '--root') options.root = argv[++index]
    else if (arg === '--retention-days') options.retentionDays = Number(argv[++index])
    else throw Object.assign(new Error(`непознат аргумент: ${arg}`), { exitCode: 2 })
  }
  if (typeof options.root !== 'string' || options.root === '') throw Object.assign(new Error('--root изисква път'), { exitCode: 2 })
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < MIN_RETENTION_DAYS) {
    throw Object.assign(new Error(`--retention-days трябва да е цяло число >= ${MIN_RETENTION_DAYS}`), { exitCode: 2 })
  }
  return options
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await run({ ...options, log: options.json ? () => {} : console.log })
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(`prune-deploy-migration-backups: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = typeof error?.exitCode === 'number' ? error.exitCode : 1
  }
}
