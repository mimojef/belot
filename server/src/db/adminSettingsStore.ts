import {
  SERVER_ANTI_BAD_LUCK_DEFAULT_THRESHOLD,
  isServerAntiBadLuckThreshold,
  type ServerAntiBadLuckConfig,
  type ServerAntiBadLuckThreshold,
} from '../game/antiBadLuck/serverAntiBadLuckTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/**
 * Mirror на authStore.ts's RegistrationVerificationMode — декларирана
 * локално (не import-нат от authStore.ts) за да остане adminSettingsStore.ts
 * decoupled от authStore.ts (established convention тук — двата store-а
 * никога не се import-ват директно един друг, само wire-нати заедно чрез
 * callback-и в index.ts, виж getSignupBonusYellowCoins pattern-а). Двата
 * литерала трябва да останат структурно идентични.
 */
export type RegistrationVerificationMode = 'email_code' | 'direct'

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
  /**
   * Дневен лимит (календарен ден, Europe/Sofia) за подаряване на жълтици от
   * профили с роля marketing — ОТДЕЛЕН, независим pool от
   * pikaTeamDailyGiftLimit по-горе (marketing role permission model брифа
   * §3: "двете роли НЕ трябва да делят общ дневен consumption pool").
   * Прилага се ОТДЕЛНО за всеки marketing профил (виж §4.5-marketing блока в
   * yellowCoinGiftStore.ts). 0 = подаряването е забранено за marketing (НЕ
   * "unlimited"). Не засяга pika_team usage и обратно.
   */
  marketingDailyGiftLimit: number
  /**
   * Брой VIP дни, които профилът получава еднократно при първи опит за
   * писане в "Теми" (launch gift, виж vipStore.ts claimLaunchGift) — 0
   * изключва безплатния VIP и насочва потребителя към VIP офертите в
   * магазина (виж index.ts handleVipClaimLaunchGiftRequest).
   */
  freeTopicsVipDays: number
  /**
   * "Метод за регистрация" (Admin -> Настройки) — SERVER-AUTHORITATIVE,
   * четено live от authStore.ts's register() на ВСЯКА заявка (виж
   * getRegistrationVerificationMode wiring-а в index.ts). 'email_code'
   * (default) е СЪЩИЯТ pending-first email verification flow, непроменен.
   * 'direct' създава account/profile веднага, без verification код/email.
   * Клиентът НИКОГА не избира/подава тази стойност — виж
   * RegistrationVerificationMode doc коментара по-горе.
   */
  registrationVerificationMode: RegistrationVerificationMode
  /**
   * "Anti Bad Luck праг" (Admin -> Настройки) — SERVER-AUTHORITATIVE.
   * Allowlist 0|5|6|7|8|9|10, default 5 (= поведението преди настройката).
   * Seat става pending след N поредни BAD първи 5 → rescue най-рано на
   * (N + 1)-вото BAD; 0 = системата е напълно изключена. Стига до game
   * worker-а само през getAntiBadLuckRuntimeConfig() (main thread cache в
   * index.ts) — никога в game/lobby snapshot към клиент.
   */
  antiBadLuckThreshold: ServerAntiBadLuckThreshold
}

export type AdminSettingsStore = {
  getSettings: () => AdminSettingsSnapshot
  /**
   * Runtime config за game worker-а: прагът + вътрешната reset generation
   * (увеличава се атомарно при всяко превключване към 0, виж updateSettings).
   * Generation-ът НЕ е част от AdminSettingsSnapshot (не се показва/приема
   * през admin API).
   */
  getAntiBadLuckRuntimeConfig: () => ServerAntiBadLuckConfig
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
  // Няма seed-ваща migration (admin_settings е key/value, няма нужда от
  // schema промяна за нов ключ) — marketing role permission model брифа §3,
  // default 200 000 mirror-ва pikaTeamDailyGiftLimit за консистентност, но
  // е ОТДЕЛЕН, независим pool (виж doc коментара на полето по-горе). Admin
  // може да го промени от панела независимо от pikaTeamDailyGiftLimit.
  marketingDailyGiftLimit: 200_000,
  // Само fallback за база без seed-натата migration (20260911_001) — реалната
  // production стойност идва от admin_settings реда, seed-нат веднъж. Трябва
  // да остане РАВЕН на предишната hardcoded VIP_LAUNCH_GIFT_INTERVAL
  // константа в index.ts, за да запази статуквото след deploy.
  freeTopicsVipDays: 30,
  // Само fallback за база без seed-натата migration
  // (20260926_001_seed_registration_verification_mode.sql) — реалната production
  // стойност идва от admin_settings реда, seed-нат веднъж. ЗАДЪЛЖИТЕЛНО
  // 'email_code' — backward compatibility (виж task-а §12): direct mode
  // никога не се активира автоматично при deploy, само explicit admin
  // превключване от панела.
  registrationVerificationMode: 'email_code',
  // Само fallback за база без seed-натата migration
  // (20261001_001_seed_anti_bad_luck_settings.sql) или при невалидна
  // запазена стойност — 5 запазва поведението отпреди настройката. Никога 0:
  // повредена стойност не бива тихо да изключва системата.
  antiBadLuckThreshold: SERVER_ANTI_BAD_LUCK_DEFAULT_THRESHOLD,
}

