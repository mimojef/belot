// checkConnectedAuthIdentity.ts — Етап 2: 'connected' носи непрозрачна
// идентичност на удостоверителната сесия (authRef) и profileId.
// Реален изолиран сървър (giftBackTestHarness) + реални WS връзки с cookie.
//
//  [A1] гост -> authRef null, profileId null; лог auth=none
//  [A2] една сесия -> същият authRef на всяка нова връзка; profileId = профила; лог auth=session
//  [A3] друга сесия (друг профил) -> различен authRef
//  [A4] authRef не съдържа sessionId, session token или cookie
//  [A5] оттеглена сесия (logout) -> нова връзка: authRef null (клиентът презарежда)
//  [A6] рестарт на сървъра -> същата сесия получава друг authRef (не е свързваем)
//
//   node server/node_modules/tsx/dist/cli.mjs scripts/checkConnectedAuthIdentity.ts
import WebSocket from 'ws'
import { assert, check, finishAndExit, startGiftBackHarness } from './giftBackTestHarness'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log('\ncheckConnectedAuthIdentity\n')
const h = await startGiftBackHarness()
const wsUrl = h.backendOrigin.replace('http://', 'ws://') + '/ws'

async function connectedFrame(cookie: string | null): Promise<Record<string, any>> {
  const ws = new WebSocket(wsUrl, cookie === null ? {} : { headers: { Cookie: `belot_session=${cookie}` } })
  try {
    return await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connected')), 8_000)
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(String(data))
          if (m.type === 'connected') { clearTimeout(timer); resolve(m) }
        } catch { /* ignore */ }
      })
      ws.once('error', reject)
    })
  } finally {
    ws.close()
    await sleep(100)
  }
}

try {
  const a = await h.register('a')
  const b = await h.register('b')

  await check('[A1] гост -> authRef null, profileId null; лог auth=none', async () => {
    const m = await connectedFrame(null)
    assert('authRef' in m && m.authRef === null && m.profileId === null, JSON.stringify(m))
    assert(h.serverOutput().includes(`[ws] client connected: ${m.clientId} `) && h.serverOutput().split('\n').some((l) => l.includes(m.clientId) && l.trim().endsWith('auth=none')), 'лог auth=none')
  })

  let refA = ''
  await check('[A2] една сесия -> същият authRef на всяка връзка; profileId = профила; лог auth=session', async () => {
    const m1 = await connectedFrame(a.cookie)
    const m2 = await connectedFrame(a.cookie)
    assert(typeof m1.authRef === 'string' && m1.authRef.length >= 20, JSON.stringify(m1))
    assert(m1.authRef === m2.authRef, `различен authRef за същата сесия: ${m1.authRef} / ${m2.authRef}`)
    assert(m1.profileId === a.profileId && m2.profileId === a.profileId, JSON.stringify([m1.profileId, m2.profileId]))
    assert(m1.clientId !== m2.clientId, 'същата връзка')
    assert(h.serverOutput().split('\n').some((l) => l.includes(m1.clientId) && l.trim().endsWith('auth=session')), 'лог auth=session')
    refA = m1.authRef
  })

  await check('[A3] друга сесия -> различен authRef', async () => {
    const m = await connectedFrame(b.cookie)
    assert(typeof m.authRef === 'string' && m.authRef !== refA && m.profileId === b.profileId, JSON.stringify(m))
  })

  await check('[A4] authRef не съдържа sessionId, session token или cookie', () => {
    const rows = h.db.prepare('SELECT session_id FROM account_sessions WHERE profile_id = ?').all(a.profileId) as Array<{ session_id: string }>
    assert(rows.length > 0, 'няма сесия в базата')
    for (const row of rows) {
      assert(!refA.includes(row.session_id) && !row.session_id.includes(refA), 'authRef разкрива sessionId')
    }
    assert(!refA.includes(a.cookie) && !a.cookie.includes(refA), 'authRef разкрива cookie/token')
  })

  await check('[A5] оттеглена сесия (logout) -> нова връзка: authRef null', async () => {
    const res = await fetch(`${h.backendOrigin}/api/auth/logout`, { method: 'POST', headers: { Cookie: `belot_session=${a.cookie}` } })
    assert(res.status < 500, `logout ${res.status}`)
    const m = await connectedFrame(a.cookie)
    assert(m.authRef === null && m.profileId === null, JSON.stringify(m))
  })

  await check('[A6] рестарт на сървъра -> същата сесия получава друг authRef', async () => {
    const before = (await connectedFrame(b.cookie)).authRef
    await h.restartServer()
    for (let i = 0; i < 20; i++) {
      try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* стара keep-alive връзка */ }
      await sleep(300)
    }
    const after = (await connectedFrame(b.cookie)).authRef
    assert(typeof before === 'string' && typeof after === 'string' && before !== after, `${before} / ${after}`)
  })
} finally {
  await h.close()
}
finishAndExit()
