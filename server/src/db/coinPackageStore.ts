import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CoinPackageStatus = 'active' | 'inactive'

export type CoinPackageSnapshot = {
  packageId: string
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  status: CoinPackageStatus
  sortOrder: number
  showInLobby: boolean
  isTopOffer: boolean
}

export type CoinPackageInput = {
  packageId?: string | null
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  status: CoinPackageStatus
  sortOrder: number
  showInLobby: boolean
  isTopOffer: boolean
}

export type CoinPackageStore = {
  listPublicPackages: () => CoinPackageSnapshot[]
  listLobbyPackages: () => CoinPackageSnapshot[]
  listAdminPackages: () => CoinPackageSnapshot[]
  upsertPackage: (
    input: CoinPackageInput,
  ) => { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string }
  setPackageStatus: (
    packageId: string,
    status: CoinPackageStatus,
  ) => { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string }
  setPackageLobbyVisibility: (
    packageId: string,
    showInLobby: boolean,
  ) => { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string }
  setPackageTopOffer: (
    packageId: string,
    isTopOffer: boolean,
  ) => { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string }
  deletePackage: (
    packageId: string,
  ) => { ok: true; packages: CoinPackageSnapshot[] } | { ok: false; message: string }
  close: () => void
}

type CoinPackageRow = {
  package_id: string
  package_key: string
  title: string
  description: string
  yellow_coins_amount: number
  price_cents: number
  currency: string
  status: CoinPackageStatus
  sort_order: number
  show_in_lobby: number
  is_top_offer: number
}

function rowToSnapshot(row: CoinPackageRow): CoinPackageSnapshot {
  return {
    packageId: row.package_id,
    packageKey: row.package_key,
    title: row.title,
    description: row.description,
    yellowCoinsAmount: row.yellow_coins_amount,
    priceCents: row.price_cents,
    currency: row.currency,
    status: row.status,
    sortOrder: row.sort_order,
    showInLobby: row.show_in_lobby !== 0,
    isTopOffer: row.is_top_offer !== 0,
  }
}

function normalizeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength)
}

function normalizePackageKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function normalizeInteger(value: number, min: number, max: number): number | null {
  if (!Number.isInteger(value) || value < min || value > max) {
    return null
  }

  return value
}

function normalizeStatus(value: string): CoinPackageStatus | null {
  if (value === 'active' || value === 'inactive') {
    return value
  }

  return null
}

