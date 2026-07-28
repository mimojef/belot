/**
 * checkPlayerOrdering.ts — Проверка на admin player ordering helper.
 *
 * Тества orderPlayersForViewer от src/app/lobby/orderPlayersForViewer.ts (без DOM).
 * Изпълнява се с `tsx` (не е в build:scripts tsconfig).
 *
 * [1]  non-admin → ред на players е непроменен
 * [2]  admin → групиране: own → online humans → offline humans → bots
 * [3]  stable order в рамките на всяка група
 * [4]  own профил се среща точно веднъж в резултата
 * [5]  own профил е пръв дори ако isOnline=true
 * [6]  bot с isOnline=true → отива в bots групата, не в onlineHumans
 * [7]  admin + search: ordered list се филтрира; own профил не е force-shown при non-match
 * [8]  renderLobbyScreen.ts и renderMobilePlayersDirectory използват orderPlayersForViewer (source check)
 * [9]  subadmin (isAdmin flag=true подаден за subadmin viewer) → същото групиране като admin
 * [10] source check: computePlayersDirectoryLists се вика с state.isAdminOrSubadmin (не state.isAdmin),
 *      за да получи subadmin същата подредба като admin, без отделна логика и без нови права
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { orderPlayersForViewer } from '../../src/app/lobby/orderPlayersForViewer.js'
import type { PlayerPublicProfileSnapshot } from '../../src/app/network/createGameServerClient.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function makePlayer(overrides: Partial<PlayerPublicProfileSnapshot> & { profileId: string | null; displayName: string }): PlayerPublicProfileSnapshot {
  return {
    profileId: overrides.profileId,
    displayName: overrides.displayName,
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
    completedGamesCount: null,
    wonGamesCount: null,
    currentRankGames: null,
    nextRankGames: null,
    gamesUntilNextRank: null,
    rankProgressRatio: null,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: null,
    galleryImages: [],
    gender: null,
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
    ...overrides,
  }
}

console.log('\ncheckPlayerOrdering')

// Фиксиран набор от играчи за тестовете
const ownId = 'admin-profile-id'

const own = makePlayer({ profileId: ownId, displayName: 'Аз', isOnline: false })
const onlineA = makePlayer({ profileId: 'online-a', displayName: 'Онлайн А', isOnline: true })
const onlineB = makePlayer({ profileId: 'online-b', displayName: 'Онлайн Б', isOnline: true })
const offlineA = makePlayer({ profileId: 'offline-a', displayName: 'Офлайн А', isOnline: false })
const offlineB = makePlayer({ profileId: 'offline-b', displayName: 'Офлайн Б' }) // isOnline undefined → offline
const bot1 = makePlayer({ profileId: 'bot-1', displayName: 'Бот 1', isBot: true })
const bot2 = makePlayer({ profileId: 'bot-2', displayName: 'Бот 2', isBot: true })

const players = [offlineA, bot1, onlineA, own, onlineB, offlineB, bot2]

// [1] non-admin → ред е непроменен
{
  const result = orderPlayersForViewer(players, { isAdmin: false, ownProfileId: ownId })
  const sameOrder = result.every((p, i) => p.profileId === players[i]!.profileId)
  check('[1] non-admin: ред непроменен', sameOrder)
  check('[1] non-admin: брой непроменен', result.length === players.length)
}

// [2] admin → групиране: own → onlineHumans → offlineHumans → bots
{
  const result = orderPlayersForViewer(players, { isAdmin: true, ownProfileId: ownId })
  const ids = result.map((p) => p.profileId)

  const ownIdx = ids.indexOf(ownId)
  const onlineAIdx = ids.indexOf('online-a')
  const onlineBIdx = ids.indexOf('online-b')
  const offlineAIdx = ids.indexOf('offline-a')
  const offlineBIdx = ids.indexOf('offline-b')
  const bot1Idx = ids.indexOf('bot-1')
  const bot2Idx = ids.indexOf('bot-2')

  check('[2] admin: own е преди online humans', ownIdx < onlineAIdx && ownIdx < onlineBIdx)
  check('[2] admin: online humans са преди offline humans', onlineAIdx < offlineAIdx && onlineBIdx < offlineAIdx)
  check('[2] admin: offline humans са преди bots', offlineAIdx < bot1Idx && offlineBIdx < bot1Idx)
  check('[2] admin: bot1 е след всички humans', bot1Idx > offlineBIdx)
}

// [3] stable order в рамките на групите
{
  const result = orderPlayersForViewer(players, { isAdmin: true, ownProfileId: ownId })
  const ids = result.map((p) => p.profileId)

  // В оригиналния масив: onlineA (idx 2) е преди onlineB (idx 4)
  check('[3] stable: onlineA преди onlineB (оригинален ред)', ids.indexOf('online-a') < ids.indexOf('online-b'))

  // offlineA (idx 0) е преди offlineB (idx 5)
  check('[3] stable: offlineA преди offlineB (оригинален ред)', ids.indexOf('offline-a') < ids.indexOf('offline-b'))

  // bot1 (idx 1) е преди bot2 (idx 6)
  check('[3] stable: bot1 преди bot2 (оригинален ред)', ids.indexOf('bot-1') < ids.indexOf('bot-2'))
}

// [4] own профил се среща точно веднъж
{
  const result = orderPlayersForViewer(players, { isAdmin: true, ownProfileId: ownId })
  const ownCount = result.filter((p) => p.profileId === ownId).length
  check('[4] own профил: точно веднъж в резултата', ownCount === 1)
}

// [5] own профил е пръв, дори ако е isOnline=true
{
  const ownOnline = makePlayer({ profileId: ownId, displayName: 'Аз онлайн', isOnline: true })
  const mixed = [onlineA, offlineA, ownOnline, bot1]
  const result = orderPlayersForViewer(mixed, { isAdmin: true, ownProfileId: ownId })
  check('[5] own (isOnline=true) е пръв', result[0]?.profileId === ownId)
}

// [6] bot с isOnline=true → в bots групата, не в onlineHumans
{
  const onlineBot = makePlayer({ profileId: 'online-bot', displayName: 'Онлайн бот', isBot: true, isOnline: true })
  const mixed = [onlineA, onlineBot, offlineA]
  const result = orderPlayersForViewer(mixed, { isAdmin: true, ownProfileId: null })
  const ids = result.map((p) => p.profileId)
  const onlineAIdx = ids.indexOf('online-a')
  const offlineAIdx = ids.indexOf('offline-a')
  const onlineBotIdx = ids.indexOf('online-bot')
  check('[6] bot с isOnline=true: след offline humans', onlineBotIdx > offlineAIdx)
  check('[6] bot с isOnline=true: не е преди online human', onlineBotIdx > onlineAIdx)
}

// [7] admin + search: ordered list се филтрира; own не е force-shown при non-match
{
  const result = orderPlayersForViewer(players, { isAdmin: true, ownProfileId: ownId })
  const query = 'онлайн'
  const filtered = result.filter((p) => (p.displayName ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase()))

  check('[7] search: само matching играчи', filtered.every((p) => (p.displayName ?? '').toLocaleLowerCase().includes('онлайн')))
  check('[7] search: own не е включен (displayName="Аз" не match "онлайн")', !filtered.some((p) => p.profileId === ownId))
  check('[7] search: online humans са включени', filtered.some((p) => p.profileId === 'online-a') && filtered.some((p) => p.profileId === 'online-b'))
}

// [9] subadmin viewer: orderPlayersForViewer няма отделен "subadmin" клон — единственият
// вход е булев isAdmin флаг. Извикващият (renderLobbyScreen) подава state.isAdminOrSubadmin,
// така че subadmin вижда точно същото групиране own → online → offline → bots като admin.
{
  const subadminOwnId = 'subadmin-profile-id'
  const subadminOwn = makePlayer({ profileId: subadminOwnId, displayName: 'Субадмин', isOnline: true })
  const subadminPlayers = [offlineA, bot1, onlineA, subadminOwn, onlineB, offlineB, bot2]

  const subadminResult = orderPlayersForViewer(subadminPlayers, { isAdmin: true, ownProfileId: subadminOwnId })

  check('[9] subadmin: собственият профил е пръв', subadminResult[0]?.profileId === subadminOwnId)
  check(
    '[9] subadmin: online humans преди offline humans преди bots',
    subadminResult.findIndex((p) => p.profileId === 'online-a') <
      subadminResult.findIndex((p) => p.profileId === 'offline-a') &&
      subadminResult.findIndex((p) => p.profileId === 'offline-a') <
        subadminResult.findIndex((p) => p.profileId === 'bot-1'),
  )
}

// [10] Source check: computePlayersDirectoryLists (desktop + mobile) се вика с
// state.isAdminOrSubadmin — не state.isAdmin — за да получи subadmin реда на admin,
// без нови права (isAdminOrSubadmin само определя подредбата в orderPlayersForViewer).
{
  const renderSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

  const desktopCallMatch = renderSrc.match(
    /function renderPlayersDirectory[\s\S]*?computePlayersDirectoryLists\(state,\s*\{\s*isAdmin:\s*([^,]+),/,
  )
  check(
    '[10] renderPlayersDirectory (desktop): computePlayersDirectoryLists получава state.isAdminOrSubadmin',
    desktopCallMatch?.[1]?.trim() === 'state.isAdminOrSubadmin',
  )

  const mobileCallMatch = renderSrc.match(
    /function renderMobilePlayersDirectory[\s\S]*?computePlayersDirectoryLists\(state,\s*\{\s*isAdmin:\s*([^,]+),/,
  )
  check(
    '[10] renderMobilePlayersDirectory (mobile): computePlayersDirectoryLists получава state.isAdminOrSubadmin',
    mobileCallMatch?.[1]?.trim() === 'state.isAdminOrSubadmin',
  )
}

// [8] Source check: renderLobbyScreen.ts използва orderPlayersForViewer и в desktop, и в mobile
//
// desktop/mobile players directory рендиране минава през общия helper
// computePlayersDirectoryLists (добавен за players search — виж
// checkPlayersSearch.ts), който самият той извиква orderPlayersForViewer.
// Проверяваме и двете нива: helper-ът съдържа реалния call, а всяка от
// двете render функции извиква helper-а.
{
  const renderSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

  check('[8] renderLobbyScreen: import на orderPlayersForViewer', renderSrc.includes("from './orderPlayersForViewer'"))

  const helperMatch = renderSrc.match(/function computePlayersDirectoryLists[\s\S]*?^function /m)
  const helperSrc = helperMatch ? helperMatch[0] : ''
  check('[8] computePlayersDirectoryLists: използва orderPlayersForViewer', helperSrc.includes('orderPlayersForViewer'))

  // Намираме и двете render функции и проверяваме, че всяка вика споделения helper.
  const desktopMatch = renderSrc.match(/function renderPlayersDirectory[\s\S]*?^function /m)
  const desktopSrc = desktopMatch ? desktopMatch[0] : ''
  check('[8] renderPlayersDirectory (desktop): използва computePlayersDirectoryLists', desktopSrc.includes('computePlayersDirectoryLists'))

  const mobileMatch = renderSrc.match(/function renderMobilePlayersDirectory[\s\S]*?^function /m)
  const mobileSrc = mobileMatch ? mobileMatch[0] : ''
  check('[8] renderMobilePlayersDirectory (mobile): използва computePlayersDirectoryLists', mobileSrc.includes('computePlayersDirectoryLists'))
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
