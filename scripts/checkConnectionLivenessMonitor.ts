/**
 * checkConnectionLivenessMonitor.ts
 *
 * Детерминистичен unit тест (фалшив часовник) за
 * src/app/network/createConnectionLivenessMonitor.ts — откриване на
 * полуотворена WebSocket връзка по време на активна игра:
 *   [L1] при поток от съобщения — нито ping, нито recovery
 *   [L2] тишина >= 6 сек -> точно един ping; отговор (pong) -> без recovery
 *   [L3] ping без НИКАКВО съобщение 5 сек -> onUnresponsive точно веднъж
 *   [L4] изключен (няма активна стая) / няма OPEN socket -> нищо
 *   [L5] не разчита на локалния таймер за ход: само на реални съобщения
 */

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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const { createConnectionLivenessMonitor, LIVENESS_IDLE_BEFORE_PING_MS, LIVENESS_PONG_TIMEOUT_MS } =
  await import('../src/app/network/createConnectionLivenessMonitor.ts')

function setup(options: { enabled?: boolean; socketOpen?: boolean } = {}) {
  let now = 1_000_000
  let lastMessageAt = now
  let enabled = options.enabled ?? true
  let socketOpen = options.socketOpen ?? true
  let pings = 0
  let unresponsive = 0
  const monitor = createConnectionLivenessMonitor({
    isEnabled: () => enabled,
    getMsSinceLastServerMessage: () => (socketOpen ? now - lastMessageAt : null),
    sendPing: () => { pings += 1 },
    onUnresponsive: () => { unresponsive += 1 },
    now: () => now,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  // Симулира tick-овете на 1 сек.
  function advance(ms: number, messageEveryMs: number | null = null): void {
    for (let t = 0; t < ms; t += 1_000) {
      now += 1_000
      if (messageEveryMs !== null && t % messageEveryMs === 0) lastMessageAt = now
      monitor.check()
    }
  }
  return {
    advance,
    // Време минава БЕЗ tick-ове (sleep / замразен background таб).
    suspend: (ms: number) => { now += ms },
    checkNow: () => monitor.check(),
    message: () => { lastMessageAt = now },
    setEnabled: (value: boolean) => { enabled = value },
    setSocketOpen: (value: boolean) => { socketOpen = value },
    pings: () => pings,
    unresponsive: () => unresponsive,
  }
}

console.log('\n═══ checkConnectionLivenessMonitor ═══\n')

check('[L0] продукционни прагове: ping след 6 сек тишина, recovery 5 сек след ping-а', () => {
  assert(LIVENESS_IDLE_BEFORE_PING_MS === 6_000, `idle=${LIVENESS_IDLE_BEFORE_PING_MS}`)
  assert(LIVENESS_PONG_TIMEOUT_MS === 5_000, `pong=${LIVENESS_PONG_TIMEOUT_MS}`)
})

check('[L1] нормален поток от snapshot-и (на 2 сек) — нито ping, нито recovery за 60 сек', () => {
  const s = setup()
  s.advance(60_000, 2_000)
  assert(s.pings() === 0, `pings=${s.pings()}`)
  assert(s.unresponsive() === 0, `unresponsive=${s.unresponsive()}`)
})

check('[L2] тишина -> един ping; pong пристига -> без recovery, после нов цикъл само при нова тишина', () => {
  const s = setup()
  s.advance(5_000)
  assert(s.pings() === 0, 'ping преди 6 сек тишина')
  s.advance(1_000)
  assert(s.pings() === 1, `очакван 1 ping, има ${s.pings()}`)
  s.advance(2_000)
  assert(s.pings() === 1, 'втори ping, докато първият чака отговор')
  s.message() // pong
  s.advance(1_000)
  assert(s.unresponsive() === 0, 'recovery при жива връзка')
  s.advance(4_000)
  assert(s.pings() === 1, 'нов ping преди нова 6-сек тишина')
  s.advance(1_000)
  assert(s.pings() === 2, `очакван 2-ри ping след нова тишина, има ${s.pings()}`)
})

check('[L3] ping без отговор -> onUnresponsive точно веднъж след 5 сек', () => {
  const s = setup()
  s.advance(6_000)
  assert(s.pings() === 1, 'няма ping')
  s.advance(4_000)
  assert(s.unresponsive() === 0, 'recovery преди pong timeout-а')
  s.advance(1_000)
  assert(s.unresponsive() === 1, `очакван 1 recovery, има ${s.unresponsive()}`)
})

check('[L4] изключен или без OPEN socket — нищо; чакащ ping се нулира', () => {
  const disabled = setup({ enabled: false })
  disabled.advance(30_000)
  assert(disabled.pings() === 0 && disabled.unresponsive() === 0, 'активност при изключен монитор')

  const closed = setup({ socketOpen: false })
  closed.advance(30_000)
  assert(closed.pings() === 0 && closed.unresponsive() === 0, 'активност без OPEN socket')

  const s = setup()
  s.advance(6_000)
  assert(s.pings() === 1, 'няма ping')
  s.setSocketOpen(false) // close/reconnect пътят поема
  s.advance(10_000)
  assert(s.unresponsive() === 0, 'recovery за вече затворен socket')
  s.setSocketOpen(true)
  s.message() // нов socket е отворен
  s.advance(5_000)
  assert(s.unresponsive() === 0 && s.pings() === 1, 'стар чакащ ping е оцелял през reconnect-а')
})

check('[L5] съобщение точно в момента на ping-а се брои за живот', () => {
  const s = setup()
  s.advance(6_000)
  s.message()
  s.advance(10_000)
  assert(s.unresponsive() === 0, `recovery въпреки съобщение след ping-а (${s.unresponsive()})`)
})

check('[L6] sleep/suspend с чакащ ping: без фалшив recovery при събуждане, нов ping и пълен timeout', () => {
  const s = setup()
  s.advance(6_000)
  assert(s.pings() === 1, 'няма ping преди sleep')
  s.suspend(60_000)
  s.checkNow() // visibilitychange -> check()
  assert(s.unresponsive() === 0, 'фалшив recovery веднага след събуждане')
  assert(s.pings() === 2, `очакван нов ping след събуждане, има ${s.pings()}`)
  // Буферираното от живата връзка пристига веднага след събуждането.
  s.message()
  s.advance(6_000)
  assert(s.unresponsive() === 0, 'recovery въпреки съобщение след събуждането')

  const dead = setup()
  dead.advance(6_000)
  dead.suspend(60_000)
  dead.checkNow()
  dead.advance(4_000)
  assert(dead.unresponsive() === 0, 'recovery преди пълния pong timeout след събуждане')
  dead.advance(1_000)
  assert(dead.unresponsive() === 1, `мъртва връзка след събуждане не е засечена (${dead.unresponsive()})`)
})

check('[L7] без чакащ ping събуждането след дълга тишина пингва веднага', () => {
  const s = setup()
  s.suspend(60_000)
  s.checkNow()
  assert(s.pings() === 1 && s.unresponsive() === 0, `pings=${s.pings()} unresponsive=${s.unresponsive()}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
