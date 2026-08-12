/**
 * Source-level regression guard for Topics individual message self-delete UI.
 *
 * The browser harnesses cover broader Topics interactions. This file pins the
 * narrow owner/moderator delete contract added for self-delete:
 * visibility, blocked own-root-with-replies UX, moderator precedence, and
 * confirmation text branching.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('.')

const topicsScreenSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')
const renderLobbySrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

console.log('\n=== Topic Message Self-Delete Client UI ===\n')

const deleteButtonFn = topicsScreenSrc.match(/function renderTopicMessageDeleteButton\([\s\S]*?\n\}/)?.[0] ?? ''
const deleteConfirmFn = topicsScreenSrc.match(/function renderTopicMessageDeleteConfirmPopup\([\s\S]*?\n\}/)?.[0] ?? ''
const deleteClickBlock = renderLobbySrc.match(/root\.querySelectorAll<HTMLButtonElement>\('\[data-topic-message-delete\]'\)[\s\S]*?\n  \}\)/)?.[0] ?? ''
const openConfirmFn = controllerSrc.match(/function openTopicMessageDeleteConfirm\([\s\S]*?\n  \}/)?.[0] ?? ''

check('[1] delete button is visible for moderator OR owner', () => {
  assert(deleteButtonFn.includes('const isModerator = state.isTopicMessageModerator'), 'must compute moderator capability')
  assert(deleteButtonFn.includes('const isOwner = state.profile.profileId !== null && senderProfileId === state.profile.profileId'), 'must compute ownership')
  assert(deleteButtonFn.includes('if (!isModerator && !isOwner) return'), 'must hide control from non-owner non-moderator players')
})

check('[2] author+moderator overlap uses one moderator-action control', () => {
  assert(deleteButtonFn.includes('const isModeratorAction = isModerator'), 'moderator capability must win for overlap')
  assert(deleteButtonFn.includes('data-topic-message-delete-is-moderator-action'), 'DOM must carry action kind into confirmation flow')
})

check('[3] ordinary owner root with replies is visible but blocked', () => {
  assert(deleteButtonFn.includes('!isModerator && isOwner && isRoot && replyCount > 0'), 'must detect blocked own root with live replies')
  assert(deleteButtonFn.includes('aria-disabled="true"'), 'blocked control must use aria-disabled, not native disabled')
  assert(deleteButtonFn.includes('data-topic-message-delete-blocked="1"'), 'blocked control must be marked for click guard')
  assert(deleteButtonFn.includes('Не можете да изтриете публикация, към която вече има отговори.'), 'blocked explanation text must be present')
})

check('[4] blocked tap/click shows explanation and sends no DELETE request', () => {
  assert(deleteClickBlock.includes("btn.dataset.topicMessageDeleteBlocked === '1'"), 'click handler must branch for blocked controls')
  assert(deleteClickBlock.includes("btn.dataset.tooltipOpen = '1'"), 'blocked click must explicitly open tooltip for touch/mobile')
  assert(deleteClickBlock.includes('return'), 'blocked branch must return before invoking onTopicMessageDeleteClick')
  const blockedBranchIndex = deleteClickBlock.indexOf("btn.dataset.topicMessageDeleteBlocked === '1'")
  const callbackIndex = deleteClickBlock.indexOf('options.onTopicMessageDeleteClick')
  assert(blockedBranchIndex !== -1 && callbackIndex !== -1 && blockedBranchIndex < callbackIndex, 'blocked branch must run before callback')
})

check('[5] tooltip CSS supports mobile/touch open state', () => {
  assert(topicsScreenSrc.includes('.topic-message-action-btn[data-tooltip-open="1"]::after'), 'CSS must expose tooltip-open state')
  assert(topicsScreenSrc.includes('@media (hover: none) and (pointer: coarse)'), 'mobile hover guard must remain present')
})

check('[6] confirmation popup branches moderator root vs own root text', () => {
  assert(deleteConfirmFn.includes('pending.isModeratorAction'), 'confirmation must branch on action capability')
  assert(deleteConfirmFn.includes('Съобщението и всички отговори към него ще бъдат премахнати.'), 'moderator root warning must mention replies')
  assert(deleteConfirmFn.includes('Съобщението ще бъде премахнато.'), 'ordinary own-root warning must not mention replies')
})

check('[7] controller stores isModeratorAction in pending delete state', () => {
  assert(renderLobbySrc.includes('topicMessageDeleteConfirm: { topicId: string; messageId: string; isRoot: boolean; isModeratorAction: boolean } | null'), 'LobbyScreenState must include isModeratorAction')
  assert(controllerSrc.includes('topicMessageDeleteConfirm: { topicId: string; messageId: string; isRoot: boolean; isModeratorAction: boolean } | null'), 'controller state must include isModeratorAction')
  assert(openConfirmFn.includes('isModeratorAction: boolean'), 'open confirm function must accept isModeratorAction')
  assert(openConfirmFn.includes('state.topicMessageDeleteConfirm = { topicId, messageId, isRoot, isModeratorAction }'), 'open confirm must persist action kind')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
