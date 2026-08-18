/**
 * checkLafcheNoOlderPagination.ts
 *
 * Root-cause regression guard за Lafche 300-post hard retention hotfix (виж
 * двата read-only production audit-а: unbounded client-side scroll-triggered
 * "load older" доведе до 900+/1170+ Lafche root nodes в DOM). Static
 * source-level checks (established checkLafcheTargetedRenderFix.ts/
 * checkTopicsComposerNonVipTapEventOrder.ts pattern — HTML/TS source string
 * assertions, проектът няма JSDOM) за:
 *
 * A. Generic scroll listener: Lafche explicit guard, positioned ПРЕДИ
 *    near-bottom threshold проверката (0 spurious onTopicMessagesLoadOlder
 *    calls, доказано структурно — самата branch, водеща до извикването,
 *    никога не се достига за Lafche).
 * B. General Topics negative regression: СЪЩИЯТ listener продължава да
 *    trigger-ва loadOlder при правилното threshold условие за non-Lafche.
 * C. loadOlderTopicMessages action-level guard (defense-in-depth отвъд
 *    самия listener).
 * D. Client state cap (capLafcheMessagesIfNeeded) — дефинирана веднъж,
 *    извикана на ВСИЧКИ state.topicMessages growth write sites (initial,
 *    topic_message, topic_message_catchup, reconnect-refresh, reorder,
 *    loadOlder-merge defense-in-depth).
 * E. capLafcheMessagesIfNeeded е Lafche-only — early-return unchanged array
 *    за всеки друг topicId (Normal Topics НЕ се cap-ват).
 * F. sortTopicMessagesByActivity наистина сортира newest-first (comparator
 *    структура) — доказва, че state cap slice(0, LIMIT) пази точно
 *    canonical newest N, не произволен range.
 * G. Full-render defense (renderTopicsScreen.ts renderTopicMessageStream) —
 *    Lafche-only slice ПРЕДИ render loop-а, Normal Topics непроменени.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderLobbySrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const topicsScreenSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')

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

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

function extractFunctionBody(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start < 0) return ''
  const braceStart = src.indexOf('{', src.indexOf(')', start))
  if (braceStart < 0) return ''
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

console.log('\n=== Lafche: no implicit older pagination (production hotfix root cause) ===\n')

// ─── A. Scroll listener — Lafche guard ──────────────────────────────────

const scrollListenerMarker = "root.querySelector<HTMLElement>('[data-topic-messages-scroll=\"1\"]')"

// Mirror на checkLafcheTargetedRenderFix.ts brace-depth extraction pattern.
function extractScrollListenerBlock(): string {
  const start = renderLobbySrc.indexOf(scrollListenerMarker)
  if (start < 0) return ''
  const ifIdx = renderLobbySrc.indexOf('if (topicMessagesScroll)', start)
  const braceStart = renderLobbySrc.indexOf('{', ifIdx)
  let depth = 0
  for (let i = braceStart; i < renderLobbySrc.length; i++) {
    if (renderLobbySrc[i] === '{') depth++
    else if (renderLobbySrc[i] === '}') {
      depth--
      if (depth === 0) return renderLobbySrc.slice(start, i + 1)
    }
  }
  return ''
}

const scrollBlock = extractScrollListenerBlock()

check('[A1] Scroll listener block found in renderLobbyScreen.ts', () => {
  assert(scrollBlock.length > 0, 'topic-messages scroll listener wiring block not found')
})

check('[A2] Lafche guard "if (state.activeTopicId === LAFCHE_TOPIC_ID) return" присъства', () => {
  assert(/if\s*\(\s*state\.activeTopicId\s*===\s*LAFCHE_TOPIC_ID\s*\)\s*return/.test(scrollBlock), 'explicit Lafche early-return guard not found inside the scroll event callback')
})

check('[A3] Guard-ът е ПРЕДИ threshold проверката и onTopicMessagesLoadOlder() извикването (structural early-exit, не post-hoc condition)', () => {
  const guardIdx = scrollBlock.search(/if\s*\(\s*state\.activeTopicId\s*===\s*LAFCHE_TOPIC_ID\s*\)\s*return/)
  const thresholdIdx = scrollBlock.indexOf('<= 40')
  const callIdx = scrollBlock.indexOf('onTopicMessagesLoadOlder()')
  assert(guardIdx >= 0 && thresholdIdx > guardIdx && callIdx > thresholdIdx, 'guard must precede both the threshold check and the loadOlder call — Lafche must never reach that branch')
})

// ─── B. General Topics negative regression ──────────────────────────────

check('[B1] onTopicMessagesLoadOlder() остава извикан за non-Lafche (General Topics infinite scroll pagination непроменена)', () => {
  assert(scrollBlock.includes('options.onTopicMessagesLoadOlder()'), 'the loadOlder trigger call must still exist for General Topics — this fix must not remove pagination entirely')
})

check('[B2] Threshold условието (near-bottom <= 40px) остава непроменено за General Topics', () => {
  assert(scrollBlock.includes('scrollHeight - topicMessagesScroll.scrollTop - topicMessagesScroll.clientHeight <= 40'), 'the established near-bottom threshold logic must remain unchanged for the General Topics path')
})

// ─── C. loadOlderTopicMessages action-level defense-in-depth ───────────

const loadOlderBody = extractFunctionBody(controllerSrc, 'async function loadOlderTopicMessages(')

check('[C1] loadOlderTopicMessages съдържа explicit "topicId === LAFCHE_TOPIC_ID" early-return guard', () => {
  assert(loadOlderBody.length > 0, 'loadOlderTopicMessages function not found')
  assert(loadOlderBody.includes('topicId === LAFCHE_TOPIC_ID'), 'action-level Lafche guard missing — must not rely solely on the scroll listener to prevent pagination')
})

check('[C2] Guard-ът НЕ разчита на hasMore=false (explicit topicId check, независимо от DB history state)', () => {
  const lafcheGuardIdx = loadOlderBody.indexOf('topicId === LAFCHE_TOPIC_ID')
  const hasMoreIdx = loadOlderBody.indexOf('!state.topicMessagesHasMore')
  assert(lafcheGuardIdx >= 0 && hasMoreIdx >= 0, 'both guard clauses must exist')
  assert(lafcheGuardIdx < hasMoreIdx, 'LAFCHE_TOPIC_ID guard must be a SEPARATE, EARLIER condition than the generic hasMore check — Lafche pagination must be refused unconditionally, not merely because hasMore happens to be false')
})

// ─── D. Client state cap (capLafcheMessagesIfNeeded) — all growth write sites ──

check('[D1] capLafcheMessagesIfNeeded helper е дефинирана веднъж', () => {
  const occurrences = controllerSrc.split('function capLafcheMessagesIfNeeded(').length - 1
  assert(occurrences === 1, `expected exactly 1 definition of capLafcheMessagesIfNeeded, found ${occurrences}`)
})

check('[D2] capLafcheMessagesIfNeeded реферира LAFCHE_MESSAGE_HISTORY_LIMIT и LAFCHE_TOPIC_ID', () => {
  const start = controllerSrc.indexOf('function capLafcheMessagesIfNeeded(')
  const body = extractFunctionBody(controllerSrc, 'function capLafcheMessagesIfNeeded(')
  assert(start >= 0, 'capLafcheMessagesIfNeeded not found')
  assert(body.includes('LAFCHE_TOPIC_ID'), 'must check against LAFCHE_TOPIC_ID')
  assert(body.includes('LAFCHE_MESSAGE_HISTORY_LIMIT'), 'must cap against LAFCHE_MESSAGE_HISTORY_LIMIT')
  assert(body.includes('.slice(0, LAFCHE_MESSAGE_HISTORY_LIMIT)'), 'must slice the FIRST N entries (newest, given sortTopicMessagesByActivity newest-first order) — see [F] below')
})

check('[D3] capLafcheMessagesIfNeeded се извиква на ВСИЧКИ growth write sites: initial load, catchup, single push, reconnect-refresh, reorder, loadOlder-merge', () => {
  const callCount = controllerSrc.split('capLafcheMessagesIfNeeded(').length - 1
  // 1 дефиниция + поне 6 call sites (initial/loadOlder-merge/reconnect-refresh/
  // reorder/catchup/single-push) — виж createLobbyFlowController.ts write sites.
  assert(callCount >= 7, `expected capLafcheMessagesIfNeeded to be defined once and called at >= 6 write sites (total >= 7 occurrences), found ${callCount}`)
})

check('[D4] Initial REST load site (loadTopicMessagesForActiveTopic) route-ва през capLafcheMessagesIfNeeded', () => {
  const body = extractFunctionBody(controllerSrc, 'async function loadTopicMessagesForActiveTopic(')
  assert(body.includes('state.topicMessages = capLafcheMessagesIfNeeded(topicId, sortTopicMessagesByActivity(result.messages))'), 'initial load write site missing the cap wrapper')
})

check('[D5] topic_message (single realtime push) handler route-ва през capLafcheMessagesIfNeeded', () => {
  // extractFunctionBody е генеричен за "function(...)" markers — за if-block
  // marker-и reuse-ваме идентична brace-depth extraction логика inline тук.
  const start = controllerSrc.indexOf("message.type === 'topic_message'")
  const braceStart = controllerSrc.indexOf('{', start)
  let depth = 0
  let handlerBlock = ''
  for (let i = braceStart; i < controllerSrc.length; i++) {
    if (controllerSrc[i] === '{') depth++
    else if (controllerSrc[i] === '}') {
      depth--
      if (depth === 0) { handlerBlock = controllerSrc.slice(start, i + 1); break }
    }
  }
  assert(handlerBlock.includes('capLafcheMessagesIfNeeded(message.topicId,'), 'topic_message handler missing the cap wrapper')
})

check('[D6] topic_message_catchup handler route-ва през capLafcheMessagesIfNeeded', () => {
  const start = controllerSrc.indexOf("message.type === 'topic_message_catchup'")
  const braceStart = controllerSrc.indexOf('{', start)
  let depth = 0
  let handlerBlock = ''
  for (let i = braceStart; i < controllerSrc.length; i++) {
    if (controllerSrc[i] === '{') depth++
    else if (controllerSrc[i] === '}') {
      depth--
      if (depth === 0) { handlerBlock = controllerSrc.slice(start, i + 1); break }
    }
  }
  assert(handlerBlock.includes('capLafcheMessagesIfNeeded(message.topicId,'), 'topic_message_catchup handler missing the cap wrapper')
})

check('[D7] reconnect-refresh (refreshTopicMessagesAfterTruncatedCatchup) route-ва през capLafcheMessagesIfNeeded', () => {
  const body = extractFunctionBody(controllerSrc, 'async function refreshTopicMessagesAfterTruncatedCatchup(')
  assert(body.includes('capLafcheMessagesIfNeeded(topicId,'), 'reconnect-refresh write site missing the cap wrapper')
})

check('[D8] reorder (refreshTopicMessagesAfterActivityChange) route-ва през capLafcheMessagesIfNeeded', () => {
  const body = extractFunctionBody(controllerSrc, 'async function refreshTopicMessagesAfterActivityChange(')
  assert(body.includes('capLafcheMessagesIfNeeded(topicId,'), 'reorder write site missing the cap wrapper')
})

check('[D9] loadOlder-merge write site route-ва през capLafcheMessagesIfNeeded (defense-in-depth, unreachable за Lafche след [C1] guard-а, но explicit пазено)', () => {
  assert(loadOlderBody.includes('capLafcheMessagesIfNeeded(topicId,'), 'loadOlderTopicMessages merge write site missing the cap wrapper')
})

// ─── E. Normal Topics isolation (capLafcheMessagesIfNeeded е Lafche-only) ──

check('[E] capLafcheMessagesIfNeeded early-returns unchanged array за non-Lafche topicId (Normal Topics НЕ се cap-ват)', () => {
  const body = extractFunctionBody(controllerSrc, 'function capLafcheMessagesIfNeeded(')
  assert(/if\s*\(\s*topicId\s*!==\s*LAFCHE_TOPIC_ID/.test(body), 'must explicitly gate on topicId !== LAFCHE_TOPIC_ID before applying any cap')
})

// ─── F. sortTopicMessagesByActivity newest-first proof ─────────────────

check('[F] sortTopicMessagesByActivity сортира NEWEST-FIRST (comparator: b.activity - a.activity, descending) — доказва, че slice(0, LIMIT) пази canonical newest N', () => {
  const body = extractFunctionBody(controllerSrc, 'function sortTopicMessagesByActivity(')
  assert(body.length > 0, 'sortTopicMessagesByActivity not found')
  assert(body.includes('getTopicMessageActivityMs(b) - getTopicMessageActivityMs(a)'), 'comparator must compute b-minus-a (descending/newest-first) activity delta')
  assert(body.includes('b.seq - a.seq'), 'tie-break must also be descending (b-minus-a) by seq — higher seq (newer) sorts first')
})

// ─── G. Full-render defense (renderTopicsScreen.ts) ─────────────────────

const streamBody = extractFunctionBody(topicsScreenSrc, 'function renderTopicMessageStream(')

check('[G1] renderTopicMessageStream съдържа Lafche-only slice defense (LAFCHE_MESSAGE_HISTORY_LIMIT)', () => {
  assert(streamBody.length > 0, 'renderTopicMessageStream not found')
  assert(streamBody.includes('LAFCHE_MESSAGE_HISTORY_LIMIT'), 'must reference LAFCHE_MESSAGE_HISTORY_LIMIT')
  assert(/isLafche\s*&&\s*rawMessages\.length\s*>\s*LAFCHE_MESSAGE_HISTORY_LIMIT/.test(stripComments(streamBody)), 'slice condition must be gated on isLafche, not applied to all topics')
})

check('[G2] Slice-ът е ПРЕДИ render loop-а (messages, не rawMessages, се подава на .map/.reverse().map)', () => {
  const sliceIdx = streamBody.indexOf('rawMessages.slice(0, LAFCHE_MESSAGE_HISTORY_LIMIT)')
  const mapIdx = streamBody.indexOf('renderLafcheMessageRow(state, m)')
  assert(sliceIdx >= 0 && mapIdx > sliceIdx, 'the Lafche slice must be computed before the render loop consumes `messages`')
})

check('[G3] Normal Topics render loop остава непроменен (messages.map без slice condition в non-Lafche клона)', () => {
  assert(streamBody.includes('messages.map((m) => renderTopicMessageRow(state, m)).join(\'\')'), 'General Topics render branch must remain unaffected')
})

// ─── Финален резултат ─────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
