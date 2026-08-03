/**
 * Targeted render checks for Admin -> Support desktop/mobile layout.
 *
 * The support composer is intentionally scoped with data-support-composer
 * attributes so the personal chat and guest contact forms are not affected.
 */

import { readFileSync } from 'node:fs'
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
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function makeConversation(overrides: Partial<SupportConversationSnapshot> = {}): SupportConversationSnapshot {
  return {
    profileId: 'prof-1',
    displayName: 'Support User',
    avatarUrl: null,
    lastMessageBody: 'Hello, I need help.',
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
    body: 'Hello, I need help.',
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
const SUPPORT_COMPOSER_MARKER = 'data-support-composer="admin"'
const SUPPORT_COMPOSER_TEXT_MARKER = 'data-support-composer-text="1"'
const SUPPORT_COMPOSER_SEND_MARKER = 'data-support-composer-send="1"'
const SUPPORT_IMAGE_BUTTON_MARKER = 'data-support-image-button="1"'
const MESSAGES_CONTAINER_MARKER = 'id="support-admin-messages-scroll"'
const CONV_ROW_MARKER = 'data-admin-support-conv="prof-1"'

const DESKTOP_COMPOSER_COLUMNS = 'grid-template-columns: minmax(0, 1fr) 44px auto;'
const DESKTOP_COMPOSER_AREAS = 'grid-template-areas: "text image send";'
const MOBILE_COMPOSER_COLUMNS = 'grid-template-columns: 44px minmax(0, 1fr);'
const MOBILE_COMPOSER_ROW_ONE = '"text text"'
const MOBILE_COMPOSER_ROW_TWO = '"image send"'
const COMPOSER_BUTTON_HEIGHT = 'height: 44px;'
const INLINE_IMAGE_BUTTON_HEIGHT = 'height:44px'
const COMPOSER_NO_OVERFLOW_GUARDS = [
  'max-width: 100%;',
  'box-sizing: border-box;',
  'overflow-x: hidden;',
  'min-width: 0;',
]

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function assertComposerCssContract(html: string): void {
  assert(html.includes(DESKTOP_COMPOSER_COLUMNS), 'desktop composer must keep textarea, image button and send button on one row')
  assert(html.includes(DESKTOP_COMPOSER_AREAS), 'desktop composer must use text/image/send grid areas on one row')
  assert(html.includes(MOBILE_COMPOSER_COLUMNS), 'mobile composer must fit 320px with fixed image button and flexible send button')
  assert(html.includes(MOBILE_COMPOSER_ROW_ONE), 'mobile composer textarea must occupy the first full row')
  assert(html.includes(MOBILE_COMPOSER_ROW_TWO), 'mobile composer image and send buttons must share the second row')
  assert(html.includes(COMPOSER_BUTTON_HEIGHT), 'send button CSS must use the shared 44px height')
  assert(html.includes(INLINE_IMAGE_BUTTON_HEIGHT), 'image button must use the same 44px height')

  for (const guard of COMPOSER_NO_OVERFLOW_GUARDS) {
    assert(html.includes(guard), `composer CSS must include overflow guard: ${guard}`)
  }
}

function makeDetailState(isMobileOpen = false): LobbyScreenState {
  return makeState({
    adminSupportSelectedProfileId: 'prof-1',
    adminSupportMessages: [makeMessage()],
    adminSupportMobileConversationOpen: isMobileOpen,
  })
}

function main(): void {
  check('[0] desktop keeps two-column support page and composer on one horizontal row', () => {
    const noneSelected = renderAdminSupportPage(makeState())
    assert(noneSelected.includes(GRID_MARKER), 'desktop without selected conversation should include two-column grid')

    const withSelected = renderAdminSupportPage(makeDetailState())
    assert(withSelected.includes(GRID_MARKER), 'desktop selected conversation should keep two-column grid')
    assert(!withSelected.includes(MOBILE_BACK_ATTR), 'desktop should not render mobile back button')
    assert(withSelected.includes(SUPPORT_COMPOSER_MARKER), 'desktop detail should render admin support composer')
    assertComposerCssContract(withSelected)
  })

  check('[1] mobile list shows only conversation list', () => {
    const html = renderAdminSupportPage(makeState(), true)
    assert(html.includes(CONV_ROW_MARKER), 'mobile list should render conversation row')
    assert(!html.includes(GRID_MARKER), 'mobile list should not render desktop grid')
    assert(!html.includes(REPLY_FORM_MARKER), 'mobile list should not render reply form')
    assert(!html.includes(MESSAGES_CONTAINER_MARKER), 'mobile list should not render messages container')
    assert(!html.includes(MOBILE_BACK_ATTR), 'mobile list should not render back button')
  })

  check('[2] mobile detail shows only selected conversation', () => {
    const html = renderAdminSupportPage(makeDetailState(true), true)
    assert(!html.includes(CONV_ROW_MARKER), 'mobile detail should not render conversation-list row')
    assert(!html.includes(GRID_MARKER), 'mobile detail should not render desktop grid')
    assert(html.includes(MOBILE_BACK_ATTR), 'mobile detail should render back button')
  })

  check('[3] mobile composer uses textarea first row and image/send buttons second row', () => {
    const html = renderAdminSupportPage(makeDetailState(true), true)
    assert(countOccurrences(html, REPLY_FORM_MARKER) === 1, 'mobile detail should render one reply form')
    assert(countOccurrences(html, SUPPORT_COMPOSER_MARKER) === 1, 'mobile detail should render one support composer')
    assert(countOccurrences(html, SUPPORT_COMPOSER_TEXT_MARKER) === 1, 'mobile composer should render one textarea')
    assert(countOccurrences(html, REPLY_IMAGE_INPUT_MARKER) === 1, 'mobile composer should keep one hidden file input')
    assert(countOccurrences(html, REPLY_IMAGE_PICK_MARKER) === 1, 'mobile composer should keep one image pick button')
    assert(countOccurrences(html, SUPPORT_IMAGE_BUTTON_MARKER) === 1, 'mobile composer should mark image button')
    assert(countOccurrences(html, SUPPORT_COMPOSER_SEND_MARKER) === 1, 'mobile composer should keep one send button')
    assert(countOccurrences(html, MESSAGES_CONTAINER_MARKER) === 1, 'mobile detail should render one messages container')
    assert(countOccurrences(html, MOBILE_BACK_ATTR) === 1, 'mobile detail should render one back button')
    assertComposerCssContract(html)
  })

  check('[4] mobile detail header shows selected profile avatar and name', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportConversations: [makeConversation({
        profileId: 'prof-1',
        displayName: 'Maria Petrova',
        avatarUrl: 'https://example.com/avatar.png',
      })],
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMessages: [makeMessage()],
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(html.includes('Maria Petrova'), 'selected profile display name should be visible')
    assert(html.includes('https://example.com/avatar.png'), 'selected profile avatar should be visible')
  })

  check('[5] missing selected profile falls back to mobile list', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportSelectedProfileId: null,
      adminSupportMobileConversationOpen: true,
    }), true)
    assert(html.includes(CONV_ROW_MARKER), 'mobile view should return to list without selected profile')
    assert(!html.includes(MOBILE_BACK_ATTR), 'list fallback should not render detail back button')
  })

  check('[6] unread badge renders on desktop and mobile lists', () => {
    const state = makeState({
      adminSupportConversations: [makeConversation({ profileId: 'prof-1', unreadByAdmin: 3 })],
    })
    const desktopHtml = renderAdminSupportPage(state)
    const mobileHtml = renderAdminSupportPage(state, true)
    assert(desktopHtml.includes('>3<'), 'desktop list should render unread badge value')
    assert(mobileHtml.includes('>3<'), 'mobile list should render unread badge value')
  })

  check('[7] selected conversation style remains visible on mobile list', () => {
    const html = renderAdminSupportPage(makeState({
      adminSupportConversations: [
        makeConversation({ profileId: 'prof-1' }),
        makeConversation({ profileId: 'prof-2', displayName: 'Second User' }),
      ],
      adminSupportSelectedProfileId: 'prof-1',
      adminSupportMobileConversationOpen: false,
    }), true)
    assert(html.includes('border-left:3px solid #d4a520'), 'selected conversation should keep highlight style')
  })

  check('[8] desktop and mobile dispatch return different layout HTML', () => {
    const state = makeDetailState(true)
    const desktopHtml = renderAdminSupportPage(state)
    const mobileHtml = renderAdminSupportPage(state, true)
    assert(desktopHtml !== mobileHtml, 'desktop and mobile renders should differ')
    assert(desktopHtml.includes(GRID_MARKER) && !mobileHtml.includes(GRID_MARKER), 'only desktop should include grid layout')
  })

  check('[9] registered-user support composer uses same scoped layout and guest contact stays text-only', () => {
    const renderSource = readFileSync(new URL('../../src/app/lobby/renderLobbyScreen.ts', import.meta.url), 'utf8')
    assert(renderSource.includes('data-support-composer="user"'), 'registered-user support form should use scoped support composer')
    assert(renderSource.includes('data-support-image-pick="1"'), 'registered-user support form should keep image picker')
    assert(renderSource.includes('data-guest-contact-form="1"'), 'guest contact form should remain present')
    assert(!renderSource.includes('data-guest-contact-image'), 'guest contact form should not gain an image picker')
  })

  console.log(`\n${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main()
