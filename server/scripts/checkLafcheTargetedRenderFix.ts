/**
 * checkLafcheTargetedRenderFix.ts
 *
 * Production flicker fix regression guard — Lafche/Topics high-frequency
 * websocket push-ове (topic_message, likes, edit/delete, unread/seen)
 * задействаха unconditional пълен render() -> renderLobbyScreen() ->
 * root.innerHTML = ... remount на ЦЕЛИЯ lobby subtree (header, mobile menu,
 * Topics/Lafche panel, всички post nodes, composer) при всяко такова
 * съобщение. Root cause и fix scope-ът са описани в родителския брифа
 * (targeted DOM patch за высок-честотни Topics/Lafche events, fallback към
 * scheduleRender()/render() само за structural/rare cases).
 *
 * Static source-level checks (established checkTopicsComposerNonVipTapEventOrder.ts
 * pattern — HTML/TS source string assertions, не реален browser DOM, тъй
 * като проектът няма JSDOM):
 *
 * A. topic_message: state се update-ва; normal (не own-ack) active-topic
 *    path опитва appendTopicMessageNode ПРЕДИ render() fallback-а, не
 *    unconditional render().
 * B. unread/seen (4 варианта): refreshTopicsUnreadDom targeted patch опит
 *    преди scheduleRender() fallback, не unconditional render().
 * C. like (changed + changed_self): refreshTopicMessageLikeDom targeted
 *    patch на конкретния бутон преди render() fallback.
 * D. edit/delete: refreshTopicMessageContentDom / removeTopicMessageDom
 *    targeted patch преди render() fallback (root-delete structural case
 *    остава на пълен render — documented exception).
 * E. Fallback path съществува навсякъде (patched===false -> render()/
 *    scheduleRender()).
 * F. Helper функциите (appendTopicMessageNode/refreshTopicsUnreadDom/
 *    refreshTopicMessageLikeDom/refreshTopicMessageContentDom/
 *    removeTopicMessageDom) никога не пипат root.innerHTML — единствената
 *    DOM write примитива, използвана е querySelector + replaceWith/remove/
 *    textContent patch (structural доказателство, че mobile menu <details>
 *    subtree/composer/popups остават недокоснати от тези пътища).
 * G. wireTopicMessageNode consolidation — per-message listeners (author/
 *    like/reply/card-open/mute-toggle/delete/edit) се дефинират ТОЧНО ВЕДНЪЖ
 *    (helper функцията), reuse-нати и от пълния render loop, и от targeted
 *    append — не дублирана wiring логика на две места (брифа "Не дублирай
 *    renderer/business markup на две напълно независими места").
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRootArg = process.argv.find((arg) => arg.startsWith('--project-root='))
const projectRoot = projectRootArg ? resolve(projectRootArg.slice('--project-root='.length)) : resolve('..')

const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

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

function extractHandlerBlock(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start < 0) return ''
  // Handler blocks в handleServerMessage следват "if (message.type === '...') { ... }"
  // pattern-а — намираме matching closing brace чрез brace-depth tracking,
  // започвайки от първата '{' след marker-а.
  const braceStart = src.indexOf('{', start)
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

console.log('\n=== Lafche/Topics targeted DOM patch regression (production flicker fix) ===\n')

// ─── A. topic_message ────────────────────────────────────────────────────

const topicMessageBlock = extractHandlerBlock(controllerSrc, "message.type === 'topic_message'")

check('[A1] topic_message handler block found', () => {
  assert(topicMessageBlock.length > 0, 'topic_message handler not found in createLobbyFlowController.ts')
})

check('[A2] state се update-ва (topicMessages merge) преди DOM patch опита', () => {
  assert(topicMessageBlock.includes('mergeTopicMessages'), 'topicMessages merge missing from handler')
})

check('[A3] appendTopicMessageNode се извиква (targeted patch опит)', () => {
  assert(topicMessageBlock.includes('appendTopicMessageNode('), 'appendTopicMessageNode call missing — targeted patch not wired')
})

check('[A4] appendTopicMessageNode резултатът гейтва връщането — patched=true пропуска render()', () => {
  const appendIdx = topicMessageBlock.indexOf('appendTopicMessageNode(')
  const afterAppend = topicMessageBlock.slice(appendIdx, appendIdx + 900)
  // "return true" трябва да е ВЪТРЕ в if(patched) блока, но не непременно
  // НЕПОСРЕДСТВЕНО след отварящата скоба — composer DOM sync fix-ът (A7)
  // добавя legitimate код (коментар + isOwnRootMessageAck reset) между тях.
  assert(/if\s*\(\s*patched\s*\)\s*\{[\s\S]{0,600}?return true/.test(afterAppend), 'patched result must gate early return, skipping fallback render()')
})

check('[A5] fallback render() съществува СЛЕД targeted опита (не unconditional в началото)', () => {
  const appendIdx = topicMessageBlock.indexOf('appendTopicMessageNode(')
  const renderIdx = topicMessageBlock.indexOf('render()', appendIdx)
  assert(renderIdx > appendIdx, 'render() fallback must appear after the appendTopicMessageNode attempt, not before it')
})

// Обновено (perf audit fix §5): own-message ack по-рано БЕЗУСЛОВНО вземаше
// скъпия full-render път (`if (!isOwnRootMessageAck) { appendTopicMessageNode... }`),
// докато чужд пост вече ползваше targeted append. Сега и двата пътя
// reuse-ват appendTopicMessageNode безусловно — appendTopicMessageNode вече
// прави dedupe по messageId (own-message race/redelivery третира се
// идемпотентно), а forceScrollToNewNode=isOwnRootMessageAck пази established
// "винаги scroll до собствения нов пост" поведение вместо composer-clear
// exclusion guard-а.
check('[A6] own-message ack вече reuse-ва targeted append (не е explicit изключен)', () => {
  assert(!topicMessageBlock.includes('if (!isOwnRootMessageAck)'), 'own-ack exclusion guard should no longer gate appendTopicMessageNode call')
  const appendIdx = topicMessageBlock.indexOf('appendTopicMessageNode(')
  const appendCallLine = topicMessageBlock.slice(appendIdx, appendIdx + 200)
  assert(appendCallLine.includes('isOwnRootMessageAck'), 'appendTopicMessageNode call must pass isOwnRootMessageAck as forceScrollToNewNode')
})

// Production bug fix — appendTopicMessageNode (targeted patch) пипа само
// message list-а, НИКОГА композер формата. Пълният render() по-рано винаги е
// бил отговорен за clear на textarea-та/re-enable на Send бутона — след
// targeted-append промяната own-ack path-ът вече не викаше render(), значи
// textarea-та/Send бутонът оставаха "залепнали" в submit-render-а-то DOM
// състояние (workaround: напускане/повторно влизане в темата). Fix-ът вика
// resetTopicsComposerAfterOwnSendDom(root, topicId) ВЪТРЕ в if(patched),
// гейтнато зад isOwnRootMessageAck (чужд post append не трябва да пипа
// МОЯ composer draft).
check('[A7] Composer DOM sync fix: own-ack targeted append изрично вика resetTopicsComposerAfterOwnSendDom (production stuck-composer bug)', () => {
  const appendIdx = topicMessageBlock.indexOf('appendTopicMessageNode(')
  const patchedIfIdx = topicMessageBlock.indexOf('if (patched)', appendIdx)
  assert(patchedIfIdx >= 0, 'if (patched) block not found after appendTopicMessageNode call')
  const braceStart = topicMessageBlock.indexOf('{', patchedIfIdx)
  let depth = 0
  let patchedBlockEnd = -1
  for (let i = braceStart; i < topicMessageBlock.length; i++) {
    if (topicMessageBlock[i] === '{') depth++
    else if (topicMessageBlock[i] === '}') {
      depth--
      if (depth === 0) { patchedBlockEnd = i + 1; break }
    }
  }
  assert(patchedBlockEnd > braceStart, 'could not find matching closing brace for if (patched) block')
  const patchedBlock = topicMessageBlock.slice(patchedIfIdx, patchedBlockEnd)

  assert(patchedBlock.includes('resetTopicsComposerAfterOwnSendDom('), 'if(patched) block must call resetTopicsComposerAfterOwnSendDom — targeted append never touches the composer form on its own')
  assert(/if\s*\(\s*isOwnRootMessageAck\s*\)\s*\{[^}]*resetTopicsComposerAfterOwnSendDom\(/.test(patchedBlock), 'resetTopicsComposerAfterOwnSendDom must be gated by isOwnRootMessageAck — a foreign post append must never touch the local composer draft')
  assert(patchedBlock.includes('return true'), 'the composer-sync call must still be followed by the early return true (no fallback render() after a successful targeted patch)')
})

check('[A8] resetTopicsComposerAfterOwnSendDom (renderLobbyScreen.ts) никога не пипа root.innerHTML (targeted patch, не full remount)', () => {
  const start = renderSrc.indexOf('export function resetTopicsComposerAfterOwnSendDom(')
  assert(start >= 0, 'resetTopicsComposerAfterOwnSendDom export not found in renderLobbyScreen.ts')
  const nextExportIdx = renderSrc.indexOf('\nexport function ', start + 1)
  const body = stripComments(nextExportIdx > 0 ? renderSrc.slice(start, nextExportIdx) : renderSrc.slice(start))
  assert(!body.includes('root.innerHTML'), 'resetTopicsComposerAfterOwnSendDom must never write root.innerHTML (full remount) — that defeats the targeted-patch purpose')
  assert(body.includes("querySelector"), 'must locate the composer form via querySelector, mirroring the established targeted-patch pattern')
})

// ─── B. unread/seen (4 варианта) ────────────────────────────────────────

for (const marker of [
  "message.type === 'topic_unread_count_changed'",
  "message.type === 'topic_seen_updated'",
  "message.type === 'topic_thread_unread_count_changed'",
  "message.type === 'topic_thread_seen_updated'",
]) {
  const block = extractHandlerBlock(controllerSrc, marker)
  check(`[B] ${marker}: refreshTopicsUnreadDom targeted patch преди scheduleRender() fallback`, () => {
    assert(block.length > 0, `handler block not found for ${marker}`)
    assert(block.includes('refreshTopicsUnreadDom('), `refreshTopicsUnreadDom call missing in ${marker} handler`)
    assert(block.includes('scheduleRender()'), `scheduleRender() fallback missing in ${marker} handler`)
    assert(!/^\s*render\(\)\s*$/m.test(block), `${marker} handler still contains an unconditional render() call`)
  })
}

// ─── C. like (changed + changed_self) ───────────────────────────────────

const likeChangedBlock = extractHandlerBlock(controllerSrc, "message.type === 'topic_message_like_changed'")
check('[C1] topic_message_like_changed: refreshTopicMessageLikeDom targeted patch преди render() fallback', () => {
  assert(likeChangedBlock.includes('refreshTopicMessageLikeDom('), 'refreshTopicMessageLikeDom call missing')
  assert(likeChangedBlock.includes('if (!patched) render()'), 'fallback render() guard missing')
})

const likeChangedSelfBlock = extractHandlerBlock(controllerSrc, "message.type === 'topic_message_like_changed_self'")
check('[C2] topic_message_like_changed_self: refreshTopicMessageLikeDom targeted patch преди render() fallback', () => {
  assert(likeChangedSelfBlock.includes('refreshTopicMessageLikeDom('), 'refreshTopicMessageLikeDom call missing')
  assert(likeChangedSelfBlock.includes('if (!patched) render()'), 'fallback render() guard missing')
})

// ─── D. edit/delete ──────────────────────────────────────────────────────

const editBlock = extractHandlerBlock(controllerSrc, "message.type === 'topic_message_edited'")
check('[D1] topic_message_edited: refreshTopicMessageContentDom targeted patch преди render() fallback', () => {
  assert(editBlock.includes('refreshTopicMessageContentDom('), 'refreshTopicMessageContentDom call missing')
  assert(editBlock.includes('if (!patched) render()'), 'fallback render() guard missing')
})

const deleteBlock = extractHandlerBlock(controllerSrc, "message.type === 'topic_message_deleted'")
check('[D2] topic_message_deleted: reply-target branch използва removeTopicMessageDom targeted removal', () => {
  assert(deleteBlock.includes('removeTopicMessageDom('), 'removeTopicMessageDom call missing')
})

check('[D3] topic_message_deleted: root-target branch остава на documented пълен render() (structural exception)', () => {
  // ROOT branch-ът съдържа topicsMode navigation промени — documented
  // exception, брифа explicit permit-ва structural fallback тук.
  const rootBranchMatch = deleteBlock.match(/if \(message\.parentMessageId === null\) \{[\s\S]*?render\(\)\s*\n\s*\} else \{/)
  assert(rootBranchMatch !== null, 'root-delete branch must retain its explicit render() call (structural/navigation side effects)')
})

// ─── E. Fallback existence (вече покрито individually по-горе, aggregate check) ──

check('[E] Всички targeted patch call sites имат explicit fallback path', () => {
  const targetedCalls = [
    'appendTopicMessageNode(',
    'refreshTopicsUnreadDom(',
    'refreshTopicMessageLikeDom(',
    'refreshTopicMessageContentDom(',
    'removeTopicMessageDom(',
  ]
  for (const call of targetedCalls) {
    const count = controllerSrc.split(call).length - 1
    assert(count >= 1, `${call} is never called from the controller`)
  }
})

// ─── F. Helper функциите никога не пипат root.innerHTML ─────────────────

check('[F] Targeted patch helpers (renderLobbyScreen.ts) не пипат root.innerHTML', () => {
  const helperNames = [
    'appendTopicMessageNode',
    'refreshTopicsUnreadDom',
    'refreshTopicMessageLikeDom',
    'refreshTopicMessageContentDom',
    'removeTopicMessageDom',
  ]
  for (const name of helperNames) {
    const start = renderSrc.indexOf(`export function ${name}(`)
    assert(start >= 0, `${name} export not found in renderLobbyScreen.ts`)
    // Следващият "export function" маркира края на тази функция (top-level
    // функциите в файла не се влагат едно в друго). Comment-ите се strip-ват
    // преди проверка — JSDoc/inline коментарите legitimately СПОМЕНАВАТ
    // "root.innerHTML" в prose (обясняват какво fix-ват), без реално да го
    // извикват в executable кода.
    const nextExportIdx = renderSrc.indexOf('\nexport function ', start + 1)
    const body = stripComments(nextExportIdx > 0 ? renderSrc.slice(start, nextExportIdx) : renderSrc.slice(start))
    assert(!body.includes('root.innerHTML'), `${name} must never write root.innerHTML (full remount) — that defeats the targeted-patch purpose`)
  }
})

// ─── G. wireTopicMessageNode consolidation (без дублирана wiring логика) ─

check('[G1] wireTopicMessageNode helper съществува и е reusable (export)', () => {
  assert(renderSrc.includes('function wireTopicMessageNode('), 'wireTopicMessageNode helper not found')
})

check('[G2] Пълният render loop извиква wireTopicMessageNode веднъж за [data-topic-message]/[data-topic-reply] nodes', () => {
  assert(
    renderSrc.includes("root.querySelectorAll<HTMLElement>('[data-topic-message], [data-topic-reply]').forEach((messageNode) => {"),
    'full-render wiring loop for per-message nodes not found — wiring may have reverted to duplicated global querySelectorAll blocks',
  )
  assert(renderSrc.includes('wireTopicMessageNode(root, state, options, messageNode)'), 'full-render loop must delegate to wireTopicMessageNode')
})

check('[G3] appendTopicMessageNode reuse-ва wireTopicMessageNode за новия node (не дублирана wiring логика)', () => {
  const start = renderSrc.indexOf('export function appendTopicMessageNode(')
  const nextExportIdx = renderSrc.indexOf('\nexport function ', start + 1)
  const body = nextExportIdx > 0 ? renderSrc.slice(start, nextExportIdx) : renderSrc.slice(start)
  assert(body.includes('wireTopicMessageNode(root, state, options, newNode)'), 'appendTopicMessageNode must reuse wireTopicMessageNode, not duplicate per-message wiring')
})

check('[G4] Няма stray дублирани global querySelectorAll blocks за message-scoped selectors извън wireTopicMessageNode', () => {
  const messageScopedSelectors = [
    "root.querySelectorAll<HTMLButtonElement>('[data-topic-message-author]')",
    "root.querySelectorAll<HTMLButtonElement>('[data-topic-message-like]')",
    "root.querySelectorAll<HTMLButtonElement>('[data-topic-mute-toggle]')",
    "root.querySelectorAll<HTMLButtonElement>('[data-topic-message-delete]')",
    "root.querySelectorAll<HTMLButtonElement>('[data-topic-message-edit]')",
  ]
  for (const selector of messageScopedSelectors) {
    assert(!renderSrc.includes(selector), `Found leftover duplicated wiring block: ${selector} — should be consolidated into wireTopicMessageNode`)
  }
})

// ─── Reusable markup builders (renderer НЕ дублиран на две места) ────────

check('[H] appendTopicMessageNode reuse-ва СЪЩИТЕ markup builders като пълния render (renderTopicMessageRow/renderLafcheMessageRow)', () => {
  const start = renderSrc.indexOf('export function appendTopicMessageNode(')
  const nextExportIdx = renderSrc.indexOf('\nexport function ', start + 1)
  const body = nextExportIdx > 0 ? renderSrc.slice(start, nextExportIdx) : renderSrc.slice(start)
  assert(body.includes('renderLafcheMessageRow(state, message)'), 'must reuse renderLafcheMessageRow, not a duplicated Lafche markup builder')
  assert(body.includes('renderTopicMessageRow(state, message)'), 'must reuse renderTopicMessageRow, not a duplicated General Topics markup builder')
})

// ─── I. Card-open self-match regression fix ────────────────────────────────
// Regression: wireTopicMessageNode() consolidation смени root.querySelectorAll
// на messageNode.querySelectorAll('[data-topic-card-open]') — но data-topic-
// card-open е self-attribute на messageNode (виж renderTopicMessageRow),
// не descendant. querySelectorAll никога не матчва self → forEach никога не
// executes → root card click/keydown listeners никога не се прикачват за
// НИТО ЕДНА root card (read или unread, еднакво засегнати). Fix: explicit
// self hasAttribute check вместо querySelectorAll.

function extractWireTopicMessageNodeBody(): string {
  const start = renderSrc.indexOf('function wireTopicMessageNode(')
  if (start < 0) return ''
  const braceStart = renderSrc.indexOf('{', renderSrc.indexOf(')', start))
  if (braceStart < 0) return ''
  let depth = 0
  for (let i = braceStart; i < renderSrc.length; i++) {
    if (renderSrc[i] === '{') depth++
    else if (renderSrc[i] === '}') {
      depth--
      if (depth === 0) return renderSrc.slice(start, i + 1)
    }
  }
  return ''
}

const wireTopicMessageNodeBody = extractWireTopicMessageNodeBody()

check('[I-A] wireTopicMessageNode разпознава card-open чрез self hasAttribute check, не querySelectorAll', () => {
  assert(wireTopicMessageNodeBody.length > 0, 'wireTopicMessageNode function body not found')
  assert(
    wireTopicMessageNodeBody.includes("messageNode.hasAttribute('data-topic-card-open')"),
    'wireTopicMessageNode must explicitly check messageNode.hasAttribute(\'data-topic-card-open\') for self-match',
  )
})

check('[I-B] Няма повече messageNode.querySelectorAll(\'[data-topic-card-open]\') като wiring mechanism', () => {
  assert(
    !renderSrc.includes("messageNode.querySelectorAll<HTMLElement>('[data-topic-card-open]')"),
    'the buggy self-excluding querySelectorAll pattern for data-topic-card-open must not reappear anywhere in the file',
  )
})

check('[I-C] Root card (messageNode with data-topic-card-open) се wire-ва — click/keydown listeners се прикачват', () => {
  assert(wireTopicMessageNodeBody.includes("card.addEventListener('click'"), 'card click listener must be attached when card is non-null')
  assert(wireTopicMessageNodeBody.includes("card.addEventListener('keydown'"), 'card keydown listener must be attached when card is non-null')
  assert(wireTopicMessageNodeBody.includes('options.onTopicThreadOpen(rootMessageId, scrollAnchor)'), 'card open must still invoke onTopicThreadOpen with the same signature')
})

check('[I-D] Reply/thread variant nodes НЕ получават root-card-open behavior (card остава null за тях)', () => {
  // renderTopicReplyRow (data-topic-reply wrapper) и renderTopicMessageRow
  // с variant:'thread' и двата НЕ добавят data-topic-card-open към markup-а
  // — hasAttribute() check-ът естествено връща false за тях, без нужда от
  // допълнителен variant-specific guard тук (същата семантика като HEAD).
  const topicsScreenSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')
  const replyRowStart = topicsScreenSrc.indexOf('export function renderTopicReplyRow(')
  const replyRowEnd = topicsScreenSrc.indexOf('\nexport function ', replyRowStart + 1)
  const replyRowBody = replyRowEnd > 0 ? topicsScreenSrc.slice(replyRowStart, replyRowEnd) : topicsScreenSrc.slice(replyRowStart)
  assert(!replyRowBody.includes('data-topic-card-open'), 'renderTopicReplyRow must never emit data-topic-card-open')

  const cardOpenAttrsIdx = topicsScreenSrc.indexOf('const cardOpenAttrs = isThread')
  assert(cardOpenAttrsIdx >= 0, 'renderTopicMessageRow isThread branching for cardOpenAttrs not found')
  const nearby = topicsScreenSrc.slice(cardOpenAttrsIdx, cardOpenAttrsIdx + 150)
  assert(nearby.includes("? ''"), 'thread variant must render an empty cardOpenAttrs string (no data-topic-card-open)')
})

check('[I-E] Останалите descendant selectors в wireTopicMessageNode остават непроменени (messageNode.querySelectorAll pattern)', () => {
  const otherDescendantSelectors = [
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-author]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-personal]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-like]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-reply]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-mute-toggle]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-delete]')",
    "messageNode.querySelectorAll<HTMLButtonElement>('[data-topic-message-edit]')",
  ]
  for (const selector of otherDescendantSelectors) {
    assert(wireTopicMessageNodeBody.includes(selector), `descendant selector wiring must remain unchanged: ${selector}`)
  }
})

check('[I-F] card-open interactive-descendant exclusion (button/a/input/textarea/select/label/image-viewer) непроменена', () => {
  assert(wireTopicMessageNodeBody.includes("target?.closest(topicCardInteractiveSelector)"), 'interactive descendant exclusion check must remain')
  const selectorListIdx = wireTopicMessageNodeBody.indexOf('const topicCardInteractiveSelector = [')
  assert(selectorListIdx >= 0, 'topicCardInteractiveSelector definition not found')
  const selectorListSection = wireTopicMessageNodeBody.slice(selectorListIdx, selectorListIdx + 250)
  for (const tag of ["'button'", "'a'", "'input'", "'textarea'", "'select'", "'label'", "'[data-image-viewer-open=\"1\"]'"]) {
    assert(selectorListSection.includes(tag), `interactive selector list must still include ${tag}`)
  }
})

check('[I-G] Keyboard accessibility (Enter/Space + preventDefault) непроменена', () => {
  assert(wireTopicMessageNodeBody.includes("event.key !== 'Enter' && event.key !== ' '"), 'Enter/Space keydown handling must remain')
  assert(wireTopicMessageNodeBody.includes('event.preventDefault()'), 'preventDefault must remain for keyboard activation')
})

// ─── J. Lafche 300-post retention DOM defense-in-depth (production hotfix,
// unbounded-growth root cause audit) — appendTopicMessageNode остава
// targeted (не regress-ва към пълен render), но вече cap-ва DOM nodes-ите
// си, работейки по [data-topic-message] selector-и, не listEl.children.length.

function extractAppendTopicMessageNodeBody(): string {
  const start = renderSrc.indexOf('export function appendTopicMessageNode(')
  const nextExportIdx = renderSrc.indexOf('\nexport function ', start + 1)
  return nextExportIdx > 0 ? renderSrc.slice(start, nextExportIdx) : renderSrc.slice(start)
}

const appendTopicMessageNodeBody = extractAppendTopicMessageNodeBody()
// stripComments() премахва prose коментарите (включително JSDoc за СЛЕДВАЩАТА
// функция, който може да "изтече" в slice-а до nextExportIdx) — checks по-долу
// за executable substrings (children.length/render()/LoadOnder) трябва да
// пробват само реален код, не обяснителен текст, който legitimately СПОМЕНАВА
// същите думи (mirror на established [F] check pattern-a по-горе).
const appendTopicMessageNodeCode = stripComments(appendTopicMessageNodeBody)

check('[J1] appendTopicMessageNode съдържа Lafche DOM eviction safety net (LAFCHE_MESSAGE_HISTORY_LIMIT)', () => {
  assert(appendTopicMessageNodeBody.includes('LAFCHE_MESSAGE_HISTORY_LIMIT'), 'appendTopicMessageNode must reference LAFCHE_MESSAGE_HISTORY_LIMIT for its DOM eviction safety net')
})

check('[J2] Eviction-ът работи по [data-topic-message] querySelectorAll, НЕ listEl.children.length (контейнерът може да носи structural nodes)', () => {
  assert(appendTopicMessageNodeCode.includes("querySelectorAll<HTMLElement>('[data-topic-message]')"), 'eviction must count via [data-topic-message] query, not raw children.length')
  assert(!appendTopicMessageNodeCode.includes('listEl.children.length'), 'eviction must not rely on raw listEl.children.length (may include non-message structural nodes)')
})

check('[J3] Eviction-ът маха най-старите nodes (индекс 0 нагоре), не произволни/newest', () => {
  const evictionIdx = appendTopicMessageNodeCode.indexOf('excessCount')
  assert(evictionIdx >= 0, 'excessCount-based eviction logic not found')
  const nearby = appendTopicMessageNodeCode.slice(evictionIdx, evictionIdx + 400)
  assert(/messageNodes\[i\]/.test(nearby), 'eviction must remove from the front of the [data-topic-message] list (oldest-first for Lafche bottom-anchored append)')
})

check('[J4] appendTopicMessageNode targeted append остава непроменен — все още append-ва/reuse-ва renderLafcheMessageRow, не regress-ва към пълен render()', () => {
  assert(appendTopicMessageNodeCode.includes('listEl.appendChild(newNode)'), 'targeted single-node append must remain (no regression to full render)')
  assert(!appendTopicMessageNodeCode.includes('render()'), 'appendTopicMessageNode must never call the full render() function directly')
})

check('[J5] Lafche targeted append НЕ re-trigger-ва older pagination (никакво loadOlder/onTopicMessagesLoadOlder извикване вътре)', () => {
  assert(!appendTopicMessageNodeCode.includes('LoadOlder'), 'appendTopicMessageNode must never call any *LoadOlder* pagination function — targeted append and older-pagination are fully independent code paths')
})

// ─── K. Generic scroll listener — Lafche guard (production hotfix root
// cause) — Lafche е bottom-anchored, "близо до дъното" е нормалното resting
// state след auto-scroll, НЕ user-intent за по-стара история. Listener-ът
// трябва explicit да откаже да trigger-не onTopicMessagesLoadOlder за Lafche,
// БЕЗ да маха trigger-а за General Topics (negative regression guard).

function extractScrollListenerBlock(): string {
  const marker = "root.querySelector<HTMLElement>('[data-topic-messages-scroll=\"1\"]')"
  const start = renderSrc.indexOf(marker)
  if (start < 0) return ''
  const braceStart = renderSrc.indexOf('{', renderSrc.indexOf('if (topicMessagesScroll)', start))
  if (braceStart < 0) return ''
  let depth = 0
  for (let i = braceStart; i < renderSrc.length; i++) {
    if (renderSrc[i] === '{') depth++
    else if (renderSrc[i] === '}') {
      depth--
      if (depth === 0) return renderSrc.slice(start, i + 1)
    }
  }
  return ''
}

const scrollListenerBlock = extractScrollListenerBlock()

check('[K1] Generic topic-messages scroll listener block found', () => {
  assert(scrollListenerBlock.length > 0, 'scroll listener wiring block not found in renderLobbyScreen.ts')
})

check('[K2] Lafche explicit guard (LAFCHE_TOPIC_ID early return) присъства ВЪТРЕ в scroll listener callback-а', () => {
  assert(scrollListenerBlock.includes('LAFCHE_TOPIC_ID'), 'scroll listener must reference LAFCHE_TOPIC_ID')
  assert(/if\s*\(\s*state\.activeTopicId\s*===\s*LAFCHE_TOPIC_ID\s*\)\s*return/.test(scrollListenerBlock), 'scroll listener callback must early-return for Lafche BEFORE evaluating the near-bottom threshold')
})

check('[K3] Lafche guard-ът идва ПРЕДИ threshold проверката (early-exit ред, не след)', () => {
  const guardIdx = scrollListenerBlock.indexOf('LAFCHE_TOPIC_ID')
  const thresholdIdx = scrollListenerBlock.indexOf('<= 40')
  assert(guardIdx >= 0 && thresholdIdx >= 0 && guardIdx < thresholdIdx, 'Lafche guard must appear before the near-bottom threshold check, not after')
})

check('[K4] onTopicMessagesLoadOlder() извикването остава ЗА GENERAL TOPICS (negative regression — guard-ът не e премахнал целия trigger)', () => {
  assert(scrollListenerBlock.includes('options.onTopicMessagesLoadOlder()'), 'the loadOlder trigger must still exist for non-Lafche topics — General Topics infinite-scroll pagination must remain functional')
})

// ─── L. loadOlderTopicMessages action-level structural guard (defense-in-
// depth — не разчита ЕДИНСТВЕНО на scroll listener-а да пресече trigger-а;
// самото action отказва да paginate-не Lafche, независимо от hasMore).

function extractLoadOlderTopicMessagesBody(): string {
  const start = controllerSrc.indexOf('async function loadOlderTopicMessages(')
  if (start < 0) return ''
  const braceStart = controllerSrc.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < controllerSrc.length; i++) {
    if (controllerSrc[i] === '{') depth++
    else if (controllerSrc[i] === '}') {
      depth--
      if (depth === 0) return controllerSrc.slice(start, i + 1)
    }
  }
  return ''
}

const loadOlderTopicMessagesBody = extractLoadOlderTopicMessagesBody()

check('[L1] loadOlderTopicMessages function body found', () => {
  assert(loadOlderTopicMessagesBody.length > 0, 'loadOlderTopicMessages function not found in createLobbyFlowController.ts')
})

check('[L2] loadOlderTopicMessages explicit отказва Lafche В НАЧАЛОТО на функцията (topicId === LAFCHE_TOPIC_ID early-return guard)', () => {
  const nullCheckIdx = loadOlderTopicMessagesBody.indexOf('topicId === null')
  const lafcheGuardIdx = loadOlderTopicMessagesBody.indexOf('topicId === LAFCHE_TOPIC_ID')
  const returnIdx = loadOlderTopicMessagesBody.indexOf('return', lafcheGuardIdx)
  assert(nullCheckIdx >= 0, 'topicId === null guard clause not found')
  assert(lafcheGuardIdx >= 0, 'topicId === LAFCHE_TOPIC_ID guard clause not found — Lafche must never paginate regardless of hasMore/DB history')
  assert(lafcheGuardIdx > nullCheckIdx, 'LAFCHE_TOPIC_ID guard must be part of the same early-return condition block as the null check')
  assert(returnIdx >= 0 && returnIdx - lafcheGuardIdx < 300, 'a return statement must follow shortly after the LAFCHE_TOPIC_ID guard (same early-exit block, not a separate later branch)')
})

// ─── Финален резултат ─────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
