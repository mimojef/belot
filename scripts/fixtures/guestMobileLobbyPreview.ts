// Локален преглед + fixture за checkGuestMobileLobby.ts — РЕАЛНИЯТ
// createLobbyFlowController + renderLobbyScreen (през Vite dev server), гост
// сесия (getAuthSession → null), без backend. Данните тук са ТЕСТОВИ и живеят
// само в тази страница: масите идват през onMatchRoomsLoad, публикациите и
// частните маси — през controller.handleServerMessage(...), точно по пътя на
// реалните API/WS отговори в main.ts. Продукционният код не съдържа нищо от тях.
//
// Query параметри: ?rooms=N (брой маси, по подразбиране 6; 0 = празно),
// ?loading=1 (масите никога не се зареждат), ?ludo=0 (Ludo flag изключен),
// ?posts=0 (без публикации), ?private=N (брой частни маси, по подразбиране 3),
// ?auth=1 (логнат играч вместо гост — за сравнение с непроменения layout),
// ?trial=N / ?trial=loading (пробните игри в popup-а на масата за 5 000),
// ?bonus=N (бонус при регистрация), ?rewards=none|error|empty и ?claim=error
// ("Ежедневни награди"), ?path=/learn (старт на информационен екран),
// ?routing=1 (URL синхронизация + "Назад" като в сайта).
import '/src/style.css'
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { __setLudoFeatureFlagOverrideForTests } from '/src/app/games/ludo/ludoFeatureFlag.ts'

const params = new URLSearchParams(window.location.search)
const intParam = (name: string, fallback: number): number => {
  const raw = params.get(name)
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

__setLudoFeatureFlagOverrideForTests(params.get('ludo') !== '0')

// Пълна навигация (както в сайта): връзките към /learn, /faq, /fair-play...
// зареждат страницата наново и приложението стартира на този път. Тук:
// ?path=/learn → контролерът стартира на /learn; непоети от приложението
// кликове върху такива връзки презареждат прегледа със същите параметри.
const INFO_PATHS = new Set(['/rules', '/strategy', '/learn', '/faq', '/fair-play', '/about', '/terms', '/privacy', '/contact', '/lobby'])
const previewUrl = window.location.pathname
const startPath = params.get('path')
if (startPath !== null && INFO_PATHS.has(startPath)) {
  history.replaceState(null, '', `${startPath}${window.location.search}`)
}
document.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest?.('a[href^="/"]')
  if (!link || event.defaultPrevented) return
  const path = link.getAttribute('href')!
  if (!INFO_PATHS.has(path)) return
  event.preventDefault()
  const next = new URLSearchParams(params)
  next.set('path', path)
  window.location.assign(`${previewUrl}?${next}`)
})

const SAMPLE_ROOMS = [
  { stakeAmount: 5000, minLevel: 1, prizeAmount: 8000, isEnabled: true },
  { stakeAmount: 8000, minLevel: 1, prizeAmount: 13000, isEnabled: true },
  { stakeAmount: 10000, minLevel: 1, prizeAmount: 16000, isEnabled: true },
  { stakeAmount: 25000, minLevel: 3, prizeAmount: 40000, isEnabled: true },
  { stakeAmount: 50000, minLevel: 5, prizeAmount: 80000, isEnabled: true },
  { stakeAmount: 100000, minLevel: 8, prizeAmount: 160000, isEnabled: true },
  { stakeAmount: 250000, minLevel: 10, prizeAmount: 400000, isEnabled: false },
]
const roomsCount = intParam('rooms', 6)
let rooms = Array.from({ length: roomsCount }, (_, i) => {
  const base = SAMPLE_ROOMS[i % 6]
  const round = Math.floor(i / 6)
  return round === 0 ? base : { ...base, stakeAmount: base.stakeAmount * (round + 1) * 10, prizeAmount: base.prizeAmount * (round + 1) * 10 }
}).concat(roomsCount > 0 ? [SAMPLE_ROOMS[6]] : [])

let dailyRewardTiers = [
  { tierId: 'preview-tier-1', sortOrder: 1, yellowCoinsAmount: 1000, claimedToday: true },
  { tierId: 'preview-tier-2', sortOrder: 2, yellowCoinsAmount: 2500, claimedToday: false },
  { tierId: 'preview-tier-3', sortOrder: 3, yellowCoinsAmount: 5000, claimedToday: false },
]

