/**
 * checkAdminActiveRoomsPanel.ts — Проверки за панела „Активни стаи“ в
 * Admin → Сървър (renderAdminServerPanel), огледално на подхода в
 * checkAdminSupportMobileLayout.ts (pure render helper, без DOM,
 * string/regex проверки върху резултатния HTML).
 *
 * [1]  панелът се появява СЛЕД „Стаи по фаза“ и ПРЕДИ „Worker pool“ в изхода
 * [2]  desktop таблицата (.admin-rooms-desktop) присъства
 * [3]  mobile картите (.admin-rooms-mobile) присъстват
 * [4]  mobile картата съдържа room ID и фаза
 * [5]  mobile картата съдържа хора/ботове/прекъснали badge-ове
 * [6]  mobile картата съдържа worker и последна активност
 * [7]  празно състояние показва точния текст „В момента няма активни игрови стаи.“
 * [8]  connected humans badge е зелен (#22c55e)
 * [9]  bots badge е златист/неутрален (#d4a520)
 * [10] disconnected humans badge е оранжев (#f59e0b)
 * [11] стая с 0 човека и само ботове е визуално приглушена (различен фон от нормален ред)
 * [12] подозрително стара стая има warning marker (⚠)
 * [13] responsive CSS превключва desktop/mobile чрез @media без хоризонтален overflow маркери
 */

import {
  renderAdminServerPanel,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { MonitoringSnapshot, ActiveRoomSnapshot } from '../../src/app/adminServer/adminServerTypes.js'

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

function makeRoom(overrides: Partial<ActiveRoomSnapshot> = {}): ActiveRoomSnapshot {
  return {
    roomId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    phase: 'playing',
    connectedHumans: 2,
    disconnectedHumans: 0,
    bots: 2,
    occupiedSeats: 4,
    workerId: 'game-worker-1',
    createdAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 3_000,
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    samplerStatus: 'running',
    sampledAtMs: Date.now(),
    sampledAtIso: new Date().toISOString(),
    sampleWindowMs: 1000,
    serverCpuNowPercent: 5,
    nodeCpuNowPercent: 2,
    ramUsedMb: 1024,
    ramTotalMb: 8192,
    ramPercent: 12.5,
    processRssMb: 128,
    processUptimeSec: 3600,
    backendStartedAtIso: new Date().toISOString(),
    activeWsConnections: 3,
    uniqueOnlineRealPlayers: 2,
    totalMatchmakingWaiters: 0,
    matchmakingWaitersByStake: {},
    activeRooms: 1,
    roomsByPhase: { playing: 1 },
    rooms: [makeRoom()],
    workerPool: null,
    lastError: null,
    ...overrides,
  }
}

function makeState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    isAdminOrSubadmin: true,
    adminMonitoringSnapshot: makeSnapshot(),
    adminMonitoringErrorText: null,
    adminHistoryWindow: '1h',
    adminHistoryResult: null,
    adminWsConnections: null,
    ...overrides,
  } as unknown as LobbyScreenState
}

const DESKTOP_TABLE_CLASS = 'admin-rooms-desktop'
const MOBILE_CARDS_CLASS = 'admin-rooms-mobile'
// Секционните sectionLabel() изходи ползват ">TEXT<" — уникално различни от
// metric card-а "Активни стаи" (който рендира стойност до label-а, не ">Активни стаи<").
const PHASE_ROWS_SECTION_MARKER = '>Стаи по фаза<'
const ACTIVE_ROOMS_SECTION_MARKER = `class="${DESKTOP_TABLE_CLASS}"`
const WORKER_POOL_SECTION_MARKER = '>Worker pool<'
const EMPTY_STATE_TEXT = 'В момента няма активни игрови стаи.'
const GREEN_BADGE_COLOR = '#22c55e'
const GOLD_BADGE_COLOR = '#d4a520'
const ORANGE_BADGE_COLOR = '#f59e0b'
const STALE_MARKER = '⚠'

