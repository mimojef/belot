/**
 * checkFriendAcceptChatConversationSync.ts
 *
 * Regression проверка за production bug сигнала: friend remove → re-add →
 * accept оставяше state.chatConversations stale, докато потребителят ръчно
 * не отвореше "Чат" таба отново или не пристигнеше нов realtime chat
 * съобщение (виж diagnostic сесията — friendshipStore.ts/chatStore.ts вече
 * работят коректно, reuse-ват СЪЩИЯ friendship_id и пазят history-то; само
 * frontend-ът не синхронизираше state.chatConversations веднага след accept).
 *
 * Проектът няма jsdom, а createLobbyFlowController е твърде голям за лек
 * headless instantiation harness тук — затова, следвайки established pattern
 * от checkChatMessageNotification.ts (§B), тестовете са source-text проверки
 * върху точния `friend_request_accepted` handler блок в
 * createLobbyFlowController.ts, не regex по целия файл.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function extractHandlerBlock(source: string): string {
  const startMarker = `if (message.type === 'friend_request_accepted') {`
  const startIdx = source.indexOf(startMarker)
  assert(startIdx !== -1, `friend_request_accepted handler block not found in ${CONTROLLER_PATH}`)

  // Brace-balanced extraction of the `if (...) { ... }` block starting at startIdx.
  let depth = 0
  let i = startIdx
  let blockStart = -1
  for (; i < source.length; i++) {
    if (source[i] === '{') {
      if (depth === 0) blockStart = i
      depth++
    } else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        return source.slice(blockStart, i + 1)
      }
    }
  }
  throw new Error('Unbalanced braces while extracting friend_request_accepted handler block')
}

async function main(): Promise<void> {
  console.log('\n=== checkFriendAcceptChatConversationSync ===\n')

  const source = await readFile(CONTROLLER_PATH, 'utf8')
  const handlerBlock = extractHandlerBlock(source)

  check('[1] friend_request_accepted handler still updates state.friendships optimistically (outgoingPending -> friends)', () => {
    assert(
      handlerBlock.includes('state.friendships = {') &&
        handlerBlock.includes('outgoingPending:') &&
        handlerBlock.includes('friends: ['),
      'optimistic state.friendships update was removed or changed shape',
    )
  })

  check('[2] Fix: handler now triggers loadChatConversations() so state.chatConversations is not left stale after accept', () => {
    assert(
      handlerBlock.includes('loadChatConversations()'),
      'friend_request_accepted handler does not call loadChatConversations() — production stale-conversation-list bug would regress',
    )
  })

  check('[3] loadChatConversations() call is fire-and-forget (void + .then), matching established call sites — no unhandled-rejection/blocking risk', () => {
    assert(
      /void\s+loadChatConversations\(\)\.then\(/.test(handlerBlock),
      'loadChatConversations() call does not follow the established `void loadChatConversations().then(...)` pattern used elsewhere in this file',
    )
  })

  check('[4] Fix does not touch pagination (PERSONAL_CHAT_HISTORY_LIMIT) or backend stores', () => {
    assert(
      !source.includes('PERSONAL_CHAT_HISTORY_LIMIT ='),
      'createLobbyFlowController.ts should not define/redefine PERSONAL_CHAT_HISTORY_LIMIT — that constant belongs to server/src/db/chatStore.ts',
    )
    assert(
      !handlerBlock.includes('mergeChatMessages'),
      'friend_request_accepted handler should not touch mergeChatMessages — that is unrelated realtime-message merge logic',
    )
  })

  check('[5] Fix does not add any vip_dm-specific branching inside the friend_request_accepted handler', () => {
    assert(
      !handlerBlock.includes('vip_dm'),
      'friend_request_accepted handler should stay kind-agnostic here — vip_dm filtering already happens inside loadChatConversations()/getFriendChatConversations() elsewhere',
    )
  })

  check('[6] loadChatConversations() itself still reconciles (not clears unconditionally) the active conversation — existing active chat is preserved unless truly gone', () => {
    const reconcileFnMatch = source.match(
      /function reconcileActiveChatConversation\(\): void \{[\s\S]*?\n  \}/,
    )
    assert(reconcileFnMatch !== null, 'reconcileActiveChatConversation function not found')
    const fnBody = reconcileFnMatch![0]
    assert(
      fnBody.includes('if (activeConversation === null || !isChatConversationValidForCurrentSurface(activeConversation))'),
      'reconcileActiveChatConversation no longer guards clearing the active conversation on "still present and valid" — a newly-accepted friend refresh could now wrongly close an unrelated open chat',
    )
  })

  check('[7] loadChatConversations() implementation is a plain GET fetch in main.ts, no WS (re)subscription side effect', async () => {
    const mainSource = await readFile(join(REPO_ROOT, 'src', 'main.ts'), 'utf8')
    const fnMatch = mainSource.match(
      /async function loadChatConversations\([\s\S]*?\n\}/,
    )
    assert(fnMatch !== null, 'loadChatConversations implementation not found in main.ts')
    const fnBody = fnMatch![0]
    assert(fnBody.includes('fetch('), 'loadChatConversations no longer performs a fetch()')
    assert(
      !/subscribe|addEventListener\(['"]message/.test(fnBody),
      'loadChatConversations appears to perform WS (re)subscription — unexpected side effect for a fire-and-forget call inside a WS message handler',
    )
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
