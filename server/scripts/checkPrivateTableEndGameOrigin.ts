/**
 * checkPrivateTableEndGameOrigin.ts
 *
 * Verifies the server-authoritative "isPrivateTableOrigin" flag that drives
 * the end-game screen's button set: private-table games (normal 4-human
 * start AND "Запълни с ботове") show only "Преиграй" + "Към лобито" ("Изход"),
 * public/matchmaking games keep all three buttons, and guest-trial rooms
 * (which also set config.isPrivate=true) are NOT misclassified as
 * private-table-origin.
 *
 * Part A: real execution of createRoomSnapshotMessage() (the single choke
 * point every room snapshot broadcast goes through — see
 * server/src/core/broadcastRoomSnapshots.ts) against minimal ServerRoom
 * fixtures built with the actual createServerRoom() factory, proving the
 * exact server-authoritative computation, not just its presence in source.
 *
 * Part B: source-text checks that the private-room-origin game-start paths
 * (handlePrivateRoomFull / handlePrivateRoomBotFill in index.ts) set the
 * flag, that the public/guest-trial paths never do, and that the client
 * threads the value from the server snapshot end-to-end without deriving it
 * from bot/human counts, stake, or room name.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'

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

// ---------------------------------------------------------------------------
// Part A — real execution against createRoomSnapshotMessage
// ---------------------------------------------------------------------------

{
  const privateTableRoom = createServerRoom({
    config: { isPrivate: true, isPrivateTableOrigin: true, allowBots: false },
  })
  const snapshot = createRoomSnapshotMessage(privateTableRoom, null)
  check(
    '[A1] a private-table-origin room snapshot carries isPrivateTableOrigin=true',
    snapshot.isPrivateTableOrigin === true,
  )
}

{
  const botFilledPrivateTableRoom = createServerRoom({
    config: { isPrivate: true, isPrivateTableOrigin: true, allowBots: true },
  })
  const snapshot = createRoomSnapshotMessage(botFilledPrivateTableRoom, null)
  check(
    '[A2] a private table started via "Запълни с ботове" (allowBots:true) still carries isPrivateTableOrigin=true',
    snapshot.isPrivateTableOrigin === true,
  )
}

{
  const guestTrialRoom = createServerRoom({
    config: { isPrivate: true, isGuestTrial: true, allowBots: true },
  })
  const snapshot = createRoomSnapshotMessage(guestTrialRoom, null)
  check(
    '[A3] guest-trial room (isPrivate=true but NOT private-table-origin) reports isPrivateTableOrigin=false — not conflated with private tables',
    snapshot.isPrivateTableOrigin === false,
  )
}

{
  const publicMatchmakingRoom = createServerRoom({
    config: { isPrivate: false, allowBots: true },
  })
  const snapshot = createRoomSnapshotMessage(publicMatchmakingRoom, null)
  check(
    '[A4] a public matchmaking room reports isPrivateTableOrigin=false',
    snapshot.isPrivateTableOrigin === false,
  )
}

{
  const defaultRoom = createServerRoom({})
  const snapshot = createRoomSnapshotMessage(defaultRoom, null)
  check(
    '[A5] default room config (no explicit flags) reports isPrivateTableOrigin=false (safe default)',
    snapshot.isPrivateTableOrigin === false,
  )
}

// ---------------------------------------------------------------------------
// Part B — source-text checks for the game-start paths and client threading
// ---------------------------------------------------------------------------

const currentDir = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(currentDir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

{
  const indexTs = readSource('server/src/index.ts')

  function sliceBetween(source: string, startMarker: string, endMarker: string): string | null {
    const start = source.indexOf(startMarker)
    if (start === -1) return null
    const end = source.indexOf(endMarker, start + startMarker.length)
    if (end === -1) return null
    return source.slice(start, end)
  }

  const handlePrivateRoomFullBody = sliceBetween(
    indexTs,
    'function handlePrivateRoomFull',
    'function handlePrivateRoomExpired',
  )
  const handlePrivateRoomBotFillBody = sliceBetween(
    indexTs,
    'function handlePrivateRoomBotFill',
    'const privateRoomChatStore',
  )

  check(
    '[B1] handlePrivateRoomFull found in index.ts',
    handlePrivateRoomFullBody !== null,
  )
  check(
    '[B1b] handlePrivateRoomFull (normal 4-human private start) sets isPrivateTableOrigin: true',
    handlePrivateRoomFullBody !== null && /isPrivateTableOrigin:\s*true/.test(handlePrivateRoomFullBody),
  )

  check(
    '[B2] handlePrivateRoomBotFill found in index.ts',
    handlePrivateRoomBotFillBody !== null,
  )
  check(
    '[B2b] handlePrivateRoomBotFill ("Запълни с ботове" start) sets isPrivateTableOrigin: true',
    handlePrivateRoomBotFillBody !== null && /isPrivateTableOrigin:\s*true/.test(handlePrivateRoomBotFillBody),
  )
}

{
  const matchedRoomTs = readSource('server/src/matchmaking/createMatchedRoomFromEntries.ts')
  check(
    '[B3] public matchmaking room creation (createMatchedRoomFromEntries.ts) never sets isPrivateTableOrigin',
    !matchedRoomTs.includes('isPrivateTableOrigin'),
  )
}

{
  const guestTrialTs = readSource('server/src/core/createGuestTrialRoom.ts')
  check(
    '[B4] guest-trial room creation (createGuestTrialRoom.ts) never sets isPrivateTableOrigin',
    !guestTrialTs.includes('isPrivateTableOrigin'),
  )
}

{
  const renderMatchEndedTs = readSource('src/app/activeRoom/renderMatchEndedScreen.ts')

  check(
    '[B5] RenderMatchEndedScreenOptions declares isPrivateTableOrigin',
    /isPrivateTableOrigin\?:\s*boolean/.test(renderMatchEndedTs),
  )

  function sliceBetween(source: string, startMarker: string, endMarker: string): string | null {
    const start = source.indexOf(startMarker)
    if (start === -1) return null
    const end = source.indexOf(endMarker, start + startMarker.length)
    if (end === -1) return null
    return source.slice(start, end)
  }

  const mobilePanelBody = sliceBetween(
    renderMatchEndedTs,
    'function renderMobileMatchEndedPanel',
    'function renderMatchEndedPanel',
  )
  const desktopPanelBody = sliceBetween(
    renderMatchEndedTs,
    'function renderMatchEndedPanel',
    'export function renderMatchEndedScreen',
  )

  check('[B6] mobile match-ended panel function found', mobilePanelBody !== null)
  check(
    '[B6b] mobile panel conditionally omits the "Нова игра" button markup based on isPrivateTableOrigin',
    mobilePanelBody !== null &&
      /isPrivateTableOrigin\s*\?\s*''\s*:\s*`/.test(mobilePanelBody) &&
      mobilePanelBody.includes('data-match-ended-new-game-button'),
  )
  check(
    '[B6c] mobile panel always renders the replay button regardless of isPrivateTableOrigin',
    mobilePanelBody !== null &&
      /data-match-ended-replay-button="1"/.test(mobilePanelBody) &&
      !new RegExp('isPrivateTableOrigin[^\\n]*data-match-ended-replay-button').test(mobilePanelBody),
  )

  check('[B7] desktop match-ended panel function found', desktopPanelBody !== null)
  check(
    '[B7b] desktop panel conditionally omits the "Нова игра" button markup based on isPrivateTableOrigin',
    desktopPanelBody !== null &&
      /isPrivateTableOrigin\s*\?\s*''\s*:\s*`/.test(desktopPanelBody) &&
      desktopPanelBody.includes('data-match-ended-new-game-button'),
  )

  check(
    '[B8] the lobby ("Към лобито") button markup is never conditioned on isPrivateTableOrigin',
    (() => {
      const lobbyButtonIndex = renderMatchEndedTs.indexOf('data-match-ended-lobby-button="1"')
      if (lobbyButtonIndex === -1) return false
      const windowBefore = renderMatchEndedTs.slice(Math.max(0, lobbyButtonIndex - 200), lobbyButtonIndex)
      return !windowBefore.includes('isPrivateTableOrigin')
    })(),
  )
}

{
  const controllerTs = readSource('src/app/activeRoom/createActiveRoomFlowController.ts')
  check(
    '[B9] applyRoomSnapshotToActiveRoom copies isPrivateTableOrigin straight from the server message (server-authoritative, not derived locally)',
    /activeRoomState\.isPrivateTableOrigin = message\.isPrivateTableOrigin/.test(controllerTs),
  )
  check(
    '[B10] renderMatchEndedScreen is invoked with isPrivateTableOrigin sourced from activeRoomState (not from botPlayers/humanPlayers/stake)',
    /isPrivateTableOrigin:\s*activeRoomState\.isPrivateTableOrigin/.test(controllerTs),
  )
}

{
  const activeRoomTypesTs = readSource('src/app/activeRoom/activeRoomTypes.ts')
  check(
    '[B11] ActiveRoomState declares isPrivateTableOrigin as a plain boolean (server-driven field, not optional/derived)',
    /isPrivateTableOrigin:\s*boolean/.test(activeRoomTypesTs),
  )
}

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
