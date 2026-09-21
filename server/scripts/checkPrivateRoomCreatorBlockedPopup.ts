/**
 * checkPrivateRoomCreatorBlockedPopup.ts
 *
 * Client-side rejection mapping for the "creator block = full seat ban" rule.
 * Drives the REAL createLobbyFlowController with a minimal fake DOM (same
 * FakeRoot/installFakeBrowser approach as checkAdminRegisteredProfilesBehavior.ts)
 * and feeds it real ServerMessage error frames.
 *
 * [1] code 'private_room_creator_blocked_you' on the private-rooms LIST screen
 *     -> popup with the exact two-line text and an "ОК" button (no X-only popup)
 * [2] mapping is by CODE, not by text: same code + a different server message
 *     still shows the client text and never leaks the server text
 * [3] mapping is NOT by text: the creator-blocked sentence under a different
 *     code does not open the popup
 * [4] clicking "ОК" closes the popup
 * [5] same behaviour on the waiting-room (previewer) screen
 * [6] regression: the old partner-block codes still open the OLD X-only popup
 *     and never the new one
 */

import { createLobbyFlowController } from '../../src/app/lobby/createLobbyFlowController.js'
import type { LobbyAuthSession } from '../../src/app/lobby/createLobbyFlowController.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}`)
  }
}

type FakeClickHandler = (ev: Event) => void

class FakeDomElement {
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  private listeners: Record<string, FakeClickHandler[]> = {}
  appendChild(_child: unknown): void {}
  contains(_child: unknown): boolean { return false }
  remove(): void {}
  setAttribute(name: string, value: string): void { (this as unknown as Record<string, unknown>)[name] = value }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void {
    const fn: FakeClickHandler = typeof handler === 'function' ? handler as FakeClickHandler : (ev) => { handler.handleEvent(ev) }
    this.listeners[event] = [...(this.listeners[event] ?? []), fn]
  }
  click(): void {
    for (const handler of this.listeners.click ?? []) handler({ type: 'click' } as Event)
  }
  querySelector<T extends Element>(_selector: string): T | null { return null }
  querySelectorAll<T extends Element>(_selector: string): NodeListOf<T> { return [] as unknown as NodeListOf<T> }
}

// Every `[data-foo="1"]` selector resolves to ONE fake element per render, iff
// the current markup contains that attribute — enough for the popup wiring.
class FakeRoot extends FakeDomElement {
  private html = ''
  private elements = new Map<string, FakeDomElement>()

  set innerHTML(value: string) {
    this.html = value
    this.elements = new Map()
  }
  get innerHTML(): string { return this.html }

  override querySelector<T extends Element>(selector: string): T | null {
    const match = /^\[([a-z0-9-]+)="1"\]$/.exec(selector)
    if (match === null || !this.html.includes(`${match[1]}="1"`)) return null
    let element = this.elements.get(selector)
    if (element === undefined) {
      element = new FakeDomElement()
      this.elements.set(selector, element)
    }
    return element as unknown as T
  }
}

function installFakeBrowser(): void {
  const location = { pathname: '/lobby', search: '', assign: (_url: string) => {} }
  const fakeWindow = {
    innerWidth: 1440, innerHeight: 900, location,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
  }
  const fakeHistory = { pushState: () => {}, replaceState: () => {} }
  const fakeDocument = {
    activeElement: null, title: '', body: new FakeDomElement(), head: new FakeDomElement(),
    createElement: () => new FakeDomElement(), getElementById: () => null, querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  }
  Object.assign(globalThis, {
    window: fakeWindow, document: fakeDocument, history: fakeHistory,
    requestAnimationFrame: fakeWindow.requestAnimationFrame, cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    setTimeout: fakeWindow.setTimeout, clearTimeout: fakeWindow.clearTimeout,
  })
}

function makeSession(): LobbyAuthSession {
  return {
    account: { role: 'player' },
    profile: {
      profileId: 'viewer-profile-001', displayName: 'Viewer', avatarUrl: null,
      level: 10, rankTitle: 'x', skillRating: 1000, completedGamesCount: 0, wonGamesCount: 0,
      currentRankGames: 0, nextRankGames: 10, gamesUntilNextRank: 10, rankProgressRatio: 0,
      averageRating: null, totalRatingsCount: 0, yellowCoinsBalance: 100000, galleryImages: [],
      gender: null, likesCount: 0, hasLikedByMe: null, isBlockedByMe: null,
    },
  } as unknown as LobbyAuthSession
}

const ROOM_ID = 'room-under-test'