const calls: string[] = []
const root = document.getElementById('app') as HTMLElement

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: (stake: unknown) => { calls.push(`joinMatchmaking:${String(stake)}`) },
  leaveMatchmaking: () => { calls.push('leaveMatchmaking') },
  onMatchFound: () => {},
  getAuthSession: () => params.get('auth') === '1'
    ? { account: { role: 'player' }, profile: { profileId: 'preview-player', displayName: 'Играч', level: 1, yellowCoinsBalance: 120000 } as any }
    : null,
  // Бонусът при регистрация (/api/settings/public): ?bonus=N, по подразбиране 50 000.
  getSignupBonusYellowCoins: () => intParam('bonus', 50000),
  joinGuestTrial: (stake: number) => { calls.push(`joinGuestTrial:${stake}`) },
  // GET /api/guest/trial-status (тестов отговор): ?trial=N оставащи пробни
  // игри от 3 (по подразбиране 3; 0 = изчерпани), ?trial=loading = без отговор.
  onGuestTrialStatusLoad: () => params.get('trial') === 'loading'
    ? new Promise(() => {})
    : Promise.resolve({ ok: true as const, gamesUsed: 3 - Math.min(3, intParam('trial', 3)), remaining: Math.min(3, intParam('trial', 3)), maxGames: 3, stake: 5000 }),
  // "Ежедневни награди" (тестови отговори): по подразбиране 3 нива (едното
  // взето); ?rewards=none — без API ("Системата не е налична."),
  // ?rewards=error — грешка от сървъра, ?rewards=empty — без нива;
  // ?claim=error — "Вземи" връща грешка, иначе успех.
  ...(params.get('rewards') === 'none' ? {} : {
    onDailyRewardsLoad: () => Promise.resolve(params.get('rewards') === 'error'
      ? { ok: false as const, message: 'Тестова грешка: наградите не бяха заредени.' }
      : { ok: true as const, tiers: params.get('rewards') === 'empty' ? [] : dailyRewardTiers.map((tier) => ({ ...tier })) }),
    onDailyRewardClaim: (tierId: string) => {
      calls.push(`onDailyRewardClaim:${tierId}`)
      if (params.get('claim') === 'error') return Promise.resolve({ ok: false as const, message: 'Тестова грешка: наградата не беше взета.' })
      dailyRewardTiers = dailyRewardTiers.map((tier) => tier.tierId === tierId ? { ...tier, claimedToday: true } : tier)
      const awarded = dailyRewardTiers.find((tier) => tier.tierId === tierId)?.yellowCoinsAmount ?? 0
      return Promise.resolve({ ok: true as const, yellowCoinsAwarded: awarded, newBalance: null, tiers: dailyRewardTiers.map((tier) => ({ ...tier })) })
    },
  }),
  onMatchRoomsLoad: () => params.get('loading') === '1'
    ? new Promise(() => {})
    : Promise.resolve({ ok: true as const, rooms: rooms.map((room) => ({ ...room })) }),
  onPrivateRoomsOpen: () => { calls.push('onPrivateRoomsOpen') },
  onPrivateGamesOpen: () => { calls.push('onPrivateGamesOpen') },
} as any)

controller.setConnected(true)
// ?routing=1 — URL синхронизация като в main.ts (navigateInitialPath): всеки
// екран пише своя път (/lobby, /learn...) в историята, а браузърното "Назад"
// минава през popstate. Без него прегледът остава на собствения си адрес
// (може да се презарежда); с него презареждане зарежда реалното приложение.
if (params.get('routing') === '1') controller.navigateInitialPath()

// Фиксирани времена — markup-ът е детерминистичен (сравнение с baseline).
const now = Date.parse('2026-10-30T10:00:00.000Z')
if (params.get('posts') !== '0') {
  controller.handleServerMessage({
    type: 'lobby_chat_history',
    messages: [
      { seq: 1, messageId: 'm1', senderProfileId: 'pika', senderDisplayName: 'Pika.bg', senderIsChatAdmin: true, senderRole: 'pika_team', body: 'Добре дошли в Pika.bg! (тестова публикация)', createdAt: new Date(now - 86_400_000).toISOString() },
      { seq: 2, messageId: 'm2', senderProfileId: 'pika', senderDisplayName: 'Pika.bg', senderIsChatAdmin: true, senderRole: 'pika_team', body: 'Тестова публикация: новият мобилен дизайн на лобито е в процес на преглед.', createdAt: new Date(now - 3_600_000).toISOString() },
    ],
  } as any)
}

const privateCount = intParam('private', 3)
controller.handleServerMessage({
  type: 'private_rooms_list',
  rooms: Array.from({ length: privateCount }, (_, i) => ({
    id: `preview-room-${i + 1}`,
    kind: 'open',
    stake: 5000,
    slots: [
      { team: 'A', slotIndex: 0, occupant: null },
      { team: 'A', slotIndex: 1, occupant: null },
      { team: 'B', slotIndex: 0, occupant: null },
      { team: 'B', slotIndex: 1, occupant: null },
    ],
    createdAt: now,
    expiresAt: now + 3_600_000,
    manualStart: false,
    canManualStart: false,
  })),
} as any)

;(window as any).__guestMobileLobbyPreview = {
  controller,
  calls,
  get rooms() { return rooms },
  // Симулира промяна от админ панела: следващото нормално зареждане на
  // масите (GET /api/rooms → onMatchRoomsLoad) връща новите стойности.
  setRooms: (next: typeof rooms) => { rooms = next },
}
