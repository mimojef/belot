// checkSilentResumeAttemptProofsE2E.ts — Етап 4 с реална игра: реален
// изолиран сървър (giftBackTestHarness), реални WebSocket връзки с cookie,
// случайна маса с ботове. Без браузър — контролираме точно кои връзки са
// „живи“, „полуотворени“ (socket спира да чете) и кои отговори се „губят“.
//
//  [X1] B се прикрепя към мястото, но клиентът не получава потвърждението и
//       B остава полуотворен (за сървъра — жив и прикрепен)
//  [X2] нов опит БЕЗ доказателство -> other_session_active (самоблокирането отпреди)
//  [X3] нов опит С доказателство за B -> room_resumed; B е изтласкан и
//       освободен с terminate() (полуотворен -> 1006) за ~1.5 s; закъснялото
//       затваряне на B не засяга вече възстановеното място
//  [X4] друго „устройство“ (жива връзка без доказателство) продължава да блокира
//       — дори ако клиентът докаже свои опити; не е изтласкано
//  [X5] грешен proof за чуждата връзка -> отказ; чуждата връзка не е изтласкана
//  [X6] attemptProof и reconnectToken не се появяват в лога на сървъра
//  [X7] изричното възстановяване (без reconnectOf) изтласква полуотворена връзка
//       както досега — само close(), без terminate() (поведението извън тихото
//       възстановяване на Белот е непроменено)
//
//   node server/node_modules/tsx/dist/cli.mjs scripts/checkSilentResumeAttemptProofsE2E.ts
import WebSocket from 'ws'
import { assert, check, finishAndExit, startGiftBackHarness } from './giftBackTestHarness'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log('\ncheckSilentResumeAttemptProofsE2E\n')
const h = await startGiftBackHarness({
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: {
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
    BELOT_LOCAL_BOT_ACTION_MIN_MS: '60',
    BELOT_LOCAL_BOT_ACTION_MAX_MS: '120',
  },
})
h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
await h.restartServer()
for (let i = 0; i < 20; i++) {
  try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* рестарт */ }
  await sleep(300)
}
const wsUrl = h.backendOrigin.replace('http://', 'ws://') + '/ws'

type Client = {
  ws: WebSocket
  id: string
  proof: string | null
  messages: Array<Record<string, any>>
  send: (m: object) => void
  waitFor: (pred: (m: Record<string, any>) => boolean, timeoutMs?: number, from?: number) => Promise<Record<string, any>>
  /** Полуотворена: socket-ът спира да чете (не отговаря и на close handshake). */
  goHalfOpen: () => void
  closed: () => boolean
}
async function open(cookie: string): Promise<Client> {
  const ws = new WebSocket(wsUrl, { headers: { Cookie: `belot_session=${cookie}` } })
  const messages: Array<Record<string, any>> = []
  let isClosed = false
  ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
  ws.on('close', () => { isClosed = true })
  ws.on('error', () => { /* затворена */ })
  const waitFor: Client['waitFor'] = async (pred, timeoutMs = 10_000, from = 0) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = messages.slice(from).find(pred)
      if (found) return found
      await sleep(30)
    }
    throw new Error('timeout waiting for message')
  }
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad) })
  const connected = await waitFor((m) => m.type === 'connected')
  return {
    ws, id: connected.clientId, proof: connected.attemptProof ?? null, messages, waitFor,
    send: (m) => ws.send(JSON.stringify(m)),
    goHalfOpen: () => { (ws as unknown as { _socket: { pause: () => void } })._socket.pause() },
    closed: () => isClosed,
  }
}
const resumeLines = () => h.serverOutput().split('\n').filter((l) => l.includes('[resume] ')).map((l) => JSON.parse(l.slice(l.indexOf('[resume] ') + 9)))
const lastResumeFor = (connectionId: string) => [...resumeLines()].reverse().find((e) => e.connectionId === connectionId)

