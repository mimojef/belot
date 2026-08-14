/**
 * checkGlobalTopicsMuteUxText.ts
 *
 * FINAL PRE-COMMIT CHECK — GLOBAL TOPICS MUTE UX. Permanent regression за
 * реалния rendered/error текст (не само helper/source string presence),
 * покриващ:
 *
 * [1]  formatModerationExpiry: exact формат "14.08.2026, 15:30 ч." — с
 *      година, БЕЗ двойно "ч. ч.", БЕЗ locale "г." суфикс след годината.
 * [2]  formatTopicsSectionMuteErrorText: reason=null → "Причина: Не е
 *      посочена причина." (никога "Причина:" самò/undefined/null).
 * [3]  formatTopicsSectionMuteErrorText: reason='' (blank legacy) → същия
 *      fallback (legacy promoted mutes могат да имат '' reason).
 * [4]  formatTopicsSectionMuteErrorText: reason='   ' (whitespace-only) →
 *      същия fallback (trim преди проверка).
 * [5]  formatTopicsSectionMuteErrorText: реален reason → показва се точно,
 *      НЕ fallback текста.
 * [6]  formatTopicsSectionMuteErrorText: пълен 3-редов изход, точен ред,
 *      БЕЗ двойно "ч." след mutedUntil частта (единственият "ч." идва от
 *      formatModerationExpiry, извикващият код не append-ва свой собствен).
 * [7]  Единствен formatter source — createLobbyFlowController.ts и
 *      main.ts И ДВАТА import-ват formatTopicsSectionMuteErrorText от
 *      renderTopicsScreen.ts, никое от двете НЕ дублира логиката локално
 *      (source-level guard срещу бъдещо разминаване).
 * [8]  Root post (WS topic_message_error) handler-ът в контролера вика
 *      formatTopicsSectionMuteErrorText при code==='topic_muted'.
 * [9]  Reply (WS topic_reply_error) handler-ът вика formatTopicsSectionMuteErrorText.
 * [10] Create-topic (WS topic_create_error) handler-ът вика formatTopicsSectionMuteErrorText.
 * [11] vip_dm first-send (sendVipDmFirstMessage) handler-ът вика formatTopicsSectionMuteErrorText.
 * [12] Existing vip_dm send (main.ts formatPersonalChatError, code='topic_muted')
 *      вика formatTopicsSectionMuteErrorText — не локално дублирана логика.
 * [13] Нито един от изходните файлове не съдържа hardcoded " ч." append
 *      извън самия formatModerationExpiry (regression guard за бъдещо
 *      copy-paste на старата грешка).
 * [14] Existing vip_dm conversation send precheck (отделно от first-send
 *      [11]) вика formatTopicsSectionMuteErrorText directno.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatModerationExpiry, formatTopicsSectionMuteErrorText } from '../src/app/lobby/renderTopicsScreen'

const args = process.argv.slice(2)
const rootArgIndex = args.indexOf('--project-root')
const projectRoot = rootArgIndex >= 0 && args[rootArgIndex + 1]
  ? resolve(args[rootArgIndex + 1])
  : process.cwd()

async function read(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), 'utf8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const controllerSource = await read('src/app/lobby/createLobbyFlowController.ts')
const mainSource = await read('src/main.ts')
const renderTopicsScreenSource = await read('src/app/lobby/renderTopicsScreen.ts')

// Фиксиран timestamp за детерминистичен изход — 2026-08-14 15:30 локално
// (тестовата среда/CI трябва да борави с UTC консистентно, но самото
// сравнение тук е срещу getDate()/getHours() на СЪЩИЯ Date обект, значи
// timezone-неутрално по конструкция; проверяваме СТРУКТУРАТА на низа
// (padding, разделители, единствено "ч."), не абсолютен час-в-UTC).
const fixedIso = '2026-08-14T15:30:00.000Z'
const expectedDate = new Date(fixedIso)
const expectedDay = String(expectedDate.getDate()).padStart(2, '0')
const expectedMonth = String(expectedDate.getMonth() + 1).padStart(2, '0')
const expectedYear = expectedDate.getFullYear()
const expectedHours = String(expectedDate.getHours()).padStart(2, '0')
const expectedMinutes = String(expectedDate.getMinutes()).padStart(2, '0')

await check('[1] formatModerationExpiry: exact формат "DD.MM.YYYY, HH:MM ч." — с година, точно 1x "ч.", без locale "г." суфикс', () => {
  const result = formatModerationExpiry(fixedIso)
  const expected = `${expectedDay}.${expectedMonth}.${expectedYear}, ${expectedHours}:${expectedMinutes} ч.`
  assertEqual(result, expected, 'formatModerationExpiry exact output')
  assert(!result.includes('г.'), 'резултатът не трябва да съдържа bg-BG locale "г." суфикс след годината')
  const chCount = (result.match(/ч\./g) ?? []).length
  assertEqual(chCount, 1, 'резултатът трябва да съдържа точно 1 "ч." суфикс, никога 2')
  assert(String(expectedYear).length === 4, 'sanity: годината трябва да е 4-цифрена')
  assert(result.includes(String(expectedYear)), 'резултатът трябва да включва пълната 4-цифрена година')
})

await check('[2] formatTopicsSectionMuteErrorText: reason=null → "Причина: Не е посочена причина." (никога празно/null/undefined)', () => {
  const result = formatTopicsSectionMuteErrorText(fixedIso, null)
  assert(result.includes('Причина: Не е посочена причина.'), 'null reason трябва да покаже canonical fallback текста')
  assert(!result.includes('Причина: null'), 'резултатът никога не трябва да съдържа литералния текст "null"')
  assert(!/Причина:\s*$/m.test(result), 'резултатът никога не трябва да има празен "Причина:" ред без стойност')
})

await check('[3] formatTopicsSectionMuteErrorText: reason=\'\' (blank legacy promoted mute) → същия canonical fallback', () => {
  const result = formatTopicsSectionMuteErrorText(fixedIso, '')
  assert(result.includes('Причина: Не е посочена причина.'), 'празен string reason трябва да покаже fallback, не празен ред')
  assert(!/Причина:\s*$/m.test(result), 'резултатът никога не трябва да има празен "Причина:" ред')
})

await check('[4] formatTopicsSectionMuteErrorText: reason=\'   \' (whitespace-only) → същия canonical fallback (trim преди проверка)', () => {
  const result = formatTopicsSectionMuteErrorText(fixedIso, '   ')
  assert(result.includes('Причина: Не е посочена причина.'), 'whitespace-only reason трябва да покаже fallback след trim')
  assert(!/Причина:\s+$/m.test(result), 'резултатът никога не трябва да завършва с "Причина:" последвано само от whitespace')
})

await check('[5] formatTopicsSectionMuteErrorText: реален reason → показва се точно, НЕ fallback текста', () => {
  const result = formatTopicsSectionMuteErrorText(fixedIso, 'spam links')
  assert(result.includes('Причина: spam links'), 'реален reason трябва да се покаже точно')
  assert(!result.includes('Не е посочена причина'), 'при реален reason fallback текстът не трябва да се появява')
})

await check('[6] formatTopicsSectionMuteErrorText: пълен 3-редов изход, точен ред, БЕЗ двойно "ч." след mutedUntil частта', () => {
  const result = formatTopicsSectionMuteErrorText(fixedIso, 'test reason')
  const lines = result.split('\n')
  assertEqual(lines.length, 3, 'изходът трябва да е точно 3 реда: intro, expiry, reason')
  assertEqual(lines[0], 'Временно сте заглушени в секция „Теми“.', 'ред 1 трябва да е точния intro текст')
  assert(lines[1]!.startsWith('Можете да публикувате отново след '), 'ред 2 трябва да започва с точната фраза')
  assert(lines[1]!.endsWith(' ч.'), 'ред 2 трябва да завършва с точно " ч." (не " ч. ч.")')
  const chCountInExpiryLine = (lines[1]!.match(/ч\./g) ?? []).length
  assertEqual(chCountInExpiryLine, 1, 'ред 2 трябва да съдържа точно 1 "ч.", никога 2 ("ч. ч." regression)')
  assertEqual(lines[2], 'Причина: test reason', 'ред 3 трябва да е точния reason ред')
})

await check('[7] Единствен formatter source — createLobbyFlowController.ts И main.ts import-ват formatTopicsSectionMuteErrorText от renderTopicsScreen.ts, никое НЕ дублира логиката локално', () => {
  assert(controllerSource.includes("import { formatTopicsSectionMuteErrorText } from './renderTopicsScreen'"), 'createLobbyFlowController.ts трябва да import-ва formatTopicsSectionMuteErrorText от renderTopicsScreen.ts')
  assert(mainSource.includes("import { formatTopicsSectionMuteErrorText } from './app/lobby/renderTopicsScreen'"), 'main.ts трябва да import-ва formatTopicsSectionMuteErrorText от app/lobby/renderTopicsScreen')
  assert(!controllerSource.includes('function formatTopicsSectionMuteErrorText'), 'createLobbyFlowController.ts НЕ трябва да дефинира собствено копие на formatTopicsSectionMuteErrorText')
  assert(!/const lines = \[.?Временно сте заглушени/.test(mainSource), 'main.ts НЕ трябва да съдържа локално дублирана "Временно сте заглушени" низ конструкция')
  assert(renderTopicsScreenSource.includes('export function formatTopicsSectionMuteErrorText'), 'renderTopicsScreen.ts трябва да е единственият export source на formatTopicsSectionMuteErrorText')
})

await check('[8] Root post (WS topic_message_error) handler вика formatTopicsSectionMuteErrorText при code===\'topic_muted\'', () => {
  const idx = controllerSource.indexOf("state.topicComposerErrorTextByTopicId[pendingTopicId] = message.code === 'topic_muted'")
  assert(idx !== -1, 'root post error handler за topic_muted не е намерен')
  const nearby = controllerSource.slice(idx, idx + 300)
  assert(nearby.includes('formatTopicsSectionMuteErrorText(message.mutedUntil, message.reason)'), 'root post handler трябва да вика formatTopicsSectionMuteErrorText с message.mutedUntil/message.reason')
})

await check('[9] Reply (WS topic_reply_error) handler вика formatTopicsSectionMuteErrorText при code===\'topic_muted\'', () => {
  const idx = controllerSource.indexOf("state.topicReplyComposerErrorTextByRootId[pendingRootId] = message.code === 'topic_muted'")
  assert(idx !== -1, 'reply error handler за topic_muted не е намерен')
  const nearby = controllerSource.slice(idx, idx + 300)
  assert(nearby.includes('formatTopicsSectionMuteErrorText(message.mutedUntil, message.reason)'), 'reply handler трябва да вика formatTopicsSectionMuteErrorText с message.mutedUntil/message.reason')
})

await check('[10] Create-topic (WS topic_create_error) handler вика formatTopicsSectionMuteErrorText при code===\'topic_muted\'', () => {
  const idx = controllerSource.indexOf("const errorText = message.code === 'topic_muted'")
  assert(idx !== -1, 'create-topic error handler за topic_muted не е намерен')
  const nearby = controllerSource.slice(idx, idx + 200)
  assert(nearby.includes('formatTopicsSectionMuteErrorText(message.mutedUntil, message.reason)'), 'create-topic handler трябва да вика formatTopicsSectionMuteErrorText с message.mutedUntil/message.reason')
})

await check('[11] vip_dm first-send (sendVipDmFirstMessage) получава готов formatTopicsSectionMuteErrorText текст в result.message (форматиран в main.ts, виж [12]) при code===\'topic_muted\', и client precheck пътят вика formatTopicsSectionMuteErrorText directno', () => {
  const fnStart = controllerSource.indexOf('async function sendVipDmFirstMessage')
  assert(fnStart !== -1, 'sendVipDmFirstMessage function not found')
  const fnEnd = controllerSource.indexOf('\n  async function submitGiftCoins', fnStart)
  const fnBody = controllerSource.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 4000)
  // (a) Client-side precheck клона (isLocallyKnownTopicsSectionMuted) вика
  // formatTopicsSectionMuteErrorText directno — instant UX denial текст.
  assert(fnBody.includes('if (isLocallyKnownTopicsSectionMuted())'), 'sendVipDmFirstMessage precheck клонът трябва да провери isLocallyKnownTopicsSectionMuted() преди request-а')
  assert(fnBody.includes('formatTopicsSectionMuteErrorText(\n        state.activeTopicViewerMute?.mutedUntil') || fnBody.includes('formatTopicsSectionMuteErrorText('), 'precheck клонът трябва да построи текста чрез formatTopicsSectionMuteErrorText')
  // (b) Server-response клона guard-ва code==='topic_muted' explicit (за
  // sync на global mute state-а) и показва result.message — стойност,
  // която идва предформатирана от main.ts startVipDmFirstMessage →
  // formatPersonalChatError → formatTopicsSectionMuteErrorText (виж [12]),
  // никога локално построен ad-hoc текст тук.
  assert(fnBody.includes("if (result.code === 'topic_muted')"), 'sendVipDmFirstMessage трябва да guard-ва изрично code===\'topic_muted\' в server-response клона (за global mute state sync)')
  assert(fnBody.includes('state.chatErrorText = result.message'), 'server-response клона трябва да показва result.message — вече форматиран от main.ts formatPersonalChatError чрез formatTopicsSectionMuteErrorText')
})

await check('[12] Existing vip_dm send (main.ts formatPersonalChatError, code=\'topic_muted\') вика formatTopicsSectionMuteErrorText — не локално дублирана логика', () => {
  const caseIdx = mainSource.indexOf("case 'topic_muted':")
  assert(caseIdx !== -1, "main.ts formatPersonalChatError трябва да има case 'topic_muted'")
  const nearby = mainSource.slice(caseIdx, caseIdx + 600)
  assert(nearby.includes('return formatTopicsSectionMuteErrorText(data.mutedUntil, data.reason)'), 'main.ts case \'topic_muted\' трябва directno да връща formatTopicsSectionMuteErrorText(data.mutedUntil, data.reason), не локално построен low-level string')
})

await check('[13] Regression guard: никой от изходните файлове не съдържа hardcoded " ч.`" append извън самия formatModerationExpiry (защита срещу бъдещо copy-paste на старата "ч. ч." грешка)', () => {
  assert(!controllerSource.includes('} ч.`'), 'createLobbyFlowController.ts НЕ трябва да append-ва свой собствен " ч." след formatModerationExpiry резултат')
  assert(!mainSource.includes('} ч.`'), 'main.ts НЕ трябва да append-ва свой собствен " ч." след formatModerationExpiry резултат')
  // renderTopicsScreen.ts Е единственото легитимно място, където " ч." се
  // append-ва — вътре в самата formatModerationExpiry имплементация.
  const formatterIdx = renderTopicsScreenSource.indexOf('export function formatModerationExpiry')
  assert(formatterIdx !== -1, 'formatModerationExpiry export not found')
  const formatterBody = renderTopicsScreenSource.slice(formatterIdx, formatterIdx + 800)
  const chAppendCount = (formatterBody.match(/ч\.`/g) ?? []).length
  assertEqual(chAppendCount, 1, 'formatModerationExpiry трябва да съдържа точно ЕДНО място, където "ч." се append-ва в темплейт литерала')
})

await check('[14] Existing vip_dm conversation send (sendChatMessage, kind===\'vip_dm\' precheck клон) вика formatTopicsSectionMuteErrorText directno — отделно от first-send [11]', () => {
  const disabledReasonIdx = controllerSource.indexOf("activeConversation.friend.isBlockedByMe === true")
  assert(disabledReasonIdx !== -1, 'existing vip_dm disabledReason ternary chain not found')
  const nearby = controllerSource.slice(disabledReasonIdx, disabledReasonIdx + 700)
  assert(nearby.includes('isLocallyKnownTopicsSectionMuted()'), 'existing vip_dm send precheck трябва да провери isLocallyKnownTopicsSectionMuted()')
  assert(nearby.includes('formatTopicsSectionMuteErrorText(state.activeTopicViewerMute?.mutedUntil ?? null, state.activeTopicViewerMute?.reason ?? null)'), 'existing vip_dm send precheck трябва да построи текста чрез formatTopicsSectionMuteErrorText, не ad-hoc string')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
