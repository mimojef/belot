/**
 * Pure unit tests for buildWsConnectionsDiagnostic and maskIpAddress.
 * Uses synthetic Map / connection objects — no server process, no DB, no sockets.
 */
import {
  buildWsConnectionsDiagnostic,
  maskIpAddress,
  WS_CONNECTING,
  WS_OPEN,
  WS_CLOSING,
  WS_CLOSED,
} from '../src/monitoring/wsConnectionsHelper.js'

// ─── Брояч ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FakeConn = {
  profileId: string | null
  currentRoomId: string | null
  connectedAt: number
  lastSeenAt: number
  remoteAddress: string | null
  userAgent: string | null
  status: 'connected' | 'disconnected'
}

function conn(overrides: Partial<FakeConn> = {}): FakeConn {
  return {
    profileId: null,
    currentRoomId: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    remoteAddress: '127.0.0.1',
    userAgent: 'test-agent',
    status: 'connected',
    ...overrides,
  }
}

function makeSocket(readyState: number): { readyState: number } {
  return { readyState }
}

const noGame = () => false
const noName = () => null

// ─── [1] maskIpAddress ────────────────────────────────────────────────────────

console.log('\n[1] maskIpAddress')

check('[1.1] IPv4 → *.*.x.y', () => {
  assert(maskIpAddress('192.168.1.100') === '*.*.1.100', 'wrong mask for 192.168.1.100')
})
check('[1.2] 127.0.0.1 → *.*.0.1', () => {
  assert(maskIpAddress('127.0.0.1') === '*.*.0.1', 'wrong mask for loopback')
})
check('[1.3] null → null', () => {
  assert(maskIpAddress(null) === null, 'null should return null')
})
check('[1.4] IPv4-mapped ::ffff:10.0.0.5 → *.*.0.5', () => {
  assert(maskIpAddress('::ffff:10.0.0.5') === '*.*.0.5', 'IPv4-mapped wrong')
})
check('[1.5] pure IPv6 → [****]', () => {
  assert(maskIpAddress('2001:db8::1') === '[****]', 'IPv6 should be [****]')
})
check('[1.6] loopback IPv6 ::1 → [****]', () => {
  assert(maskIpAddress('::1') === '[****]', '::1 should be [****]')
})
check('[1.7] whitespace is trimmed', () => {
  assert(maskIpAddress('  10.20.30.40  ') === '*.*.30.40', 'trim not working')
})

// ─── [2] Един профил, една OPEN връзка ───────────────────────────────────────

console.log('\n[2] Един профил, една OPEN връзка')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['conn-1', makeSocket(WS_OPEN)],
  ])
  const connections = {
    'conn-1': conn({ profileId: 'profile-A', status: 'connected' }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)

  check('[2.1] entries.length === 1', () => assert(result.entries.length === 1, `length=${result.entries.length}`))
  check('[2.2] isOpen === true', () => assert(result.entries[0].isOpen === true, 'not open'))
  check('[2.3] readyStateLabel === OPEN', () => assert(result.entries[0].readyStateLabel === 'OPEN', result.entries[0].readyStateLabel))
  check('[2.4] openSocketCount === 1', () => assert(result.summary.openSocketCount === 1, `${result.summary.openSocketCount}`))
  check('[2.5] authenticatedOpenSockets === 1', () => assert(result.summary.authenticatedOpenSockets === 1, `${result.summary.authenticatedOpenSockets}`))
  check('[2.6] guestOpenSockets === 0', () => assert(result.summary.guestOpenSockets === 0, `${result.summary.guestOpenSockets}`))
  check('[2.7] uniqueOnlineProfiles === 1', () => assert(result.summary.uniqueOnlineProfiles === 1, `${result.summary.uniqueOnlineProfiles}`))
  check('[2.8] profilesWithMultipleOpenSockets === 0', () => assert(result.summary.profilesWithMultipleOpenSockets === 0, `${result.summary.profilesWithMultipleOpenSockets}`))
}

