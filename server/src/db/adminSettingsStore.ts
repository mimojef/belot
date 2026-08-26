type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AdminSettingsSnapshot = {
  signupBonusYellowCoins: number
  profileNameChangePrice: number
  vipPrice30DaysCents: number
  vipPrice180DaysCents: number
  vipPrice365DaysCents: number
  /**
   * Дневен лимит (календарен ден, Europe/Sofia) за подаряване на жълтици от
   * профили с роля pika_team — прилага се ОТДЕЛНО за всеки такъв профил
   * (виж yellowCoinGiftStore.ts). 0 = подаряването е забранено за pika_team
   * (НЕ "unlimited"). Различен, независим механизъм от единствения-sender
   * rolling-24h DAILY_GIFT_LIMIT константа в yellowCoinGiftStore.ts.
   */
  pikaTeamDailyGiftLimit: number
}

export type AdminSettingsStore = {
  getSettings: () => AdminSettingsSnapshot
  updateSettings: (
    input: Partial<AdminSettingsSnapshot>,
  ) => { ok: true; settings: AdminSettingsSnapshot } | { ok: false; message: string }
  /**
   * Persistent cutoff за "Публикации от Pika.bg" — seq на последното
   * съобщение от СТАРИЯ общ Live Chat в момента на cutover-а (seed-нато
   * ЕДНАГА от migration 20260817_001, никога не се преизчислява при
   * restart). Съобщения с seq <= тази стойност НЕ се показват в новата
   * секция (виж lobbyChatStore.listRecentMessages/pollNewMessages
   * извикванията в index.ts). Не е admin-editable — само read.
   */
  getLobbyChatPikaAnnouncementCutoffSeq: () => number
  close: () => void
}

type SettingRow = {
  setting_key: string
  setting_value: string
}

const DEFAULT_SETTINGS: AdminSettingsSnapshot = {
  signupBonusYellowCoins: 100_000,
  profileNameChangePrice: 50_000,
  // Само fallback за база без seed-натата migration (20260818_006) — реалната
  // production стойност идва от admin_settings реда, seed-нат веднъж.
  vipPrice30DaysCents: 789,
  vipPrice180DaysCents: 3_989,
  vipPrice365DaysCents: 6_989,
  // Само fallback за база без seed-натата migration (20260825_001) — реалната
  // production стойност идва от admin_settings реда, seed-нат веднъж. Трябва
  // да остане РАВЕН на migration seed-натата стойност (200 000, умишлено
  // равна на legacy sender rolling-24h DAILY_GIFT_LIMIT в
  // yellowCoinGiftStore.ts — pika_team вече bypass-ва оня лимит изцяло и
  // разчита само на тази стойност, значи deploy-ът не трябва сам по себе си
  // да вдига ефективния economy лимит). Admin може да го промени от панела.
  pikaTeamDailyGiftLimit: 200_000,
}

const SETTING_KEYS = {
  signupBonusYellowCoins: 'signup_bonus_yellow_coins',
  profileNameChangePrice: 'profile_name_change_price',
  vipPrice30DaysCents: 'vip_price_30_days_cents',
  vipPrice180DaysCents: 'vip_price_180_days_cents',
  vipPrice365DaysCents: 'vip_price_365_days_cents',
  pikaTeamDailyGiftLimit: 'pika_team_daily_gift_limit',
} as const

// VIP е платен пакет — 0 € не е валидна цена (би направило пакета безплатен
// без изричен "безплатен VIP" flow). Долна граница 1 цент.
const VIP_PRICE_MIN_CENTS = 1
// VIP цена upper bound — 1000,00 € е далеч над всякаква разумна admin цена,
// но пази от fat-finger вход (напр. случайно добавена нула).
const VIP_PRICE_MAX_CENTS = 100_000

const LOBBY_CHAT_PIKA_ANNOUNCEMENT_CUTOFF_SEQ_KEY = 'lobby_chat_pika_announcement_cutoff_seq'

function normalizeSettingNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return null
  }

  return value
}

function parseStoredInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return parsed
}

export async function createAdminSettingsStore(
  databaseFilePath: string,
): Promise<AdminSettingsStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectSettingsStatement = database.prepare(`
    SELECT setting_key, setting_value
    FROM admin_settings
    WHERE setting_key IN (
      'signup_bonus_yellow_coins',
      'profile_name_change_price',
      'vip_price_30_days_cents',
      'vip_price_180_days_cents',
      'vip_price_365_days_cents',
      'pika_team_daily_gift_limit'
    );
  `)

  const upsertSettingStatement = database.prepare(`
    INSERT INTO admin_settings (
      setting_key,
      setting_value
    ) VALUES (
      ?,
      ?
    )
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP;
  `)

  const selectLobbyChatCutoffSeqStatement = database.prepare(`
    SELECT setting_value
    FROM admin_settings
    WHERE setting_key = ?
    LIMIT 1;
  `)

  function getSettings(): AdminSettingsSnapshot {
    const rows = selectSettingsStatement.all() as SettingRow[]
    const values = new Map(rows.map((row) => [row.setting_key, row.setting_value]))

    return {
      signupBonusYellowCoins: parseStoredInteger(
        values.get(SETTING_KEYS.signupBonusYellowCoins) ?? '',
        DEFAULT_SETTINGS.signupBonusYellowCoins,
      ),
      profileNameChangePrice: parseStoredInteger(
        values.get(SETTING_KEYS.profileNameChangePrice) ?? '',
        DEFAULT_SETTINGS.profileNameChangePrice,
      ),
      vipPrice30DaysCents: parseStoredInteger(
        values.get(SETTING_KEYS.vipPrice30DaysCents) ?? '',
        DEFAULT_SETTINGS.vipPrice30DaysCents,
      ),
      vipPrice180DaysCents: parseStoredInteger(
        values.get(SETTING_KEYS.vipPrice180DaysCents) ?? '',
        DEFAULT_SETTINGS.vipPrice180DaysCents,
      ),
      vipPrice365DaysCents: parseStoredInteger(
        values.get(SETTING_KEYS.vipPrice365DaysCents) ?? '',
        DEFAULT_SETTINGS.vipPrice365DaysCents,
      ),
      pikaTeamDailyGiftLimit: parseStoredInteger(
        values.get(SETTING_KEYS.pikaTeamDailyGiftLimit) ?? '',
        DEFAULT_SETTINGS.pikaTeamDailyGiftLimit,
      ),
    }
  }

  function updateSettings(
    input: Partial<AdminSettingsSnapshot>,
  ): { ok: true; settings: AdminSettingsSnapshot } | { ok: false; message: string } {
    const nextSignupBonus =
      input.signupBonusYellowCoins === undefined
        ? undefined
        : normalizeSettingNumber(input.signupBonusYellowCoins, 0, 10_000_000)
    const nextNameChangePrice =
      input.profileNameChangePrice === undefined
        ? undefined
        : normalizeSettingNumber(input.profileNameChangePrice, 0, 10_000_000)
    const nextVipPrice30 =
      input.vipPrice30DaysCents === undefined
        ? undefined
        : normalizeSettingNumber(input.vipPrice30DaysCents, VIP_PRICE_MIN_CENTS, VIP_PRICE_MAX_CENTS)
    const nextVipPrice180 =
      input.vipPrice180DaysCents === undefined
        ? undefined
        : normalizeSettingNumber(input.vipPrice180DaysCents, VIP_PRICE_MIN_CENTS, VIP_PRICE_MAX_CENTS)
    const nextVipPrice365 =
      input.vipPrice365DaysCents === undefined
        ? undefined
        : normalizeSettingNumber(input.vipPrice365DaysCents, VIP_PRICE_MIN_CENTS, VIP_PRICE_MAX_CENTS)
    const nextPikaTeamDailyGiftLimit =
      input.pikaTeamDailyGiftLimit === undefined
        ? undefined
        : normalizeSettingNumber(input.pikaTeamDailyGiftLimit, 0, 100_000_000)

    if (input.signupBonusYellowCoins !== undefined && nextSignupBonus === null) {
      return {
        ok: false,
        message: 'Signup bonus трябва да е цяло число между 0 и 10 000 000.',
      }
    }

    if (input.profileNameChangePrice !== undefined && nextNameChangePrice === null) {
      return {
        ok: false,
        message: 'Цената за смяна на име трябва да е цяло число между 0 и 10 000 000.',
      }
    }

    if (input.vipPrice30DaysCents !== undefined && nextVipPrice30 === null) {
      return {
        ok: false,
        message: 'Цената за VIP 30 дни трябва да е между 0,01 € и 1000 € (макс. 2 знака след запетая).',
      }
    }

    if (input.vipPrice180DaysCents !== undefined && nextVipPrice180 === null) {
      return {
        ok: false,
        message: 'Цената за VIP 180 дни трябва да е между 0,01 € и 1000 € (макс. 2 знака след запетая).',
      }
    }

    if (input.vipPrice365DaysCents !== undefined && nextVipPrice365 === null) {
      return {
        ok: false,
        message: 'Цената за VIP 365 дни трябва да е между 0,01 € и 1000 € (макс. 2 знака след запетая).',
      }
    }

    if (input.pikaTeamDailyGiftLimit !== undefined && nextPikaTeamDailyGiftLimit === null) {
      return {
        ok: false,
        message: 'Дневният лимит за подаряване от Екип Pika.bg трябва да е цяло число между 0 и 100 000 000.',
      }
    }

    if (nextSignupBonus !== undefined) {
      upsertSettingStatement.run(
        SETTING_KEYS.signupBonusYellowCoins,
        String(nextSignupBonus),
      )
    }

    if (nextNameChangePrice !== undefined) {
      upsertSettingStatement.run(
        SETTING_KEYS.profileNameChangePrice,
        String(nextNameChangePrice),
      )
    }

    if (nextVipPrice30 !== undefined) {
      upsertSettingStatement.run(SETTING_KEYS.vipPrice30DaysCents, String(nextVipPrice30))
    }

    if (nextVipPrice180 !== undefined) {
      upsertSettingStatement.run(SETTING_KEYS.vipPrice180DaysCents, String(nextVipPrice180))
    }

    if (nextVipPrice365 !== undefined) {
      upsertSettingStatement.run(SETTING_KEYS.vipPrice365DaysCents, String(nextVipPrice365))
    }

    if (nextPikaTeamDailyGiftLimit !== undefined) {
      upsertSettingStatement.run(SETTING_KEYS.pikaTeamDailyGiftLimit, String(nextPikaTeamDailyGiftLimit))
    }

    return {
      ok: true,
      settings: getSettings(),
    }
  }

  // Ако migration 20260817_001 по някаква причина не е приложена (напр.
  // изолирана тестова база, seed-ната преди тя да съществува) — fallback 0
  // означава "няма cutoff", т.е. цялата стара история би се показала. Това
  // е безопасно за нови/тестови бази (без стари съобщения за скриване), не
  // и заместител на реалната миграция за production базата.
  function getLobbyChatPikaAnnouncementCutoffSeq(): number {
    const row = selectLobbyChatCutoffSeqStatement.get(
      LOBBY_CHAT_PIKA_ANNOUNCEMENT_CUTOFF_SEQ_KEY,
    ) as SettingRow | undefined
    return parseStoredInteger(row?.setting_value ?? '', 0)
  }

  function close(): void {
    database.close()
  }

  return {
    getSettings,
    updateSettings,
    getLobbyChatPikaAnnouncementCutoffSeq,
    close,
  }
}
