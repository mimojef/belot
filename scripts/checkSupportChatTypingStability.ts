import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import {
  renderAdminSupportPage,
  type LobbyScreenState,
} from '../src/app/lobby/renderLobbyScreen.js'

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

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function getHandlerBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert(start >= 0, `${startMarker} was not found`)
  const end = source.indexOf(endMarker, start)
  assert(end > start, `${endMarker} was not found after ${startMarker}`)
  return source.slice(start, end)
}

function makeAdminState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  const messages = Array.from({ length: 24 }, (_, index) => ({
    messageId: `message-${index + 1}`,
    profileId: 'user-profile',
    body: `Support history line ${index + 1}`,
    isFromAdmin: index % 3 === 0,
    createdAt: new Date(2026, 7, 3, 10, index).toISOString(),
    attachment: null,
  }))

  return {
    adminSupportConversations: [{
      profileId: 'user-profile',
      displayName: 'Support User',
      avatarUrl: null,
      lastMessageBody: 'Needs help',
      lastMessageIsFromAdmin: false,
      unreadByAdmin: 1,
      updatedAt: new Date('2026-08-03T10:00:00Z').toISOString(),
    }],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: 'user-profile',
    adminSupportMessages: messages,
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportReplyErrorText: null,
    adminSupportReplyDraftByProfileId: {},
    adminSupportPendingImageByProfileId: {},
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    adminSupportMobileConversationOpen: true,
    ...overrides,
  } as unknown as LobbyScreenState
}

async function main(): Promise<void> {
  await check('support draft handlers update state without full render', async () => {
    const controllerSource = await readFile(resolve('src/app/lobby/createLobbyFlowController.ts'), 'utf8')
    const userDraftHandler = getHandlerBody(controllerSource, 'onSupportDraftChange: (draft) => {', 'onSupportImageSelect:')
    const adminDraftHandler = getHandlerBody(controllerSource, 'onAdminSupportReplyDraftChange: (profileId, draft) => {', 'onAdminSupportImageSelect:')

    assert(userDraftHandler.includes('state.supportDraft = draft'), 'user support draft handler should update only the draft')
    assert(!/\brender\s*\(/.test(userDraftHandler), 'user support draft handler should not call render()')
    assert(adminDraftHandler.includes('[profileId]: draft'), 'admin support draft handler should update only the draft')
    assert(!/\brender\s*\(/.test(adminDraftHandler), 'admin support draft handler should not call render()')
  })

  await check('renderLobbyScreen preserves support focus, caret and scroll across external rerenders', async () => {
    const renderSource = await readFile(resolve('src/app/lobby/renderLobbyScreen.ts'), 'utf8')
    assert(renderSource.includes('const wasSupportInputFocused'), 'user support focus capture is missing')
    assert(renderSource.includes('savedSupportInputSelectionStart'), 'user support selection capture is missing')
    assert(renderSource.includes('const wasAdminSupportReplyFocused'), 'admin support focus capture is missing')
    assert(renderSource.includes('savedAdminSupportReplySelectionStart'), 'admin support selection capture is missing')
    assert(renderSource.includes('const newSupportMessagesScrollEl'), 'user support scroll restore is missing')
    assert(renderSource.includes('const newAdminSupportMessagesScrollEl'), 'admin support scroll restore is missing')
    assert(!/for \(const id of \['support-popup-messages-scroll', 'support-admin-messages-scroll'\]/.test(renderSource), 'support messages should not be forced to bottom on every render')
  })

  await check('sequential typing keeps the same selected support conversation, textarea, focus, caret and scroll', async () => {
    const browser = await chromium.launch()
    try {
      for (const scenario of [
        { label: 'desktop', width: 1280, height: 900, mobile: false },
        { label: 'mobile', width: 390, height: 844, mobile: true },
      ]) {
        const page = await browser.newPage({
          viewport: { width: scenario.width, height: scenario.height },
          isMobile: scenario.mobile,
          hasTouch: scenario.mobile,
        })
        try {
          const state = makeAdminState()
          await page.setContent(`
            <!doctype html>
            <html>
              <body>
                <main id="root">${renderAdminSupportPage(state, scenario.mobile)}</main>
                <script>
                  window.__drafts = {};
                  window.__firstTextarea = null;
                  const textarea = document.querySelector('[data-admin-support-reply-form="user-profile"] textarea[name="body"]');
                  const scroll = document.querySelector('#support-admin-messages-scroll');
                  scroll.style.height = '120px';
                  scroll.scrollTop = 64;
                  textarea.addEventListener('input', () => {
                    window.__drafts['user-profile'] = textarea.value;
                  });
                  textarea.focus();
                  window.__firstTextarea = textarea;
                </script>
              </body>
            </html>
          `)

          const chars = ['h', 'e', 'l', 'l', 'o']
          let expected = ''
          for (const char of chars) {
            expected += char
            await page.locator('[data-admin-support-reply-form="user-profile"] textarea[name="body"]').type(char)
            const snapshot = await page.evaluate(() => {
              const textarea = document.querySelector<HTMLTextAreaElement>('[data-admin-support-reply-form="user-profile"] textarea[name="body"]')
              const selectedConversation = document.querySelector<HTMLButtonElement>('[data-admin-support-conv="user-profile"]')
              const scroll = document.querySelector<HTMLElement>('#support-admin-messages-scroll')
              return {
                hasTextarea: textarea !== null,
                sameTextarea: textarea === window.__firstTextarea,
                selectedProfileId: textarea?.closest<HTMLFormElement>('[data-admin-support-reply-form]')?.dataset.adminSupportReplyForm ?? null,
                hasSelectedConversation: selectedConversation !== null,
                value: textarea?.value ?? '',
                draft: window.__drafts['user-profile'] ?? '',
                active: document.activeElement === textarea,
                selectionStart: textarea?.selectionStart ?? null,
                selectionEnd: textarea?.selectionEnd ?? null,
                scrollTop: scroll?.scrollTop ?? null,
              }
            })

            assert(snapshot.hasTextarea, `[${scenario.label}] reply textarea disappeared`)
            assert(snapshot.sameTextarea, `[${scenario.label}] reply textarea was recreated during input`)
            assert(snapshot.selectedProfileId === 'user-profile', `[${scenario.label}] selected support conversation changed`)
            assert(scenario.mobile || snapshot.hasSelectedConversation, `[${scenario.label}] selected support conversation is missing from the list`)
            assert(snapshot.value === expected, `[${scenario.label}] draft textarea value was lost after "${expected}"`)
            assert(snapshot.draft === expected, `[${scenario.label}] draft state was not updated after "${expected}"`)
            assert(snapshot.active, `[${scenario.label}] reply textarea lost focus`)
            assert(snapshot.selectionStart === expected.length && snapshot.selectionEnd === expected.length, `[${scenario.label}] caret position moved unexpectedly`)
            assert(snapshot.scrollTop === 64, `[${scenario.label}] support message scroll position was reset during typing`)
          }
        } finally {
          await page.close()
        }
      }
    } finally {
      await browser.close()
    }
  })

  console.log(`\nSupport chat typing stability checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

declare global {
  interface Window {
    __drafts: Record<string, string>
    __firstTextarea: HTMLTextAreaElement | null
  }
}