// ─── [3] Един профил, две OPEN връзки ────────────────────────────────────────

console.log('\n[3] Един профил, две OPEN връзки')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['conn-1', makeSocket(WS_OPEN)],
    ['conn-2', makeSocket(WS_OPEN)],
  ])
  const connections = {
    'conn-1': conn({ profileId: 'profile-A', connectedAt: 1000 }),
    'conn-2': conn({ profileId: 'profile-A', connectedAt: 2000 }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)

  check('[3.1] entries.length === 2', () => assert(result.entries.length === 2, `length=${result.entries.length}`))
  check('[3.2] openSocketCount === 2', () => assert(result.summary.openSocketCount === 2, `${result.summary.openSocketCount}`))
  check('[3.3] uniqueOnlineProfiles === 1', () => assert(result.summary.uniqueOnlineProfiles === 1, `${result.summary.uniqueOnlineProfiles}`))
  check('[3.4] profilesWithMultipleOpenSockets === 1', () => assert(result.summary.profilesWithMultipleOpenSockets === 1, `${result.summary.profilesWithMultipleOpenSockets}`))
  check('[3.5] entries сортирани по connectedAtMs низходящо', () => {
    assert(result.entries[0].connectedAtMs >= result.entries[1].connectedAtMs, 'not sorted desc')
  })
}

// ─── [4] OPEN guest socket ────────────────────────────────────────────────────

console.log('\n[4] OPEN guest socket (profileId === null)')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['conn-g', makeSocket(WS_OPEN)],
    ['conn-a', makeSocket(WS_OPEN)],
  ])
  const connections = {
    'conn-g': conn({ profileId: null }),
    'conn-a': conn({ profileId: 'profile-B' }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)

  check('[4.1] guestOpenSockets === 1', () => assert(result.summary.guestOpenSockets === 1, `${result.summary.guestOpenSockets}`))
  check('[4.2] authenticatedOpenSockets === 1', () => assert(result.summary.authenticatedOpenSockets === 1, `${result.summary.authenticatedOpenSockets}`))
  check('[4.3] guest entry profileId === null', () => {
    const guestEntry = result.entries.find(e => e.profileId === null)
    assert(guestEntry !== undefined, 'no guest entry')
    assert(guestEntry.hasActiveGameSession === false, 'guest should not have active game')
    assert(guestEntry.probablePendingSessionInGame === false, 'guest should not be pending')
  })
  check('[4.4] openSocketCount = guestOpenSockets + authenticatedOpenSockets', () => {
    const { openSocketCount, guestOpenSockets, authenticatedOpenSockets } = result.summary
    assert(openSocketCount === guestOpenSockets + authenticatedOpenSockets, `${openSocketCount} ≠ ${guestOpenSockets}+${authenticatedOpenSockets}`)
  })
}

// ─── [5] probablePendingSessionInGame ─────────────────────────────────────────

console.log('\n[5] probablePendingSessionInGame')
{
  const profileInGame = 'profile-game'
  const hasGame = (id: string) => id === profileInGame

  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['conn-pending', makeSocket(WS_OPEN)],   // OPEN + no room + has game = pending
    ['conn-playing', makeSocket(WS_OPEN)],   // OPEN + has room + has game = игрова (не pending)
    ['conn-other', makeSocket(WS_OPEN)],     // OPEN + no room + no game = обикновена
  ])
  const connections = {
    'conn-pending': conn({ profileId: profileInGame, currentRoomId: null }),
    'conn-playing': conn({ profileId: profileInGame, currentRoomId: 'room-xyz' }),
    'conn-other': conn({ profileId: 'profile-other', currentRoomId: null }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, hasGame, noName)

  const pending = result.entries.find(e => e.connectionId === 'conn-pending')
  const playing = result.entries.find(e => e.connectionId === 'conn-playing')
  const other = result.entries.find(e => e.connectionId === 'conn-other')

  check('[5.1] conn-pending е probablePendingSessionInGame', () => {
    assert(pending?.probablePendingSessionInGame === true, 'expected true')
  })
  check('[5.2] conn-pending hasActiveGameSession === true', () => {
    assert(pending?.hasActiveGameSession === true, 'expected true')
  })
  check('[5.3] conn-playing НЕ е probablePendingSessionInGame (има currentRoomId)', () => {
    assert(playing?.probablePendingSessionInGame === false, 'should be false, has room')
  })
  check('[5.4] conn-other НЕ е probablePendingSessionInGame (no game session)', () => {
    assert(other?.probablePendingSessionInGame === false, 'should be false, no game')
  })
  check('[5.5] conn-other hasActiveGameSession === false', () => {
    assert(other?.hasActiveGameSession === false, 'should be false')
  })
}

