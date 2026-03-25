export function createInitialGameState() {
  return {
    status: 'idle',
    phase: 'setup',

    dealerIndex: 0,
    currentPlayerIndex: 0,
    currentTurn: null,
    bidStarter: null,
    cuttingPlayer: null,

    trumpSuit: null,
    contract: null,
    winningBidder: null,
    isDoubled: false,
    isRedoubled: false,
    bidHistory: [],
    passedPlayers: [],

    bidding: {
      starter: null,
      currentTurn: null,
      order: [],
      history: [],
      passesInRow: 0,
      contract: null,
      trumpSuit: null,
      winningBidder: null,
      isComplete: false,
      allowedSuits: [],
      allowedContracts: [],
      isDoubled: false,
      isRedoubled: false,
      canDouble: false,
      canRedouble: false,
    },

    deck: [],
    cutIndex: null,

    hands: {
      bottom: [],
      left: [],
      top: [],
      right: [],
    },

    firstRoundDealt: false,
    secondRoundDealt: false,

    currentTrick: [],
    completedTricks: [],
    trickLeaderIndex: null,
    lastTrickWinnerIndex: null,
    cardsPlayedCount: 0,
    roundWinnerTeam: null,

    announcements: {
      belotDeclaredBy: [],
      declarations: [],
    },

    // Оставяме го временно за съвместимост,
    // докато прехвърлим engine/UI изцяло към currentTrick
    trick: [],

    scores: {
      teamA: 0,
      teamB: 0,
    },

    trickWins: {
      teamA: 0,
      teamB: 0,
    },
  }
}