/**
 * checkCoinPackagesTopOffer.ts — Проверки за "Топ оферта" на пакети жълтици.
 *
 * [0] нов пакет по подразбиране isTopOffer:false (дори без да е подадено изрично в SQL нивото)
 * [1] upsertPackage с isTopOffer:true създава пакет с isTopOffer:true
 * [2] setPackageTopOffer(id, true) маркира пакет, getPackageById/listAdminPackages го връщат
 * [3] setPackageTopOffer(id, false) премахва маркировката
 * [4] могат едновременно да съществуват няколко пакета с isTopOffer:true
 * [5] listPublicPackages връща isTopOffer коректно за активни пакети
 * [6] listLobbyPackages връща isTopOffer независимо от лоби филтъра (двете настройки са независими)
 * [7] listAdminPackages връща isTopOffer за всички пакети, включително inactive
 * [8] обикновена редакция (upsertPackage през ON CONFLICT със същия package_key) НЕ променя isTopOffer,
 *     дори ако входът подава различна стойност — текущата стойност се запазва
 * [9] стар ред, създаден преди миграцията (без is_top_offer колона), след прилагане на
 *     реалния миграционен SQL файл получава is_top_offer = 0 по подразбиране
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCoinPackageStore, type CoinPackageInput } from '../src/db/coinPackageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function seedDb(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

// ── Пълна текуща схема (с is_top_offer) — за повечето проверки ────────────────

const CURRENT_SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE coin_packages (
    package_id TEXT PRIMARY KEY,
    package_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'EUR',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    show_in_lobby INTEGER NOT NULL DEFAULT 0,
    is_top_offer INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`

function baseInput(overrides: Partial<CoinPackageInput> = {}): CoinPackageInput {
  return {
    packageKey: 'starter',
    title: 'Starter',
    description: 'Тестов пакет',
    yellowCoinsAmount: 1000,
    priceCents: 199,
    currency: 'EUR',
    status: 'active',
    sortOrder: 1,
    showInLobby: false,
    isTopOffer: false,
    ...overrides,
  }
}

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-coin-packages-top-offer-'))

  try {
    await check('[0] нов пакет без isTopOffer в упсърта → isTopOffer:false по подразбиране', async () => {
      const dbPath = join(tmpDir, 'test0.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const result = store.upsertPackage(baseInput({ packageKey: 'pkg0' }))
        assert(result.ok, 'upsert трябва да успее')
        if (!result.ok) return
        assert(result.package.isTopOffer === false, 'isTopOffer трябва да е false по подразбиране')
      } finally {
        store.close()
      }
    })

    await check('[1] upsertPackage с isTopOffer:true създава маркиран пакет', async () => {
      const dbPath = join(tmpDir, 'test1.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const result = store.upsertPackage(baseInput({ packageKey: 'pkg1', isTopOffer: true }))
        assert(result.ok, 'upsert трябва да успее')
        if (!result.ok) return
        assert(result.package.isTopOffer === true, 'isTopOffer трябва да е true')
      } finally {
        store.close()
      }
    })

    await check('[2] setPackageTopOffer(id, true) маркира съществуващ пакет', async () => {
      const dbPath = join(tmpDir, 'test2.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const created = store.upsertPackage(baseInput({ packageKey: 'pkg2' }))
        assert(created.ok, 'upsert трябва да успее')
        if (!created.ok) return
        const result = store.setPackageTopOffer(created.package.packageId, true)
        assert(result.ok, 'setPackageTopOffer трябва да успее')
        if (!result.ok) return
        assert(result.package.isTopOffer === true, 'isTopOffer трябва да стане true')

        const admin = store.listAdminPackages().find((p) => p.packageId === created.package.packageId)
        assert(admin !== undefined && admin.isTopOffer === true, 'listAdminPackages трябва да отразява true')
      } finally {
        store.close()
      }
    })

    await check('[3] setPackageTopOffer(id, false) премахва маркировката', async () => {
      const dbPath = join(tmpDir, 'test3.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const created = store.upsertPackage(baseInput({ packageKey: 'pkg3', isTopOffer: true }))
        assert(created.ok, 'upsert трябва да успее')
        if (!created.ok) return
        assert(created.package.isTopOffer === true, 'началната стойност трябва да е true')

        const result = store.setPackageTopOffer(created.package.packageId, false)
        assert(result.ok, 'setPackageTopOffer трябва да успее')
        if (!result.ok) return
        assert(result.package.isTopOffer === false, 'isTopOffer трябва да стане false')
      } finally {
        store.close()
      }
    })

    await check('[4] няколко пакета могат едновременно да са isTopOffer:true', async () => {
      const dbPath = join(tmpDir, 'test4.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const a = store.upsertPackage(baseInput({ packageKey: 'pkg4a', isTopOffer: true }))
        const b = store.upsertPackage(baseInput({ packageKey: 'pkg4b', isTopOffer: true }))
        const c = store.upsertPackage(baseInput({ packageKey: 'pkg4c', isTopOffer: false }))
        assert(a.ok && b.ok && c.ok, 'всички upsert-и трябва да успеят')
        if (!a.ok || !b.ok || !c.ok) return

        const admin = store.listAdminPackages()
        const flaggedCount = admin.filter((p) => p.isTopOffer).length
        assert(flaggedCount === 2, `очаквани 2 маркирани пакета, получени ${flaggedCount}`)
      } finally {
        store.close()
      }
    })

    await check('[5] listPublicPackages връща isTopOffer коректно', async () => {
      const dbPath = join(tmpDir, 'test5.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        store.upsertPackage(baseInput({ packageKey: 'pkg5', isTopOffer: true, status: 'active' }))
        const publicPackages = store.listPublicPackages()
        const pkg = publicPackages.find((p) => p.packageKey === 'pkg5')
        assert(pkg !== undefined && pkg.isTopOffer === true, 'публичният списък трябва да върне isTopOffer:true')
      } finally {
        store.close()
      }
    })

    await check('[6] listLobbyPackages връща isTopOffer независимо от лоби филтъра', async () => {
      const dbPath = join(tmpDir, 'test6.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        store.upsertPackage(baseInput({ packageKey: 'pkg6', isTopOffer: true, showInLobby: true, status: 'active' }))
        const lobbyPackages = store.listLobbyPackages()
        const pkg = lobbyPackages.find((p) => p.packageKey === 'pkg6')
        assert(pkg !== undefined && pkg.isTopOffer === true, 'лоби списъкът трябва да върне isTopOffer:true')
      } finally {
        store.close()
      }
    })

    await check('[7] listAdminPackages връща isTopOffer за inactive пакети', async () => {
      const dbPath = join(tmpDir, 'test7.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        store.upsertPackage(baseInput({ packageKey: 'pkg7', isTopOffer: true, status: 'inactive' }))
        const admin = store.listAdminPackages()
        const pkg = admin.find((p) => p.packageKey === 'pkg7')
        assert(pkg !== undefined && pkg.isTopOffer === true, 'admin списъкът трябва да върне isTopOffer:true дори за inactive')

        const publicPackages = store.listPublicPackages()
        assert(
          publicPackages.find((p) => p.packageKey === 'pkg7') === undefined,
          'публичният списък не трябва да включва inactive пакета (без промяна на филтрирането)',
        )
      } finally {
        store.close()
      }
    })

    await check('[8] обикновена редакция запазва текущата isTopOffer стойност', async () => {
      const dbPath = join(tmpDir, 'test8.db')
      seedDb(dbPath, CURRENT_SCHEMA_SQL)
      const store = await createCoinPackageStore(dbPath)
      try {
        const created = store.upsertPackage(baseInput({ packageKey: 'pkg8', isTopOffer: true }))
        assert(created.ok, 'upsert трябва да успее')
        if (!created.ok) return
        assert(created.package.isTopOffer === true, 'началната стойност трябва да е true')

        // Симулира редакция на цената през формата (същия package_key), с isTopOffer:false в подадения вход
        const edited = store.upsertPackage(
          baseInput({ packageKey: 'pkg8', priceCents: 299, isTopOffer: false }),
        )
        assert(edited.ok, 'редакцията трябва да успее')
        if (!edited.ok) return
        assert(edited.package.priceCents === 299, 'цената трябва да се обнови')
        assert(
          edited.package.isTopOffer === true,
          'isTopOffer трябва да остане true въпреки различната стойност във формата',
        )
      } finally {
        store.close()
      }
    })

    await check('[9] стар ред без is_top_offer колона → 0 по подразбиране след миграция', async () => {
      const dbPath = join(tmpDir, 'test9.db')

      // Схема ПРЕДИ миграцията (без is_top_offer, но с показ на лоби, съответства на реалната преди-миграция схема)
      seedDb(dbPath, `
        PRAGMA foreign_keys = ON;
        CREATE TABLE coin_packages (
          package_id TEXT PRIMARY KEY,
          package_key TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
          price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
          currency TEXT NOT NULL DEFAULT 'EUR',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          show_in_lobby INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status, sort_order)
          VALUES ('old-pkg-1', 'old-pkg', 'Стар пакет', 5000, 399, 'EUR', 'active', 1);
      `)

      // Прилага РЕАЛНИЯ миграционен файл (не копие на текста)
      const migrationPath = join(
        serverRoot,
        'database',
        'migrations',
        '20260727_001_add_top_offer_to_coin_packages.sql',
      )
      const migrationSql = (await readFile(migrationPath, 'utf8')).trim()
      assert(migrationSql.length > 0, 'миграционният файл трябва да съществува и да не е празен')

      const db = new DatabaseSync(dbPath, { open: true })
      try {
        db.exec(migrationSql)
      } finally {
        db.close()
      }

      const store = await createCoinPackageStore(dbPath)
      try {
        const admin = store.listAdminPackages()
        const oldPkg = admin.find((p) => p.packageId === 'old-pkg-1')
        assert(oldPkg !== undefined, 'старият ред трябва да продължи да съществува')
        assert(oldPkg!.isTopOffer === false, 'старият ред трябва да получи isTopOffer:false по подразбиране')
      } finally {
        store.close()
      }
    })

    console.log(`\n${passed} passed, ${failed} failed`)

    if (failed > 0) {
      process.exitCode = 1
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

void main()
