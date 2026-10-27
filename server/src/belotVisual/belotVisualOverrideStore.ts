// "Визия на Белот" (Admin → основен панел) — ръчна приоритетна визия на
// Белот масата. Пази се в admin_settings (key/value, без нова схема):
// превключвателят и URL-ите на трите изображения са отделни ключове, така че
// изключването НЕ трие изображенията и повторното включване ги връща.
// Четенето е директно от базата при всяко извикване (без кеш) — единственият
// източник на истината, mirror на getCurrentActiveCampaignThemeOrNull().

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type BelotVisualAssetKind = 'table_bg_desktop' | 'table_bg_mobile' | 'card_back'

export const BELOT_VISUAL_ASSET_KINDS: readonly BelotVisualAssetKind[] = ['table_bg_desktop', 'table_bg_mobile', 'card_back']

export type BelotVisualOverrideSnapshot = {
  enabled: boolean
  tableBgDesktopUrl: string | null
  tableBgMobileUrl: string | null
  cardBackUrl: string | null
}

export type BelotVisualOverrideStore = {
  getSnapshot: () => BelotVisualOverrideSnapshot
  setEnabled: (enabled: boolean) => BelotVisualOverrideSnapshot
  /** Връща предишния URL (за изтриване на заменения/премахнатия файл). */
  setAssetUrl: (kind: BelotVisualAssetKind, url: string | null) => { previousUrl: string | null; snapshot: BelotVisualOverrideSnapshot }
  close: () => void
}

const ENABLED_KEY = 'belot_visual_override_enabled'

const ASSET_URL_KEYS: Record<BelotVisualAssetKind, string> = {
  table_bg_desktop: 'belot_visual_table_bg_desktop_url',
  table_bg_mobile: 'belot_visual_table_bg_mobile_url',
  card_back: 'belot_visual_card_back_url',
}

export function isBelotVisualAssetKind(value: unknown): value is BelotVisualAssetKind {
  return typeof value === 'string' && (BELOT_VISUAL_ASSET_KINDS as readonly string[]).includes(value)
}

export async function createBelotVisualOverrideStore(databaseFilePath: string): Promise<BelotVisualOverrideStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true })
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectStatement = database.prepare(`
    SELECT setting_key, setting_value
    FROM admin_settings
    WHERE setting_key IN (?, ?, ?, ?);
  `)

  const upsertStatement = database.prepare(`
    INSERT INTO admin_settings (setting_key, setting_value)
    VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP;
  `)

  // setting_value е NOT NULL — липсващо изображение = липсващ ред.
  const deleteStatement = database.prepare('DELETE FROM admin_settings WHERE setting_key = ?;')

  function getSnapshot(): BelotVisualOverrideSnapshot {
    const rows = selectStatement.all(
      ENABLED_KEY,
      ASSET_URL_KEYS.table_bg_desktop,
      ASSET_URL_KEYS.table_bg_mobile,
      ASSET_URL_KEYS.card_back,
    ) as Array<{ setting_key: string; setting_value: string }>
    const values = new Map(rows.map((row) => [row.setting_key, row.setting_value]))
    const urlOrNull = (kind: BelotVisualAssetKind): string | null => {
      const value = values.get(ASSET_URL_KEYS[kind])?.trim() ?? ''
      return value.length > 0 ? value : null
    }
    return {
      // Изключено по подразбиране (липсващ ред).
      enabled: values.get(ENABLED_KEY) === '1',
      tableBgDesktopUrl: urlOrNull('table_bg_desktop'),
      tableBgMobileUrl: urlOrNull('table_bg_mobile'),
      cardBackUrl: urlOrNull('card_back'),
    }
  }

  function setEnabled(enabled: boolean): BelotVisualOverrideSnapshot {
    upsertStatement.run(ENABLED_KEY, enabled ? '1' : '0')
    return getSnapshot()
  }

  function setAssetUrl(kind: BelotVisualAssetKind, url: string | null): { previousUrl: string | null; snapshot: BelotVisualOverrideSnapshot } {
    const before = getSnapshot()
    const previousUrl = kind === 'table_bg_desktop'
      ? before.tableBgDesktopUrl
      : kind === 'table_bg_mobile' ? before.tableBgMobileUrl : before.cardBackUrl
    if (url === null) {
      deleteStatement.run(ASSET_URL_KEYS[kind])
    } else {
      upsertStatement.run(ASSET_URL_KEYS[kind], url)
    }
    return { previousUrl, snapshot: getSnapshot() }
  }

  return {
    getSnapshot,
    setEnabled,
    setAssetUrl,
    close: () => database.close(),
  }
}
