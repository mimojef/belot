/**
 * checkLudoEntryPickerPrizeMirror.ts — мобилният избор на вход показва
 * наградата на „Не се сърди човече“ чрез клиентско огледало
 * (src/app/games/ludo/ludoFormulaPrize.ts). Проверява, че огледалото дава
 * ТОЧНО същия резултат като сървърната computeLudoFormulaPrize за входове,
 * брой играчи и комисиони от общия каталог (вкл. невалидни стойности).
 *
 * Пускане: npx tsx scripts/checkLudoEntryPickerPrizeMirror.ts
 */

import { computeLudoFormulaPrize } from '../src/db/ludoEconomyStore.js'
import { DEFAULT_SITE_COMMISSION_BPS } from '../src/economy/prizeFormula.js'
import { computeLudoEntryPrize } from '../../src/app/games/ludo/ludoFormulaPrize.js'

let failures = 0
let checks = 0
function check(name: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) {
    failures++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const stakes = [100, 500, 1_000, 5_000, 5_500, 8_000, 10_000, 12_300, 15_000, 20_000, 35_000, 50_000, 99_900, 150_000, 1_000_000, 123_456_700, 1_000_000_000]
const commissions = [1_000, 1_001, 1_250, 1_999, 2_000, 2_345, 2_500, 3_333, 4_999, 5_000, 999, 5_001, 0]
for (const stake of stakes) {
  for (const players of [2, 4]) {
    for (const bps of commissions) {
      const server = computeLudoFormulaPrize(stake, players, bps)
      const client = computeLudoEntryPrize(stake, players, bps)
      check(`stake=${stake} players=${players} bps=${bps}`, server === client, `server=${server} client=${client}`)
    }
    // null в каталога → комисионата по подразбиране (както resolveCommonCommissionBps).
    const server = computeLudoFormulaPrize(stake, players, DEFAULT_SITE_COMMISSION_BPS)
    check(`stake=${stake} players=${players} bps=null`, computeLudoEntryPrize(stake, players, null) === server)
  }
}
// Примерите от референцията (20%): 5 000 × 2 → 8 000; 5 000 × 4 → 16 000.
check('5000×2 @20% = 8000', computeLudoEntryPrize(5_000, 2, 2_000) === 8_000)
check('5000×4 @20% = 16000', computeLudoEntryPrize(5_000, 4, 2_000) === 16_000)

console.log(`${checks - failures}/${checks} passed`)
if (failures > 0) process.exit(1)
