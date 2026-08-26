/**
 * checkAdminVipPriceSettings.ts
 *
 * Checks за adminSettingsStore VIP price полетата (vipPrice30DaysCents/
 * vipPrice180DaysCents/vipPrice365DaysCents): default стойности, validation
 * (отрицателна цена, upper bound), partial update semantics, price echo
 * (getSettings след updateSettings връща новата стойност веднага).
 *
 * [0] getSettings без seed-нати редове → default стойности (789/3989/6989)
 * [1] updateSettings с валидна нова цена за vipPrice30DaysCents → ok:true,
 *       getSettings веднага echo-ва новата стойност
 * [2] updateSettings с отрицателна VIP цена → ok:false, стойността в базата
 *       остава непроменена
 * [3] updateSettings с цена над upper bound (100000 цента) → ok:false
 * [4] updateSettings с не-цяло число (fractional cents) → ok:false
 * [5] Partial update: промяна само на vipPrice180DaysCents НЕ променя
 *       vipPrice30DaysCents/vipPrice365DaysCents
 * [6] updateSettings за трите VIP цени едновременно → и трите се записват
 *       коректно, независимо една от друга
 * [7] Съществуващите non-VIP полета (signupBonusYellowCoins/
 *       profileNameChangePrice) остават незасегнати от VIP промени
 * [8] updateSettings с VIP цена = 0 → ok:false (VIP е платен пакет, 0 € НЕ
 *       е валидна цена), стойността в базата остава непроменена
 * [9] updateSettings с точно граничните валидни стойности (1 цент и 100000
 *       цента) → и двете ok:true (inclusive bounds)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'

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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-vip-price-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function buildSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-settings.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  const store = await createAdminSettingsStore(dbPath)

  await check('[0] getSettings без seed → default VIP цени (789/3989/6989)', () => {
    const settings = store.getSettings()
    assertEqual(settings.vipPrice30DaysCents, 789, 'default VIP 30 дни трябва да е 789')
    assertEqual(settings.vipPrice180DaysCents, 3_989, 'default VIP 180 дни трябва да е 3989')
    assertEqual(settings.vipPrice365DaysCents, 6_989, 'default VIP 365 дни трябва да е 6989')
  })

  await check('[1] updateSettings валидна нова цена за VIP 30 → ok:true, echo веднага', () => {
    const result = store.updateSettings({ vipPrice30DaysCents: 849 })
    assert(result.ok === true, `Очаквах ok=true: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.settings.vipPrice30DaysCents, 849, 'updateSettings трябва да върне новата стойност веднага')
    }
    const echoed = store.getSettings()
    assertEqual(echoed.vipPrice30DaysCents, 849, 'getSettings след update трябва да echo-ва новата цена')
  })

  await check('[2] Отрицателна VIP цена → ok:false, базата остава непроменена', () => {
    const before = store.getSettings().vipPrice180DaysCents
    const result = store.updateSettings({ vipPrice180DaysCents: -100 })
    assertEqual(result.ok, false, 'отрицателна цена трябва да е невалидна')
    const after = store.getSettings().vipPrice180DaysCents
    assertEqual(after, before, 'стойността не трябва да се промени при невалиден вход')
  })

  await check('[3] Цена над upper bound (100000 цента) → ok:false', () => {
    const before = store.getSettings().vipPrice365DaysCents
    const result = store.updateSettings({ vipPrice365DaysCents: 100_001 })
    assertEqual(result.ok, false, 'цена над upper bound трябва да е невалидна')
    const after = store.getSettings().vipPrice365DaysCents
    assertEqual(after, before, 'стойността не трябва да се промени при цена над bound-а')
  })

  await check('[4] Не-цяло число (fractional cents) → ok:false', () => {
    const result = store.updateSettings({ vipPrice30DaysCents: 789.5 })
    assertEqual(result.ok, false, 'fractional цена (не цели центове) трябва да е невалидна')
  })

  await check('[5] Partial update: промяна само на VIP 180 не пипа VIP 30/365', () => {
    const before30 = store.getSettings().vipPrice30DaysCents
    const before365 = store.getSettings().vipPrice365DaysCents

    const result = store.updateSettings({ vipPrice180DaysCents: 4_200 })
    assert(result.ok === true, 'update трябва да успее')

    const after = store.getSettings()
    assertEqual(after.vipPrice180DaysCents, 4_200, 'VIP 180 трябва да се промени')
    assertEqual(after.vipPrice30DaysCents, before30, 'VIP 30 НЕ трябва да се промени')
    assertEqual(after.vipPrice365DaysCents, before365, 'VIP 365 НЕ трябва да се промени')
  })

  await check('[6] Едновременна промяна на трите VIP цени → и трите се записват коректно', () => {
    const result = store.updateSettings({
      vipPrice30DaysCents: 899,
      vipPrice180DaysCents: 4_500,
      vipPrice365DaysCents: 7_500,
    })
    assert(result.ok === true, `Очаквах ok=true: ${JSON.stringify(result)}`)

    const settings = store.getSettings()
    assertEqual(settings.vipPrice30DaysCents, 899, 'VIP 30 трябва да е 899')
    assertEqual(settings.vipPrice180DaysCents, 4_500, 'VIP 180 трябва да е 4500')
    assertEqual(settings.vipPrice365DaysCents, 7_500, 'VIP 365 трябва да е 7500')
  })

  await check('[7] Non-VIP полета (signupBonus/profileNameChangePrice) остават незасегнати', () => {
    const before = store.getSettings()
    store.updateSettings({ vipPrice30DaysCents: 999 })
    const after = store.getSettings()
    assertEqual(after.signupBonusYellowCoins, before.signupBonusYellowCoins, 'signupBonusYellowCoins не трябва да се промени от VIP update')
    assertEqual(after.profileNameChangePrice, before.profileNameChangePrice, 'profileNameChangePrice не трябва да се промени от VIP update')
  })

  await check('[8] VIP цена = 0 → ok:false (VIP е платен пакет, не може да е безплатен)', () => {
    const before = store.getSettings().vipPrice30DaysCents
    const result = store.updateSettings({ vipPrice30DaysCents: 0 })
    assertEqual(result.ok, false, 'цена 0 трябва да е невалидна за платен VIP пакет')
    const after = store.getSettings().vipPrice30DaysCents
    assertEqual(after, before, 'стойността не трябва да се промени при опит за цена 0')
  })

  await check('[9] Гранични валидни стойности: 1 цент и 100000 цента → ok:true (inclusive bounds)', () => {
    const lowResult = store.updateSettings({ vipPrice30DaysCents: 1 })
    assert(lowResult.ok === true, `1 цент трябва да е валиден: ${JSON.stringify(lowResult)}`)
    assertEqual(store.getSettings().vipPrice30DaysCents, 1, 'VIP 30 трябва да е точно 1 цент')

    const highResult = store.updateSettings({ vipPrice365DaysCents: 100_000 })
    assert(highResult.ok === true, `100000 цента трябва да е валидно: ${JSON.stringify(highResult)}`)
    assertEqual(store.getSettings().vipPrice365DaysCents, 100_000, 'VIP 365 трябва да е точно 100000 цента')
  })

  // ── pikaTeamDailyGiftLimit default/production-safety проверки ───────────
  // Conservative rollout изискване: fresh DB (без custom admin update) НЕ
  // трябва да прескача автоматично от legacy sender rolling-24h лимита
  // (200 000, DAILY_GIFT_LIMIT в yellowCoinGiftStore.ts) на по-висока
  // стойност само защото тази функционалност е deploy-ната — default трябва
  // да е точно 200 000, не 1 000 000. Admin update-ва после веднага влиза в
  // сила (getSettings echo без restart).

  await check('[10] getSettings без seed/custom update → default pikaTeamDailyGiftLimit = 200 000 (conservative rollout)', () => {
    const settings = store.getSettings()
    assertEqual(
      settings.pikaTeamDailyGiftLimit,
      200_000,
      'default трябва да е 200 000 (равен на legacy sender rolling-24h лимита), не по-висок',
    )
  })

  await check('[11] Admin update на pikaTeamDailyGiftLimit до 1 000 000 → веднага ефективен (echo без restart)', () => {
    const result = store.updateSettings({ pikaTeamDailyGiftLimit: 1_000_000 })
    assert(result.ok === true, `Очаквах ok=true: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.settings.pikaTeamDailyGiftLimit, 1_000_000, 'updateSettings трябва да върне новата стойност веднага')
    }
    const echoed = store.getSettings()
    assertEqual(echoed.pikaTeamDailyGiftLimit, 1_000_000, 'getSettings след update трябва да echo-ва новата стойност веднага')
  })

  store.close()
  db.close()
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
