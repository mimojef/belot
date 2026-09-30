// Square (каре) guard за Anti Bad Luck: пази пълните финални 8 карти на
// всичките 4 seats от изкуствени карета, създадени от rescue swap-овете
// (включително когато изместена карта довърши каре при ДРУГ seat). За
// разлика от sequence guard-а (serverAntiBadLuckSequenceGuard.ts), тук НЯМА
// процентен allowance — всяко artificial каре се reject-ва безусловно,
// защото каретата (особено 4×J=200 и 4×A=100, произлизащи директно от
// ALL_TRUMPS/NO_TRUMPS anchor rescue) се оказаха доминиращият източник на
// прекалено чести 50/100 анонса (виж diagnoseAntiBadLuckDeclarations.ts).
//
// Guard-ът НЕ копира scoring/точкуване — вика реалния production declaration
// engine (detectServerDeclarationsInHand) и само пита "кои рангове формират
// валидно каре в тази ръка", за да няма разминаване с истинските Pika.bg
// правила (J=200, 9=150, A/10/K/Q=100; 7/8 никога не са square declaration).

import { SERVER_SEAT_ORDER, type Seat } from '../../core/serverTypes.js'
import { detectServerDeclarationsInHand } from '../declarations/detectServerDeclarationsInHand.js'
import type { ServerDeclarationDetectionContract } from '../declarations/serverDeclarationTypes.js'
import type { ServerCard, ServerRank } from '../serverGameTypes.js'

// Форсира non-"no-trumps" contract само за да отключим square детекцията в
// реалния engine (detectServerDeclarationsInHand връща [] при contract===null
// или 'no-trumps' — виж detectServerDeclarationsInHand.ts). Anti Bad Luck
// работи ПРЕДИ bidding, затова това е чисто структурна проверка "ръката
// съдържа валидно каре", не твърдение за реалния contract на раздаването.
const SQUARE_DETECTION_CONTRACT: ServerDeclarationDetectionContract = {
  contract: 'all-trumps',
  trumpSuit: null,
}

// Кои рангове образуват валидно каре в дадена ръка — директно от реалния
// declaration engine (без копиране на getSquarePoints точкуването).
export function getServerAntiBadLuckSquareRanks(hand: readonly ServerCard[]): Set<ServerRank> {
  const candidates = detectServerDeclarationsInHand(hand as ServerCard[], SQUARE_DETECTION_CONTRACT)
  const ranks = new Set<ServerRank>()

  for (const candidate of candidates) {
    if (candidate.type === 'square' && candidate.privateMetadata.rank) {
      ranks.add(candidate.privateMetadata.rank)
    }
  }

  return ranks
}

// Сравнява natural срещу candidate финални 8-карти ръце на всичките 4 seats:
// - разрушено natural каре (на който и да е seat) → reject (не жертваме
//   естествен късмет за да дадем rescue на друг играч);
// - каквото и да е НОВО каре (не съществувало natural) на който и да е seat
//   → reject, БЕЗ процентен allowance (за разлика от sequence guard-а —
//   артифициалните карета винаги се отхвърлят).
export function isServerAntiBadLuckSquarePlanSafe(
  naturalHandsBySeat: Record<Seat, readonly ServerCard[]>,
  candidateHandsBySeat: Record<Seat, readonly ServerCard[]>,
): boolean {
  for (const seat of SERVER_SEAT_ORDER) {
    const naturalRanks = getServerAntiBadLuckSquareRanks(naturalHandsBySeat[seat])
    const candidateRanks = getServerAntiBadLuckSquareRanks(candidateHandsBySeat[seat])

    for (const rank of naturalRanks) {
      if (!candidateRanks.has(rank)) return false // natural square разрушено
    }

    for (const rank of candidateRanks) {
      if (!naturalRanks.has(rank)) return false // ново artificial square
    }
  }

  return true
}
