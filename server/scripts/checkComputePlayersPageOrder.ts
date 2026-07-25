/**
 * checkComputePlayersPageOrder.ts
 *
 * Unit тестове за server/src/db/computePlayersPageOrder.ts — чист seeded
 * shuffle + bucketing helper, използван от handlePlayersRequest за
 * server-side pagination на страница "Играчи" (виж checkPlayersPagination.ts
 * за HTTP/store интеграционния тест, checkPlayersPageSnapshotStore.ts за
 * snapshot store теста).
 *
 * [1]  Non-admin: реални играчи (всички) → преди ботовете
 * [2]  Non-admin: всеки профил се среща точно веднъж
 * [3]  Admin (без own): online реални играчи → офлайн реални играчи → ботове
 * [4]  Admin: bot с "online" статус остава в bots bucket-а, не в online humans
 * [5]  Стабилност: същия seed + същия вход → идентичен ред при две отделни извиквания
 * [6]  Различни seed-ове → различен (разбъркан) ред за реалистичен брой профили
 * [7]  generatePlayersPageSeed: връща различни seed-ове при различни повиквания
 * [8]  Admin own pinning: own профил е ВИНАГИ на глобална позиция 0, дори
 *      когато seed-ът иначе би го поставил другаде (офлайн, среда на списъка)
 * [9]  Admin own pinning: own профил НЕ се дублира (изключен от online/
 *      offline bucket-ите)
 * [10] Admin own pinning: online хора → офлайн хора → ботове следват СЛЕД own
 * [11] Admin own pinning: own профил, който е bot (edge case, не би трябвало
 *      да се случи в реалност) — не се третира като own pin
 * [12] Non-admin: ownProfileId не влияе на реда (own pinning е само за admin)
 * [13] Admin: ownProfileId=null или извън eligible → без pin, нормален ред
 */

import {
  computePlayersPageOrder,
  generatePlayersPageSeed,
  type EligiblePlayerForOrdering,
} from '../src/db/computePlayersPageOrder.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

console.log('\ncheckComputePlayersPageOrder')

function makeEligible(count: number, botStartIndex: number): EligiblePlayerForOrdering[] {
  return Array.from({ length: count }, (_, i) => ({
    profileId: `p-${i}`,
    isBot: i >= botStartIndex,
  }))
}

// [1] + [2] Non-admin ordering
{
  const eligible = makeEligible(20, 12) // 12 humans (p-0..p-11), 8 bots (p-12..p-19)
  const order = computePlayersPageOrder(eligible, {
    isAdmin: false,
    onlineProfileIds: new Set(),
    seed: 'seed-a',
  })

  const humanIds = new Set(eligible.filter((p) => !p.isBot).map((p) => p.profileId))
  const botIds = new Set(eligible.filter((p) => p.isBot).map((p) => p.profileId))
  const lastHumanIndex = Math.max(...order.map((id, i) => (humanIds.has(id) ? i : -1)))
  const firstBotIndex = Math.min(...order.map((id, i) => (botIds.has(id) ? i : Infinity)))

  check('[1] non-admin: всички хора преди всички ботове', lastHumanIndex < firstBotIndex)
  check('[2] non-admin: всеки профил среща точно веднъж', order.length === eligible.length && new Set(order).size === eligible.length)
}

// [3] + [4] Admin ordering (без own)
{
  const eligible = makeEligible(30, 20) // 20 humans (p-0..p-19), 10 bots (p-20..p-29)
  const onlineProfileIds = new Set(['p-2', 'p-5', 'p-9']) // 3 от хората online
  const order = computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds, seed: 'seed-b' })

  const onlineHumanIds = new Set(onlineProfileIds)
  const offlineHumanIds = new Set(
    eligible.filter((p) => !p.isBot && !onlineProfileIds.has(p.profileId)).map((p) => p.profileId),
  )
  const botIds = new Set(eligible.filter((p) => p.isBot).map((p) => p.profileId))

  const lastOnlineIdx = Math.max(...order.map((id, i) => (onlineHumanIds.has(id) ? i : -1)))
  const firstOfflineIdx = Math.min(...order.map((id, i) => (offlineHumanIds.has(id) ? i : Infinity)))
  const lastOfflineIdx = Math.max(...order.map((id, i) => (offlineHumanIds.has(id) ? i : -1)))
  const firstBotIdx = Math.min(...order.map((id, i) => (botIds.has(id) ? i : Infinity)))

  check('[3] admin: online хора преди офлайн хора', lastOnlineIdx < firstOfflineIdx)
  check('[3] admin: офлайн хора преди ботове', lastOfflineIdx < firstBotIdx)

  // [4] Бот, чийто profileId случайно е и в onlineProfileIds (edge case) — пак остава в bots bucket-а.
  const eligibleWithTrickyBot = [...eligible, { profileId: 'p-20', isBot: true }]
  const onlineIncludingBot = new Set([...onlineProfileIds, 'p-20'])
  const orderTricky = computePlayersPageOrder(eligibleWithTrickyBot, {
    isAdmin: true,
    onlineProfileIds: onlineIncludingBot,
    seed: 'seed-b',
  })
  const botIdxInTricky = orderTricky.indexOf('p-20')
  const firstOfflineIdxTricky = Math.min(
    ...orderTricky.map((id, i) => (offlineHumanIds.has(id) ? i : Infinity)),
  )
  check('[4] admin: bot с online=true остава след офлайн хората (в bots bucket-а)', botIdxInTricky > firstOfflineIdxTricky)
}

