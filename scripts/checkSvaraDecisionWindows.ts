import assert from 'node:assert/strict'
import { getSvaraDecisionWindow, renderSvaraDecisionWindow, svaraJoiningStatus } from '../src/app/games/svara/table/svaraDecisionWindows'
import { renderSvaraActiveTable } from '../src/app/games/svara/table/renderSvaraActiveTable'
import { svaraDecisionFixture, RESULT_START } from './fixtures/svaraDecisionFixtures'
import { svaraResultFixture } from './fixtures/svaraResultFixtures'

let passed = 0, failed = 0
function check(label: string, run: () => void) {
  try { run(); passed++; console.log(`  ok ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
}
const sample = (input: ReturnType<typeof svaraDecisionFixture>, ms = 0) => {
  input.serverNow = RESULT_START + ms
  return getSvaraDecisionWindow(input.snapshot, input.timing, input.serverNow, input.localProfileId)
}
check('eligible outsider receives exact fee and existing join/decline commands', () => {
  const input = svaraDecisionFixture()
  const model = sample(input)!
  assert.equal(model.fee, 625)
  assert.deepEqual(model.actions.map((action) => action.command), [{ type: 'svara-join' }, { type: 'svara-decline' }])
  assert.match(renderSvaraActiveTable(input), /Такса за включване: <strong>625<\/strong>/)
})
check('holders and other viewers have no choice dialog', () => {
  assert.equal(sample(svaraDecisionFixture('joining', 'alice')), null)
  const input = svaraDecisionFixture()
  input.localProfileId = 'bob'
  assert.equal(sample(input), null)
})
check('absent, insufficient-balance server permission and closed windows cannot decide', () => {
  const input = svaraDecisionFixture()
  input.snapshot!.you.status = 'absent'
  assert.equal(sample(input), null)
  input.snapshot!.you.status = 'active'
  input.snapshot!.you.svaraDecision = null // server excludes players who cannot pay
  if (input.snapshot!.round!.kind === 'svara-joining') input.snapshot!.round!.decisions = []
  assert.equal(sample(input), null)
  const closed = svaraDecisionFixture()
  if (closed.snapshot!.round!.kind === 'svara-joining') closed.snapshot!.round!.closed = true
  assert.equal(sample(closed), null)
})
check('public statuses are mapped directly; no missing joiner is guessed as declined', () => {
  const input = svaraDecisionFixture()
  const round = input.snapshot!.round!
  if (round.kind !== 'svara-joining') throw new Error('fixture')
  assert.equal(svaraJoiningStatus(round, 'carol'), 'ИЗЧАКВА СЕ')
  assert.equal(svaraJoiningStatus(round, 'alice'), null)
  round.decisions[0]!.status = 'declined'
  round.decisions[1]!.status = 'joined'
  assert.equal(svaraJoiningStatus(round, 'carol'), 'ПРОПУСКА')
  assert.equal(svaraJoiningStatus(round, 'dave'), 'ВКЛЮЧВА СЕ')
  const html = renderSvaraActiveTable(input)
  assert.match(html, /ПРОПУСКА/); assert.match(html, /ВКЛЮЧВА СЕ/)
})
check('special all-in Svara never gets an ordinary joining dialog', () => {
  const input = svaraDecisionFixture()
  input.snapshot!.lockedPots[0]!.kind = 'allin'
  assert.equal(sample(input), null)
  input.snapshot!.round = { kind: 'allin-svara', roundId: 'allin', potIds: ['ordinary-tie'], iteration: 1 }
  assert.equal(sample(input), null)
})
check('15s countdown uses the original absolute deadline on reconnect and ends exactly at expiry', () => {
  const input = svaraDecisionFixture()
  assert.equal(sample(input, 6300)!.remainingMs, 8700)
  const restored = svaraDecisionFixture()
  assert.deepEqual(sample(restored, 6300), sample(input, 6300))
  assert.equal(sample(input, 14999)!.remainingMs, 1)
  assert.equal(sample(input, 15000), null)
})
check('confirmed decisions and early transition immediately remove the choice', () => {
  const input = svaraDecisionFixture()
  input.snapshot!.you.svaraDecision = 'joined'
  assert.equal(sample(input), null)
  input.snapshot!.round = null
  assert(!renderSvaraActiveTable(input).includes('data-svara-decision-window='))
})
check('missing, mismatched or stale timing cannot show an old window', () => {
  const input = svaraDecisionFixture()
  input.timing!.revision--
  assert.equal(sample(input), null)
  input.timing!.revision++
  input.timing!.matchId = 'other'
  assert.equal(sample(input), null)
  input.timing = null
  assert.equal(sample(input), null)
})
check('only winner with individual permission receives reveal/hide commands', () => {
  assert.equal(sample(svaraDecisionFixture('reveal', 'carol')), null)
  const input = svaraDecisionFixture('reveal', 'alice')
  assert.deepEqual(sample(input)!.actions.map((action) => action.command), [{ type: 'reveal-cards' }, { type: 'hide-cards' }])
  input.snapshot!.you.revealChoice = null
  assert.equal(sample(input), null)
})
check('5s reveal countdown survives reconnect without resetting', () => {
  const input = svaraDecisionFixture('reveal', 'alice')
  assert.equal(sample(input, 3100)!.remainingMs, 1900)
  assert.deepEqual(sample(svaraDecisionFixture('reveal', 'alice'), 3100), sample(input, 3100))
  assert.equal(sample(input, 5000), null)
})
check('opponents see waiting text, never private cards or reveal buttons', () => {
  const input = svaraDecisionFixture('reveal', 'carol')
  sample(input, 1000)
  const html = renderSvaraActiveTable(input)
  assert.match(html, /Изчаква се решение на победителя/)
  assert(!html.includes('data-svara-decision-action='))
  assert(!html.includes('data-svara-reveal-cards='))
  assert(!html.includes('/A_clubs_'))
})
check('normal showdown never presents reveal choice', () => {
  const input = svaraResultFixture()
  assert.equal(getSvaraDecisionWindow(input.snapshot, input.timing, RESULT_START + 100, 'alice'), null)
})
check('server reveal shows winner cards/points only for its 3s deadline, with no extra payout', () => {
  const input = svaraDecisionFixture('reveal', 'carol')
  if (input.snapshot!.round!.kind !== 'reveal-choice') throw new Error('fixture')
  input.snapshot!.round!.decision = 'revealed'; input.snapshot!.round!.cards = ['AC', 'AH', 'AS']; input.snapshot!.round!.handPoints = 33
  input.timing!.deadlines = [{ kind: 'reveal-display', deadlineAt: RESULT_START + 8000, remainingMs: 3000, playerId: 'alice' }]
  sample(input, 5500)
  let html = renderSvaraActiveTable(input)
  assert.equal((html.match(/data-svara-reveal-cards=/g) ?? []).length, 1)
  assert.match(html, /data-svara-reveal-points="1"[^>]*>33</)
  assert(!html.includes('Печеля'))
  sample(input, 8000)
  html = renderSvaraActiveTable(input)
  assert(!html.includes('data-svara-reveal-cards='))
})
check('pending disables both buttons and error messages are escaped', () => {
  const input = svaraDecisionFixture()
  const html = renderSvaraDecisionWindow(sample(input), true, '<img src=x onerror=evil()>')
  assert.equal((html.match(/ disabled/g) ?? []).length, 2)
  assert(!html.includes('<img src=x'))
  assert.match(html, /&lt;img/)
})
check('duplicate snapshots and samples never mutate chips, status, deadlines or reveal data', () => {
  for (const input of [svaraDecisionFixture(), svaraDecisionFixture('reveal', 'alice')]) {
    const before = JSON.stringify([input.snapshot, input.timing])
    for (let ms = 0; ms <= 16000; ms += 101) { sample(input, ms); renderSvaraActiveTable(input) }
    assert.equal(JSON.stringify([input.snapshot, input.timing]), before)
  }
})
console.log(`Svara decision windows: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
