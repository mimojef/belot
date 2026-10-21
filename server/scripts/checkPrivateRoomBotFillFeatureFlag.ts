/**
 * checkPrivateRoomBotFillFeatureFlag.ts
 *
 * Verifies BELOT_PRIVATE_BOT_FILL_ENABLED (src/app/lobby/privateRoomBotFillFeatureFlag.ts)
 * gating of the per-team "Запълни с бот" button in the private-room waiting
 * screen, by calling the REAL exported renderPrivateRoomWaitingScreen() with
 * the flag forced OFF and ON and asserting on the rendered HTML.
 *
 *  [0] the flag defaults to false;
 *  [1] OFF → no bot row/button at all (no empty placeholder), for member and
 *      previewer views; invite / manual start / join slots still render;
 *  [2] OFF + a bot already in the team (room created before the switch) →
 *      "Махни бот" stays available so the bot can still be removed;
 *  [3] ON → the button renders exactly as before (fill enabled for own team,
 *      disabled for the opponent team, remove mode when a bot is present);
 *  [4] the bot-add wiring (controller click handler + WS client send) is
 *      left untouched — source-level check.
 *
 * Does NOT touch server-side bot logic — see checkPrivateRoomBotOwnership.ts.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  renderPrivateRoomWaitingScreen,
  type PrivateRoomWaitingSlotSnapshot,
  type RenderPrivateRoomWaitingScreenParams,
} from '../../src/app/lobby/renderPrivateRoomWaitingScreen.js'
import {
  BELOT_PRIVATE_BOT_FILL_ENABLED,
  __setBelotPrivateBotFillOverrideForTests,
  isBelotPrivateBotFillEnabled,
} from '../../src/app/lobby/privateRoomBotFillFeatureFlag.js'

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

console.log('\n=== Private Room "Запълни с бот" feature flag ===\n')

function human(profileId: string, displayName: string, isHost: boolean) {
  return { profileId, displayName, avatarUrl: null, level: 5, rankTitle: null, isHost, isBot: false }
}

const bot = { profileId: null, displayName: 'Бот', avatarUrl: null, level: null, rankTitle: null, isHost: false, isBot: true }

function params(
  slots: PrivateRoomWaitingSlotSnapshot[],
  viewerRole: 'member' | 'previewer',
  overrides: Partial<RenderPrivateRoomWaitingScreenParams> = {},
): RenderPrivateRoomWaitingScreenParams {
  return {
    isLocked: true,
    stake: 5000,
    slots,
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
    manualStart: true,
    canManualStart: false,
    isLocalHost: viewerRole === 'member',
    startInFlight: false,
    ...overrides,
  }
}

// 1 човек на отбор — без flag-а и двамата собственици биха видели активен "Запълни с бот".
const oneHumanPerTeam: PrivateRoomWaitingSlotSnapshot[] = [
  { team: 'A', slotIndex: 0, occupant: human('p1', 'Host', true) },
  { team: 'A', slotIndex: 1, occupant: null },
  { team: 'B', slotIndex: 0, occupant: human('p2', 'Guest', false) },
  { team: 'B', slotIndex: 1, occupant: null },
]

// Отбор А вече има бот (стая отпреди изключването).
const teamAWithBot: PrivateRoomWaitingSlotSnapshot[] = [
  { team: 'A', slotIndex: 0, occupant: human('p1', 'Host', true) },
  { team: 'A', slotIndex: 1, occupant: bot },
  { team: 'B', slotIndex: 0, occupant: human('p2', 'Guest', false) },
  { team: 'B', slotIndex: 1, occupant: null },
]

function botButton(html: string, team: 'A' | 'B'): string | null {
  const match = new RegExp(`<button[^>]*data-private-room-bot-team="${team}"[^>]*>[^<]*</button>`).exec(html)
  return match ? match[0] : null
}

function stripStyle(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, '')
}

// ── [0] Default ─────────────────────────────────────────────────────────────

__setBelotPrivateBotFillOverrideForTests(undefined)
check('[0] BELOT_PRIVATE_BOT_FILL_ENABLED defaults to false', BELOT_PRIVATE_BOT_FILL_ENABLED === false)
check('[0] isBelotPrivateBotFillEnabled() reflects the default (false)', isBelotPrivateBotFillEnabled() === false)

// ── [1] OFF ─────────────────────────────────────────────────────────────────

{
  const memberHtml = stripStyle(renderPrivateRoomWaitingScreen(params(oneHumanPerTeam, 'member')))
  const previewerHtml = stripStyle(renderPrivateRoomWaitingScreen(params(oneHumanPerTeam, 'previewer')))

  check('[1] OFF member: no "Запълни с бот" text', !memberHtml.includes('Запълни с бот'))
  check('[1] OFF member: no bot button for either team', botButton(memberHtml, 'A') === null && botButton(memberHtml, 'B') === null)
  check('[1] OFF member: no empty prw-bot-row placeholder left behind', !memberHtml.includes('prw-bot-row'))
  check('[1] OFF previewer: no bot row/button either', !previewerHtml.includes('prw-bot-row') && !previewerHtml.includes('Запълни с бот'))
  check('[1] OFF: team columns + slots still render', (memberHtml.match(/class="prw-team"/g) ?? []).length === 2 && memberHtml.includes('data-private-room-slot-join="A:1"'))
  check('[1] OFF: "+ Покани приятели" still rendered', memberHtml.includes('data-private-room-invite-open="1"'))
  check('[1] OFF: host START (manual start) button still rendered', memberHtml.includes('data-private-room-manual-start="1"'))
  check('[1] OFF previewer: empty slots are still clickable for join', /data-private-room-slot-join="A:1"[^>]*>/.test(previewerHtml) && !/data-private-room-slot-join="A:1"[\s\S]{0,120}disabled/.test(previewerHtml))
}

// ── [2] OFF + existing bot ──────────────────────────────────────────────────

{
  const html = stripStyle(renderPrivateRoomWaitingScreen(params(teamAWithBot, 'member')))
  const btnA = botButton(html, 'A')
  check('[2] OFF + existing bot: "Махни бот" still shown for the owning team', btnA !== null && btnA.includes('Махни бот') && btnA.includes('data-private-room-bot-mode="remove"'))
  check('[2] OFF + existing bot: "Махни бот" is enabled', btnA !== null && !/\sdisabled[\s>]/.test(btnA))
  check('[2] OFF + existing bot: team without bot shows no fill button', botButton(html, 'B') === null && !html.includes('Запълни с бот'))
}

// ── [3] ON ──────────────────────────────────────────────────────────────────

__setBelotPrivateBotFillOverrideForTests(true)
check('[3] override ON → isBelotPrivateBotFillEnabled() === true', isBelotPrivateBotFillEnabled() === true)

{
  const html = stripStyle(renderPrivateRoomWaitingScreen(params(oneHumanPerTeam, 'member')))
  const btnA = botButton(html, 'A')
  const btnB = botButton(html, 'B')
  check('[3] ON: own team (A) shows "Запълни с бот", mode=fill', btnA !== null && btnA.includes('Запълни с бот') && btnA.includes('data-private-room-bot-mode="fill"'))
  check('[3] ON: own team button is enabled', btnA !== null && !/\sdisabled[\s>]/.test(btnA))
  check('[3] ON: opponent team (B) shows "Запълни с бот" but disabled', btnB !== null && btnB.includes('Запълни с бот') && /\sdisabled[\s>]/.test(btnB))

  const loadingHtml = stripStyle(renderPrivateRoomWaitingScreen(params(oneHumanPerTeam, 'member', { botActionLoadingTeam: 'A' })))
  const loadingBtn = botButton(loadingHtml, 'A')
  check('[3] ON: in-flight state shows "..." and disables the button', loadingBtn !== null && loadingBtn.includes('...') && /\sdisabled[\s>]/.test(loadingBtn))

  const withBotHtml = stripStyle(renderPrivateRoomWaitingScreen(params(teamAWithBot, 'member')))
  const removeBtn = botButton(withBotHtml, 'A')
  check('[3] ON: team with bot shows enabled "Махни бот"', removeBtn !== null && removeBtn.includes('Махни бот') && !/\sdisabled[\s>]/.test(removeBtn))
}

__setBelotPrivateBotFillOverrideForTests(false)
check('[3] override OFF explicitly → hidden again', !renderPrivateRoomWaitingScreen(params(oneHumanPerTeam, 'member')).includes('Запълни с бот'))
__setBelotPrivateBotFillOverrideForTests(undefined)

// ── [4] Bot-add wiring untouched ────────────────────────────────────────────

const controllerSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const clientSrc = readFileSync(resolve(PROJECT_ROOT, 'src/app/network/createGameServerClient.ts'), 'utf8')
check('[4] controller click handler for [data-private-room-bot-team] still wired to onPrivateRoomAddBot', /\[data-private-room-bot-team\][\s\S]{0,800}onPrivateRoomAddBot/.test(controllerSrc))
check('[4] WS client still sends add_bot_to_private_room_team', clientSrc.includes("send({ type: 'add_bot_to_private_room_team', team })"))

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)
if (failed > 0) process.exit(1)
