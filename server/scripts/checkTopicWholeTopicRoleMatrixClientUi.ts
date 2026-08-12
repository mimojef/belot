/**
 * Regression guard за client UI role matrix на whole-topic moderation
 * контроли (Lock/Unlock/Delete) — corrective pass.
 *
 * Root cause на bug-а: единствен client predicate `isTopicModeratorAuthSession`
 * (admin/subadmin/pika_team/top_chat_admin) захранваше и mute/report/audit UI
 * gate-а, И Lock/Unlock/Delete бутоните в renderTopicHeaderModerationControls.
 * Продуктовото решение изисква Lock/Unlock/Delete да са видими САМО за
 * admin/subadmin/top_chat_admin — pika_team и chat_admin трябва да ги
 * загубят, без да губят mute/report/audit достъпа си.
 *
 * Fix: нов по-тесен predicate `isTopicWholeTopicModeratorAuthSession`
 * (admin/subadmin/top_chat_admin), ново state поле `isWholeTopicModerator`,
 * renderTopicHeaderModerationControls превключен от isTopicModerator към
 * isWholeTopicModerator. isTopicModerator (широкия set) остава непроменен за
 * mute/report-menu/audit gate-овете другаде.
 *
 * [1] Нов по-тесен predicate съществува с точния role set (admin/subadmin/top_chat_admin)
 * [2] Широкият predicate (isTopicModeratorAuthSession) остава непроменен (mute/report/audit)
 * [3] Widening predicate НЕ включва pika_team/chat_admin
 * [4] renderTopicHeaderModerationControls (Lock/Unlock/Delete) гейтва по isWholeTopicModerator, НЕ isTopicModerator
 * [5] Mute control (renderTopicAuthorBlock) остава гейтнат по isTopicModerator (непроменено)
 * [6] Reports menu entry (renderLobbyScreen mail dropdown) остава гейтнат по isTopicModerator (непроменено)
 * [7] isWholeTopicModerator е wire-нат в snapshot builder-а (createLobbyFlowController.ts)
 * [8] LobbyScreenState типът декларира isWholeTopicModerator
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

console.log('\n=== Whole-topic role matrix client UI gate (corrective pass) ===\n')

const wholeTopicFnBody = controllerSrc.match(/function isTopicWholeTopicModeratorAuthSession\(session: LobbyAuthSession \| null\): boolean \{[\s\S]*?\n\}/)?.[0] ?? ''
const moderatorFnBody = controllerSrc.match(/function isTopicModeratorAuthSession\(session: LobbyAuthSession \| null\): boolean \{[\s\S]*?\n\}/)?.[0] ?? ''

check('[1] isTopicWholeTopicModeratorAuthSession съществува с admin/subadmin/top_chat_admin', () => {
  assert(wholeTopicFnBody.length > 0, 'isTopicWholeTopicModeratorAuthSession function not found')
  assert(wholeTopicFnBody.includes(`'admin'`), 'must include admin')
  assert(wholeTopicFnBody.includes(`'subadmin'`), 'must include subadmin')
  assert(wholeTopicFnBody.includes(`'top_chat_admin'`), 'must include top_chat_admin')
})

check('[2] isTopicModeratorAuthSession (широк) остава непроменен — все още admin/subadmin/pika_team/top_chat_admin', () => {
  assert(moderatorFnBody.length > 0, 'isTopicModeratorAuthSession function not found')
  assert(moderatorFnBody.includes(`'admin'`), 'must include admin')
  assert(moderatorFnBody.includes(`'subadmin'`), 'must include subadmin')
  assert(moderatorFnBody.includes(`'pika_team'`), 'must still include pika_team — mute/report/audit unaffected')
  assert(moderatorFnBody.includes(`'top_chat_admin'`), 'must include top_chat_admin')
})

check('[3] isTopicWholeTopicModeratorAuthSession НЕ включва pika_team/chat_admin', () => {
  assert(!wholeTopicFnBody.includes(`'pika_team'`), 'must NOT include pika_team')
  assert(!wholeTopicFnBody.includes(`'chat_admin'`), 'must NOT include chat_admin')
})

check('[4] renderTopicHeaderModerationControls (Lock/Unlock/Delete) гейтва по state.isWholeTopicModerator', () => {
  const fnBody = topicsScreenSrc.match(/function renderTopicHeaderModerationControls[\s\S]*?\n\}/)?.[0] ?? ''
  assert(fnBody.length > 0, 'renderTopicHeaderModerationControls function not found')
  assert(fnBody.includes('state.isWholeTopicModerator'), 'must gate on state.isWholeTopicModerator')
  assert(
    !/if \(state\.isTopicModerator\)/.test(fnBody),
    'must NOT gate Lock/Unlock/Delete on the wide state.isTopicModerator anymore — that would let pika_team/chat_admin see them again',
  )
  assert(fnBody.includes('data-topic-lock='), 'Lock button must still be present')
  assert(fnBody.includes('data-topic-unlock='), 'Unlock button must still be present')
  assert(fnBody.includes('data-topic-delete='), 'Delete button must still be present')
})

check('[5] Mute control (renderTopicAuthorBlock) остава гейтнат по широкия state.isTopicModerator (непроменено)', () => {
  const fnBody = topicsScreenSrc.match(/function renderTopicAuthorBlock[\s\S]*?\n\}/)?.[0] ?? ''
  assert(fnBody.length > 0, 'renderTopicAuthorBlock function not found')
  assert(fnBody.includes('state.isTopicModerator'), 'mute gate must still reference state.isTopicModerator (wide set — pika_team/chat_admin keep mute rights)')
})

check('[6] Reports menu entry (mail dropdown) остава гейтнат по широкия state.isTopicModerator (непроменено)', () => {
  assert(
    /\$\{state\.isTopicModerator \? `[\s\S]{0,400}?data-lobby-nav-admin-topic-reports="1"/.test(renderLobbySrc),
    'reports menu entry must remain gated on the wide state.isTopicModerator — pika_team/chat_admin keep reports access',
  )
})

check('[7] isWholeTopicModerator е wire-нат в snapshot builder-а', () => {
  assert(
    controllerSrc.includes('isWholeTopicModerator: isTopicWholeTopicModeratorAuthSession(options.getAuthSession?.() ?? null),'),
    'snapshot builder must compute isWholeTopicModerator from isTopicWholeTopicModeratorAuthSession',
  )
})

check('[8] LobbyScreenState типът декларира isWholeTopicModerator: boolean', () => {
  assert(/isWholeTopicModerator:\s*boolean/.test(renderLobbySrc), 'LobbyScreenState must declare isWholeTopicModerator: boolean')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
