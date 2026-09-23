import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type BundlePackageStatus = 'active' | 'inactive'

export type BundlePackageSnapshot = {
  packageId: string
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  vipDays: number
  priceCents: number
  currency: string
  status: BundlePackageStatus
  sortOrder: number
}

export type BundlePackageInput = {
  packageId?: string | null
  /**
   * ИГНОРИРАНО от upsertPackage() — задържано в типа само за structural
   * съвместимост с CoinPackageInput (frontend подава '' винаги, виж
   * renderLobbyScreen.ts's bundle admin form submit handler). packageKey е
   * ЧИСТО ВЪТРЕШЕН slug (UNIQUE stable business key за ON CONFLICT upsert
   * семантиката), НИКОГА derive-нат от title — title е свободен UTF-8 текст
   * (кирилица/латиница/всякакъв нормален текст), не бива да ограничава или
   * да бъде транслитериран за да "стане" валиден packageKey. Виж
   * generatePackageKey()/upsertPackage() за реалната server-side логика.
   */
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  vipDays: number
  priceCents: number
  currency: string
  status: BundlePackageStatus
  sortOrder: number
}

export type ShopBundlePackageStore = {
  listPublicPackages: () => BundlePackageSnapshot[]
  listAdminPackages: () => BundlePackageSnapshot[]
  getPackageById: (packageId: string) => BundlePackageSnapshot | null
  upsertPackage: (
    input: BundlePackageInput,
  ) => { ok: true; package: BundlePackageSnapshot } | { ok: false; message: string }
  setPackageStatus: (
    packageId: string,
    status: BundlePackageStatus,
  ) => { ok: true; package: BundlePackageSnapshot } | { ok: false; message: string }
  deletePackage: (
    packageId: string,
  ) => { ok: true; packages: BundlePackageSnapshot[] } | { ok: false; message: string }
  close: () => void
}

type BundlePackageRow = {
  package_id: string
  package_key: string
  title: string
  description: string
  yellow_coins_amount: number
  vip_days: number
  price_cents: number
  currency: string
  status: BundlePackageStatus
  sort_order: number
}

function rowToSnapshot(row: BundlePackageRow): BundlePackageSnapshot {
  return {
    packageId: row.package_id,
    packageKey: row.package_key,
    title: row.title,
    description: row.description,
    yellowCoinsAmount: row.yellow_coins_amount,
    vipDays: row.vip_days,
    priceCents: row.price_cents,
    currency: row.currency,
    status: row.status,
    sortOrder: row.sort_order,
  }
}

function normalizeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength)
}