try {
  const p = await h.register('p')
  h.setBalance(p.profileId, 50_000_000)
  const A = await open(p.cookie)
  assert(typeof A.proof === 'string' && A.proof.length >= 20, `attemptProof: ${A.proof}`)
  A.send({ type: 'join_matchmaking', stake: 5000 })
  const firstSnapshot = await A.waitFor((m) => m.type === 'room_snapshot' && m.game != null && typeof m.reconnectToken === 'string', 90_000)
  const roomId: string = firstSnapshot.roomId
  const token: string = firstSnapshot.reconnectToken
  console.log(`  room=${roomId}`)

  // [X1] B се прикрепя; потвърждението „се губи“ и B става полуотворен.
  const B = await open(p.cookie)
  B.send({ type: 'resume_room', roomId, reconnectToken: token, reconnectOf: A.id, reconnectAttempt: 1 })
  await B.waitFor((m) => m.type === 'room_resumed')
  B.goHalfOpen()
  await check('[X1] сървърът е прикрепил B към мястото (B остава жив за сървъра)', () => {
    const entry = lastResumeFor(B.id)
    assert(entry?.result === 'attached' && entry.mode === 'silent_reconnect', JSON.stringify(entry))
  })

  await check('[X2] нов опит без доказателство -> other_session_active (самоблокирането отпреди)', async () => {
    const C1 = await open(p.cookie)
    C1.send({ type: 'resume_room', roomId, reconnectToken: token, reconnectOf: A.id, reconnectAttempt: 2 })
    const reply = await C1.waitFor((m) => m.type === 'room_resume_failed' || m.type === 'room_resumed')
    assert(reply.type === 'room_resume_failed' && reply.code === 'other_session_active', JSON.stringify(reply))
    assert(lastResumeFor(C1.id)?.detail === 'seat_held_by_other_connection', JSON.stringify(lastResumeFor(C1.id)))
    C1.ws.close()
  })

  let C2: Client | null = null
  await check('[X3] нов опит с доказателство за B -> възстановено; B освободен с terminate(); мястото не се засяга', async () => {
    C2 = await open(p.cookie)
    C2.send({ type: 'resume_room', roomId, reconnectToken: token, reconnectOf: A.id, reconnectAttempt: 3, priorAttempts: [{ connectionId: B.id, proof: B.proof }] })
    const reply = await C2.waitFor((m) => m.type === 'room_resume_failed' || m.type === 'room_resumed')
    assert(reply.type === 'room_resumed', JSON.stringify(reply))
    const entry = lastResumeFor(C2.id)
    assert(entry?.result === 'attached' && entry.verifiedPriorAttemptCount === 1 && entry.provenOwnConnectionIds?.[0] === B.id && entry.displacedConnectionIds?.includes(B.id), JSON.stringify(entry))
    const terminatedAt = Date.now()
    // B е полуотворен — close handshake-ът няма отговор -> terminate() след ~1.5 s -> 1006.
    const deadline = Date.now() + 6_000
    let closeEntry: any = null
    while (Date.now() < deadline && closeEntry === null) {
      const line = h.serverOutput().split('\n').find((l) => l.includes('[ws-close]') && l.includes(B.id))
      if (line) closeEntry = JSON.parse(line.slice(line.indexOf('[ws-close]') + 11))
      await sleep(100)
    }
    assert(closeEntry !== null && closeEntry.code === 1006, `затваряне на B: ${JSON.stringify(closeEntry)}`)
    assert(h.serverOutput().includes(`"connectionId":"${B.id}"`) && h.serverOutput().split('\n').some((l) => l.includes('[ws-displace-terminate]') && l.includes(B.id)), 'няма [ws-displace-terminate] за B')
    assert(Date.now() - terminatedAt < 5_000, 'terminate() закъсня')
    // След затварянето на B мястото остава на C2: идват нови snapshot-и и мястото е свързано.
    const from = C2.messages.length
    const snap = await C2.waitFor((m) => m.type === 'room_snapshot' && m.roomId === roomId, 20_000, from)
    const mySeat = snap.yourSeat
    const seat = snap.seats.find((s: any) => s.seat === mySeat)
    assert(mySeat != null && seat?.isConnected === true, `мястото след затварянето на B: ${JSON.stringify(seat)}`)
  })

  await check('[X4] друго „устройство“ (жива връзка без доказателство) блокира и не е изтласкано, дори при доказани собствени опити', async () => {
    const D = await open(p.cookie) // чуждо устройство: живо, proof-ът му никога не стига до клиента E
    const F = await open(p.cookie) // собствен предишен опит на E (доказан)
    const E = await open(p.cookie)
    E.send({ type: 'resume_room', roomId, reconnectToken: token, reconnectOf: C2!.id, reconnectAttempt: 4, priorAttempts: [{ connectionId: F.id, proof: F.proof }] })
    const reply = await E.waitFor((m) => m.type === 'room_resume_failed' || m.type === 'room_resumed')
    assert(reply.type === 'room_resume_failed' && reply.code === 'other_session_active', JSON.stringify(reply))
    const entry = lastResumeFor(E.id)
    assert(entry?.blockingConnectionId === D.id && entry.verifiedPriorAttemptCount === 1, JSON.stringify(entry))
    await sleep(2_000)
    assert(!D.closed() && !C2!.closed(), `изтласкване: D=${D.closed()} C2=${C2!.closed()}`)

    // [X5] грешен proof за чуждата връзка
    const E2 = await open(p.cookie)
    E2.send({ type: 'resume_room', roomId, reconnectToken: token, reconnectOf: C2!.id, reconnectAttempt: 5, priorAttempts: [{ connectionId: D.id, proof: 'not-the-real-proof' }, { connectionId: F.id, proof: F.proof }] })
    const reply2 = await E2.waitFor((m) => m.type === 'room_resume_failed' || m.type === 'room_resumed')
    assert(reply2.type === 'room_resume_failed' && reply2.code === 'other_session_active', JSON.stringify(reply2))
    assert(lastResumeFor(E2.id)?.verifiedPriorAttemptCount === 1, JSON.stringify(lastResumeFor(E2.id)))
    await sleep(1_000)
    assert(!D.closed() && !C2!.closed(), 'грешен proof изтласка връзка')
    for (const c of [D, F, E, E2]) c.ws.close()
  })
  await check('[X5] (в X4) грешен proof не изтласква чужда връзка', () => { /* проверено в X4 */ })

  await check('[X6] attemptProof и reconnectToken не се появяват в лога на сървъра', () => {
    const out = h.serverOutput()
    assert(!out.includes(token), 'reconnectToken в лога')
    for (const proof of [A.proof, B.proof]) assert(proof !== null && !out.includes(proof), 'attemptProof в лога')
  })
  await check('[X7] изрично възстановяване: изтласкана полуотворена връзка — без terminate()', async () => {
    // C2 държи мястото; спира да чете (полуотворена). Изричният resume_room
    // (без reconnectOf, напр. „Върни ме в играта“) изтласква всички връзки.
    C2!.goHalfOpen()
    const G = await open(p.cookie)
    G.send({ type: 'resume_room', roomId, reconnectToken: token })
    const reply = await G.waitFor((m) => m.type === 'room_resumed' || m.type === 'room_resume_failed')
    assert(reply.type === 'room_resumed', JSON.stringify(reply))
    assert(lastResumeFor(G.id)?.mode === 'explicit' && lastResumeFor(G.id)?.displacedConnectionIds?.includes(C2!.id), JSON.stringify(lastResumeFor(G.id)))
    await sleep(3_500)
    const terminated = h.serverOutput().split('\n').some((l) => l.includes('[ws-displace-terminate]') && l.includes(C2!.id))
    assert(!terminated, 'terminate() при изрично възстановяване')
    G.ws.close()
  })
  C2?.ws.close()
} finally {
  await h.close()
}
finishAndExit()
