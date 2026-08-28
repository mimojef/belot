/**
 * checkAdminRegisteredProfilesFrontend.ts
 *
 * Pure-render regression checks за drill-down UI-то на "Регистрирани профили"
 * (Admin -> Информация), огледално на checkAdminActiveRoomsPanel.ts подхода
 * (pure render helper, без DOM, string/regex проверки върху резултатния HTML).
 *
 * [1]  "днес" бройката е обвита в бутон с data-admin-registered-profiles-open="today"
 * [2]  "вчера" бройката е обвита в бутон с data-admin-registered-profiles-open="yesterday"
 * [3]  "общо" НЕ е clickable (визуализацията му остава непроменена — plain div, без бутон)
 * [4]  Затворен модал (adminRegisteredProfilesModal=null) не рендира modal root-а изобщо
 * [5]  Отворен "today" модал рендира правилното заглавие "Регистрирани профили — Днес"
 * [6]  Отворен "yesterday" модал рендира правилното заглавие "Регистрирани профили — Вчера"
 * [7]  Loading state показва "Зареждане..."
 * [8]  Error state показва грешката
 * [9]  Empty state показва точния текст "Няма регистрирани профили за този период."
 * [10] Списък с редове показва Дата/Час/Потребителско име/Имейл колони
 * [11] Модалът има close бутон (data-admin-registered-profiles-close)
 * [12] Модалът има backdrop за нормално затваряне (data-admin-registered-profiles-backdrop)
 * [13] username fallback към displayName, когато username е null
 */

import {
  renderAdminInfoPanel,
  escapeHtml,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { AdminStatsSnapshot, AdminRegisteredProfileRow } from '../../src/app/network/createGameServerClient.js'
import type { AdminRegisteredProfilesModalState } from '../../src/app/adminInfo/renderAdminRegisteredProfilesModal.js'

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

function makeStats(overrides: Partial<AdminStatsSnapshot> = {}): AdminStatsSnapshot {
  return {
    onlineCount: 5,
    registeredProfiles: { total: 1000, today: 12, yesterday: 8 },
    payments: {
      today: { count: 0, totalCents: 0 },
      yesterday: { count: 0, totalCents: 0 },
      last7days: { count: 0, totalCents: 0 },
      thisMonth: { count: 0, totalCents: 0 },
      allTime: { count: 0, totalCents: 0 },
    },
    visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
    viewLayout: {
      today: { mobile: 0, desktop: 0 },
      yesterday: { mobile: 0, desktop: 0 },
      last7days: { mobile: 0, desktop: 0 },
      last30days: { mobile: 0, desktop: 0 },
    },
    gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
    ...overrides,
  }
}

function makeState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    isAdminOrSubadmin: true,
    adminStats: makeStats(),
    adminStatsLoading: false,
    adminStatsErrorText: null,
    adminRegisteredProfilesModal: null,
    ...overrides,
  } as unknown as LobbyScreenState
}

function makeRow(overrides: Partial<AdminRegisteredProfileRow> = {}): AdminRegisteredProfileRow {
  return {
    profileId: 'profile-1',
    username: 'TestUser',
    displayName: 'Test Display',
    createdAt: '2026-08-15 10:30:00',
    email: 'test@example.test',
    ...overrides,
  }
}

function makeModal(overrides: Partial<AdminRegisteredProfilesModalState> = {}): AdminRegisteredProfilesModalState {
  return {
    isOpen: true,
    period: 'today',
    loading: false,
    errorText: null,
    rows: [makeRow()],
    ...overrides,
  }
}

function main(): void {
  check('[1] "днес" бройката е clickable с правилен data-атрибут', () => {
    const html = renderAdminInfoPanel(makeState())
    assert(
      html.includes('data-admin-registered-profiles-open="today"'),
      'бутонът data-admin-registered-profiles-open="today" трябва да присъства',
    )
  })

  check('[2] "вчера" бройката е clickable с правилен data-атрибут', () => {
    const html = renderAdminInfoPanel(makeState())
    assert(
      html.includes('data-admin-registered-profiles-open="yesterday"'),
      'бутонът data-admin-registered-profiles-open="yesterday" трябва да присъства',
    )
  })

  check('[3] "общо" остава непроменено — не е clickable', () => {
    const html = renderAdminInfoPanel(makeState())
    // "общо" стойността трябва да се показва все още, без data-open атрибут около нея.
    assert(html.includes('>общо<'), '"общо" label-ът трябва да присъства непроменен')
    assert(
      !/data-admin-registered-profiles-open="total"/.test(html),
      '"общо" не трябва да има data-admin-registered-profiles-open атрибут',
    )
  })

  check('[4] Затворен модал не рендира modal root-а', () => {
    const html = renderAdminInfoPanel(makeState({ adminRegisteredProfilesModal: null }))
    assert(
      !html.includes('data-admin-registered-profiles-root="1"'),
      'modal root елементът не трябва да присъства, когато модалът е затворен',
    )
  })

  check('[5] Отворен "today" модал показва правилното заглавие', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ period: 'today' }),
    }))
    assert(html.includes('Регистрирани профили — Днес'), 'заглавието за "today" трябва да присъства')
  })

  check('[6] Отворен "yesterday" модал показва правилното заглавие', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ period: 'yesterday' }),
    }))
    assert(html.includes('Регистрирани профили — Вчера'), 'заглавието за "yesterday" трябва да присъства')
  })

  check('[7] Loading state показва "Зареждане..."', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ loading: true, rows: null }),
    }))
    assert(html.includes('Зареждане...'), 'loading текстът трябва да присъства')
  })

  check('[8] Error state показва грешката', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ loading: false, errorText: 'Нямаш достъп.', rows: null }),
    }))
    assert(html.includes('Нямаш достъп.'), 'грешката трябва да се показва в модала')
  })

  check('[9] Empty state показва точния текст', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ loading: false, errorText: null, rows: [] }),
    }))
    assert(
      html.includes('Няма регистрирани профили за този период.'),
      'точният empty-state текст трябва да присъства',
    )
  })

  check('[10] Списък с редове показва всички изисквани колони', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({ rows: [makeRow()] }),
    }))
    assert(html.includes('>Дата<'), 'колона "Дата" трябва да присъства')
    assert(html.includes('>Час<'), 'колона "Час" трябва да присъства')
    assert(html.includes('>Потребителско име<'), 'колона "Потребителско име" трябва да присъства')
    assert(html.includes('>Имейл<'), 'колона "Имейл" трябва да присъства')
    assert(html.includes('TestUser'), 'username стойността трябва да се вижда в реда')
    assert(html.includes('test@example.test'), 'email стойността трябва да се вижда в реда')
  })

  check('[11] Модалът има close бутон', () => {
    const html = renderAdminInfoPanel(makeState({ adminRegisteredProfilesModal: makeModal() }))
    assert(
      html.includes('data-admin-registered-profiles-close="1"'),
      'close бутонът трябва да присъства',
    )
  })

  check('[12] Модалът има backdrop за нормално затваряне', () => {
    const html = renderAdminInfoPanel(makeState({ adminRegisteredProfilesModal: makeModal() }))
    assert(
      html.includes('data-admin-registered-profiles-backdrop="1"'),
      'backdrop елементът трябва да присъства',
    )
  })

  check('[13] username fallback към displayName, когато username е null', () => {
    const html = renderAdminInfoPanel(makeState({
      adminRegisteredProfilesModal: makeModal({
        rows: [makeRow({ username: null, displayName: 'FallbackName' })],
      }),
    }))
    assert(html.includes('FallbackName'), 'displayName трябва да се покаже, когато username е null')
  })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main()