function makeRoomSnapshot() {
  return {
    id: ROOM_ID,
    kind: 'open',
    stake: 5000,
    slots: [
      { team: 'A', slotIndex: 0, occupant: { profileId: 'creator-profile', displayName: 'Creator', avatarUrl: null, level: 5, rankTitle: null, isHost: true, isBot: false } },
      { team: 'A', slotIndex: 1, occupant: null },
      { team: 'B', slotIndex: 0, occupant: null },
      { team: 'B', slotIndex: 1, occupant: null },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    manualStart: false,
    canManualStart: false,
  }
}

const CODE = 'private_room_creator_blocked_you'
const POPUP_LINE_1 = 'Вие не можете да седнете в тази маса.'
const POPUP_LINE_2 = 'Създателят ви е блокирал.'
const POPUP_TEXT_HTML = `${POPUP_LINE_1}<br>${POPUP_LINE_2}`
const OK_BUTTON = 'data-private-room-creator-blocked-popup-ok="1"'
const OLD_POPUP_TITLE = 'Не можете да влезете в този отбор'
const OLD_POPUP_CLOSE = 'data-private-room-blocked-popup-close="1"'

function setup(screen: 'list' | 'waiting') {
  installFakeBrowser()
  const root = new FakeRoot()
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeSession(),
  } as any)
  controller.setConnected(true)
  controller.handleServerMessage({ type: 'private_rooms_list', rooms: [makeRoomSnapshot()] } as any)
  if (screen === 'list') {
    controller.navigateToPrivateRooms()
  } else {
    controller.joinPrivateRoom(ROOM_ID)
  }
  return { root, controller }
}

function sendError(controller: ReturnType<typeof createLobbyFlowController>, code: string | undefined, message: string): boolean {
  return controller.handleServerMessage({ type: 'error', message, ...(code !== undefined ? { code } : {}) } as any)
}

const SERVER_TEXT = 'Вие не можете да седнете в тази маса. Създателят ви е блокирал.'

console.log('\ncheckPrivateRoomCreatorBlockedPopup')

for (const screen of ['list', 'waiting'] as const) {
  const tag = screen === 'list' ? 'LIST screen' : 'WAITING-ROOM screen'
  const n = screen === 'list' ? 1 : 5

  {
    const { root, controller } = setup(screen)
    check(`[${n}] ${tag}: precondition — no creator-blocked popup before any error`, !root.innerHTML.includes(OK_BUTTON))
    const handled = sendError(controller, CODE, SERVER_TEXT)
    check(`[${n}a] ${tag}: the error frame is handled`, handled === true)
    check(`[${n}b] ${tag}: popup shows the exact two-line client text`, root.innerHTML.includes(POPUP_TEXT_HTML))
    check(`[${n}c] ${tag}: popup has an "ОК" button`, root.innerHTML.includes(OK_BUTTON) && />ОК<\/button>/.test(root.innerHTML))
    check(`[${n}d] ${tag}: the OLD X-only partner-block popup is NOT shown`, !root.innerHTML.includes(OLD_POPUP_TITLE) && !root.innerHTML.includes(OLD_POPUP_CLOSE))

    ;(root.querySelector(`[${OK_BUTTON}]`) as unknown as FakeDomElement | null)?.click()
    check(`[${n}e] ${tag}: clicking "ОК" closes the popup`, !root.innerHTML.includes(OK_BUTTON) && !root.innerHTML.includes(POPUP_LINE_1))
  }

  {
    const { root, controller } = setup(screen)
    sendError(controller, CODE, 'ЧУЖД СЪРВЪРЕН ТЕКСТ КОЙТО НЕ БИВА ДА СЕ ПОКАЗВА')
    check(`[${n}f] ${tag}: mapping is by CODE — the client text is shown even when the server message differs`, root.innerHTML.includes(POPUP_TEXT_HTML))
    check(`[${n}g] ${tag}: ...and the differing server text is never rendered`, !root.innerHTML.includes('ЧУЖД СЪРВЪРЕН ТЕКСТ'))
  }

  {
    const { root, controller } = setup(screen)
    sendError(controller, 'private_room_slot_taken', SERVER_TEXT)
    check(`[${n}h] ${tag}: the same sentence under a DIFFERENT code does NOT open the popup (no text parsing)`, !root.innerHTML.includes(OK_BUTTON))
    const { root: root2, controller: controller2 } = setup(screen)
    sendError(controller2, undefined, SERVER_TEXT)
    check(`[${n}i] ${tag}: the same sentence with NO code does NOT open the popup either`, !root2.innerHTML.includes(OK_BUTTON))
  }

  for (const oldCode of ['private_room_partner_blocked', 'private_room_partner_blocked_by_viewer']) {
    const { root, controller } = setup(screen)
    sendError(controller, oldCode, 'Този потребител е блокиран от Вас и не може да Ви бъде партньор.')
    check(`[6] ${tag}: ${oldCode} still opens the OLD X-only popup`, root.innerHTML.includes(OLD_POPUP_TITLE) && root.innerHTML.includes(OLD_POPUP_CLOSE))
    check(`[6b] ${tag}: ${oldCode} does NOT open the new creator popup`, !root.innerHTML.includes(OK_BUTTON))
  }
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