export async function createCoinPackageStore(
  databaseFilePath: string,
): Promise<CoinPackageStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectPublicPackagesStatement = database.prepare(`
    SELECT
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      price_cents,
      currency,
      status,
      sort_order,
      show_in_lobby,
      is_top_offer
    FROM coin_packages
    WHERE status = 'active'
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectLobbyPackagesStatement = database.prepare(`
    SELECT
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      price_cents,
      currency,
      status,
      sort_order,
      show_in_lobby,
      is_top_offer
    FROM coin_packages
    WHERE status = 'active' AND show_in_lobby = 1
    ORDER BY yellow_coins_amount ASC;
  `)

  const selectAdminPackagesStatement = database.prepare(`
    SELECT
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      price_cents,
      currency,
      status,
      sort_order,
      show_in_lobby,
      is_top_offer
    FROM coin_packages
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectPackageByIdStatement = database.prepare(`
    SELECT
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      price_cents,
      currency,
      status,
      sort_order,
      show_in_lobby,
      is_top_offer
    FROM coin_packages
    WHERE package_id = ?;
  `)

  const upsertPackageStatement = database.prepare(`
    INSERT INTO coin_packages (
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      price_cents,
      currency,
      status,
      sort_order,
      show_in_lobby,
      is_top_offer
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
    ON CONFLICT(package_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      yellow_coins_amount = excluded.yellow_coins_amount,
      price_cents = excluded.price_cents,
      currency = excluded.currency,
      status = excluded.status,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP;
  `)

  const updateStatusStatement = database.prepare(`
    UPDATE coin_packages
    SET
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE package_id = ?;
  `)

  const updateLobbyVisibilityStatement = database.prepare(`
    UPDATE coin_packages
    SET
      show_in_lobby = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE package_id = ?;
  `)

  const updateTopOfferStatement = database.prepare(`
    UPDATE coin_packages
    SET
      is_top_offer = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE package_id = ?;
  `)

  const deletePackageStatement = database.prepare(`
    DELETE FROM coin_packages WHERE package_id = ?;
  `)

  function listPublicPackages(): CoinPackageSnapshot[] {
    return (selectPublicPackagesStatement.all() as CoinPackageRow[]).map(rowToSnapshot)
  }

  function listLobbyPackages(): CoinPackageSnapshot[] {
    return (selectLobbyPackagesStatement.all() as CoinPackageRow[]).map(rowToSnapshot)
  }

  function listAdminPackages(): CoinPackageSnapshot[] {
    return (selectAdminPackagesStatement.all() as CoinPackageRow[]).map(rowToSnapshot)
  }

  function getPackageById(packageId: string): CoinPackageSnapshot | null {
    const row = selectPackageByIdStatement.get(packageId) as CoinPackageRow | undefined

    return row ? rowToSnapshot(row) : null
  }

  function upsertPackage(
    input: CoinPackageInput,
  ): { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string } {
    const packageId = normalizeText(input.packageId ?? '', 96) || randomUUID()
    const packageKey = normalizePackageKey(input.packageKey)
    const title = normalizeText(input.title, 80)
    const description = normalizeText(input.description, 220)
    const yellowCoinsAmount = normalizeInteger(input.yellowCoinsAmount, 1, 100_000_000)
    const priceCents = normalizeInteger(input.priceCents, 0, 10_000_000)
    const currency = normalizeText(input.currency.toUpperCase(), 3)
    const status = normalizeStatus(input.status)
    const sortOrder = normalizeInteger(input.sortOrder, 0, 1_000_000)

    if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(packageKey)) {
      return {
        ok: false,
        message: 'Ключът на пакета трябва да съдържа само латински букви, цифри, тире или долна черта.',
      }
    }

    if (title.length < 2) {
      return {
        ok: false,
        message: 'Името на пакета трябва да е поне 2 символа.',
      }
    }

    if (yellowCoinsAmount === null) {
      return {
        ok: false,
        message: 'Жълтиците в пакета трябва да са цяло число между 1 и 100 000 000.',
      }
    }

    if (priceCents === null) {
      return {
        ok: false,
        message: 'Цената трябва да е цяло число в центове.',
      }
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      return {
        ok: false,
        message: 'Валутата трябва да е ISO код от 3 главни букви.',
      }
    }

    if (status === null) {
      return {
        ok: false,
        message: 'Статусът трябва да бъде active или inactive.',
      }
    }

    if (sortOrder === null) {
      return {
        ok: false,
        message: 'Подредбата трябва да е цяло число между 0 и 1 000 000.',
      }
    }

    upsertPackageStatement.run(
      packageId,
      packageKey,
      title,
      description,
      yellowCoinsAmount,
      priceCents,
      currency,
      status,
      sortOrder,
      input.showInLobby ? 1 : 0,
      input.isTopOffer ? 1 : 0,
    )

    const savedPackage =
      listAdminPackages().find((coinPackage) => coinPackage.packageKey === packageKey) ??
      getPackageById(packageId)

    if (savedPackage === null) {
      return {
        ok: false,
        message: 'Пакетът не беше записан.',
      }
    }

    return {
      ok: true,
      package: savedPackage,
    }
  }

  function setPackageStatus(
    packageId: string,
    status: CoinPackageStatus,
  ): { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string } {
    const normalizedPackageId = normalizeText(packageId, 96)
    const normalizedStatus = normalizeStatus(status)

    if (normalizedPackageId.length === 0 || normalizedStatus === null) {
      return {
        ok: false,
        message: 'Невалиден пакет или статус.',
      }
    }

    updateStatusStatement.run(normalizedStatus, normalizedPackageId)

    const updatedPackage = getPackageById(normalizedPackageId)

    if (updatedPackage === null) {
      return {
        ok: false,
        message: 'Пакетът не беше намерен.',
      }
    }

    return {
      ok: true,
      package: updatedPackage,
    }
  }

  function setPackageLobbyVisibility(
    packageId: string,
    showInLobby: boolean,
  ): { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string } {
    const normalizedPackageId = normalizeText(packageId, 96)

    if (normalizedPackageId.length === 0) {
      return { ok: false, message: 'Невалиден ID на пакет.' }
    }

    updateLobbyVisibilityStatement.run(showInLobby ? 1 : 0, normalizedPackageId)

    const updatedPackage = getPackageById(normalizedPackageId)

    if (updatedPackage === null) {
      return { ok: false, message: 'Пакетът не беше намерен.' }
    }

    return { ok: true, package: updatedPackage }
  }

  function setPackageTopOffer(
    packageId: string,
    isTopOffer: boolean,
  ): { ok: true; package: CoinPackageSnapshot } | { ok: false; message: string } {
    const normalizedPackageId = normalizeText(packageId, 96)

    if (normalizedPackageId.length === 0) {
      return { ok: false, message: 'Невалиден ID на пакет.' }
    }

    updateTopOfferStatement.run(isTopOffer ? 1 : 0, normalizedPackageId)

    const updatedPackage = getPackageById(normalizedPackageId)

    if (updatedPackage === null) {
      return { ok: false, message: 'Пакетът не беше намерен.' }
    }

    return { ok: true, package: updatedPackage }
  }

  function deletePackage(
    packageId: string,
  ): { ok: true; packages: CoinPackageSnapshot[] } | { ok: false; message: string } {
    const normalizedPackageId = normalizeText(packageId, 96)

    if (normalizedPackageId.length === 0) {
      return { ok: false, message: 'Невалиден ID на пакет.' }
    }

    const existing = getPackageById(normalizedPackageId)

    if (existing === null) {
      return { ok: false, message: 'Пакетът не беше намерен.' }
    }

    deletePackageStatement.run(normalizedPackageId)

    return { ok: true, packages: listAdminPackages() }
  }

  function close(): void {
    database.close()
  }

  return {
    listPublicPackages,
    listLobbyPackages,
    listAdminPackages,
    upsertPackage,
    setPackageStatus,
    setPackageLobbyVisibility,
    setPackageTopOffer,
    deletePackage,
    close,
  }
}
