/**
 * checkPlayersDirectoryOnlineStatusVisibility.ts
 *
 * Проверява, че „Онлайн/Офлайн“ надписът в общия списък „Играчи“ (/players)
 * се показва само за admin/subadmin (state.isAdminOrSubadmin), а за
 * guest/player остава скрит — реален render тест (не текстов grep върху
 * цялото приложение), огледално на checkAdminSupportMobileLayout.ts /
 * checkSubadminProfilePopupRendering.ts. renderPlayersDirectory и
 * renderMobilePlayerListCard бяха export-нати (само видимост, без промяна
 * в поведение) специално за този тест.
 *
 * [1] desktop, isAdminOrSubadmin:false + isOnline:true  → няма "Онлайн"
 * [2] desktop, isAdminOrSubadmin:false + isOnline:false → няма "Офлайн"
 * [3] desktop, isAdminOrSubadmin:true  + isOnline:true  → има "Онлайн" (зелено #4ade80)
 * [4] desktop, isAdminOrSubadmin:true  + isOnline:false → има "Офлайн" (червено #f87171)
 * [5] desktop, isOnline:undefined, isAdminOrSubadmin:true → няма статус изобщо
 * [6] mobile,  showOnlineStatus:false + isOnline:true  → няма "Онлайн"
 * [7] mobile,  showOnlineStatus:false + isOnline:false → няма "Офлайн"
 * [8] mobile,  showOnlineStatus:true  + isOnline:true  → има "Онлайн" (зелено #4ade80)
 * [9] mobile,  showOnlineStatus:true  + isOnline:false → има "Офлайн" (червено #f87171)
 * [10] mobile, isOnline:undefined, showOnlineStatus:true → няма статус изобщо
 */

import {
  renderPlayersDirectory,
  renderMobilePlayerListCard,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { PlayerPublicProfileSnapshot } from '../../src/app/network/createGameServerClient.js'

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
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function makePlayer(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'p1',
    displayName: 'Тест Играч',
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

function makeState(player: PlayerPublicProfileSnapshot, isAdminOrSubadmin: boolean): LobbyScreenState {
  return {
    isAdminOrSubadmin,
    profile: { profileId: 'viewer-1' },
    players: [player],
    playersLoading: false,
    playersErrorText: null,
    playersSearchQuery: '',
    playersSearchResults: null,
    playersTotalCount: 1,
    playersTotalPages: 1,
    playersPage: 1,
  } as unknown as LobbyScreenState
}

// Точните markup низове, произведени от renderPlayersDirectory (desktop, renderLobbyScreen.ts:4445)
const DESKTOP_ONLINE = '<div style="font-size:11px;font-weight:800;color:#4ade80;white-space:nowrap;flex-shrink:0;">Онлайн</div>'
const DESKTOP_OFFLINE = '<div style="font-size:11px;font-weight:800;color:#f87171;white-space:nowrap;flex-shrink:0;">Офлайн</div>'

// Точните markup низове, произведени от renderMobilePlayerListCard (renderLobbyScreen.ts:3465)
const MOBILE_ONLINE = '<div style="color:#4ade80;font-size:11px;font-weight:900;flex:0 0 auto;">Онлайн</div>'
const MOBILE_OFFLINE = '<div style="color:#f87171;font-size:11px;font-weight:900;flex:0 0 auto;">Офлайн</div>'

function main(): void {
  check('[1] desktop non-admin + isOnline:true → няма "Онлайн"', () => {
    const html = renderPlayersDirectory(makeState(makePlayer({ isOnline: true }), false))
    assert(!html.includes('Онлайн'), 'не трябва да съдържа "Онлайн" за player/guest')
    assert(!html.includes(DESKTOP_ONLINE), 'не трябва да съдържа online badge markup-а')
  })

  check('[2] desktop non-admin + isOnline:false → няма "Офлайн"', () => {
    const html = renderPlayersDirectory(makeState(makePlayer({ isOnline: false }), false))
    assert(!html.includes('Офлайн'), 'не трябва да съдържа "Офлайн" за player/guest')
    assert(!html.includes(DESKTOP_OFFLINE), 'не трябва да съдържа offline badge markup-а')
  })

  check('[3] desktop admin/subadmin + isOnline:true → има "Онлайн" в зелено', () => {
    const html = renderPlayersDirectory(makeState(makePlayer({ isOnline: true }), true))
    assert(html.includes(DESKTOP_ONLINE), 'трябва да съдържа точния online badge (текст + #4ade80)')
  })

  check('[4] desktop admin/subadmin + isOnline:false → има "Офлайн" в червено', () => {
    const html = renderPlayersDirectory(makeState(makePlayer({ isOnline: false }), true))
    assert(html.includes(DESKTOP_OFFLINE), 'трябва да съдържа точния offline badge (текст + #f87171)')
  })

  check('[5] desktop admin/subadmin + isOnline:undefined → няма статус изобщо', () => {
    const html = renderPlayersDirectory(makeState(makePlayer({ isOnline: undefined }), true))
    assert(!html.includes('Онлайн'), 'isOnline:undefined не трябва да показва "Онлайн" дори за admin')
    assert(!html.includes('Офлайн'), 'isOnline:undefined не трябва да показва "Офлайн" дори за admin')
  })

  check('[6] mobile showOnlineStatus:false + isOnline:true → няма "Онлайн"', () => {
    const html = renderMobilePlayerListCard(makePlayer({ isOnline: true }), 'data-lobby-player-card', false)
    assert(!html.includes('Онлайн'), 'не трябва да съдържа "Онлайн" за player/guest')
    assert(!html.includes(MOBILE_ONLINE), 'не трябва да съдържа online badge markup-а')
  })

  check('[7] mobile showOnlineStatus:false + isOnline:false → няма "Офлайн"', () => {
    const html = renderMobilePlayerListCard(makePlayer({ isOnline: false }), 'data-lobby-player-card', false)
    assert(!html.includes('Офлайн'), 'не трябва да съдържа "Офлайн" за player/guest')
    assert(!html.includes(MOBILE_OFFLINE), 'не трябва да съдържа offline badge markup-а')
  })

  check('[8] mobile showOnlineStatus:true + isOnline:true → има "Онлайн" в зелено', () => {
    const html = renderMobilePlayerListCard(makePlayer({ isOnline: true }), 'data-lobby-player-card', true)
    assert(html.includes(MOBILE_ONLINE), 'трябва да съдържа точния online badge (текст + #4ade80)')
  })

  check('[9] mobile showOnlineStatus:true + isOnline:false → има "Офлайн" в червено', () => {
    const html = renderMobilePlayerListCard(makePlayer({ isOnline: false }), 'data-lobby-player-card', true)
    assert(html.includes(MOBILE_OFFLINE), 'трябва да съдържа точния offline badge (текст + #f87171)')
  })

  check('[10] mobile showOnlineStatus:true + isOnline:undefined → няма статус изобщо', () => {
    const html = renderMobilePlayerListCard(makePlayer({ isOnline: undefined }), 'data-lobby-player-card', true)
    assert(!html.includes('Онлайн'), 'isOnline:undefined не трябва да показва "Онлайн" дори с showOnlineStatus:true')
    assert(!html.includes('Офлайн'), 'isOnline:undefined не трябва да показва "Офлайн" дори с showOnlineStatus:true')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
