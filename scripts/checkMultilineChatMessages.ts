/**
 * checkMultilineChatMessages.ts — многоредови съобщения в личния чат и „Поддръжка“
 * (потребител и администратор): правилото (server/src/shared/multilineMessageBody.ts)
 * и целият сървърен път през РЕАЛЕН изолиран сървър (HTTP -> store -> SQLite ->
 * HTTP четене).
 *
 *   [N*] правилото: нови редове (\r\n, \r, U+2028/2029), празни редове (≤ 2
 *        подред), интервали в реда, контролни символи, emoji (ZWJ, VS16, тонове,
 *        флагове, keycap, tag последователности), лимити след нормализирането
 *   [C*] личен чат: многоредово съобщение се записва и чете непроменено от двете
 *        страни; 40 реда — да, 41 — разбираемо съобщение; 1000/1001 символа;
 *        XSS текстът се пази като текст (escape е при показването)
 *   [S*] „Поддръжка“: потребител и администратор — многоредово записване/четене;
 *        60/61 реда; 2000/2001 символа; без запис при отказ
 *   [T1] Теми (vip_dm начало) остават със старото правило (статична проверка)
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkMultilineChatMessages.ts
 */

import { readFile } from 'node:fs/promises'
import {
  PERSONAL_CHAT_MESSAGE_LIMITS,
  SUPPORT_MESSAGE_LIMITS,
  normalizeMultilineMessageBody,
} from '../server/src/shared/multilineMessageBody'
import { assert, check, finishAndExit, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckMultilineChatMessages\n')

const norm = (value: string, limits = PERSONAL_CHAT_MESSAGE_LIMITS) => normalizeMultilineMessageBody(value, limits)
const ok = (value: string, limits = PERSONAL_CHAT_MESSAGE_LIMITS): string => {
  const result = norm(value, limits)
  if (!result.ok) throw new Error(`очаквано ok, получено ${result.reason}`)
  return result.body
}
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

// ─── Правилото ───────────────────────────────────────────────────────────

await check('[N1] нови редове: \\n, \\r\\n, \\r, U+2028, U+2029 -> \\n; редовете се пазят', () => {
  assert(ok('ред 1\nред 2') === 'ред 1\nред 2', 'LF')
  assert(ok('ред 1\r\nред 2\rред 3') === 'ред 1\nред 2\nред 3', 'CRLF/CR')
  assert(ok(`а${LS}б${PS}в`) === 'а\nб\nв', 'U+2028/2029')
})

await check('[N2] празни редове: пазят се до 2 подред; в началото и в края — махат се', () => {
  assert(ok('абзац 1\n\nабзац 2') === 'абзац 1\n\nабзац 2', '1 празен ред')
  assert(ok('а\n\n\nб') === 'а\n\n\nб', '2 празни реда')
  assert(ok('а\n\n\n\n\n\nб') === 'а\n\n\nб', 'повече от 2 -> 2')
  assert(ok('\n\n  \nа\nб\n \n\n') === 'а\nб', 'начало/край')
  assert(ok('а\n   \n\t\nб') === 'а\n\n\nб', 'редове само с интервали са празни')
})

await check('[N3] интервали в реда — сгъват се както досега; табулацията е интервал; краищата на реда се подрязват', () => {
  assert(ok('  много   интервали\tи\t\tтаб  \n  втори  ред ') === 'много интервали и таб\nвтори ред', 'сгъване')
  assert(ok(`а${String.fromCharCode(0xa0)}${String.fromCharCode(0x3000)}б`) === 'а б', 'Unicode интервали (както досега, \\s)')
})

await check('[N4] контролни символи (C0/C1) се махат, \\n остава', () => {
  const controls = [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0x9f].map((c) => String.fromCharCode(c)).join('')
  assert(ok(`а${controls}б\nв`) === 'аб\nв', 'контролни')
})

await check('[N5] emoji: ZWJ, VS16, тонове, флагове, keycap и tag последователности — непокътнати', () => {
  const samples = ['👨‍👩‍👧‍👦', '❤️', '👍🏽', '🇧🇬', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🧑🏽‍💻', '☕️', '©︎']
  for (const emoji of samples) assert(ok(`x ${emoji} y`) === `x ${emoji} y`, `emoji ${emoji}`)
  const multi = `Здравей 👋🏼\n\n${samples.join(' ')}\nкрай`
  assert(ok(multi) === multi, 'многоредово с emoji')
  assert(ok('[e:01]\n[e:02]') === '[e:01]\n[e:02]', 'анимирани emoji кодове')
})

await check('[N6] лимити — след нормализирането; 40/41 реда (личен), 60/61 (поддръжка); символи 1000/1001 и 2000/2001; без отрязване', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `р${i + 1}`).join('\n')
  assert(norm(lines(40)).ok, '40 реда')
  const over = norm(lines(41))
  assert(!over.ok && over.reason === 'too_many_lines' && over.lines === 41, '41 реда -> too_many_lines')
  assert(norm(lines(60), SUPPORT_MESSAGE_LIMITS).ok && !norm(lines(61), SUPPORT_MESSAGE_LIMITS).ok, 'поддръжка 60/61')
  assert(norm('a'.repeat(1000)).ok, '1000 символа')
  const long = norm('a'.repeat(1001))
  assert(!long.ok && long.reason === 'too_long', '1001 -> too_long')
  assert(norm('a'.repeat(2000), SUPPORT_MESSAGE_LIMITS).ok && !norm('a'.repeat(2001), SUPPORT_MESSAGE_LIMITS).ok, 'поддръжка 2000/2001')
  // Новият ред е 1 символ; празните редове се броят като редове.
  const blank = norm(`${lines(20)}\n\n\n${lines(19)}`)
  assert(!blank.ok && blank.reason === 'too_many_lines' && blank.lines === 41, 'празните редове се броят')
  // Сгъването на интервалите не позволява заобикаляне в другата посока: лимитът е за резултата.
  assert(norm(`${'a '.repeat(600)}`).ok === false, '1200 символа с интервали -> над лимита')
})