const SETTING_KEYS = {
  signupBonusYellowCoins: 'signup_bonus_yellow_coins',
  profileNameChangePrice: 'profile_name_change_price',
  vipPrice30DaysCents: 'vip_price_30_days_cents',
  vipPrice180DaysCents: 'vip_price_180_days_cents',
  vipPrice365DaysCents: 'vip_price_365_days_cents',
  pikaTeamDailyGiftLimit: 'pika_team_daily_gift_limit',
  marketingDailyGiftLimit: 'marketing_daily_gift_limit',
  freeTopicsVipDays: 'free_topics_vip_days',
  registrationVerificationMode: 'registration_verification_mode',
  antiBadLuckThreshold: 'anti_bad_luck_threshold',
} as const

// Вътрешен (не admin-editable) ключ — виж getAntiBadLuckRuntimeConfig.
const ANTI_BAD_LUCK_RESET_GENERATION_KEY = 'anti_bad_luck_reset_generation'

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

const REGISTRATION_VERIFICATION_MODE_VALUES: readonly RegistrationVerificationMode[] = ['email_code', 'direct']

/** Strict enum validation — ЕДИНСТВЕНО 'email_code'/'direct' са допустими (виж task-а §11), всичко друго се отказва. */
function normalizeRegistrationVerificationMode(value: unknown): RegistrationVerificationMode | null {
  if (typeof value !== 'string') {
    return null
  }
  return (REGISTRATION_VERIFICATION_MODE_VALUES as readonly string[]).includes(value)
    ? (value as RegistrationVerificationMode)
    : null
}

/** Strict allowlist validation — само 0|5|6|7|8|9|10 (цели числа, не string-ове). */
function normalizeAntiBadLuckThreshold(value: unknown): ServerAntiBadLuckThreshold | null {
  return isServerAntiBadLuckThreshold(value) ? value : null
}

// Запазената стойност е TEXT — приема само точния десетичен запис на
// позволена стойност; всичко друго → default 5 (не 0).
function parseStoredAntiBadLuckThreshold(value: string): ServerAntiBadLuckThreshold {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  return isServerAntiBadLuckThreshold(parsed) ? parsed : SERVER_ANTI_BAD_LUCK_DEFAULT_THRESHOLD
}