// [5] + [6] Стабилност и seed-зависимост
{
  const eligible = makeEligible(200, 100)
  const orderA1 = computePlayersPageOrder(eligible, { isAdmin: false, onlineProfileIds: new Set(), seed: 'stable-seed' })
  const orderA2 = computePlayersPageOrder(eligible, { isAdmin: false, onlineProfileIds: new Set(), seed: 'stable-seed' })
  const orderB = computePlayersPageOrder(eligible, { isAdmin: false, onlineProfileIds: new Set(), seed: 'different-seed' })

  check('[5] стабилност: същия seed → идентичен ред', JSON.stringify(orderA1) === JSON.stringify(orderA2))
  check('[6] различен seed → различен ред', JSON.stringify(orderA1) !== JSON.stringify(orderB))
}

// [7] generatePlayersPageSeed
{
  const s1 = generatePlayersPageSeed()
  const s2 = generatePlayersPageSeed()
  check('[7] generatePlayersPageSeed: различни повиквания → различни seed-ове', s1 !== s2)
}

// [8]-[10] Admin own pinning
{
  const eligible = makeEligible(50, 40) // p-0..p-39 humans, p-40..p-49 bots
  const onlineProfileIds = new Set(['p-3', 'p-7']) // 2 online хора
  const ownProfileId = 'p-25' // офлайн, някъде по средата на списъка

  // Пускаме с МНОГО различни seed-ове — own трябва да е позиция 0 ВИНАГИ,
  // независимо какъв ред би му дал самия shuffle.
  const seeds = ['seed-1', 'seed-2', 'seed-3', 'seed-4', 'seed-5']
  let allOwnFirst = true
  let anyOwnDuplicated = false
  for (const seed of seeds) {
    const order = computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds, seed, ownProfileId })
    if (order[0] !== ownProfileId) allOwnFirst = false
    const occurrences = order.filter((id) => id === ownProfileId).length
    if (occurrences !== 1) anyOwnDuplicated = true
  }
  check('[8] admin own pinning: own е ВИНАГИ глобална позиция 0, независимо от seed', allOwnFirst)
  check('[9] admin own pinning: own не се дублира', !anyOwnDuplicated)

  const order = computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds, seed: 'seed-1', ownProfileId })
  check('[9b] admin own pinning: точния брой елементи (без дублиране/пропускане)', order.length === eligible.length && new Set(order).size === eligible.length)

  const onlineHumanIds = new Set(onlineProfileIds)
  const offlineHumanIds = new Set(
    eligible.filter((p) => !p.isBot && !onlineProfileIds.has(p.profileId) && p.profileId !== ownProfileId).map((p) => p.profileId),
  )
  const botIds = new Set(eligible.filter((p) => p.isBot).map((p) => p.profileId))

  const firstOnlineIdx = Math.min(...order.map((id, i) => (onlineHumanIds.has(id) ? i : Infinity)))
  const lastOnlineIdx = Math.max(...order.map((id, i) => (onlineHumanIds.has(id) ? i : -1)))
  const firstOfflineIdx = Math.min(...order.map((id, i) => (offlineHumanIds.has(id) ? i : Infinity)))
  const lastOfflineIdx = Math.max(...order.map((id, i) => (offlineHumanIds.has(id) ? i : -1)))
  const firstBotIdx = Math.min(...order.map((id, i) => (botIds.has(id) ? i : Infinity)))

  check('[10a] own (поз. 0) е преди първия online човек', 0 < firstOnlineIdx)
  check('[10b] online хора преди офлайн хора', lastOnlineIdx < firstOfflineIdx)
  check('[10c] офлайн хора преди ботове', lastOfflineIdx < firstBotIdx)
}

// [11] Edge case: ownProfileId сочи към bot профил — не се третира като own pin
{
  const eligible = makeEligible(10, 5) // p-0..p-4 humans, p-5..p-9 bots
  const order = computePlayersPageOrder(eligible, {
    isAdmin: true,
    onlineProfileIds: new Set(),
    seed: 'seed-x',
    ownProfileId: 'p-7', // бот, не човек
  })
  const botIds = new Set(eligible.filter((p) => p.isBot).map((p) => p.profileId))
  const firstBotIdx = Math.min(...order.map((id, i) => (botIds.has(id) ? i : Infinity)))
  check('[11] ownProfileId сочещ към bot не се pin-ва отпред (остава в bots bucket-а)', firstBotIdx > 0)
}

// [12] Non-admin: ownProfileId не влияе (pinning е само за admin)
{
  const eligible = makeEligible(20, 12)
  const withoutOwn = computePlayersPageOrder(eligible, { isAdmin: false, onlineProfileIds: new Set(), seed: 'seed-y' })
  const withOwn = computePlayersPageOrder(eligible, { isAdmin: false, onlineProfileIds: new Set(), seed: 'seed-y', ownProfileId: 'p-5' })
  check('[12] non-admin: ownProfileId не променя реда', JSON.stringify(withoutOwn) === JSON.stringify(withOwn))
}

// [13] Admin: ownProfileId=null или извън eligible → без pin
{
  const eligible = makeEligible(20, 12)
  const withNull = computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds: new Set(), seed: 'seed-z', ownProfileId: null })
  const withUnknown = computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds: new Set(), seed: 'seed-z', ownProfileId: 'not-in-eligible-set' })
  check('[13a] ownProfileId=null → идентичен на без own параметър изобщо', JSON.stringify(withNull) === JSON.stringify(
    computePlayersPageOrder(eligible, { isAdmin: true, onlineProfileIds: new Set(), seed: 'seed-z' }),
  ))
  check('[13b] ownProfileId извън eligible → без грешка, пълен списък непроменен', withUnknown.length === eligible.length && new Set(withUnknown).size === eligible.length)
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
