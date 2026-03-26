export function createInitialGameState() {
  return {
    // Общо състояние
    status: 'idle',
    phase: 'setup',

    // Рунд / дилър / цепене
    roundNumber: 0,
    dealerIndex: null,
    initialDealerIndex: null,
    currentPlayerIndex: null,
    currentTurn: null,
    bidStarter: null,
    cuttingPlayer: null,
    dealerRotationDirection: 'counter-clockwise',
    randomDealerChosen: false,
    awaitingCut: true,

    // Обява
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

    // Тесте / shuffle / cut
    deck: [],
    cutIndex: null,
    isDeckShuffled: false,
    isDeckSpreadForCut: false,
    isDeckCut: false,

    // Нов flow за cut / collect / deal animation
    selectedCutIndex: null,
    isCutSelectionLocked: false,
    isDeckCollecting: false,
    isDeckCollected: false,
    dealStep: null, // null | first-3 | next-2 | last-3
    dealingPacketSize: 0,
    dealingTargetPlayer: null,
    dealingAnimationQueue: [],
    lastDealBatchComplete: false,

    // Ръце
    hands: {
      bottom: [],
      left: [],
      top: [],
      right: [],
    },

    // Раздаване
    firstRoundDealt: false,
    secondRoundDealt: false,

    // Взятки
    currentTrick: [],
    completedTricks: [],
    trickLeaderIndex: null,
    lastTrickWinnerIndex: null,
    cardsPlayedCount: 0,
    roundWinnerTeam: null,

    // Анонси
    announcements: {
      belotDeclaredBy: [],
      declarations: [],
    },

    // Временно за съвместимост
    trick: [],

    // Точки
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