// packageKey е ВТОРИЧНО, ЧИСТО ВЪТРЕШНО slug поле (UNIQUE stable business
// key за ON CONFLICT upsert семантиката, mirror на coin_packages design) —
// НЕ display title. Server-side generated от UUID, НИКОГА derive-нато от
// admin-подаденото заглавие (заглавието е свободен UTF-8 текст — кирилица,
// латиница, всякакъв нормален текст трябва да работи без ASCII-транслитерация
// hack-ове). Виж upsertPackage()'s edit-vs-create клон за защо генерирането
// става само за НОВ пакет — при edit оригиналният packageKey се запазва
// непроменен, независимо колко пъти title се редактира.
function generatePackageKey(): string {
  return `bundle-${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

function normalizeInteger(value: number, min: number, max: number): number | null {
  if (!Number.isInteger(value) || value < min || value > max) {
    return null
  }

  return value
}

function normalizeStatus(value: string): BundlePackageStatus | null {
  if (value === 'active' || value === 'inactive') {
    return value
  }

  return null
}

// Mirror на coinPackageStore.ts — идентичен generic CRUD pattern (§6 "избери
// решението, което най-добре съответства на текущата архитектура"), само
// добавена vip_days колона. Отделна таблица от coin_packages (не разширение
// на нея) — виж migration-a doc коментара за пълния rationale.
export async function createShopBundlePackageStore(
  databaseFilePath: string,
): Promise<ShopBundlePackageStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const SELECT_COLUMNS = `
    package_id,
    package_key,
    title,
    description,
    yellow_coins_amount,
    vip_days,
    price_cents,
    currency,
    status,
    sort_order
  `

  const selectPublicPackagesStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM shop_bundle_packages
    WHERE status = 'active'
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectAdminPackagesStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM shop_bundle_packages
    ORDER BY sort_order ASC, yellow_coins_amount ASC;
  `)

  const selectPackageByIdStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM shop_bundle_packages
    WHERE package_id = ?;
  `)

  const upsertPackageStatement = database.prepare(`
    INSERT INTO shop_bundle_packages (
      package_id,
      package_key,
      title,
      description,
      yellow_coins_amount,
      vip_days,
      price_cents,
      currency,
      status,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(package_key) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      yellow_coins_amount = excluded.yellow_coins_amount,
      vip_days = excluded.vip_days,
      price_cents = excluded.price_cents,
      currency = excluded.currency,
      status = excluded.status,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP;
  `)

  const updateStatusStatement = database.prepare(`
    UPDATE shop_bundle_packages
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE package_id = ?;
  `)

  const deletePackageStatement = database.prepare(`
    DELETE FROM shop_bundle_packages WHERE package_id = ?;
  `)

  function listPublicPackages(): BundlePackageSnapshot[] {
    return (selectPublicPackagesStatement.all() as BundlePackageRow[]).map(rowToSnapshot)
  }

  function listAdminPackages(): BundlePackageSnapshot[] {
    return (selectAdminPackagesStatement.all() as BundlePackageRow[]).map(rowToSnapshot)
  }

  function getPackageById(packageId: string): BundlePackageSnapshot | null {
    const row = selectPackageByIdStatement.get(packageId) as BundlePackageRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function upsertPackage(
    input: BundlePackageInput,
  ): { ok: true; package: BundlePackageSnapshot } | { ok: false; message: string } {
    const requestedPackageId = normalizeText(input.packageId ?? '', 96)
    const existing = requestedPackageId ? getPackageById(requestedPackageId) : null
    const packageId = requestedPackageId || randomUUID()

    // packageKey: edit на съществуващ пакет ЗАПАЗВА оригиналния key
    // непроменен (stable identifier за upsertPackageStatement's
    // ON CONFLICT(package_key), НЕ бива да "мигрира" при всяка редакция на
    // името). Нов пакет получава прясно server-generated key — клиентският
    // input.packageKey тук се игнорира изцяло (§"НЕ трябва да се въвежда от
    // администратора"), елиминира ASCII-derived-from-title bug-а за
    // кирилица/друг UTF-8 текст.
    const packageKey = existing ? existing.packageKey : generatePackageKey()

    const title = normalizeText(input.title, 80)
    const description = normalizeText(input.description, 220)
    const yellowCoinsAmount = normalizeInteger(input.yellowCoinsAmount, 1, 100_000_000)
    const vipDays = normalizeInteger(input.vipDays, 1, 3650)
    const priceCents = normalizeInteger(input.priceCents, 1, 10_000_000)
    const currency = normalizeText(input.currency.toUpperCase(), 3)
    const status = normalizeStatus(input.status)
    const sortOrder = normalizeInteger(input.sortOrder, 0, 1_000_000)

    if (title.length < 2) {
      return { ok: false, message: 'Името на пакета трябва да е поне 2 символа.' }
    }

    if (yellowCoinsAmount === null) {
      return { ok: false, message: 'Жълтиците в пакета трябва да са цяло число между 1 и 100 000 000.' }
    }

    if (vipDays === null) {
      return { ok: false, message: 'VIP дните трябва да са цяло число между 1 и 3650.' }
    }

    if (priceCents === null) {
      return { ok: false, message: 'Цената трябва да е цяло число в центове, по-голямо от 0.' }
    }

    if (!/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, message: 'Валутата трябва да е ISO код от 3 главни букви.' }
    }

    if (status === null) {
      return { ok: false, message: 'Статусът трябва да бъде active или inactive.' }
    }

    if (sortOrder === null) {
      return { ok: false, message: 'Подредбата трябва да е цяло число между 0 и 1 000 000.' }
    }

    upsertPackageStatement.run(
      packageId,
      packageKey,
      title,
      description,
      yellowCoinsAmount,
      vipDays,
      priceCents,
      currency,
      status,
      sortOrder,
    )

    const savedPackage =
      listAdminPackages().find((bundlePackage) => bundlePackage.packageKey === packageKey) ??
      getPackageById(packageId)

    if (savedPackage === null) {
      return { ok: false, message: 'Пакетът не беше записан.' }
    }

    return { ok: true, package: savedPackage }
  }

  function setPackageStatus(
    packageId: string,
    status: BundlePackageStatus,
  ): { ok: true; package: BundlePackageSnapshot } | { ok: false; message: string } {
    const normalizedPackageId = normalizeText(packageId, 96)
    const normalizedStatus = normalizeStatus(status)

    if (normalizedPackageId.length === 0 || normalizedStatus === null) {
      return { ok: false, message: 'Невалиден пакет или статус.' }
    }

    updateStatusStatement.run(normalizedStatus, normalizedPackageId)

    const updatedPackage = getPackageById(normalizedPackageId)

    if (updatedPackage === null) {
      return { ok: false, message: 'Пакетът не беше намерен.' }
    }

    return { ok: true, package: updatedPackage }
  }

  function deletePackage(
    packageId: string,
  ): { ok: true; packages: BundlePackageSnapshot[] } | { ok: false; message: string } {
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
    listAdminPackages,
    getPackageById,
    upsertPackage,
    setPackageStatus,
    deletePackage,
    close,
  }
}
