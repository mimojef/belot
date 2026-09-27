/**
 * checkLudoProfileRefreshAfterMatchEnd.ts
 *
 * Regression test за task-а "Ludo -> level/rank progression: stale profile
 * cache след мач" (продължение на "Ludo -> level/rank progression" — REAL
 * LIVE TEST потвърди persistence-ът е коректен: profile_completed_game_ledger
 * + profile_progress/profiles бяха точно обновени в DB веднага след реален
 * мач, но клиентският `authSession.profile` оставаше stale, защото Ludo's
 * "return to lobby" път никога не викаше `loadAuthSession()`, за разлика от
 * Belot's `createActiveRoomFlowController.ts::showLobby()`, който вече го
 * прави).
 *
 * FIX (чист callback, БЕЗ дублирана /api/auth/me логика):
 *   - createLobbyFlowController.ts добавя нова опция
 *     `onLudoMatchEndedProfileRefresh?: () => void`, извикана ЕДИНСТВЕНО
 *     вътре в `onGameEndAcknowledged` (реално приключен И acknowledged Ludo
 *     match — потребителят кликва "OK" на end-game popup-а), СЛЕД
 *     `ensureLudoLobbyControllerAndRefreshGames()`.
 *   - main.ts wire-ва това към СЪЩАТА `loadAuthSession()` функция, която
 *     Belot's `showLobby()` вече ползва — нула нова fetch логика.
 *   - Spectator instantiation (viewMode:'spectator') на createLudoFlowController
 *     НЕ подава `onGameEndAcknowledged` изобщо -> callback-ът структурно
 *     никога не може да се извика за spectator.
 *   - `requestExit()`/mid-game exit пътят е напълно отделен от
 *     `onGameEndAcknowledged` -> напускане на незавършена игра никога не
 *     тригва profile refresh.
 *   - Persistence слоят (playerProgressStore.ts, migration-ът, index.ts's
 *     Ludo progression block) НЕ е пипан — тоя fix е ЧИСТО read-refresh на
 *     клиента, никакъв нов progression write.
 *
 * Покрива:
 *   [S1] createLobbyFlowController.ts дефинира
 *        `onLudoMatchEndedProfileRefresh?: () => void` в options типа
 *   [S2] `onGameEndAcknowledged` body-то реално вика
 *        `options.onLudoMatchEndedProfileRefresh?.()`
 *   [S3] Тоя call site е ЕДИНСТВЕН в целия файл (не дублиран на друго място)
 *   [S4] Извикването е ПОЗИЦИОНИРАНО след
 *        `ensureLudoLobbyControllerAndRefreshGames()` вътре в СЪЩИЯ
 *        `onGameEndAcknowledged` body (коректен ред, не преди/вместо)
 *   [S5] Spectator instantiation-ът на createLudoFlowController (viewMode:
 *        'spectator') НЕ дефинира `onGameEndAcknowledged` изобщо -> callback-ът
 *        структурно е недостижим за spectator
 *   [S6] main.ts wire-ва `onLudoMatchEndedProfileRefresh` към
 *        `void loadAuthSession()` — СЪЩАТА функция, която Belot's
 *        `showLobby()` вече ползва (reuse, не паралелна реимплементация)
 *   [S7] Тая конкретна main.ts wiring линия НЕ съдържа собствен `fetch(`
 *        извикване (нула дублирана /api/auth/me логика в Ludo пътя)
 *   [S8] createLudoFlowController.ts's dismiss-button click handler вика
 *        `options.onGameEndAcknowledged?.(` ТОЧНО ВЕДНЪЖ в целия файл
 *        (единствен trigger point -> "точно веднъж" по конструкция, не
 *        случайност)
 *   [S9] Persistence regression guard — playerProgressStore.ts продължава
 *        да export-ва `recordCompletedGameForProfile`, migration файлът
 *        продължава да съществува, index.ts продължава да го извиква вътре
 *        в status==='finished' блока — тоя UI fix НЕ е пипнал persistence-а
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}

const projectRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? resolve(process.cwd(), '..'))
const serverRoot = resolve(projectRoot, 'server')

const lobbyControllerPath = resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts')
const lobbyControllerSrc = readFileSync(lobbyControllerPath, 'utf8')
const mainTsPath = resolve(projectRoot, 'src/main.ts')
const mainTsSrc = readFileSync(mainTsPath, 'utf8')
const ludoControllerPath = resolve(projectRoot, 'src/app/games/ludo/createLudoFlowController.ts')
const ludoControllerSrc = readFileSync(ludoControllerPath, 'utf8')
const playerProgressStorePath = resolve(serverRoot, 'src/db/playerProgressStore.ts')
const playerProgressStoreSrc = readFileSync(playerProgressStorePath, 'utf8')
const indexTsPath = resolve(serverRoot, 'src/index.ts')
const indexTsSrc = readFileSync(indexTsPath, 'utf8')

console.log('\ncheckLudoProfileRefreshAfterMatchEnd\n')

check('[S1] createLobbyFlowController.ts дефинира onLudoMatchEndedProfileRefresh?: () => void в options типа', () => {
  assert.match(lobbyControllerSrc, /onLudoMatchEndedProfileRefresh\?:\s*\(\)\s*=>\s*void/)
})

function extractFunctionBody(src: string, startMarker: string): string {
  const startIndex = src.indexOf(startMarker)
  assert.ok(startIndex >= 0, `очакван маркер "${startMarker}" не е намерен`)
  const braceStart = src.indexOf('{', startIndex)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(startIndex, i + 1)
    }
  }
  throw new Error(`не намерих затваряща } за "${startMarker}"`)
}

const onGameEndAcknowledgedBody = extractFunctionBody(lobbyControllerSrc, 'onGameEndAcknowledged: (matchId) => {')

check('[S2] onGameEndAcknowledged body-то реално вика options.onLudoMatchEndedProfileRefresh?.()', () => {
  assert.match(onGameEndAcknowledgedBody, /options\.onLudoMatchEndedProfileRefresh\?\.\(\)/)
})

check('[S3] Извикването options.onLudoMatchEndedProfileRefresh?.() е ЕДИНСТВЕНО в целия файл', () => {
  const occurrences = lobbyControllerSrc.match(/options\.onLudoMatchEndedProfileRefresh\?\.\(\)/g) ?? []
  assert.equal(occurrences.length, 1, `очаквано точно 1 извикване, намерени ${occurrences.length}`)
})

check('[S4] options.onLudoMatchEndedProfileRefresh?.() е ПОЗИЦИОНИРАНО след ensureLudoLobbyControllerAndRefreshGames() в СЪЩИЯ onGameEndAcknowledged body', () => {
  const refreshGamesIndex = onGameEndAcknowledgedBody.indexOf('ensureLudoLobbyControllerAndRefreshGames()')
  const profileRefreshIndex = onGameEndAcknowledgedBody.indexOf('options.onLudoMatchEndedProfileRefresh?.()')
  assert.ok(refreshGamesIndex >= 0, 'ensureLudoLobbyControllerAndRefreshGames() трябва да присъства в body-то')
  assert.ok(profileRefreshIndex > refreshGamesIndex, 'profile refresh callback-ът трябва да е СЛЕД games-list refresh-а')
})

check("[S5] Spectator instantiation (viewMode: 'spectator') НЕ дефинира onGameEndAcknowledged изобщо", () => {
  const spectatorMarker = "viewMode: 'spectator',"
  const spectatorStart = lobbyControllerSrc.indexOf(spectatorMarker)
  assert.ok(spectatorStart >= 0, 'очакван spectator instantiation блок (viewMode: \'spectator\')')
  // Границата на тоя конкретен createLudoFlowController(...) call — до
  // следващата top-level функция веднага след spectator instantiation-а
  // в тоя файл (established landmark, идва directno след closing `})`).
  const boundaryMarker = 'function shouldSuppressLobbyRender'
  const boundaryIndex = lobbyControllerSrc.indexOf(boundaryMarker, spectatorStart)
  assert.ok(boundaryIndex > spectatorStart, `очакван landmark "${boundaryMarker}" след spectator instantiation-а`)
  const spectatorBlock = lobbyControllerSrc.slice(spectatorStart, boundaryIndex)
  assert.ok(!/onGameEndAcknowledged/.test(spectatorBlock), 'spectator instantiation блокът не трябва да реферира onGameEndAcknowledged изобщо')
})

check('[S6] main.ts wire-ва onLudoMatchEndedProfileRefresh към void loadAuthSession() (reuse на Belot mechanism-а)', () => {
  const match = /onLudoMatchEndedProfileRefresh:\s*\(\)\s*=>\s*\{\s*void loadAuthSession\(\)\s*\}/.exec(mainTsSrc)
  assert.ok(match, 'очаквано onLudoMatchEndedProfileRefresh: () => { void loadAuthSession() } в main.ts')

  // Reuse guard — потвърждава, че СЪЩАТА функция (не паралелна реимплементация)
  // вече се ползва от Belot's showLobby() callback.
  const showLobbyBody = extractFunctionBody(mainTsSrc, 'showLobby: (errorText = null, leftRoomId = null) => {')
  assert.match(showLobbyBody, /void loadAuthSession\(\)/, 'Belot\'s showLobby() трябва все още да вика loadAuthSession() (established mechanism)')
})

check('[S7] main.ts-овата onLudoMatchEndedProfileRefresh линия НЕ съдържа собствен fetch( извикване', () => {
  const lineMatch = /onLudoMatchEndedProfileRefresh:[^\n]*\n?/.exec(mainTsSrc)
  assert.ok(lineMatch, 'очаквана wiring линия')
  assert.ok(!/fetch\(/.test(lineMatch![0]), 'wiring линията не бива да прави собствен fetch( — само void loadAuthSession()')
})

check('[S8] createLudoFlowController.ts вика options.onGameEndAcknowledged?.( ТОЧНО ВЕДНЪЖ в целия файл', () => {
  const occurrences = ludoControllerSrc.match(/options\.onGameEndAcknowledged\?\.\(/g) ?? []
  assert.equal(occurrences.length, 1, `очакван точно 1 call site, намерени ${occurrences.length} — множествени trigger points биха застрашили "точно веднъж" гаранцията`)
})

check('[S9] Persistence слоят (playerProgressStore.ts / migration / index.ts wiring) НЕ е пипнат от тоя UI fix', () => {
  assert.match(playerProgressStoreSrc, /function recordCompletedGameForProfile\(/, 'recordCompletedGameForProfile трябва да продължава да съществува непроменено')
  const migrationPath = resolve(serverRoot, 'database/migrations/20260927_001_create_profile_completed_game_ledger.sql')
  assert.ok(existsSync(migrationPath), 'migration файлът трябва да продължава да съществува')
  assert.match(indexTsSrc, /playerProgressStore\.recordCompletedGameForProfile\(snapshot\.matchId, player\.profileId, 'ludo_match'\)/, 'index.ts-овия Ludo progression call site трябва да остане непроменен')
})

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1
