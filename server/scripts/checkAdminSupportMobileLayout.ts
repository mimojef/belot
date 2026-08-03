/**
 * checkAdminSupportMobileLayout.ts — Проверки за мобилния master-detail layout
 * на Admin → Поддръжка (renderAdminSupportPage).
 *
 * Тества чрез pure render helper (без DOM), огледално на подхода в
 * checkCoinPackagesTopOfferBadge.ts / checkShopPurchaseFlow.ts [16]
 * (renderAdminSupportPage вече е export-нат за целта; минимален
 * LobbyScreenState fixture чрез `as unknown as`).
 *
 * [0]  desktop (isMobile:false) съдържа двуколонния grid, независимо от избрания разговор
 * [1]  mobile list (adminSupportMobileConversationOpen:false) показва само списъка —
 *      без grid, без reply форма, без messages контейнер, без mobile back бутон
 * [2]  mobile detail (adminSupportMobileConversationOpen:true + избран профил) показва
 *      само разговора — списъкът отсъства, mobile back бутонът присъства
 * [3]  mobile detail: reply формата и messages контейнерът присъстват точно по веднъж
 * [4]  mobile detail header показва аватар и име на избрания потребител
 * [5]  архивиран/липсващ selected profile (adminSupportMobileConversationOpen:true,
 *      adminSupportSelectedProfileId:null) връща мобилния изглед към списъка
 * [6]  непрочетените съобщения (unread badge) се показват в списъка и на desktop, и на mobile
 * [7]  маркирането на избрания разговор (isSelected стил) не е нарушено на mobile list
 * [8]  desktop dispatch (state, false / без втори аргумент) и mobile dispatch (state, true)
 *      връщат различен HTML за един и същ state — потвърждава коректен режим на извикване
 */

import {
  renderAdminSupportPage,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type {
  SupportConversationSnapshot,
  SupportMessageSnapshot,
} from '../../src/app/network/createGameServerClient.js'

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

function makeConversation(overrides: Partial<SupportConversationSnapshot> = {}): SupportConversationSnapshot {
  return {
    profileId: 'prof-1',
    displayName: 'Иван Иванов',
    avatarUrl: null,
    lastMessageBody: 'Здравейте, имам въпрос.',
    lastMessageIsFromAdmin: false,
    unreadByAdmin: 0,
    updatedAt: new Date('2026-07-27T10:00:00Z').toISOString(),
    ...overrides,
  }
}

function makeMessage(overrides: Partial<SupportMessageSnapshot> = {}): SupportMessageSnapshot {
  return {
    messageId: 'msg-1',
    profileId: 'prof-1',
    body: 'Здравейте, имам въпрос.',
    isFromAdmin: false,
    createdAt: new Date('2026-07-27T10:00:00Z').toISOString(),
    attachment: null,
    ...overrides,
  }
}

function makeState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    adminSupportConversations: [makeConversation()],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: null,
    adminSupportMessages: [],
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportReplyErrorText: null,
    adminSupportReplyDraftByProfileId: {},
    adminSupportPendingImageByProfileId: {},
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    adminSupportMobileConversationOpen: false,
    ...overrides,
  } as unknown as LobbyScreenState
}

