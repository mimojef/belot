/**
 * checkSupportOwnMessageDelete.ts — „Поддръжка“: HARD DELETE на собствени
 * admin съобщения от собственическия акаунт (PIKA_OWNER_ACCOUNT_ID).
 * Реален изолиран сървър (giftBackTestHarness, отделна временна база) +
 * HTTP + WS.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkSupportOwnMessageDelete.ts
 *
 * Покрива: права (собственик / друг admin / потребител / без env / невалиден
 * env), авторство, текст + снимка (DB редове, опашка, физическо изтриване от
 * worker-а), разговор-доказателство (409), брояч на непрочетени, последно
 * съобщение в списъка, WS известие (без данни за автора), че потребителят не
 * получава автор/canDelete, приписване на старите съобщения (без презапис,
 * само отпреди миграцията, fail-closed при невалиден env/не-admin акаунт),
 * „Маркирай като заявка за изтриване“ (валидацията на user съобщение).
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws') as any

console.log('\ncheckSupportOwnMessageDelete\n')

const FAST_SUPPORT_CLEANUP: ServerSourcePatch = {
  file: 'index.ts',
  find: 'const SUPPORT_ATTACHMENT_CLEANUP_INTERVAL_MS = CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS',
  replace: 'const SUPPORT_ATTACHMENT_CLEANUP_INTERVAL_MS = 1_500',
}
const MIGRATION = '20261117_002_support_message_sender_account.sql'

const env: Record<string, string> = {}
const h = await startGiftBackHarness({ patchServerSource: [FAST_SUPPORT_CLEANUP], env })
const wsOrigin = h.backendOrigin.replace(/^http/, 'ws')
const sockets: Array<{ close: () => void }> = []

try {
  let tag = 0
  async function register(): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    tag += 1
    return h.register(`s${tag}`)
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  const makeAdmin = (p: TestProfile) => h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?`).run(accountOf(p.profileId))
  const ageAccount = (p: TestProfile) => h.db.prepare(`UPDATE accounts SET created_at = '2020-01-01 00:00:00' WHERE account_id = ?`).run(accountOf(p.profileId))

  async function api(p: TestProfile, method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
    const res = await fetch(`${h.backendOrigin}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${p.cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { /* ignore */ }
    return { status: res.status, body: parsed, text }
  }
  function connect(p: TestProfile): { frames: any[] } {
    const frames: any[] = []
    const socket = new WebSocket(`${wsOrigin}/ws`, { headers: { Cookie: `belot_session=${p.cookie}` } })
    socket.on('message', (raw: Buffer) => { try { frames.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
    sockets.push({ close: () => socket.close() })
    return { frames }
  }
  const image = async () => `data:image/png;base64,${(await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 32, g: 120, b: 220 } } }).png().toBuffer()).toString('base64')}`
  const row = (messageId: string) => h.db.prepare('SELECT message_id, sender_account_id FROM support_messages WHERE message_id = ?').get(messageId) as { sender_account_id: string | null } | undefined

  const owner = await register()
  const admin2 = await register()
  const user = await register()
  const user2 = await register()
  makeAdmin(owner); makeAdmin(admin2); ageAccount(user); ageAccount(user2)
  const ownerAccountId = accountOf(owner.profileId)

  // ── Приписване на старите съобщения (преди env / при невалиден env) ──
  const applied = h.db.prepare('SELECT applied_at FROM server_migrations WHERE filename = ?').get(MIGRATION) as { applied_at: string } | undefined
  await check('миграцията е приложена, колоната съществува', () => {
    const cols = (h.db.prepare('PRAGMA table_info(support_messages)').all() as Array<{ name: string }>).map((c) => c.name)
    assert(applied !== undefined && cols.includes('sender_account_id'), JSON.stringify({ applied, cols }))
  })
  const legacyOld = randomUUID(), legacyOther = randomUUID(), legacyNew = randomUUID(), legacyUser = randomUUID()
  const insertLegacy = h.db.prepare(`INSERT INTO support_messages (message_id, profile_id, body, is_from_admin, created_at, read_by_user, read_by_admin, sender_account_id) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`)
  insertLegacy.run(legacyUser, user2.profileId, 'стар въпрос', 0, '2026-01-01T09:00:00.000Z', null)
  insertLegacy.run(legacyOld, user2.profileId, 'стар отговор', 1, '2026-01-01T10:00:00.000Z', null)
  insertLegacy.run(legacyOther, user2.profileId, 'отговор с автор', 1, '2026-01-01T11:00:00.000Z', accountOf(admin2.profileId))
  insertLegacy.run(legacyNew, user2.profileId, 'NULL след миграцията', 1, '2099-01-01T00:00:00.000Z', null)

  env.PIKA_OWNER_ACCOUNT_ID = 'not-a-uuid'
  await h.restartServer()
  await check('невалиден PIKA_OWNER_ACCOUNT_ID → нищо не се приписва', () => {
    assert(row(legacyOld)?.sender_account_id === null, JSON.stringify(row(legacyOld)))
  })
  env.PIKA_OWNER_ACCOUNT_ID = accountOf(user.profileId) // съществуващ, но НЕ admin
  await h.restartServer()
  await check('не-admin акаунт в PIKA_OWNER_ACCOUNT_ID → нищо не се приписва', () => {
    assert(row(legacyOld)?.sender_account_id === null, JSON.stringify(row(legacyOld)))
  })
  env.PIKA_OWNER_ACCOUNT_ID = ownerAccountId.toUpperCase() // регистърът не е важен
  await h.restartServer()
  await check('валиден собственик → старите admin съобщения без автор се приписват', () => {
    assert(row(legacyOld)?.sender_account_id === ownerAccountId, JSON.stringify(row(legacyOld)))
  })
  await check('вече установен автор не се презаписва; user съобщение и ред след миграцията — непокътнати', () => {
    assert(row(legacyOther)?.sender_account_id === accountOf(admin2.profileId), 'other')
    assert(row(legacyUser)?.sender_account_id === null, 'user')
    assert(row(legacyNew)?.sender_account_id === null, 'after migration')
  })

  // ── Разговор с потребителя ──
  const userWs = connect(user)
  const admin2Ws = connect(admin2)
  await sleep(800)
  const u1 = await api(user, 'POST', '/api/support/messages', { body: 'Здравейте, имам въпрос' })
  assert(u1.status === 200, `user send ${u1.status} ${u1.text}`)
  const userMessageId = u1.body.message.messageId as string
  const a2 = await api(admin2, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Отговор от друг админ' })
  assert(a2.status === 200, `admin2 reply ${a2.text}`)
  const admin2MessageId = a2.body.message.messageId as string
  const o1 = await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Текст от собственика' })
  const ownerTextId = o1.body.message.messageId as string
  const o2 = await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Ето снимка', imageDataUrl: await image() })
  assert(o2.status === 200 && o2.body.message.attachment, `owner image ${o2.text}`)
  const ownerImageId = o2.body.message.messageId as string
  const ownerImageFile = o2.body.message.attachment.attachmentId as string

  await check('новите admin отговори записват автора (вътрешно)', () => {
    assert(row(ownerTextId)?.sender_account_id === ownerAccountId && row(admin2MessageId)?.sender_account_id === accountOf(admin2.profileId), 'sender')
  })
  await check('собственикът: canDelete само за собствените му съобщения', async () => {
    const r = await api(owner, 'GET', `/api/support/admin/messages/${user.profileId}`)
    const by = Object.fromEntries((r.body.messages as any[]).map((m) => [m.messageId, m.canDelete]))
    assert(by[ownerTextId] === true && by[ownerImageId] === true && by[admin2MessageId] === false && by[userMessageId] === false, JSON.stringify(by))
  })
  await check('друг admin: canDelete false навсякъде', async () => {
    const r = await api(admin2, 'GET', `/api/support/admin/messages/${user.profileId}`)
    assert((r.body.messages as any[]).every((m) => m.canDelete === false), JSON.stringify(r.body.messages.map((m: any) => m.canDelete)))
  })
  await check('потребителят не получава автор/canDelete/account id', async () => {
    const r = await api(user, 'GET', '/api/support/messages')
    assert(r.status === 200 && r.body.messages.length === 4, r.text.slice(0, 200))
    assert(!/canDelete|sender|account/i.test(r.text) && !r.text.includes(ownerAccountId), r.text.slice(0, 300))
  })

  // Непрочетени при потребителя (3 admin отговора, ново зареждане ги маркира → тестваме преди)
  h.db.prepare('UPDATE support_messages SET read_by_user = 0 WHERE profile_id = ? AND is_from_admin = 1').run(user.profileId)
  const unreadBefore = (await api(user, 'GET', '/api/support/unread')).body.unreadCount

  await check('отказ: потребител → 403', async () => {
    const r = await api(user, 'DELETE', `/api/support/admin/messages/${ownerTextId}`)
    assert(r.status === 403 && row(ownerTextId) !== undefined, `${r.status}`)
  })
  await check('отказ: друг admin върху съобщение на собственика → 403', async () => {
    const r = await api(admin2, 'DELETE', `/api/support/admin/messages/${ownerTextId}`)
    assert(r.status === 403 && row(ownerTextId) !== undefined, `${r.status}`)
  })
  await check('отказ: собственикът върху съобщение на друг admin → 403', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${admin2MessageId}`)
    assert(r.status === 403 && row(admin2MessageId) !== undefined, `${r.status}`)
  })
  await check('отказ: собственикът върху съобщение на потребителя → 403', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${userMessageId}`)
    assert(r.status === 403 && row(userMessageId) !== undefined, `${r.status}`)
  })
  await check('несъществуващо съобщение → 404', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${randomUUID()}`)
    assert(r.status === 404, `${r.status}`)
  })

  await check('изтриване на снимка: HARD DELETE (съобщение + прикачен файл в БД), файлът в опашката', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${ownerImageId}`)
    assert(r.status === 200 && r.body.messageId === ownerImageId && r.body.profileId === user.profileId, r.text)
    assert(row(ownerImageId) === undefined, 'message row still present')
    assert(h.db.prepare('SELECT 1 FROM support_message_attachments WHERE message_id = ?').get(ownerImageId) === undefined, 'attachment row')
    assert(h.db.prepare('SELECT 1 FROM support_message_attachment_deletions WHERE storage_filename = ?').get(ownerImageFile) !== undefined, 'queue')
    assert(!(r.body.messages as any[]).some((m) => m.messageId === ownerImageId), 'response list')
  })
  await check('WS: потребителят и другият admin получават support_message_deleted само с profileId/messageId', async () => {
    await sleep(400)
    const forUser = userWs.frames.find((f) => f.type === 'support_message_deleted' && f.messageId === ownerImageId)
    const forAdmin = admin2Ws.frames.find((f) => f.type === 'support_message_deleted' && f.messageId === ownerImageId)
    assert(forUser && forAdmin, 'frames missing')
    assert(JSON.stringify(Object.keys(forUser).sort()) === JSON.stringify(['messageId', 'profileId', 'type']) && forUser.profileId === user.profileId, JSON.stringify(forUser))
  })
  await check('брояч на непрочетени при потребителя намалява с 1', async () => {
    const after = (await api(user, 'GET', '/api/support/unread')).body.unreadCount
    assert(after === unreadBefore - 1, `${unreadBefore} → ${after}`)
  })
  await check('списъкът с разговори: последното съобщение се актуализира', async () => {
    const r = await api(owner, 'GET', '/api/support/admin/conversations?filter=active')
    const conv = (r.body.conversations as any[]).find((c) => c.profileId === user.profileId)
    assert(conv && conv.lastMessageBody === 'Текст от собственика' && conv.lastMessageIsFromAdmin === true, JSON.stringify(conv))
  })
  await check('физическото изтриване на файла (worker, без други референции)', async () => {
    const deadline = Date.now() + 15_000
    let status = ''
    while (Date.now() < deadline) {
      status = (h.db.prepare('SELECT cleanup_status FROM support_message_attachment_deletions WHERE storage_filename = ?').get(ownerImageFile) as { cleanup_status: string }).cleanup_status
      if (status === 'done') break
      await sleep(500)
    }
    assert(status === 'done' && /\[support-attachments\] Cleanup: deleted=1/.test(h.serverOutput()), `status=${status}`)
    const r = await api(owner, 'GET', `/api/support/attachments/${encodeURIComponent(ownerImageFile)}`)
    assert(r.status === 404, `attachment GET ${r.status}`)
  })
  await check('изтриване на текст; „Маркирай като заявка за изтриване“ остава валидно за user съобщението', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${ownerTextId}`)
    assert(r.status === 200 && row(ownerTextId) === undefined, r.text)
    assert(row(userMessageId) !== undefined && row(admin2MessageId) !== undefined, 'others touched')
    const conv = ((await api(owner, 'GET', '/api/support/admin/conversations?filter=active')).body.conversations as any[]).find((c) => c.profileId === user.profileId)
    assert(conv?.lastMessageBody === 'Отговор от друг админ', JSON.stringify(conv))
  })
  await check('повторно изтриване → 404', async () => {
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${ownerTextId}`)
    assert(r.status === 404, `${r.status}`)
  })

  // ── Разговор-доказателство за изтрит профил ──
  h.db.prepare(`INSERT INTO support_deletion_archives (archive_id, profile_id, username_snapshot, display_name_snapshot, request_message_id, requested_at) VALUES (?, ?, 'u', 'U', ?, '2026-01-01 09:00:00')`).run(randomUUID(), user2.profileId, legacyUser)
  await check('разговор-доказателство: canDelete false и DELETE → 409', async () => {
    const g = await api(owner, 'GET', `/api/support/admin/messages/${user2.profileId}`)
    assert((g.body.messages as any[]).every((m) => m.canDelete === false), JSON.stringify(g.body.messages))
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${legacyOld}`)
    assert(r.status === 409 && row(legacyOld) !== undefined, `${r.status}`)
  })

  // ── Без env: функцията е изключена ──
  const o3 = await api(owner, 'POST', '/api/support/admin/reply', { profileId: user.profileId, body: 'Още един' })
  const ownerThirdId = o3.body.message.messageId as string
  delete env.PIKA_OWNER_ACCOUNT_ID
  await h.restartServer()
  await check('без PIKA_OWNER_ACCOUNT_ID: canDelete false и DELETE → 403', async () => {
    const g = await api(owner, 'GET', `/api/support/admin/messages/${user.profileId}`)
    assert((g.body.messages as any[]).every((m) => m.canDelete === false), 'canDelete')
    const r = await api(owner, 'DELETE', `/api/support/admin/messages/${ownerThirdId}`)
    assert(r.status === 403 && row(ownerThirdId) !== undefined, `${r.status}`)
  })
} finally {
  for (const s of sockets) s.close()
  await h.close()
}

finishAndExit()
