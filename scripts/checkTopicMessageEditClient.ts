import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRootArgIndex = process.argv.indexOf('--project-root')
const projectRoot = projectRootArgIndex >= 0 && process.argv[projectRootArgIndex + 1]
  ? resolve(process.argv[projectRootArgIndex + 1]!)
  : resolve('.')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function read(rel: string): Promise<string> {
  return readFile(resolve(projectRoot, rel), 'utf8')
}

console.log('\n=== Topic Message Edit Client Guard ===\n')

const renderTopics = await read('src/app/lobby/renderTopicsScreen.ts')
const renderLobby = await read('src/app/lobby/renderLobbyScreen.ts')
const controller = await read('src/app/lobby/createLobbyFlowController.ts')
const network = await read('src/app/network/createGameServerClient.ts')
const main = await read('src/main.ts')

await check('[1] DTOs include editedAt for root/reply snapshots and edited WS event', () => {
  assert(network.includes('editedAt: string | null'), 'snapshot editedAt missing')
  assert(network.includes("type: 'topic_message_edited'"), 'edited event type missing')
  assert(network.includes('| TopicMessageEditedMessage'), 'ServerMessage union missing edited event')
})

await check('[2] UI renders edited marker next to timestamp', () => {
  assert(renderTopics.includes("editedAt !== null ? ' · редактирано' : ''"), 'edited marker missing')
})

await check('[3] edit button is owner-only and distinct from moderator delete', () => {
  assert(renderTopics.includes('function renderTopicMessageEditButton'), 'edit button renderer missing')
  assert(renderTopics.includes('const isOwner = state.profile.profileId !== null && senderProfileId === state.profile.profileId'), 'owner check missing')
  assert(renderTopics.includes('if (!isOwner) return'), 'non-owner visibility guard missing')
})

await check('[3.1] edit action icon is deterministic SVG, not Unicode pencil', () => {
  const editButtonBlock = renderTopics.slice(renderTopics.indexOf('function renderTopicMessageEditButton'), renderTopics.indexOf('function renderTopicMessageEditForm'))
  assert(renderTopics.includes('function renderTopicActionIcon'), 'shared action icon helper missing')
  assert(editButtonBlock.includes("renderTopicActionIcon('edit')"), 'edit button must use SVG helper')
  assert(!editButtonBlock.includes('&#9998;'), 'edit button must not use Unicode pencil')
  assert(renderTopics.includes('width="20" height="20" viewBox="0 0 24 24"'), 'SVG must use deterministic viewBox')
  assert(renderTopics.includes('stroke="currentColor"'), 'SVG must inherit currentColor')
})

await check('[4] blocked edit states are visible and do not use native disabled', () => {
  assert(renderTopics.includes('data-topic-message-edit-blocked="1"'), 'blocked edit data attribute missing')
  assert(renderTopics.includes('Не можете да редактирате публикация, към която вече има отговори.'), 'root replies message missing')
  assert(renderTopics.includes('Времето за редакция изтече.'), 'expired message missing')
  assert(renderTopics.includes('Темата е заключена.'), 'locked message missing')
  const editButtonBlock = renderTopics.slice(renderTopics.indexOf('function renderTopicMessageEditButton'), renderTopics.indexOf('function renderTopicMessageEditForm'))
  assert(!editButtonBlock.includes(' disabled'), 'blocked edit button should not use native disabled')
})

await check('[5] inline editor has textarea, cancel/save, preserves attachment rendering outside editor', () => {
  assert(renderTopics.includes('function renderTopicMessageEditForm'), 'edit form renderer missing')
  assert(renderTopics.includes('data-topic-message-edit-text'), 'edit textarea missing')
  assert(renderTopics.includes('data-topic-message-edit-cancel'), 'cancel hook missing')
  assert(renderTopics.includes('data-topic-message-edit-save'), 'save hook missing')
  assert(renderTopics.includes('reply.attachment ? renderTopicAttachment'), 'reply attachment should remain rendered')
  assert(renderTopics.includes('message.attachment ? renderTopicAttachment'), 'root attachment should remain rendered')
})

await check('[6] DOM wiring handles edit click/input/cancel/submit and blocked tooltip', () => {
  assert(renderLobby.includes('[data-topic-message-edit]'), 'edit click wiring missing')
  assert(renderLobby.includes("btn.dataset.topicMessageEditBlocked === '1'"), 'blocked click guard missing')
  assert(renderLobby.includes('data-topic-message-edit-form'), 'form submit wiring missing')
  assert(renderLobby.includes('data-topic-message-edit-text'), 'textarea input wiring missing')
  assert(renderLobby.includes('data-topic-message-edit-cancel'), 'cancel wiring missing')
})

await check('[7] controller has one-editor state, submit guard, and realtime no-create update', () => {
  assert(controller.includes('topicMessageEdit: { topicId: string; messageId: string; draft: string } | null'), 'edit state missing')
  assert(controller.includes('if (edit === null || edit.messageId !== messageId || state.topicMessageEditBusy) return'), 'double-save guard missing')
  assert(controller.includes("message.type === 'topic_message_edited'"), 'realtime edit handler missing')
  assert(controller.includes('applyTopicMessageEdit(message.messageId, message.parentMessageId, message.body, message.editedAt)'), 'realtime update call missing')
  assert(controller.includes('if (!replies) return false'), 'reply no-create guard missing')
})

await check('[8] main.ts uses PATCH /api/topics/:topicId/messages/:messageId and controller option', () => {
  assert(main.includes('async function editTopicMessage'), 'HTTP edit helper missing')
  assert(main.includes("method: 'PATCH'"), 'PATCH method missing')
  assert(main.includes('onTopicMessageEdit: (topicId, messageId, body) => editTopicMessage(topicId, messageId, body)'), 'controller callback missing')
})

console.log(`\nTopic message edit client guard: ${passed} passed, ${failed} failed.`)
if (failed > 0) process.exitCode = 1