// ─── [6] CONNECTING / CLOSING / CLOSED не се броят като OPEN ─────────────────

console.log('\n[6] CONNECTING / CLOSING / CLOSED → не са OPEN')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['c-connecting', makeSocket(WS_CONNECTING)],
    ['c-open',       makeSocket(WS_OPEN)],
    ['c-closing',    makeSocket(WS_CLOSING)],
    ['c-closed',     makeSocket(WS_CLOSED)],
  ])
  const connections = {
    'c-connecting': conn({ profileId: 'p1' }),
    'c-open':       conn({ profileId: 'p2' }),
    'c-closing':    conn({ profileId: 'p3' }),
    'c-closed':     conn({ profileId: 'p4' }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)

  check('[6.1] openSocketCount === 1 (само OPEN)', () => assert(result.summary.openSocketCount === 1, `${result.summary.openSocketCount}`))
  check('[6.2] registrySize === 4', () => assert(result.summary.registrySize === 4, `${result.summary.registrySize}`))
  check('[6.3] authenticatedOpenSockets === 1', () => assert(result.summary.authenticatedOpenSockets === 1, `${result.summary.authenticatedOpenSockets}`))
  check('[6.4] uniqueOnlineProfiles === 1 (само OPEN профила)', () => assert(result.summary.uniqueOnlineProfiles === 1, `${result.summary.uniqueOnlineProfiles}`))
  check('[6.5] CONNECTING readyStateLabel', () => {
    const e = result.entries.find(e => e.connectionId === 'c-connecting')
    assert(e?.readyStateLabel === 'CONNECTING', e?.readyStateLabel)
  })
  check('[6.6] CLOSING readyStateLabel', () => {
    const e = result.entries.find(e => e.connectionId === 'c-closing')
    assert(e?.readyStateLabel === 'CLOSING', e?.readyStateLabel)
  })
  check('[6.7] CLOSED readyStateLabel', () => {
    const e = result.entries.find(e => e.connectionId === 'c-closed')
    assert(e?.readyStateLabel === 'CLOSED', e?.readyStateLabel)
  })
  check('[6.8] non-OPEN socket → probablePendingSessionInGame === false', () => {
    const closing = result.entries.find(e => e.connectionId === 'c-closing')
    assert(closing?.probablePendingSessionInGame === false, 'closing should not be pending')
  })
}

// ─── [7] Липсващ conn в connections не хвърля exception ──────────────────────

console.log('\n[7] Липсващ запис в connections')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['orphan-conn', makeSocket(WS_OPEN)],
  ])
  const connections: Record<string, never> = {}  // умишлено празно

  let result: ReturnType<typeof buildWsConnectionsDiagnostic> | undefined
  check('[7.1] не хвърля exception при липсващ conn', () => {
    result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)
  })
  check('[7.2] entry съществува с default стойности', () => {
    assert(result !== undefined, 'no result')
    const e = result.entries[0]
    assert(e !== undefined, 'no entry')
    assert(e.profileId === null, `profileId=${String(e.profileId)}`)
    assert(e.connectedAtMs === 0, `connectedAtMs=${e.connectedAtMs}`)
    assert(e.maskedIp === null, `maskedIp=${String(e.maskedIp)}`)
  })
  check('[7.3] guestOpenSockets === 1 (orphan се брои като guest)', () => {
    assert(result?.summary.guestOpenSockets === 1, `${result?.summary.guestOpenSockets}`)
  })
}

