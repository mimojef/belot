import { svaraResultFixture, RESULT_START } from './svaraResultFixtures'

export { RESULT_START }
export function svaraDecisionFixture(kind: 'joining' | 'reveal' = 'joining', viewer = 'carol') {
  const input = svaraResultFixture()
  const snapshot = input.snapshot!
  input.localProfileId = viewer
  for (const seat of snapshot.seats) {
    seat.folded = false; seat.allIn = false; seat.cardCount = 0; seat.roundContribution = 0
  }
  snapshot.you = { ...snapshot.you, playerId: viewer, seatIndex: snapshot.seats.find((seat) => seat.playerId === viewer)!.seatIndex,
    cards: null, looked: false, svaraDecision: kind === 'joining' && ['carol', 'dave'].includes(viewer) ? 'undecided' : null,
    revealChoice: kind === 'reveal' && viewer === 'alice' ? { canDecide: true } : null }
  if (kind === 'joining') {
    snapshot.lockedPots = [{ potId: 'ordinary-tie', kind: 'ordinary', amount: 1250, eligible: ['alice', 'bob'], isMain: true, continuation: 1 }]
    snapshot.round = { kind: 'svara-joining', roundId: 'joining-8', potId: 'ordinary-tie', fee: 625, joiners: [], closed: false,
      decisions: [{ playerId: 'carol', status: 'undecided' }, { playerId: 'dave', status: 'undecided' }] }
  } else {
    snapshot.round = { kind: 'reveal-choice', roundId: 'reveal-9', winnerId: 'alice', decision: 'pending', cards: null, handPoints: null }
    if (viewer === 'alice') { snapshot.you.cards = ['AC', 'AH', 'AS']; snapshot.you.looked = true }
  }
  input.timing!.deadlines = [{ kind: kind === 'joining' ? 'svara-joining' : 'reveal-choice',
    deadlineAt: RESULT_START + (kind === 'joining' ? 15000 : 5000), remainingMs: kind === 'joining' ? 15000 : 5000, playerId: kind === 'reveal' ? 'alice' : null }]
  return input
}