function main(): void {
  check('[1] панелът "Активни стаи" е след "Стаи по фаза" и преди "Worker pool"', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({ roomsByPhase: { playing: 1 } }),
    }))
    const phaseIdx = html.indexOf(PHASE_ROWS_SECTION_MARKER)
    const activeRoomsIdx = html.indexOf(ACTIVE_ROOMS_SECTION_MARKER)
    const workerPoolIdx = html.indexOf(WORKER_POOL_SECTION_MARKER)
    assert(phaseIdx !== -1, '"Стаи по фаза" секцията трябва да присъства')
    assert(activeRoomsIdx !== -1, '"Активни стаи" секцията (desktop таблица) трябва да присъства')
    assert(workerPoolIdx !== -1, '"Worker pool" секцията трябва да присъства')
    assert(phaseIdx < activeRoomsIdx, '"Стаи по фаза" трябва да е преди "Активни стаи"')
    assert(activeRoomsIdx < workerPoolIdx, '"Активни стаи" трябва да е преди "Worker pool"')
  })

  check('[2] desktop таблицата (.admin-rooms-desktop) присъства с активни стаи', () => {
    const html = renderAdminServerPanel(makeState())
    assert(html.includes(DESKTOP_TABLE_CLASS), 'desktop таблицата трябва да присъства')
    assert(html.includes('<table'), 'desktop изгледът трябва да е таблица')
  })

  check('[3] mobile картите (.admin-rooms-mobile) присъстват с активни стаи', () => {
    const html = renderAdminServerPanel(makeState())
    assert(html.includes(MOBILE_CARDS_CLASS), 'mobile картите трябва да присъстват')
  })

  check('[4] mobile картата съдържа room ID (съкратен) и фаза', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ roomId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', phase: 'bidding' })],
      }),
    }))
    const mobileSectionStart = html.indexOf(`class="${MOBILE_CARDS_CLASS}"`)
    assert(mobileSectionStart !== -1, 'mobile секцията трябва да присъства')
    const mobileSection = html.slice(mobileSectionStart)
    assert(mobileSection.includes('aaaaaaaa'), 'mobile картата трябва да съдържа съкратения room ID')
    assert(mobileSection.includes('Обявяване'), 'mobile картата трябва да съдържа BG label за фазата (bidding → Обявяване)')
  })

  check('[5] mobile картата съдържа хора/ботове/прекъснали badge-ове', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ connectedHumans: 1, bots: 2, disconnectedHumans: 1 })],
      }),
    }))
    const mobileSection = html.slice(html.indexOf(`class="${MOBILE_CARDS_CLASS}"`))
    assert(mobileSection.includes('1 човек'), 'mobile картата трябва да показва броя свързани хора')
    assert(mobileSection.includes('2 бота'), 'mobile картата трябва да показва броя ботове')
    assert(mobileSection.includes('1 прекъснал'), 'mobile картата трябва да показва броя прекъснали')
  })

  check('[6] mobile картата съдържа worker и последна активност', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ workerId: 'game-worker-7' })],
      }),
    }))
    const mobileSection = html.slice(html.indexOf(`class="${MOBILE_CARDS_CLASS}"`))
    assert(mobileSection.includes('game-worker-7'), 'mobile картата трябва да показва worker ID-то')
    assert(/преди \d+ (сек|мин|ч)\./.test(mobileSection), 'mobile картата трябва да показва относителна последна активност')
  })

  check('[7] празно състояние показва точния текст', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({ activeRooms: 0, roomsByPhase: {}, rooms: [] }),
    }))
    assert(html.includes(EMPTY_STATE_TEXT), `трябва да съдържа "${EMPTY_STATE_TEXT}"`)
  })

  check('[8] connected humans badge е зелен', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({ rooms: [makeRoom({ connectedHumans: 3 })] }),
    }))
    assert(html.includes(GREEN_BADGE_COLOR), 'трябва да съдържа зеления цвят за свързани хора')
  })

  check('[9] bots badge е златист/неутрален', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({ rooms: [makeRoom({ bots: 4 })] }),
    }))
    assert(html.includes(GOLD_BADGE_COLOR), 'трябва да съдържа златистия цвят за ботове')
  })

  check('[10] disconnected humans badge е оранжев', () => {
    const html = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ connectedHumans: 1, disconnectedHumans: 1, bots: 2 })],
      }),
    }))
    assert(html.includes(ORANGE_BADGE_COLOR), 'трябва да съдържа оранжевия цвят за прекъснали')
  })

  check('[11] стая с 0 човека и само ботове е визуално приглушена', () => {
    const normalHtml = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ connectedHumans: 2, disconnectedHumans: 0, bots: 2, lastActivityAt: Date.now() })],
      }),
    }))
    const botsOnlyHtml = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({ connectedHumans: 0, disconnectedHumans: 0, bots: 4, lastActivityAt: Date.now() })],
      }),
    }))
    // Различен desktop row background между нормален ред (transparent) и bots-only ред (приглушен).
    assert(normalHtml.includes('background:transparent;'), 'нормален ред трябва да е с прозрачен фон')
    assert(botsOnlyHtml.includes('rgba(255,255,255,0.015)'), 'bots-only ред трябва да е визуално приглушен')
    assert(!normalHtml.includes('rgba(255,255,255,0.015)'), 'нормален ред не трябва да ползва приглушения фон')
  })

  check('[12] подозрително стара стая има warning marker', () => {
    const staleHtml = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({
          connectedHumans: 0,
          disconnectedHumans: 0,
          bots: 4,
          lastActivityAt: Date.now() - 6 * 60 * 1000,
        })],
      }),
    }))
    const freshHtml = renderAdminServerPanel(makeState({
      adminMonitoringSnapshot: makeSnapshot({
        rooms: [makeRoom({
          connectedHumans: 0,
          disconnectedHumans: 0,
          bots: 4,
          lastActivityAt: Date.now() - 10_000,
        })],
      }),
    }))
    assert(staleHtml.includes(STALE_MARKER), 'стара стая трябва да съдържа warning marker')
    assert(!freshHtml.includes(STALE_MARKER), 'прясна bots-only стая не трябва да съдържа warning marker')
  })

  check('[13] responsive CSS превключва desktop/mobile чрез @media (без overflow marker класове извън контейнера)', () => {
    const html = renderAdminServerPanel(makeState())
    assert(
      html.includes(`@media(max-width:700px){.${DESKTOP_TABLE_CLASS}{display:none!important;}}`),
      'CSS трябва да скрива desktop таблицата под 700px',
    )
    assert(
      html.includes(`@media(min-width:701px){.${MOBILE_CARDS_CLASS}{display:none!important;}}`),
      'CSS трябва да скрива mobile картите над 701px',
    )
    assert(html.includes('overflow-x:auto;'), 'desktop таблицата трябва да е обвита в overflow-x:auto контейнер')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