function parseStoredResetGeneration(value: string | undefined): number {
  const parsed = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function parseStoredRegistrationVerificationMode(
  value: string,
  fallback: RegistrationVerificationMode,
): RegistrationVerificationMode {
  return normalizeRegistrationVerificationMode(value) ?? fallback
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
  // updateSettings пише в BEGIN IMMEDIATE транзакция — mirror на другите
  // write store-ове (5000).
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectSettingsStatement = database.prepare(`
    SELECT setting_key, setting_value
    FROM admin_settings
    WHERE setting_key IN (
      'signup_bonus_yellow_coins',
      'profile_name_change_price',
      'vip_price_30_days_cents',
      'vip_price_180_days_cents',
      'vip_price_365_days_cents',
      'pika_team_daily_gift_limit',
      'marketing_daily_gift_limit',
      'free_topics_vip_days',
      'registration_verification_mode',
      'anti_bad_luck_threshold'
    );
  `)

  const selectAntiBadLuckRuntimeStatement = database.prepare(`
    SELECT setting_key, setting_value
    FROM admin_settings
    WHERE setting_key IN ('anti_bad_luck_threshold', 'anti_bad_luck_reset_generation');
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
      marketingDailyGiftLimit: parseStoredInteger(
        values.get(SETTING_KEYS.marketingDailyGiftLimit) ?? '',
        DEFAULT_SETTINGS.marketingDailyGiftLimit,
      ),
      freeTopicsVipDays: parseStoredInteger(
        values.get(SETTING_KEYS.freeTopicsVipDays) ?? '',
        DEFAULT_SETTINGS.freeTopicsVipDays,
      ),
      registrationVerificationMode: parseStoredRegistrationVerificationMode(
        values.get(SETTING_KEYS.registrationVerificationMode) ?? '',
        DEFAULT_SETTINGS.registrationVerificationMode,
      ),
      antiBadLuckThreshold: parseStoredAntiBadLuckThreshold(values.get(SETTING_KEYS.antiBadLuckThreshold) ?? ''),
    }
  }

  function getAntiBadLuckRuntimeConfig(): ServerAntiBadLuckConfig {
    const rows = selectAntiBadLuckRuntimeStatement.all() as SettingRow[]
    const values = new Map(rows.map((row) => [row.setting_key, row.setting_value]))
    return {
      threshold: parseStoredAntiBadLuckThreshold(values.get(SETTING_KEYS.antiBadLuckThreshold) ?? ''),
      resetGeneration: parseStoredResetGeneration(values.get(ANTI_BAD_LUCK_RESET_GENERATION_KEY)),
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
    const nextMarketingDailyGiftLimit =
      input.marketingDailyGiftLimit === undefined
        ? undefined
        : normalizeSettingNumber(input.marketingDailyGiftLimit, 0, 100_000_000)
    const nextFreeTopicsVipDays =
      input.freeTopicsVipDays === undefined
        ? undefined
        : normalizeSettingNumber(input.freeTopicsVipDays, 0, 3_650)
    const nextRegistrationVerificationMode =
      input.registrationVerificationMode === undefined
        ? undefined
        : normalizeRegistrationVerificationMode(input.registrationVerificationMode)
    const nextAntiBadLuckThreshold =
      input.antiBadLuckThreshold === undefined
        ? undefined
        : normalizeAntiBadLuckThreshold(input.antiBadLuckThreshold)

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

    if (input.marketingDailyGiftLimit !== undefined && nextMarketingDailyGiftLimit === null) {
      return {
        ok: false,
        message: 'Дневният лимит за подаряване от Marketing трябва да е цяло число между 0 и 100 000 000.',
      }
    }

    if (input.freeTopicsVipDays !== undefined && nextFreeTopicsVipDays === null) {
      return {
        ok: false,
        message: 'Безплатният VIP при писане в „Теми“ трябва да е цяло число между 0 и 3650 дни.',
      }
    }

    if (input.registrationVerificationMode !== undefined && nextRegistrationVerificationMode === null) {
      return {
        ok: false,
        message: 'Методът за регистрация трябва да е "email_code" или "direct".',
      }
    }

    if (input.antiBadLuckThreshold !== undefined && nextAntiBadLuckThreshold === null) {
      return {
        ok: false,
        message: 'Anti Bad Luck прагът трябва да е 0, 5, 6, 7, 8, 9 или 10.',
      }
    }

    // Всички записи на един PATCH — една BEGIN IMMEDIATE транзакция (atomic):
    // особено прагът + reset generation при превключване към 0 трябва да се
    // видят заедно или изобщо.
    database.exec('BEGIN IMMEDIATE;')
    try {
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

      if (nextMarketingDailyGiftLimit !== undefined) {
        upsertSettingStatement.run(SETTING_KEYS.marketingDailyGiftLimit, String(nextMarketingDailyGiftLimit))
      }

      if (nextFreeTopicsVipDays !== undefined) {
        upsertSettingStatement.run(SETTING_KEYS.freeTopicsVipDays, String(nextFreeTopicsVipDays))
      }

      if (nextRegistrationVerificationMode !== undefined) {
        upsertSettingStatement.run(SETTING_KEYS.registrationVerificationMode, nextRegistrationVerificationMode)
      }

      if (nextAntiBadLuckThreshold !== undefined) {
        // Старата стойност се чете ВЪТРЕ в транзакцията (writer lock-ът вече е
        // взет) — превключване X → 0 (X ≠ 0) увеличава reset generation-а,
        // така че anti-bad-luck state-ът на всички активни мачове се изхвърля
        // при следващото им раздаване (виж applyServerAntiBadLuckToDeck).
        // 0 → 0 и X → Y (Y ≠ 0) НЕ пипат generation-а.
        const previous = getAntiBadLuckRuntimeConfig()
        upsertSettingStatement.run(SETTING_KEYS.antiBadLuckThreshold, String(nextAntiBadLuckThreshold))
        if (nextAntiBadLuckThreshold === 0 && previous.threshold !== 0) {
          upsertSettingStatement.run(ANTI_BAD_LUCK_RESET_GENERATION_KEY, String(previous.resetGeneration + 1))
        }
      }

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Preserve the original failure.
      }
      throw error
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
    getAntiBadLuckRuntimeConfig,
    updateSettings,
    getLobbyChatPikaAnnouncementCutoffSeq,
    close,
  }
}