const GRID_MARKER = 'grid-template-columns:300px 1fr'
const MOBILE_BACK_ATTR = 'data-admin-support-mobile-back="1"'
const REPLY_FORM_MARKER = 'data-admin-support-reply-form='
const REPLY_IMAGE_INPUT_MARKER = 'data-admin-support-image-input='
const REPLY_IMAGE_PICK_MARKER = 'data-admin-support-image-pick='
const MESSAGES_CONTAINER_MARKER = 'id="support-admin-messages-scroll"'
const CONV_ROW_MARKER = 'data-admin-support-conv="prof-1"'

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function main(): void {
  check('[0] desktop (isMobile:false) съдържа двуколонния grid, независимо от избрания разговор', () => {
    const noneSelected = renderAdminSupportPage(makeState())
    assert(noneSelected.includes(GRID_MARKER), 'desktop без избран разговор трябва да съдържа grid layout-а')

    const withSelected = renderAdminSupportPage(makeState({
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
    }))
    assert(withSelected.includes(GRID_MARKER), 'desktop с избран разговор трябва да продължи да съдържа grid layout-а')
    assert(!withSelected.includes(MOBILE_BACK_ATTR), 'desktop не трябва да съдържа mobile back бутона')
  })

  check('[1] mobile list показва само списъка (без grid, reply форма, messages контейнер, back бутон)', () => {
    const html = renderAdminSupportPage(makeState(), true)
    assert(html.includes(CONV_ROW_MARKER), 'списъкът с разговори трябва да присъства')
    assert(!html.includes(GRID_MARKER), 'mobile list не трябва да съдържа desktop grid layout-а')
    assert(!html.includes(REPLY_FORM_MARKER), 'mobile list не трябва да съдържа reply формата')
    assert(!html.includes(MESSAGES_CONTAINER_MARKER), 'mobile list не трябва да съдържа messages контейнера')
    assert(!html.includes(MOBILE_BACK_ATTR), 'mobile list не трябва да съдържа mobile back бутона')
  })

  check('[2] mobile detail показва само разговора (списъкът отсъства, back бутонът присъства)', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(!html.includes(CONV_ROW_MARKER), 'mobile detail не трябва да показва реда от списъка')
    assert(!html.includes(GRID_MARKER), 'mobile detail не трябва да съдържа desktop grid layout-а')
    assert(html.includes(MOBILE_BACK_ATTR), 'mobile detail трябва да съдържа back бутона към списъка')
  })

  check('[3] mobile detail: reply формата и messages контейнерът присъстват точно по веднъж', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(countOccurrences(html, REPLY_FORM_MARKER) === 1, 'reply формата трябва да присъства точно веднъж')
    assert(countOccurrences(html, MESSAGES_CONTAINER_MARKER) === 1, 'messages контейнерът трябва да присъства точно веднъж')
    assert(countOccurrences(html, MOBILE_BACK_ATTR) === 1, 'back бутонът трябва да присъства точно веднъж')
  })

  check('[4] mobile detail header показва аватар и име на избрания потребител', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportConversations: [makeConversation({ profileId: 'prof-1', displayName: 'Мария Петрова', avatarUrl: 'https://example.com/avatar.png' })],
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(html.includes('Мария Петрова'), 'името на избрания потребител трябва да се показва в header-а')
    assert(html.includes('https://example.com/avatar.png'), 'аватарът на избрания потребител трябва да се показва в header-а')
  })

  check('[5] архивиран/липсващ selected profile (mobile detail флаг вдигнат) връща изгледа към списъка', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportSelectedProfileId: null,
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(html.includes(CONV_ROW_MARKER), 'без избран профил mobile изгледът трябва да падне обратно към списъка')
    assert(!html.includes(MOBILE_BACK_ATTR), 'back бутонът не трябва да присъства, щом се показва списъкът')
  })

  check('[6] непрочетените съобщения (unread badge) се показват в списъка на desktop и mobile', () => {
    const state = makeState({
      adminSupportConversations: [makeConversation({ profileId: 'prof-1', unreadByAdmin: 3 })],
    })
    const desktopHtml = renderAdminSupportPage(state)
    const mobileHtml = renderAdminSupportPage(state, true)
    assert(desktopHtml.includes('>3<'), 'desktop списъкът трябва да показва unread badge стойността')
    assert(mobileHtml.includes('>3<'), 'mobile списъкът трябва да показва unread badge стойността')
  })

  check('[7] маркирането на избрания разговор (isSelected стил) работи в mobile list', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportConversations: [
        makeConversation({ profileId: 'prof-1' }),
        makeConversation({ profileId: 'prof-2', displayName: 'Друг потребител' }),
      ],
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMobileConversationOpen: false,
    }), true)
    assert(html.includes('border-left:3px solid #d4a520'), 'избраният разговор трябва да е маркиран в списъка')
  })

  check('[8] desktop и mobile dispatch (различен isMobile аргумент) връщат различен HTML за един и същ state', () => {
    const state = makeState({
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
      adminSupportMobileConversationOpen: true,
    })
    const desktopHtml = renderAdminSupportPage(state)
    const mobileHtml = renderAdminSupportPage(state, true)
    assert(desktopHtml !== mobileHtml, 'desktop и mobile рендерите трябва да се различават за същия state')
    assert(desktopHtml.includes(GRID_MARKER) && !mobileHtml.includes(GRID_MARKER), 'само desktop трябва да съдържа grid layout-а')
  })

  console.log(`\n${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main()
