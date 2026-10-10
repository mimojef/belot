/**
 * checkCampaignsFeatureFlag.ts
 *
 * Фаза 0 на системата "Кампании" — проверява isCampaignsFeatureEnabled()
 * (server/src/campaigns/campaignsFeatureFlag.ts): изключен по подразбиране,
 * активен само при ТОЧНО "1", и че нищо друго в Фаза 0 (миграциите, новите
 * таблици) не проверява или зависи от флага — схемата е изолирана и
 * съществува независимо от него (виж checkCampaignMigrations.ts/
 * checkCampaignSchemaConstraints.ts, които не пипат env въобще).
 */

import { isCampaignsFeatureEnabled } from '../src/campaigns/campaignsFeatureFlag.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const ENV_NAME = 'CAMPAIGNS_FEATURE_ENABLED'
const originalValue = process.env[ENV_NAME]

console.log('\ncheckCampaignsFeatureFlag')

try {
  check('[1] Без зададен env (unset) флагът е изключен', () => {
    delete process.env[ENV_NAME]
    assert(isCampaignsFeatureEnabled() === false, 'expected false when unset')
  })

  check('[2] Празен низ не включва флага', () => {
    process.env[ENV_NAME] = ''
    assert(isCampaignsFeatureEnabled() === false, 'expected false for empty string')
  })

  check('[3] "0" не включва флага', () => {
    process.env[ENV_NAME] = '0'
    assert(isCampaignsFeatureEnabled() === false, 'expected false for "0"')
  })

  check('[4] "true" (не точно "1") НЕ включва флага — строго само "1", по конвенцията на BELOT_SPECTATOR_ENABLED', () => {
    process.env[ENV_NAME] = 'true'
    assert(isCampaignsFeatureEnabled() === false, 'expected false for "true" — only exact "1" enables')
  })

  check('[5] "yes" не включва флага', () => {
    process.env[ENV_NAME] = 'yes'
    assert(isCampaignsFeatureEnabled() === false, 'expected false for "yes"')
  })

  check('[6] Точно "1" включва флага', () => {
    process.env[ENV_NAME] = '1'
    assert(isCampaignsFeatureEnabled() === true, 'expected true for exact "1"')
  })

  check('[7] " 1" (с whitespace) НЕ включва флага — строго equality, без trim', () => {
    process.env[ENV_NAME] = ' 1'
    assert(isCampaignsFeatureEnabled() === false, 'expected false for " 1" (no implicit trim)')
  })

  check('[8] Връщане към unset отново изключва флага (без залепнало състояние)', () => {
    delete process.env[ENV_NAME]
    assert(isCampaignsFeatureEnabled() === false, 'expected false after unset again')
  })
} finally {
  if (originalValue === undefined) {
    delete process.env[ENV_NAME]
  } else {
    process.env[ENV_NAME] = originalValue
  }
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
