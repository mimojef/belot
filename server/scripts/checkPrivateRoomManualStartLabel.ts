/**
 * checkPrivateRoomManualStartLabel.ts
 *
 * Verifies the "Ръчен старт" (manual start) visual indicator added to:
 *  [1] the Private Rooms LIST card (renderLobbyScreen.ts roomRowHtml) — shown
 *      next to the creator's name when room.manualStart===true, for every
 *      list entry (not just the viewer's own room), hidden when false;
 *  [2] the waiting-room screen (renderPrivateRoomWaitingScreen.ts) — shown in
 *      the subtitle next to the "Чакалня — частна маса" title when
 *      params.manualStart===true, visible for ALL viewer roles (member AND
 *      previewer — the param is never gated behind isLocalHost), hidden when
 *      false.
 *
 * [1] is a source-string check (roomRowHtml is a private closure inside
 * renderPrivateRoomsPage, not exported — mirrors the established source-check
 * pattern used elsewhere in this suite, e.g. checkGiftLimitFrontend.ts).
 * [2] calls the REAL exported renderPrivateRoomWaitingScreen() function with
 * both manualStart:true and manualStart:false params and asserts on the
 * actual rendered HTML output — a stronger check than a source string match.
 *
 * Does NOT touch: the manual-start toggle itself, the START button, 4/4
 * readiness, auto-start behavior, or any other room lifecycle logic — see
 * checkPrivateRoomManualStartAndKick.ts for that (store-level) coverage.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  renderPrivateRoomWaitingScreen,
  type RenderPrivateRoomWaitingScreenParams,
} from '../../src/app/lobby/renderPrivateRoomWaitingScreen.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

console.log('\n=== Private Room manual-start label (list + waiting room) ===\n')

// ── [1] List card (source-level — roomRowHtml is a private closure) ────────

const renderLobbySrc = readFileSync(
  resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'),
  'utf8',
)

// Isolate the roomRowHtml closure so we don't accidentally match unrelated
// "Ръчен старт" text elsewhere in the file (e.g. the create-room checkbox
// label, which is a different, pre-existing feature). Sliced between its
// declaration and the next sibling const (allRooms) — safer than a
// brace-matching regex, which can stop early at the first nested `}` with
// matching indentation.
const roomRowStart = renderLobbySrc.indexOf('const roomRowHtml = (room: PrivateRoomSnapshot): string => {')
const roomRowEnd = renderLobbySrc.indexOf('const allRooms = [', roomRowStart)
const roomRowSrc = roomRowStart >= 0 && roomRowEnd > roomRowStart
  ? renderLobbySrc.slice(roomRowStart, roomRowEnd)
  : ''

check('[1] roomRowHtml closure found in renderLobbyScreen.ts', roomRowSrc.length > 0)
check(
  '[1] list card: manual-start label is conditional on room.manualStart (authoritative field, not a derived UI state)',
  roomRowSrc.includes('room.manualStart ?') && roomRowSrc.includes('Ръчен старт'),
)
check(
  '[1] list card: label sits next to the creator/host name (hostOccupant?.displayName), not elsewhere in the card',
  /hostOccupant\?\.displayName[\s\S]{0,400}room\.manualStart \?[\s\S]{0,300}Ръчен старт/.test(roomRowSrc),
)
check(
  '[1] list card: does NOT gate the label behind isMine/isLocalHost (must be visible to every viewer)',
  !/room\.manualStart && isMine/.test(roomRowSrc) && !/isMine[\s\S]{0,50}room\.manualStart/.test(roomRowSrc),
)

// ── [2] Waiting room (real render call — actual HTML output) ───────────────

function baseParams(manualStart: boolean, viewerRole: 'member' | 'previewer'): RenderPrivateRoomWaitingScreenParams {
  return {
    isLocked: false,
    stake: 5000,
    slots: [
      { team: 'A', slotIndex: 0, occupant: { profileId: 'p1', displayName: 'Host', avatarUrl: null, level: 10, rankTitle: null, isHost: true, isBot: false } },
      { team: 'A', slotIndex: 1, occupant: null },
      { team: 'B', slotIndex: 0, occupant: null },
      { team: 'B', slotIndex: 1, occupant: null },
    ],
    localProfileId: viewerRole === 'member' ? 'p1' : 'someone-else',
    viewerRole,
    joinSlotPopup: null,
    leaveConfirmOpen: false,
    kickConfirmPopup: null,
    blockedPopupText: null,
    botActionLoadingTeam: null,
    inviteFriendsPopupOpen: false,
    inviteFriends: null,
    chatMessages: [],
    chatDraft: '',
    chatSending: false,
    chatErrorText: null,
    infoText: null,
    expiresAt: Date.now() + 600_000,
    kickedPopupOpen: false,
    manualStart,
    canManualStart: false,
    isLocalHost: viewerRole === 'member',
    startInFlight: false,
  }
}

const htmlManualOn_member = renderPrivateRoomWaitingScreen(baseParams(true, 'member'))
const htmlManualOn_previewer = renderPrivateRoomWaitingScreen(baseParams(true, 'previewer'))
const htmlManualOff = renderPrivateRoomWaitingScreen(baseParams(false, 'member'))

check(
  '[2] waiting room: manualStart=true → "Ръчен старт" visible next to the title (member/host view)',
  htmlManualOn_member.includes('Чакалня') && htmlManualOn_member.includes('Ръчен старт'),
)
check(
  '[2] waiting room: manualStart=true → "Ръчен старт" ALSO visible to a non-host previewer (visible to ALL participants, not just the creator)',
  htmlManualOn_previewer.includes('Ръчен старт'),
)
check(
  '[2] waiting room: manualStart=false → label is absent entirely',
  !htmlManualOff.includes('Ръчен старт'),
)
check(
  '[2] waiting room: the label sits in the subtitle immediately after the title (same header block)',
  /prw-title[\s\S]{0,400}Ръчен старт/.test(htmlManualOn_member),
)

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