// ─── Реален сървър ───────────────────────────────────────────────────────

const h = await startGiftBackHarness()

async function api(profile: TestProfile, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${h.backendOrigin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${profile.cookie}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => null) }
}

try {
  const alice = await h.register('mlalice')
  const bob = await h.register('mlbob')
  const admin = await h.register('mladmin')
  h.db.prepare('UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)').run('admin', admin.profileId)

  const request = await api(alice, 'POST', '/api/friends/request', { profileId: bob.profileId })
  assert(request.status === 200 && request.json?.ok === true, `покана: ${JSON.stringify(request.json)}`)
  const friendshipId = String((request.json.friendships?.outgoingPending as Array<{ friendshipId: string; profile: { profileId: string } }> | undefined)
    ?.find((row) => row.profile.profileId === bob.profileId)?.friendshipId ?? '')
  assert(friendshipId.length > 0, `friendshipId: ${JSON.stringify(request.json)}`)
  const accept = await api(bob, 'POST', `/api/friends/${encodeURIComponent(friendshipId)}/accept`)
  assert(accept.status === 200 && accept.json?.ok === true, `приемане: ${JSON.stringify(accept.json)}`)
  const chatPath = `/api/chat/${encodeURIComponent(friendshipId)}/messages`
  const lastChatBody = async (profile: TestProfile): Promise<string> => {
    const list = await api(profile, 'GET', chatPath)
    const messages = list.json?.messages as Array<{ body: string }> | undefined
    return messages?.[messages.length - 1]?.body ?? ''
  }

  await check('[C1] личен чат: многоредово съобщение (нови и празни редове) — записва се и се чете непроменено от двете страни', async () => {
    const body = 'Здравей!\r\n\r\nПърви абзац,\nвтори ред.\n\n\n\n\nКрай 👨‍👩‍👧 ❤️'
    const sent = await api(alice, 'POST', chatPath, { body })
    assert(sent.status === 200 && sent.json?.ok === true, `изпращане: ${sent.status} ${JSON.stringify(sent.json)}`)
    const expected = 'Здравей!\n\nПърви абзац,\nвтори ред.\n\n\nКрай 👨‍👩‍👧 ❤️'
    assert(await lastChatBody(alice) === expected, `подател: ${JSON.stringify(await lastChatBody(alice))}`)
    assert(await lastChatBody(bob) === expected, `получател: ${JSON.stringify(await lastChatBody(bob))}`)
    const stored = h.db.prepare('SELECT body FROM friend_chat_messages ORDER BY created_at DESC LIMIT 1').get() as { body: string } | undefined
    assert(stored?.body === expected, `в базата: ${JSON.stringify(stored?.body)}`)
  })

  await check('[C2] личен чат: 40 реда — да; 41 — 400 с „до 40 реда“, без запис', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `ред ${i + 1}`).join('\n')
    const okSend = await api(alice, 'POST', chatPath, { body: lines(40) })
    assert(okSend.status === 200, `40 реда: ${okSend.status}`)
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM friend_chat_messages').get() as { n: number }).n
    const tooMany = await api(alice, 'POST', chatPath, { body: lines(41) })
    assert(tooMany.status === 400 && String(tooMany.json?.message).includes('до 40 реда'), `41 реда: ${tooMany.status} ${JSON.stringify(tooMany.json)}`)
    assert(tooMany.json?.code === 'message_too_many_lines', 'код')
    assert((h.db.prepare('SELECT COUNT(*) AS n FROM friend_chat_messages').get() as { n: number }).n === before, 'без запис')
  })

  await check('[C3] личен чат: 1000 символа (с нови редове) — да; 1001 — отказ (лимитът не се заобикаля)', async () => {
    const thousand = `${'а'.repeat(499)}\n${'б'.repeat(500)}`
    assert(thousand.length === 1000, 'дължина')
    assert((await api(alice, 'POST', chatPath, { body: thousand })).status === 200, '1000')
    const over = await api(alice, 'POST', chatPath, { body: `${thousand}в` })
    assert(over.status === 400 && String(over.json?.message).includes('1000 символа'), `1001: ${JSON.stringify(over.json)}`)
  })

  await check('[C4] личен чат: HTML/скрипт в многоредов текст се пази като текст (без интерпретация)', async () => {
    const body = '<b>удебелен</b>\n<img src=x onerror="alert(1)">\n**markdown**'
    assert((await api(alice, 'POST', chatPath, { body })).status === 200, 'изпращане')
    assert(await lastChatBody(bob) === body, 'буквално същият текст')
  })

  const supportBody = async (profile: TestProfile): Promise<string> => {
    const list = await api(profile, 'GET', '/api/support/messages')
    const messages = list.json?.messages as Array<{ body: string }> | undefined
    return messages?.[messages.length - 1]?.body ?? ''
  }

  await check('[S1] Поддръжка (потребител): многоредово съобщение — записва се и се чете непроменено', async () => {
    const body = 'Здравейте,\n\nимам проблем:\n1. първо\n2. второ\n\nБлагодаря!'
    const sent = await api(alice, 'POST', '/api/support/messages', { body })
    assert(sent.status === 200 && sent.json?.ok === true, `изпращане: ${sent.status} ${JSON.stringify(sent.json)}`)
    assert(await supportBody(alice) === body, `четене: ${JSON.stringify(await supportBody(alice))}`)
  })

  await check('[S2] Поддръжка (администратор): многоредов отговор — записва се; потребителят го вижда непроменен', async () => {
    const body = 'Здравейте!\n\nПроверихме:\n- точка 1\n- точка 2\n\n\nЕкипът'
    const sent = await api(admin, 'POST', '/api/support/admin/reply', { profileId: alice.profileId, body })
    assert(sent.status === 200 && sent.json?.ok === true, `отговор: ${sent.status} ${JSON.stringify(sent.json)}`)
    assert(await supportBody(alice) === body, `потребителят: ${JSON.stringify(await supportBody(alice))}`)
    const adminView = await api(admin, 'GET', `/api/support/admin/messages/${encodeURIComponent(alice.profileId)}`)
    const adminMessages = adminView.json?.messages as Array<{ body: string }> | undefined
    assert(adminMessages?.some((m) => m.body === body) === true, 'админ изгледът')
  })

  await check('[S3] Поддръжка: 61 реда — 400 с „до 60 реда“ (потребител и админ), без запис; 2001 символа — отказ', async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `ред ${i + 1}`).join('\n')
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM support_messages').get() as { n: number }).n
    const user = await api(bob, 'POST', '/api/support/messages', { body: lines(61) })
    assert(user.status === 400 && String(user.json?.message).includes('до 60 реда'), `потребител: ${user.status} ${JSON.stringify(user.json)}`)
    const reply = await api(admin, 'POST', '/api/support/admin/reply', { profileId: alice.profileId, body: lines(61) })
    assert(reply.status === 400 && String(reply.json?.message).includes('до 60 реда'), `админ: ${reply.status} ${JSON.stringify(reply.json)}`)
    const long = await api(bob, 'POST', '/api/support/messages', { body: 'a'.repeat(2001) })
    assert(long.status === 400, `2001: ${long.status}`)
    assert((h.db.prepare('SELECT COUNT(*) AS n FROM support_messages').get() as { n: number }).n === before, 'без запис')
    const sixty = await api(bob, 'POST', '/api/support/messages', { body: lines(60) })
    assert(sixty.status === 200, `60 реда: ${sixty.status} ${JSON.stringify(sixty.json)}`)
  })

  await check('[T1] Теми (начало на vip_dm) — старото едноредово правило (не е пипано)', async () => {
    const source = (await readFile('server/src/db/chatStore.ts', 'utf8')).replace(/\r\n/g, '\n')
    const start = source.indexOf('function startVipDmConversationWithMessage(')
    const block = source.slice(start, source.indexOf('function authorizeSendMessage(', start))
    assert(start > 0 && block.includes('normalizeMessageBody(body)') && !block.includes('normalizeMultilineMessageBody'), 'startVipDm ползва старото правило')
    assert(/function normalizeMessageBody\(value: string\): string \| null \{\n {2}const normalized = value\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/.test(source), 'старото правило е непроменено')
  })
} finally {
  await h.close().catch(() => undefined)
}

finishAndExit()
