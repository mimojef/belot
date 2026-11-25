// Етап 4 — доказателство, че предишен опит за свързване е на СЪЩАТА страница.
//
// При всяка удостоверена WS връзка сървърът генерира случаен attemptProof
// (128 бита) и го изпраща САМО по тази връзка в 'connected'. При тихо
// възстановяване клиентът подава priorAttempts = [{connectionId, proof}] за
// собствените си неуспели/прекъснати опити. Сървърът приема връзката като
// „собствена“ единствено ако:
//  - има запис за connectionId (връзката е още регистрирана — записът се
//    маха при затварянето ѝ, т.е. живее колкото връзката);
//  - записът е на СЪЩИЯ профил като текущата връзка;
//  - proof-ът съвпада (сравнение на SHA-256 хешове, timing-safe).
//
// Верига: връзка, която е доказала свои предишни опити, ги „притежава“ —
// следващият опит, който докаже нея, наследява и тях (само ако са още
// регистрирани и на същия профил). Така клиентът не трябва да пази proof за
// всеки опит в дълго прекъсване: старите полуотворени връзки остават доказани
// през по-новите. Всяка връзка във веригата е проверена криптографски.
//
// Друго устройство/таб никога не получава чуждия proof, затова не може да
// изтласка чужда валидна връзка. clientInstanceId не участва.
// Пази се само хешът; proof-ът не се логва никъде.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Максимум директни priorAttempts в едно resume_room — равно на тавана от
 * опити в едно прекъсване на клиента (32), т.е. клиентът подава всички
 * собствени предишни опити.
 */
export const MAX_PRIOR_ATTEMPTS = 32
/** Максимум наследени (притежавани) връзки, пазени към една връзка. */
const MAX_OWNED_CONNECTIONS = 32
const PROOF_BYTES = 16

export type ReconnectAttemptProofStore = {
  /** Нов proof за удостоверена връзка; null за гост. */
  issue: (connectionId: string, profileId: string | null) => string | null
  verify: (connectionId: string, profileId: string | null, proof: string) => boolean
  /**
   * Доказаните собствени предишни опити на currentConnectionId: директно
   * проверените + притежаваните от тях (още регистрирани, същият профил).
   * Записва резултата като притежание на текущата връзка (за следващия опит).
   */
  resolveOwned: (currentConnectionId: string, profileId: string | null, priorAttempts: ReadonlyArray<{ connectionId: string; proof: string }>) => Set<string>
  /** При затваряне на връзката. */
  release: (connectionId: string) => void
  size: () => number
}

type Entry = { profileId: string; hash: Buffer; owned: Set<string> }

function hashProof(proof: string): Buffer {
  return createHash('sha256').update(proof, 'utf8').digest()
}

export function createReconnectAttemptProofStore(random: (size: number) => Buffer = randomBytes): ReconnectAttemptProofStore {
  const entries = new Map<string, Entry>()

  function verify(connectionId: string, profileId: string | null, proof: string): boolean {
    if (profileId === null || typeof proof !== 'string' || proof.length === 0 || proof.length > 64) return false
    const entry = entries.get(connectionId)
    if (entry === undefined || entry.profileId !== profileId) return false
    return timingSafeEqual(entry.hash, hashProof(proof))
  }

  return {
    issue(connectionId, profileId) {
      if (profileId === null) return null
      const proof = random(PROOF_BYTES).toString('base64url')
      entries.set(connectionId, { profileId, hash: hashProof(proof), owned: new Set() })
      return proof
    },
    verify,
    resolveOwned(currentConnectionId, profileId, priorAttempts) {
      const owned = new Set<string>()
      if (profileId === null) return owned
      for (const prior of priorAttempts.slice(0, MAX_PRIOR_ATTEMPTS)) {
        if (prior.connectionId === currentConnectionId || !verify(prior.connectionId, profileId, prior.proof)) continue
        owned.add(prior.connectionId)
        for (const inherited of entries.get(prior.connectionId)?.owned ?? []) {
          const inheritedEntry = entries.get(inherited)
          if (inherited !== currentConnectionId && inheritedEntry !== undefined && inheritedEntry.profileId === profileId) owned.add(inherited)
        }
      }
      const current = entries.get(currentConnectionId)
      if (current !== undefined && current.profileId === profileId && owned.size > 0) {
        for (const id of owned) current.owned.add(id)
        // Само още регистрираните, най-много MAX_OWNED_CONNECTIONS (най-новите).
        const live = [...current.owned].filter((id) => entries.has(id))
        current.owned = new Set(live.slice(-MAX_OWNED_CONNECTIONS))
      }
      return owned
    },
    release(connectionId) {
      entries.delete(connectionId)
    },
    size: () => entries.size,
  }
}
