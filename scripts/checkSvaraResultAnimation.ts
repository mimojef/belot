// Pure client presentation checks with a fake server clock. No real browser/WS.
import assert from 'node:assert/strict'
import { computeSvaraResultVisualState, SVARA_TIE_SOUND_SRC } from '../src/app/games/svara/table/svaraResultAnimation'
import { renderSvaraActiveTable } from '../src/app/games/svara/table/renderSvaraActiveTable'
import { RESULT_START, setFixturePayout, svaraResultFixture } from './fixtures/svaraResultFixtures'
import { SVARA_PAYOUT_STEP_MS, SVARA_SHOWDOWN_DISPLAY_MS } from '../server/src/games/svara/runtime/svaraDeadlines'
import { svaraCardCodeToFaceSrc } from '../src/app/games/svara/table/svaraTableAssets'

let passed = 0, failed = 0
function check(label: string, run: () => void) {
  try { run(); passed++; console.log(`  ok ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}`, error) }
}
const at = (input: ReturnType<typeof svaraResultFixture>, elapsed: number) => {
  input.serverNow = RESULT_START + elapsed
  return computeSvaraResultVisualState(input.snapshot, input.timing, input.serverNow)
}

check('server constants agree with presentation windows', () => {
  assert.equal(SVARA_SHOWDOWN_DISPLAY_MS, 3000)
  assert.equal(SVARA_PAYOUT_STEP_MS, 1200)
})
check('all compared hands flip together, including the local player and all-in participant', () => {
  const input = svaraResultFixture()
  at(input, 105)
  const html = renderSvaraActiveTable(input)
  assert.equal((html.match(/data-svara-flip-progress="0.2500"/g) ?? []).length, 2)
  assert.equal((html.match(/data-svara-showdown-cards=/g) ?? []).length, 2)
  assert(!html.includes(svaraCardCodeToFaceSrc('AC')!)) // back half of flip
})
check('exact server scores are rendered without evaluation', () => {
  const input = svaraResultFixture()
  if (input.snapshot!.round!.kind === 'showdown-display') input.snapshot!.round!.comparisonPoints.alice = 17
  at(input, 500)
  const html = renderSvaraActiveTable(input)
  assert.match(html, /data-svara-showdown-points="1"[^>]*>17</)
  assert.match(html, /data-svara-showdown-points="1"[^>]*>34</)
})
check('folded and non-compared all-in cards cannot leak, even if extra fields are present', () => {
  const input = svaraResultFixture()
  const round = input.snapshot!.round!
  if (round.kind !== 'showdown-display') throw new Error('fixture')
  round.cards.carol = ['KC', 'KD', 'KH']
  round.cards.dave = ['QC', 'QD', 'QH']
  input.snapshot!.seats[2]!.allIn = true
  round.comparedPlayers.push('dave') // defensive folded guard
  at(input, 700)
  const html = renderSvaraActiveTable(input)
  assert(!html.includes('/K_clubs_') && !html.includes('/Q_clubs_'))
  assert.equal((html.match(/data-svara-showdown-cards=/g) ?? []).length, 2)
})
check('showdown lasts precisely the absolute 3000ms window, including late reconnect', () => {
  const input = svaraResultFixture()
  assert.equal(at(input, -1).showCards, false)
  assert.equal(at(input, 1800).flipProgress, 1)
  assert.equal(at(input, 2999).showCards, true)
  assert.equal(at(input, 3000).showCards, false)
  assert.equal(at(input, 7000).showCards, false)
  assert(!renderSvaraActiveTable(input).includes('data-svara-showdown-cards='))
})
check('no timing, another match, or old revision cannot start a result animation', () => {
  const input = svaraResultFixture()
  assert.equal(computeSvaraResultVisualState(input.snapshot, null, RESULT_START).showCards, false)
  input.timing!.revision--
  assert.equal(at(input, 100).showCards, false)
  input.timing!.revision++
  input.timing!.matchId = 'another'
  assert.equal(at(input, 100).showCards, false)
  input.table.matchId = 'another-table'
  assert(!renderSvaraActiveTable(input).includes('data-svara-showdown-cards='))
})
check('payout steps use server sequence even if input storage order differs', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  if (input.snapshot!.round!.kind === 'showdown-display') input.snapshot!.round!.payout.reverse()
  assert.equal(at(input, 3000).payout?.step.potId, 'main')
  assert.equal(at(input, 4199).payout?.step.potId, 'main')
  assert.equal(at(input, 4200).payout?.step.potId, 'side')
  assert.equal(at(input, 5399).payout?.step.potId, 'side')
  assert.equal(at(input, 5400).payout, null)
})
check('main and side pots reach their own actual winners', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  assert.deepEqual(at(input, 3200).payout?.recipients, [{ playerId: 'bob', amount: 1250 }])
  assert.deepEqual(at(input, 4400).payout?.recipients, [{ playerId: 'alice', amount: 200 }, { playerId: 'carol', amount: 200 }])
})
check('split uses the server share exactly, never divides amount or distributes the removed remainder', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  if (input.snapshot!.round!.kind === 'showdown-display') input.snapshot!.round!.payout[1]!.share = 137
  assert.equal(at(input, 4300).payout?.recipients[0]?.amount, 137)
  const html = renderSvaraActiveTable(input)
  assert.equal((html.match(/Печеля 137!/g) ?? []).length, 2)
  assert(!html.includes('Печеля 200.5!'))
})
check('exact win bubble, highlighted pot and chip destination are scoped to the active step', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  at(input, 3300)
  let html = renderSvaraActiveTable(input)
  assert.match(html, /Печеля 1250!/)
  assert.match(html, /data-svara-payout-flight="1"/)
  assert.match(html, /data-svara-active-pot="main"/)
  assert(!html.includes('Печеля 200!'))
  at(input, 4500)
  html = renderSvaraActiveTable(input)
  assert(!html.includes('Печеля 1250!'))
  assert.match(html, /data-svara-payout-flight="0"/)
  assert.match(html, /data-svara-payout-flight="2"/)
})
check('reconnect mid-payout seeks to the active step and skips completed steps', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  const sampled = at(input, 4800)
  assert.equal(sampled.payout?.step.potId, 'side')
  assert.equal(sampled.payout?.progress, 0.5)
  assert.deepEqual(sampled.remainingSteps.map((step) => step.potId), ['side'])
  assert(!renderSvaraActiveTable(input).includes('Печеля 1250!'))
})
check('duplicate snapshot, refresh and remount have stable round/step identifiers and identical visual state', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  const state = at(input, 4700)
  const fresh = svaraResultFixture()
  setFixturePayout(fresh)
  assert.deepEqual(at(fresh, 4700), state)
  assert.deepEqual(at(input, 4700), state)
  assert.equal((renderSvaraActiveTable(input).match(/Печеля 200!/g) ?? []).length, 2)
  if (fresh.snapshot!.round!.kind === 'showdown-display') fresh.snapshot!.round!.roundId += '-next'
  assert.notEqual(at(fresh, 4700).payout?.key, state.payout?.key)
})
check('tie leaves locked chips on the table while other resolved pots can fly', () => {
  const input = svaraResultFixture()
  input.snapshot!.lockedPots.push({ potId: 'locked', kind: 'allin', amount: 777, eligible: ['alice', 'bob'], isMain: true, continuation: 1 })
  if (input.snapshot!.round!.kind === 'showdown-display') input.snapshot!.round!.svaraTie = true
  setFixturePayout(input)
  at(input, 3300)
  const html = renderSvaraActiveTable(input)
  assert.match(html, /СВАРА!/)
  assert.match(html, /Заключена банка \(Свара\): 777/)
  assert.match(html, /Печеля 1250!/)
  assert(!html.includes('Печеля 777!'))
  assert.equal(SVARA_TIE_SOUND_SRC, null)
})
check('locked banks cannot be animated even with a malformed payout step', () => {
  const input = svaraResultFixture()
  input.snapshot!.lockedPots.push({ potId: 'main', kind: 'allin', amount: 1250, eligible: ['alice', 'bob'], isMain: true, continuation: 1 })
  setFixturePayout(input)
  assert.equal(at(input, 3200).payout, null)
})
check('reduced motion preserves deadlines and amounts without flying chips or card rotation', () => {
  const input = svaraResultFixture()
  input.reducedMotion = true
  at(input, 1)
  assert.match(renderSvaraActiveTable(input), /data-svara-flip-progress="1.0000"/)
  setFixturePayout(input)
  at(input, 3300)
  const html = renderSvaraActiveTable(input)
  assert.match(html, /Печеля 1250!/)
  assert(!html.includes('data-svara-payout-flight='))
  at(input, 5400)
  assert(!renderSvaraActiveTable(input).includes('Печеля'))
})
check('reveal-choice stays separate: pending hides public cards; revealed shows only winner and server points', () => {
  const input = svaraResultFixture()
  input.snapshot!.round = { kind: 'reveal-choice', roundId: 'reveal-8', winnerId: 'alice', decision: 'pending', cards: null, handPoints: null }
  input.timing!.deadlines = [{ kind: 'reveal-choice', deadlineAt: RESULT_START + 5000, remainingMs: 5000, playerId: 'alice' }]
  at(input, 3000)
  assert(!renderSvaraActiveTable(input).includes('data-svara-reveal-cards='))
  input.snapshot!.round.decision = 'revealed'
  input.snapshot!.round.cards = ['AC', 'AH', 'AS']
  input.snapshot!.round.handPoints = 33
  input.timing!.deadlines = [{ kind: 'reveal-display', deadlineAt: RESULT_START + 8000, remainingMs: 3000, playerId: 'alice' }]
  assert.equal(at(input, 5500).payout, null)
  const html = renderSvaraActiveTable(input)
  assert.equal((html.match(/data-svara-reveal-cards=/g) ?? []).length, 1)
  assert.match(html, /data-svara-reveal-points="1"[^>]*>33</)
  assert(!html.includes('data-svara-showdown-cards='))
  at(input, 8000)
  assert(!renderSvaraActiveTable(input).includes('data-svara-reveal-cards='))
})
check('all frame samples and render calls leave balances and snapshot byte-for-byte unchanged', () => {
  const input = svaraResultFixture()
  setFixturePayout(input)
  const before = JSON.stringify(input.snapshot)
  for (let ms = 3000; ms < 6000; ms += 13) { at(input, ms); renderSvaraActiveTable(input) }
  assert.equal(JSON.stringify(input.snapshot), before)
})

console.log(`\nSvara result animation: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