// ─── [8] Summary аритметика е консистентна ───────────────────────────────────

console.log('\n[8] Summary аритметика')
{
  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['c1', makeSocket(WS_OPEN)],
    ['c2', makeSocket(WS_OPEN)],
    ['c3', makeSocket(WS_OPEN)],
    ['c4', makeSocket(WS_CLOSING)],
  ])
  const connections = {
    'c1': conn({ profileId: 'p1' }),
    'c2': conn({ profileId: null }),   // guest
    'c3': conn({ profileId: 'p2' }),
    'c4': conn({ profileId: 'p3', status: 'connected' }),
  }
  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, noName)
  const sm = result.summary

  check('[8.1] openSocketCount = auth + guest', () => {
    assert(sm.openSocketCount === sm.authenticatedOpenSockets + sm.guestOpenSockets,
      `${sm.openSocketCount} ≠ ${sm.authenticatedOpenSockets}+${sm.guestOpenSockets}`)
  })
  check('[8.2] registrySize === entries.length', () => {
    assert(sm.registrySize === result.entries.length, `${sm.registrySize} ≠ ${result.entries.length}`)
  })
  check('[8.3] connectedStateCount счита всички connected (не само OPEN)', () => {
    // c4 е CLOSING но status='connected' → трябва да се брои
    assert(sm.connectedStateCount === 4, `${sm.connectedStateCount}`)
  })
}

// ─── [9] Helper не модифицира подадените Map и connections ────────────────────

console.log('\n[9] Immutability — helper не модифицира входните данни')
{
  const originalSockets = new Map([
    ['c1', makeSocket(WS_OPEN)],
  ])
  const originalConnections = {
    'c1': conn({ profileId: 'p1' }),
  }
  const socketSizeBefore = originalSockets.size
  const connBefore = { ...originalConnections['c1'] }

  buildWsConnectionsDiagnostic(originalSockets, originalConnections, noGame, noName)

  check('[9.1] socketRegistry.size не е променен', () => {
    assert(originalSockets.size === socketSizeBefore, 'Map size changed')
  })
  check('[9.2] connection обектът не е мутиран', () => {
    const c = originalConnections['c1']
    assert(c.profileId === connBefore.profileId, 'profileId mutated')
    assert(c.connectedAt === connBefore.connectedAt, 'connectedAt mutated')
    assert(c.status === connBefore.status, 'status mutated')
  })
}

// ─── [10] displayName lookup се вика само за authenticated ────────────────────

console.log('\n[10] getDisplayName — извиква се само за non-null profileId')
{
  let callCount = 0
  const trackingGetName = (id: string): string | null => {
    callCount++
    return `Name-${id}`
  }

  const sockets: ReadonlyMap<string, { readyState: number }> = new Map([
    ['g', makeSocket(WS_OPEN)],    // guest
    ['a', makeSocket(WS_OPEN)],    // authenticated
  ])
  const connections = {
    'g': conn({ profileId: null }),
    'a': conn({ profileId: 'px' }),
  }

  const result = buildWsConnectionsDiagnostic(sockets, connections, noGame, trackingGetName)

  check('[10.1] getDisplayName викан точно 1 път (само за authenticated)', () => {
    assert(callCount === 1, `callCount=${callCount}`)
  })
  check('[10.2] authenticated entry има displayName', () => {
    const a = result.entries.find(e => e.profileId === 'px')
    assert(a?.displayName === 'Name-px', `displayName=${String(a?.displayName)}`)
  })
  check('[10.3] guest entry displayName === null', () => {
    const g = result.entries.find(e => e.profileId === null)
    assert(g?.displayName === null, `displayName=${String(g?.displayName)}`)
  })
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
