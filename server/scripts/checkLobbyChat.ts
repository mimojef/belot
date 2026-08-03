/**
 * checkLobbyChat.ts
 *
 * Интеграционен + source-check тест за общия лайв чат в лобито (херо карето
 * на началния екран) — виж задачата "Нов общ лайв чат в горното херо каре".
 *
 * Реален spawn-нат сървър (или два — за cross-instance теста), изолирана
 * SQLite база, реални HTTP + WS заявки, точно както клиентът би ги видял.
 *
 * === Server / WS (Section A) ===
 * [A1]  Анонимен (без сесия) може да се абонира и да получи история/live
 *       broadcast, но НЕ може да пише — сървърът отказва.
 * [A2]  Регистриран потребител може да пише; broadcast-ът достига до
 *       подателя със съответстващ requestId.
 * [A3]  Публичното име на автора се вижда коректно в history И в live
 *       broadcast; НЕ се разкриват имейл/роля/account ID.
 * [A4]  Опит за подмяна на автора (senderDisplayName/senderProfileId в
 *       суровия WS payload) се игнорира — сървърът винаги ползва сесията.
 * [A5]  Валидация: празен текст, само whitespace, нов ред, >300 Unicode
 *       code points (не UTF-16 units) → отделен lobby_chat_error с code.
 * [A6]  Rate limit: 6-о съобщение в прозореца → rate_limited; след прозореца
 *       отново позволено.
 * [A7]  Ограничение на бързо повторно изпращане на идентичен текст.
 * [A8]  Unsubscribe → съответният клиент вече не получава broadcast-и.
 * [A9]  Блокиране: A блокира B → A не вижда съобщенията на B (history И live);
 *       B продължава да вижда съобщенията на A (едностранно).
 * [A10] Модерация: пълен admin трие съобщение → веднага lobby_chat_message_deleted
 *       до всички абонати; съобщението изчезва от следваща история.
 * [A11] Admin, subadmin И chat_admin МОГАТ да трият (200); обикновен player
 *       НЕ може (403). (Обновено: subadmin/chat_admin получиха това право —
 *       виж isLobbyChatModeratorSession в authStore.ts.)
 * [A12] Повторно изтриване на вече изтрито съобщение е безопасно (200, без
 *       дублиран audit запис).
 * [A13] Стабилен ред (seq) при бързо изпратени съобщения; дедупликация по
 *       messageId между история и WS.
 * [A14] Retention: purgeOlderThanDays премахва стари съобщения, пази нови,
 *       НЕ пипа audit log-а за изтривания.
 * [A15] Unicode LINE/PARAGRAPH SEPARATOR (u2028/u2029) се отхвърлят като
 *       "нов ред" (не само литералните \n\r) — намерен и коригиран проблем
 *       при финалния преглед (.trim() не ги маха от средата на низа).
 * [A16] DB индекси: seq/event_seq (INTEGER PRIMARY KEY = rowid alias) НЕ
 *       трябва да имат допълнителен излишен индекс; created_at на
 *       lobby_chat_deletion_events ТРЯБВА да има индекс (ползва се от
 *       retention purge заявката) — намерен и коригиран проблем.
 * [A17] senderIsChatAdmin snapshot флаг: true в WS broadcast/history за
 *       съобщение от chat_admin подател, false за admin/subadmin/player
 *       (само за оцветяване на името в клиента, виж renderLobbyChatMessageRow).
 *
 * === Cross-instance broadcast (Section B) ===
 * [B1]  Съобщение, изпратено през instance #1, стига до абонат на instance #2
 *       (споделена SQLite база, отделни socketRegistry-та — симулира PM2).
 * [B2]  Няма двойно broadcast-ване на едно и също съобщение към собствения
 *       subscriber на instance-а, който го е вмъкнал.
 * [B3]  Admin delete на instance #1 се разпространява като
 *       lobby_chat_message_deleted до абонат на instance #2.
 *
 * === Source checks (Section C) — не изискват сървър ===
 * [C1]  subscribe/unsubscribe lifecycle wiring съществува в контролера и в
 *       main.ts на точните места (match_found, room_resumed, session_in_game,
 *       reconnect само ако е на lobby екрана).
 * [C2]  Draft/focus/caret/scroll preservation блокове съществуват за
 *       data-lobby-livechat-*.
 * [C3]  Smart autoscroll условие ("near bottom") съществува.
 * [C4]  Гост попъп с точния текст + бутоните Вход/Регистрация ползват
 *       съществуващия auth modal механизъм (без нова форма).
 * [C5]  Desktop: hero-cards.png се ползва, hero-banner.png вече НЕ се ползва
 *       в замененото място; object-fit:contain (без деформация/изрязване).
 * [C6]  Mobile: чатът е между профилната карта и "Избери маса", фиксирана
 *       (не collapsed) секция.
 * [C7]  Личният чат (ЧАТ таб) остава непроменен — chatStore/friend_chat_messages
 *       не са пипнати от новите файлове.
 * [C8]  Не се създава отделна WebSocket връзка за лайв чата (само нови
 *       ClientMessage/ServerMessage типове върху съществуващия socket).
 * [C9]  Reconnect reconciliation: клиентски съобщения в обхвата на свежата
 *       история, но липсващи от нея, се премахват (изтрито докато сме били
 *       offline не остава "залепено") — намерен и коригиран проблем.
 * [C10] setConnected(false) нулира lobbyChatSending/lobbyChatPendingRequestId
 *       — без това, прекъсване по средата на изпращане би заклещило бутона
 *       "изпрати" завинаги дори след успешен reconnect — намерен и коригиран
 *       проблем.
 * [C11] lobbyChatBlockCache е ограничен по размер с LRU-по-lastAccessedAt
 *       eviction — без това, кешът би растял неограничено за целия живот на
 *       процеса — намерен и коригиран проблем.
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { type RawData } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const projectRoot = resolve(serverRoot, '..')

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

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Section C: Source checks (не изискват сървър) ─────────────────────────

console.log('\n=== Lobby Chat — source checks ===\n')

const controllerSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
const renderSrc = readFileSync(resolve(projectRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')
const mainSrc = readFileSync(resolve(projectRoot, 'src/main.ts'), 'utf8')

await check('[C1] reconcileLobbyChatSubscription се вика в render() (subscribe/unsubscribe при вътрешна навигация)', () => {
  assert(controllerSrc.includes('reconcileLobbyChatSubscription()'), 'липсва извикване в render()')
  assert(controllerSrc.includes("state.currentScreen === 'lobby'"), 'липсва проверка за началния екран')
})

await check('[C1b] main.ts спира лайв чата изрично при match_found / room_resumed / session_in_game', () => {
  const matchFoundBlock = mainSrc.match(/onMatchFound:[\s\S]{0,200}/)?.[0] ?? ''
  assert(matchFoundBlock.includes('lobby.suspendLobbyChatForActiveRoom()'), 'onMatchFound не спира лайв чата')

  const roomResumedBlock = mainSrc.match(/message\.type === 'room_resumed'[\s\S]{0,200}/)?.[0] ?? ''
  assert(roomResumedBlock.includes('lobby.suspendLobbyChatForActiveRoom()'), 'room_resumed не спира лайв чата')

  const sessionInGameBlock = mainSrc.match(/message\.type === 'session_in_game'[\s\S]{0,200}/)?.[0] ?? ''
  assert(sessionInGameBlock.includes('lobby.suspendLobbyChatForActiveRoom()'), 'session_in_game не спира лайв чата')
})

await check('[C1c] Reconnect ресубскрайбва лайв чата само през forceLobbyChatResubscribeIfOnLobbyScreen (не безусловно)', () => {
  assert(mainSrc.includes('lobby.forceLobbyChatResubscribeIfOnLobbyScreen()'), 'липсва извикване при onOpen')
  const onOpenBlock = mainSrc.match(/onOpen: \(\) => \{[\s\S]*?\n  \},/)?.[0] ?? ''
  assert(onOpenBlock.includes('forceLobbyChatResubscribeIfOnLobbyScreen'), 'извикването не е в onOpen блока')
  assert(
    controllerSrc.includes('function forceLobbyChatResubscribeIfOnLobbyScreen'),
    'липсва имплементация в контролера',
  )
})

await check('[C2] Draft/focus/caret/scroll preservation за data-lobby-livechat-*', () => {
  assert(renderSrc.includes("prevLobbyChatScrollEl = root.querySelector"), 'липсва save на scroll позицията преди re-render')
  assert(renderSrc.includes('savedLobbyChatScrollTop'), 'липсва saved scrollTop променлива')
  assert(renderSrc.includes('wasLobbyChatInputFocused'), 'липсва save на focus състоянието')
  assert(renderSrc.includes('savedLobbyChatInputSelectionStart'), 'missing selectionStart/caret save')
  assert(renderSrc.includes('savedLobbyChatInputSelectionEnd'), 'missing selectionEnd save')
  assert(renderSrc.includes('savedLobbyChatInputSelectionDirection'), 'missing selection direction save')
  assert(renderSrc.includes('newLobbyChatInputEl.setSelectionRange'), 'липсва restore на caret позицията')
  assert(controllerSrc.includes('state.lobbyChatDraft = value'), 'draft-ът не се пази в state при typing')
})

await check('[C3] Smart autoscroll — скролва до дъно само ако е бил близо до дъното', () => {
  assert(
    renderSrc.includes('wasLobbyChatNearBottom'),
    'липсва "near bottom" проверка преди re-render',
  )
  assert(
    /scrollHeight\s*-\s*\w*\.?scrollTop\s*-\s*\w*\.?clientHeight\s*<\s*\d+/.test(renderSrc),
    'липсва точната near-bottom формула (scrollHeight - scrollTop - clientHeight)',
  )
  assert(
    renderSrc.includes('newLobbyChatScrollEl.scrollTop = wasLobbyChatNearBottom'),
    'restore-ът не е условен на wasLobbyChatNearBottom',
  )
})

await check('[C4] Гост попъп с точния текст + Вход/Регистрация през съществуващия auth modal', () => {
  assert(renderSrc.includes("'lobby-chat-guest'"), 'липсва lobby-chat-guest режим')
  assert(
    renderSrc.includes('Общ чат само за регистрирани потребители'),
    'липсва точния изискван текст на попъпа',
  )
  const guestGateBlock = renderSrc.match(/state\.authModalMode === 'lobby-chat-guest'[\s\S]{0,700}/)?.[0] ?? ''
  assert(guestGateBlock.includes('data-lobby-auth-register-button="1"'), 'липсва бутон Регистрация (съществуващ)')
  assert(guestGateBlock.includes('data-lobby-auth-login-button="1"'), 'липсва бутон Вход (съществуващ)')
  assert(!renderSrc.includes('data-lobby-livechat-auth-form'), 'не трябва да съществува нова форма за вход/регистрация')
})

await check('[C5] Desktop: hero-cards.png вместо hero-banner.png в новото херо каре, без деформация', () => {
  const heroFn = renderSrc.match(/function renderLobbyHeroCardsAndChat[\s\S]*?\n\}/)?.[0] ?? ''
  assert(heroFn.includes('/assets/lobby/hero-cards.png'), 'липсва hero-cards.png')
  assert(!heroFn.includes('hero-banner.png'), 'hero-banner.png не трябва да се ползва тук')
  assert(heroFn.includes('object-fit: contain') || heroFn.includes('object-fit:contain'), 'липсва object-fit:contain (без изрязване/деформация)')
  assert(heroFn.includes('height:258px') || heroFn.includes('height: 258px'), 'височината на карето трябва да е ~258px (близка до старата)')

  assert(
    renderSrc.includes('renderGuestHeroCard(state, state.signupBonusYellowCoins'),
    'renderGuestHeroCard трябва да получава state (за да покаже чата и на нерегистрирани посетители)',
  )
})

await check('[C6] Mobile: чатът е фиксирана секция между профилната карта и "Избери маса" (не collapsed)', () => {
  const mobileContentFn = renderSrc.match(/function renderMobileLobbyScreenContent[\s\S]*?\n\}/)?.[0] ?? ''
  const profileIdx = mobileContentFn.indexOf('renderMobileProfileCard')
  const chatIdx = mobileContentFn.indexOf('renderMobileLobbyChatSection')
  const stakeIdx = mobileContentFn.indexOf('renderMobileStakeSection')
  assert(profileIdx !== -1 && chatIdx !== -1 && stakeIdx !== -1, 'липсва някой от трите елемента в мобилния render')
  assert(profileIdx < chatIdx && chatIdx < stakeIdx, 'редът трябва да е: профил -> чат -> Избери маса')

  const chatSectionFn = renderSrc.match(/function renderMobileLobbyChatSection[\s\S]*?\n\}/)?.[0] ?? ''
  assert(/height:\s*15[0-9]px/.test(chatSectionFn), 'мобилната чат секция трябва да е с фиксирана височина ~150-160px')
  assert(!chatSectionFn.includes('collapsed'), 'мобилният чат не трябва да има collapsed вариант')
})

await check('[C7] Личният чат (ЧАТ таб) остава непроменен', () => {
  assert(renderSrc.includes('function renderChatPanel'), 'renderChatPanel трябва да продължи да съществува непроменено')
  assert(renderSrc.includes("Само между приятели"), 'описанието на личния чат трябва да остане')
  const chatStoreSrc = readFileSync(resolve(serverRoot, 'src/db/chatStore.ts'), 'utf8')
  assert(chatStoreSrc.includes('friend_chat_messages'), 'chatStore.ts (личен чат) не трябва да е пипнат/премахнат')
})

await check('[C8] Не се създава отделна WebSocket връзка — само нови типове върху съществуващия socket', () => {
  const clientSrc = readFileSync(resolve(projectRoot, 'src/app/network/createGameServerClient.ts'), 'utf8')
  const newWebSocketCalls = (clientSrc.match(/new WebSocket\(/g) ?? []).length
  assert(newWebSocketCalls === 1, `очаква се точно 1 WebSocket конструктор в целия клиент, намерени ${newWebSocketCalls}`)
  assert(clientSrc.includes("type: 'subscribe_lobby_chat'"), 'липсва subscribe_lobby_chat в ClientMessage')
  assert(clientSrc.includes("type: 'send_lobby_chat_message'"), 'липсва send_lobby_chat_message в ClientMessage')
  assert(clientSrc.includes("| LobbyChatMessageEventMessage"), 'липсва lobby chat типовете в ServerMessage union-а')
})

await check('[C9] Reconnect reconciliation премахва клиентски съобщения, изтрити докато сме били offline', () => {
  const historyBlock = controllerSrc.match(/message\.type === 'lobby_chat_history'[\s\S]{0,1400}/)?.[0] ?? ''
  assert(historyBlock.includes('minFreshSeq'), 'липсва изчисление на минималния seq в свежата история')
  assert(
    /keptExisting\s*=\s*minFreshSeq\s*===\s*null[\s\S]{0,40}\?\s*state\.lobbyChatMessages[\s\S]{0,80}m\.seq\s*<\s*minFreshSeq\s*\|\|\s*freshIds\.has/.test(historyBlock),
    'липсва reconciliation филтър (m.seq < minFreshSeq || freshIds.has) — изтрито докато сме offline съобщение би останало "залепено"',
  )
})

await check('[C10] setConnected(false) нулира lobbyChatSending/lobbyChatPendingRequestId', () => {
  const setConnectedBlock = controllerSrc.match(/setConnected:\s*\(value\)\s*=>\s*\{[\s\S]*?\n    \},/)?.[0] ?? ''
  assert(setConnectedBlock.includes('state.lobbyChatSending = false'), 'setConnected(false) не нулира lobbyChatSending')
  assert(setConnectedBlock.includes('state.lobbyChatPendingRequestId = null'), 'setConnected(false) не нулира lobbyChatPendingRequestId')
})

await check('[C11] lobbyChatBlockCache е ограничен по размер (LRU eviction), не расте неограничено', () => {
  const serverSrc = readFileSync(resolve(serverRoot, 'src/index.ts'), 'utf8')
  assert(serverSrc.includes('LOBBY_CHAT_BLOCK_CACHE_MAX_ENTRIES'), 'липсва горна граница на размера на block cache-а')
  assert(serverSrc.includes('cleanupLobbyChatBlockCacheIfNeeded'), 'липсва cleanup/eviction логика за block cache-а')
  assert(serverSrc.includes('lastAccessedAt'), 'липсва LRU-подобно "last accessed" проследяване за eviction')
})

// ─── DB seed / HTTP harness (established pattern, виж checkPlayersPagination.ts) ──

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'LobbyChatCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-lobby-chat-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function httpDeleteJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
}

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${email} failed: ${regRes.status}`)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const h = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)

  const meRes = await httpGetJson(port, '/api/auth/me', cookie)
  const profileId = (meRes.body as { session?: { profile?: { profileId?: string } } }).session?.profile?.profileId
  if (!profileId) throw new Error(`No profileId for ${email}`)

  return { cookie, profileId }
}

type AnyMsg = Record<string, unknown> & { type: string }

// Персистентен per-socket буфер, закачен ВЕДНАГА при отваряне на връзката —
// нарочно, за да няма race между "изчакай HTTP action" и "после закачи WS
// listener": ако broadcast-ът пристигне, докато await-ваме HTTP отговора,
// listener, закачен EDNO-ONLY-JUST-IN-TIME в waitForWsMessage, би го изпуснал
// безвъзвратно (EventEmitter не буферира за листенъри, добавени СЛЕД emit-а).
const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try {
        buffer.push(JSON.parse(raw.toString()))
      } catch { /* ignore malformed */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolveClose) => {
    ws.once('close', () => resolveClose())
    ws.close()
    setTimeout(resolveClose, 2000)
  })
}

function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}

// Чете от персистентния буфер (закачен в openWs) — не регистрира нов listener
// just-in-time, за да не пропусне съобщение, пристигнало между trigger-ращото
// действие (напр. HTTP delete) и извикването на waitForWsMessage.
async function waitForWsMessage(
  ws: WebSocket,
  predicate: (msg: AnyMsg) => boolean,
  timeoutMs = 5000,
): Promise<AnyMsg> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    if (Date.now() > deadline) {
      throw new Error('Timeout waiting for WS message matching predicate')
    }
    await sleep(25)
  }
}

// Не splice-ва буфера (за разлика от waitForWsMessage) — други, все още
// неизпълнени waitForWsMessage повиквания може да чакат по-стари съобщения.
async function collectWsMessages(ws: WebSocket, durationMs: number): Promise<AnyMsg[]> {
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const startLength = buffer.length
  await sleep(durationMs)
  return buffer.slice(startLength)
}

// ─── Section A: HTTP/WS single-instance тест ────────────────────────────────

console.log('\n=== Lobby Chat — Section A (single instance) ===\n')

const isoA = await makeIsolated(serverRoot)
const portA = await getFreePort()
let srvA: ReturnType<typeof startSrv> | null = null

try {
  srvA = startSrv(isoA.serverDir, portA)
  console.log(`  Чакам сървъра на порт ${portA}…`)
  await waitForServerReady(portA)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userA = await registerAndLogin(portA, `lc-user-a-${runId}@example.test`, 'Mimojef')
  const userB = await registerAndLogin(portA, `lc-user-b-${runId}@example.test`, 'Blondie')
  const adminUser = await registerAndLogin(portA, `lc-admin-${runId}@example.test`, 'AdminUser')
  const subadminUser = await registerAndLogin(portA, `lc-subadmin-${runId}@example.test`, 'SubadminUser')
  const chatAdminUser = await registerAndLogin(portA, `lc-chat-admin-${runId}@example.test`, 'ChatAdminUser')

  const dbForRoles = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
  dbForRoles.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(`lc-admin-${runId}@example.test`)
  dbForRoles.prepare(`UPDATE accounts SET role='subadmin' WHERE email=?`).run(`lc-subadmin-${runId}@example.test`)
  dbForRoles.prepare(`UPDATE accounts SET role='chat_admin' WHERE email=?`).run(`lc-chat-admin-${runId}@example.test`)
  dbForRoles.close()

  const wsA = await openWs(portA, userA.cookie)
  const wsB = await openWs(portA, userB.cookie)
  const wsAdmin = await openWs(portA, adminUser.cookie)
  const wsSubadmin = await openWs(portA, subadminUser.cookie)
  const wsChatAdmin = await openWs(portA, chatAdminUser.cookie)
  const wsAnon = await openWs(portA)

  await check('[A1] Анонимен: subscribe -> получава история; send -> отказан от сървъра', async () => {
    sendWs(wsAnon, { type: 'subscribe_lobby_chat' })
    const history = await waitForWsMessage(wsAnon, (m) => m.type === 'lobby_chat_history')
    assert(Array.isArray(history.messages), 'lobby_chat_history трябва да съдържа messages масив')

    sendWs(wsAnon, { type: 'send_lobby_chat_message', body: 'опит от анонимен', requestId: 'anon-1' })
    const err = await waitForWsMessage(wsAnon, (m) => m.type === 'lobby_chat_error' && m.requestId === 'anon-1')
    assert(err.code === 'not_authenticated', `очакван code=not_authenticated, получен ${err.code}`)
  })

  sendWs(wsA, { type: 'subscribe_lobby_chat' })
  await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_history')
  sendWs(wsB, { type: 'subscribe_lobby_chat' })
  await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_history')
  sendWs(wsAdmin, { type: 'subscribe_lobby_chat' })
  await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_history')

  let lastMessageId = ''
  let lastSeq = -1

  await check('[A2] Регистриран потребител пише -> broadcast с requestId стига до подателя', async () => {
    sendWs(wsA, { type: 'send_lobby_chat_message', body: 'Добро утро', requestId: 'req-a2' })
    const msg = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-a2')
    assert(typeof msg.messageId === 'string' && msg.messageId.length > 0, 'липсва messageId')
    assert(msg.body === 'Добро утро', 'тялото на съобщението трябва да съвпада')
    lastMessageId = msg.messageId as string
    lastSeq = msg.seq as number
  })

  await check('[A3] Публичното име се вижда коректно; без email/роля/account ID', async () => {
    sendWs(wsB, { type: 'send_lobby_chat_message', body: 'Здравейте всички', requestId: 'req-a3' })
    const msg = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-a3')
    assert(msg.senderDisplayName === 'Blondie', `очаквано display name Blondie, получено ${msg.senderDisplayName}`)
    assert(msg.senderProfileId === userB.profileId, 'senderProfileId трябва да съвпада с истинския профил')
    const raw = JSON.stringify(msg)
    assert(!raw.includes('@example.test'), 'съобщението не трябва да съдържа имейл')
    assert(!('role' in msg), 'съобщението не трябва да съдържа роля')
    assert(!('accountId' in msg) && !('account_id' in msg), 'съобщението не трябва да съдържа account ID')
  })

  await check('[A4] Опит за подмяна на автора през суров WS payload се игнорира', async () => {
    sendWs(wsA, {
      type: 'send_lobby_chat_message',
      body: 'опит за spoof',
      requestId: 'req-a4',
      senderProfileId: userB.profileId,
      senderDisplayName: 'НЕ-СЪМ-АЗ',
      role: 'admin',
    })
    const msg = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-a4')
    assert(msg.senderProfileId === userA.profileId, 'senderProfileId трябва да остане реалния подател (userA)')
    assert(msg.senderDisplayName === 'Mimojef', 'senderDisplayName трябва да остане реалното display name на подателя')
  })

  await check('[A5] Валидация: празно, whitespace, нов ред, >300 code points', async () => {
    sendWs(wsA, { type: 'send_lobby_chat_message', body: '', requestId: 'req-empty' })
    const emptyErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-empty')
    assert(emptyErr.code === 'empty_body', `очакван empty_body, получен ${emptyErr.code}`)

    sendWs(wsA, { type: 'send_lobby_chat_message', body: '     ', requestId: 'req-ws' })
    const wsErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-ws')
    assert(wsErr.code === 'empty_body', `whitespace-only трябва да е empty_body, получен ${wsErr.code}`)

    sendWs(wsA, { type: 'send_lobby_chat_message', body: 'първи ред\nвтори ред', requestId: 'req-newline' })
    const newlineErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-newline')
    assert(newlineErr.code === 'invalid_body', `нов ред трябва да е invalid_body, получен ${newlineErr.code}`)

    // 301 astral emoji (всеки е 1 Unicode code point, но 2 UTF-16 units) —
    // проверява, че лимитът брои CODE POINTS, не UTF-16 units/bytes.
    const over301 = '😀'.repeat(301)
    assert([...over301].length === 301, 'тестовият низ трябва да е точно 301 code points')
    sendWs(wsA, { type: 'send_lobby_chat_message', body: over301, requestId: 'req-toolong' })
    const tooLongErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-toolong')
    assert(tooLongErr.code === 'body_too_long', `>300 code points трябва да е body_too_long, получен ${tooLongErr.code}`)

    const exactly300 = '😀'.repeat(300)
    sendWs(wsA, { type: 'send_lobby_chat_message', body: exactly300, requestId: 'req-exact300' })
    const okMsg = await waitForWsMessage(
      wsA,
      (m) => (m.type === 'lobby_chat_message' && m.requestId === 'req-exact300') || (m.type === 'lobby_chat_error' && m.requestId === 'req-exact300'),
    )
    assert(okMsg.type === 'lobby_chat_message', `точно 300 code points трябва да е позволено, получено ${okMsg.type}/${(okMsg as { code?: string }).code}`)
  })

  await check('[A15] Unicode LINE/PARAGRAPH SEPARATOR (u2028/u2029) се отхвърлят като "нов ред"', async () => {
    sendWs(wsA, { type: 'send_lobby_chat_message', body: 'първи ред\u2028втори ред', requestId: 'req-line-sep' })
    const lineSepErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-line-sep')
    assert(lineSepErr.code === 'invalid_body', `U+2028 трябва да е invalid_body, получен ${lineSepErr.code}`)

    sendWs(wsA, { type: 'send_lobby_chat_message', body: 'параграф1\u2029параграф2', requestId: 'req-para-sep' })
    const paraSepErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-para-sep')
    assert(paraSepErr.code === 'invalid_body', `U+2029 трябва да е invalid_body, получен ${paraSepErr.code}`)
  })

  await check('[A6] Rate limit: 6-о съобщение в прозореца се отхвърля', async () => {
    let rateLimited = false
    for (let i = 0; i < 6; i++) {
      sendWs(wsA, { type: 'send_lobby_chat_message', body: `rl-съобщение-${i}-${Date.now()}`, requestId: `req-rl-${i}` })
      const result = await waitForWsMessage(
        wsA,
        (m) => (m.requestId === `req-rl-${i}`) && (m.type === 'lobby_chat_message' || m.type === 'lobby_chat_error'),
      )
      if (result.type === 'lobby_chat_error' && result.code === 'rate_limited') {
        rateLimited = true
        break
      }
    }
    assert(rateLimited, 'очаква се rate_limited грешка в рамките на 6 бързи съобщения')
  })

  await sleep(10_500) // изчакваме rate-limit прозореца (10s) да изтече напълно

  await check('[A7] Ограничение на бързо повторно изпращане на идентичен текст', async () => {
    const uniqueBody = `дубликат-тест-${Date.now()}`
    sendWs(wsA, { type: 'send_lobby_chat_message', body: uniqueBody, requestId: 'req-dup-1' })
    await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-dup-1')

    sendWs(wsA, { type: 'send_lobby_chat_message', body: uniqueBody, requestId: 'req-dup-2' })
    const dupErr = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_error' && m.requestId === 'req-dup-2')
    assert(dupErr.code === 'duplicate_message', `очакван duplicate_message, получен ${dupErr.code}`)
  })

  await sleep(8_500) // изчакваме duplicate-guard прозореца (8s) да изтече

  await check('[A8] Unsubscribe -> клиентът вече не получава broadcast-и', async () => {
    sendWs(wsB, { type: 'unsubscribe_lobby_chat' })
    await sleep(150)

    const collected = collectWsMessages(wsB, 1200)
    sendWs(wsA, { type: 'send_lobby_chat_message', body: `след-unsubscribe-${Date.now()}`, requestId: 'req-post-unsub' })
    await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-post-unsub')

    const messages = await collected
    const gotChatMessage = messages.some((m) => m.type === 'lobby_chat_message')
    assert(!gotChatMessage, 'B не трябва да получи lobby_chat_message след unsubscribe')

    // Ресубскрайб за следващите тестове.
    sendWs(wsB, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_history')
  })

  await check('[A9] Блокиране: A блокира B -> A не вижда съобщенията на B (history + live); B вижда A', async () => {
    const blockRes = await fetch(`http://127.0.0.1:${portA}/api/profiles/${userB.profileId}/block`, {
      method: 'POST',
      headers: { Cookie: userA.cookie },
    })
    assert(blockRes.status === 200, `block заявката трябва да е 200, получена ${blockRes.status}`)

    const bMarker = `blocked-marker-${Date.now()}`
    sendWs(wsB, { type: 'send_lobby_chat_message', body: bMarker, requestId: 'req-blocked-live' })
    await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-blocked-live')

    const collectedForA = await collectWsMessages(wsA, 1200)
    const aSawBlockedLive = collectedForA.some((m) => m.type === 'lobby_chat_message' && m.body === bMarker)
    assert(!aSawBlockedLive, 'A не трябва да вижда live съобщение от блокирания B')

    // Нов subscribe (нова история) не трябва да съдържа съобщения от B.
    sendWs(wsA, { type: 'subscribe_lobby_chat' })
    const historyForA = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_history')
    const historyMessages = historyForA.messages as Array<{ senderProfileId: string }>
    assert(
      !historyMessages.some((m) => m.senderProfileId === userB.profileId),
      'историята на A не трябва да съдържа съобщения от блокирания B',
    )

    // A изпраща -> B (небклокиран от своя страна) продължава да вижда A.
    const aMarker = `unblocked-direction-${Date.now()}`
    sendWs(wsB, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_history')
    sendWs(wsA, { type: 'send_lobby_chat_message', body: aMarker, requestId: 'req-a-to-b' })
    const seenByB = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.body === aMarker)
    assert(seenByB.senderProfileId === userA.profileId, 'B трябва да продължи да вижда съобщенията на A (едностранно блокиране)')

    // Разблокирай за чистота на следващите тестове.
    await fetch(`http://127.0.0.1:${portA}/api/profiles/${userB.profileId}/block`, {
      method: 'POST',
      headers: { Cookie: userA.cookie },
    })
  })

  await check('[A10] Admin трие съобщение -> моментален lobby_chat_message_deleted до абонатите; изчезва от история', async () => {
    const del = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(lastMessageId)}`, adminUser.cookie)
    assert(del.status === 200, `delete трябва да е 200, получен ${del.status}`)

    const deletedEventForA = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message_deleted' && m.messageId === lastMessageId)
    assert(deletedEventForA.messageId === lastMessageId, 'deleted event трябва да реферира правилния messageId')

    sendWs(wsA, { type: 'subscribe_lobby_chat' })
    const historyAfterDelete = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_history')
    const stillThere = (historyAfterDelete.messages as Array<{ messageId: string }>).some((m) => m.messageId === lastMessageId)
    assert(!stillThere, 'изтритото съобщение не трябва да се появява в последваща история')
  })

  await check('[A11] Subadmin и chat_admin МОГАТ да трият (200); player и неавтентикиран — НЕ (403)', async () => {
    // Отделно съобщение за всеки опит — веднъж изтрито, не може да послужи повторно.
    sendWs(wsB, { type: 'send_lobby_chat_message', body: `за-player-опит-${Date.now()}`, requestId: 'req-player-attempt' })
    const forPlayer = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-player-attempt')

    sendWs(wsB, { type: 'send_lobby_chat_message', body: `за-анонимен-опит-${Date.now()}`, requestId: 'req-anon-attempt' })
    const forAnon = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-anon-attempt')

    sendWs(wsB, { type: 'send_lobby_chat_message', body: `за-subadmin-изтриване-${Date.now()}`, requestId: 'req-subadmin-delete' })
    const forSubadmin = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-subadmin-delete')

    sendWs(wsB, { type: 'send_lobby_chat_message', body: `за-chat-admin-изтриване-${Date.now()}`, requestId: 'req-chat-admin-delete' })
    const forChatAdmin = await waitForWsMessage(wsB, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-chat-admin-delete')

    const playerAttempt = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(forPlayer.messageId as string)}`, userB.cookie)
    assert(playerAttempt.status === 403, `player delete трябва да е 403, получен ${playerAttempt.status}`)

    const anonAttempt = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(forAnon.messageId as string)}`)
    assert(anonAttempt.status === 403, `неавтентикиран delete трябва да е 403, получен ${anonAttempt.status}`)

    const subadminAttempt = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(forSubadmin.messageId as string)}`, subadminUser.cookie)
    assert(subadminAttempt.status === 200, `subadmin delete трябва да е 200, получен ${subadminAttempt.status}`)

    const chatAdminAttempt = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(forChatAdmin.messageId as string)}`, chatAdminUser.cookie)
    assert(chatAdminAttempt.status === 200, `chat_admin delete трябва да е 200, получен ${chatAdminAttempt.status}`)

    // Директна проверка, че сървърът наистина е изтрил (не само върнал 200) —
    // подправена/невалидна заявка не бива да променя съобщението.
    const db = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const playerMsgRow = db.prepare(`SELECT deleted_at FROM lobby_chat_messages WHERE message_id = ?`).get(forPlayer.messageId) as { deleted_at: string | null }
      assert(playerMsgRow.deleted_at === null, 'player-blocked съобщението НЕ трябва да е маркирано изтрито')

      const subadminMsgRow = db.prepare(`SELECT deleted_at FROM lobby_chat_messages WHERE message_id = ?`).get(forSubadmin.messageId) as { deleted_at: string | null }
      assert(subadminMsgRow.deleted_at !== null, 'subadmin трябва наистина да е изтрил съобщението')

      const chatAdminMsgRow = db.prepare(`SELECT deleted_at FROM lobby_chat_messages WHERE message_id = ?`).get(forChatAdmin.messageId) as { deleted_at: string | null }
      assert(chatAdminMsgRow.deleted_at !== null, 'chat_admin трябва наистина да е изтрил съобщението')

      const auditRoleRows = db.prepare(`
        SELECT message_id, actor_role_at_deletion FROM lobby_chat_deletion_audit_log
        WHERE message_id IN (?, ?)
      `).all(forSubadmin.messageId, forChatAdmin.messageId) as { message_id: string; actor_role_at_deletion: string }[]
      const bySubadmin = auditRoleRows.find((r) => r.message_id === forSubadmin.messageId)
      const byChatAdmin = auditRoleRows.find((r) => r.message_id === forChatAdmin.messageId)
      assert(bySubadmin?.actor_role_at_deletion === 'subadmin', `audit actor_role_at_deletion за subadmin трябва да е 'subadmin', получено ${bySubadmin?.actor_role_at_deletion}`)
      assert(byChatAdmin?.actor_role_at_deletion === 'chat_admin', `audit actor_role_at_deletion за chat_admin трябва да е 'chat_admin', получено ${byChatAdmin?.actor_role_at_deletion}`)
    } finally {
      db.close()
    }
  })

  await check('[A12] Повторно изтриване на вече изтрито съобщение е безопасно (идемпотентно)', async () => {
    const first = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(lastMessageId)}`, adminUser.cookie)
    assert(first.status === 200, `повторно изтриване трябва пак да е 200, получено ${first.status}`)
    const second = await httpDeleteJson(portA, `/api/lobby-chat/messages/${encodeURIComponent(lastMessageId)}`, adminUser.cookie)
    assert(second.status === 200, `трето изтриване трябва пак да е 200 (идемпотентно), получено ${second.status}`)

    const db = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const auditRows = db.prepare(`SELECT COUNT(*) as cnt FROM lobby_chat_deletion_audit_log WHERE message_id = ?`)
        .get(lastMessageId) as { cnt: number }
      assert(auditRows.cnt === 1, `трябва да има точно 1 audit запис за съобщението, намерени ${auditRows.cnt}`)
    } finally {
      db.close()
    }
  })

  await check('[A17] senderIsChatAdmin: true за съобщение от chat_admin, false за admin/subadmin/player', async () => {
    // subadmin/chat_admin socket-ите досега само са изтривали през HTTP
    // (виж [A11]) — никога не са се абонирали за live broadcast, затова тук
    // подателят не би получил СОБСТВЕНОТО си потвърждение без предварителен subscribe.
    sendWs(wsSubadmin, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsSubadmin, (m) => m.type === 'lobby_chat_history')
    sendWs(wsChatAdmin, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsChatAdmin, (m) => m.type === 'lobby_chat_history')

    // Свеж, никога преди неизползван player акаунт — wsB вече е изпратил
    // много съобщения в по-ранни тестове (A9/A11 и др.) и може да е близо до
    // rate limit-а (5 съобщения / 10с прозорец); свеж профил гарантира, че
    // тази проверка не зависи от точния timing на предходните тестове.
    const freshPlayer = await registerAndLogin(portA, `lc-color-player-${runId}@example.test`, 'ColorPlayer')
    const wsFreshPlayer = await openWs(portA, freshPlayer.cookie)
    sendWs(wsFreshPlayer, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsFreshPlayer, (m) => m.type === 'lobby_chat_history')

    sendWs(wsChatAdmin, { type: 'send_lobby_chat_message', body: `от-chat-admin-${Date.now()}`, requestId: 'req-color-chat-admin' })
    const fromChatAdmin = await waitForWsMessage(wsChatAdmin, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-color-chat-admin')
    assert(fromChatAdmin.senderIsChatAdmin === true, `senderIsChatAdmin трябва да е true за chat_admin подател, получено ${fromChatAdmin.senderIsChatAdmin}`)

    sendWs(wsAdmin, { type: 'send_lobby_chat_message', body: `от-admin-${Date.now()}`, requestId: 'req-color-admin' })
    const fromAdmin = await waitForWsMessage(wsAdmin, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-color-admin')
    assert(fromAdmin.senderIsChatAdmin === false, `senderIsChatAdmin трябва да е false за пълен admin подател, получено ${fromAdmin.senderIsChatAdmin}`)

    sendWs(wsSubadmin, { type: 'send_lobby_chat_message', body: `от-subadmin-${Date.now()}`, requestId: 'req-color-subadmin' })
    const fromSubadmin = await waitForWsMessage(wsSubadmin, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-color-subadmin')
    assert(fromSubadmin.senderIsChatAdmin === false, `senderIsChatAdmin трябва да е false за subadmin подател, получено ${fromSubadmin.senderIsChatAdmin}`)

    sendWs(wsFreshPlayer, { type: 'send_lobby_chat_message', body: `от-player-${Date.now()}`, requestId: 'req-color-player' })
    const fromPlayer = await waitForWsMessage(wsFreshPlayer, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-color-player')
    assert(fromPlayer.senderIsChatAdmin === false, `senderIsChatAdmin трябва да е false за обикновен player, получено ${fromPlayer.senderIsChatAdmin}`)
    await closeWs(wsFreshPlayer)

    // Проверка и в историята (subscribe наново), не само в live broadcast-а.
    sendWs(wsChatAdmin, { type: 'subscribe_lobby_chat' })
    const historyForChatAdmin = await waitForWsMessage(wsChatAdmin, (m) => m.type === 'lobby_chat_history')
    const historyEntry = (historyForChatAdmin.messages as Array<{ messageId: string; senderIsChatAdmin: boolean }>)
      .find((m) => m.messageId === fromChatAdmin.messageId)
    assert(historyEntry?.senderIsChatAdmin === true, 'senderIsChatAdmin трябва да остане true и в lobby_chat_history')
  })

  await check('[A13] Стабилен ред (seq) при бързи съобщения; дедупликация по messageId', async () => {
    sendWs(wsA, { type: 'subscribe_lobby_chat' })
    await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_history')

    const seqs: number[] = []
    for (let i = 0; i < 4; i++) {
      sendWs(wsA, { type: 'send_lobby_chat_message', body: `order-${i}-${Date.now()}`, requestId: `req-order-${i}` })
      const msg = await waitForWsMessage(wsA, (m) => m.type === 'lobby_chat_message' && m.requestId === `req-order-${i}`)
      seqs.push(msg.seq as number)
    }
    for (let i = 1; i < seqs.length; i++) {
      assert(seqs[i]! > seqs[i - 1]!, `seq трябва да е строго нарастващ: ${seqs.join(',')}`)
    }
    assert(seqs[seqs.length - 1]! > lastSeq, 'seq трябва да продължава да расте спрямо по-ранни съобщения')

    const uniqueMessageIds = new Set(seqs)
    assert(uniqueMessageIds.size === seqs.length, 'всеки seq трябва да е уникален (без дублиране)')
  })

  await check('[A14] Retention: purgeOlderThanDays трие стари съобщения, пази нови, не пипа audit log-а', async () => {
    const { createLobbyChatStore } = await import(
      pathToFileURL(resolve(isoA.serverDir, 'dist', 'db', 'lobbyChatStore.js')).href
    ) as typeof import('../src/db/lobbyChatStore.js')

    const store = await createLobbyChatStore(isoA.dbFile)
    try {
      const oldMessage = store.insertMessage({
        senderProfileId: userA.profileId,
        senderDisplayName: 'Mimojef',
        body: 'старо съобщение за retention теста',
      })
      const freshMessage = store.insertMessage({
        senderProfileId: userA.profileId,
        senderDisplayName: 'Mimojef',
        body: 'прясно съобщение за retention теста',
      })

      const db = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
      const oldCutoff = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '')
      db.prepare(`UPDATE lobby_chat_messages SET created_at = ? WHERE seq = ?`).run(oldCutoff, oldMessage.seq)
      db.close()

      const auditCountBefore = (() => {
        const d = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
        try {
          return (d.prepare(`SELECT COUNT(*) as cnt FROM lobby_chat_deletion_audit_log`).get() as { cnt: number }).cnt
        } finally { d.close() }
      })()

      const result = store.purgeOlderThanDays(30, 500)
      assert(result.deletedMessages >= 1, `очаква се поне 1 изтрито съобщение, получени ${result.deletedMessages}`)

      const d2 = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
      try {
        const oldStillThere = d2.prepare(`SELECT 1 as found FROM lobby_chat_messages WHERE seq = ?`).get(oldMessage.seq)
        assert(oldStillThere === undefined, 'старото съобщение трябва да е изтрито от retention-а')

        const freshStillThere = d2.prepare(`SELECT 1 as found FROM lobby_chat_messages WHERE seq = ?`).get(freshMessage.seq)
        assert(freshStillThere !== undefined, 'прясното съобщение НЕ трябва да е засегнато от retention-а')

        const auditCountAfter = (d2.prepare(`SELECT COUNT(*) as cnt FROM lobby_chat_deletion_audit_log`).get() as { cnt: number }).cnt
        assert(auditCountAfter === auditCountBefore, 'retention не трябва да пипа audit log-а за модераторски изтривания')
      } finally {
        d2.close()
      }
    } finally {
      store.close()
    }
  })

  await check('[A16] DB индекси: правилни за реалните заявки (без излишни, без липсващи)', () => {
    const db = new DatabaseSync(isoA.dbFile, { open: true, enableForeignKeyConstraints: true })
    try {
      const indexNames = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'lobby_chat%'`).all() as Array<{ name: string }>)
          .map((r) => r.name),
      )

      assert(
        !indexNames.has('idx_lobby_chat_messages_seq'),
        'seq е INTEGER PRIMARY KEY (rowid alias) — отделен индекс върху него е излишен overhead',
      )
      assert(
        !indexNames.has('idx_lobby_chat_deletion_events_seq'),
        'event_seq е INTEGER PRIMARY KEY (rowid alias) — отделен индекс върху него е излишен overhead',
      )
      assert(
        indexNames.has('idx_lobby_chat_messages_created_at'),
        'липсва индекс за created_at на lobby_chat_messages (ползва се от retention purge заявката)',
      )
      assert(
        indexNames.has('idx_lobby_chat_deletion_events_created_at'),
        'липсва индекс за created_at на lobby_chat_deletion_events (ползва се от retention purge заявката)',
      )
      assert(
        indexNames.has('idx_lobby_chat_messages_deleted_at'),
        'липсва индекс за deleted_at на lobby_chat_messages (ползва се от history заявката)',
      )
    } finally {
      db.close()
    }
  })

  wsA.terminate()
  wsB.terminate()
  wsAdmin.terminate()
  wsSubadmin.terminate()
  wsAnon.terminate()
} catch (err) {
  fail('Section A setup/HTTP error', err)
  if (srvA) console.error('\n[server A output]\n' + srvA.output().slice(-3000))
} finally {
  if (srvA) await stopSrv(srvA)
  await isoA.cleanup()
}

// ─── Section B: Cross-instance broadcast (два процеса, обща SQLite база) ───

console.log('\n=== Lobby Chat — Section B (cross-instance broadcast) ===\n')

const isoB = await makeIsolated(serverRoot)
const portB1 = await getFreePort()
const portB2 = await getFreePort()
let srvB1: ReturnType<typeof startSrv> | null = null
let srvB2: ReturnType<typeof startSrv> | null = null

try {
  // Инстанция #1 стартира първа и завършва миграциите; #2 стартира само след
  // това, за да избегнем race при едновременно прилагане на миграции върху
  // празна база (виж коментара в анализа/плана).
  srvB1 = startSrv(isoB.serverDir, portB1)
  console.log(`  Чакам instance #1 на порт ${portB1}…`)
  await waitForServerReady(portB1)

  srvB2 = startSrv(isoB.serverDir, portB2)
  console.log(`  Чакам instance #2 на порт ${portB2}…`)
  await waitForServerReady(portB2)
  console.log('  И двете инстанции са готови (споделят една SQLite база — симулира PM2 клъстер).\n')

  const runId = `${Date.now()}-${process.pid}`
  const senderOnB1 = await registerAndLogin(portB1, `lc-cross-sender-${runId}@example.test`, 'CrossSender')
  const subscriberOnB2 = await registerAndLogin(portB2, `lc-cross-subscriber-${runId}@example.test`, 'CrossSubscriber')

  const dbForAdmin = new DatabaseSync(isoB.dbFile, { open: true, enableForeignKeyConstraints: true })
  dbForAdmin.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(`lc-cross-sender-${runId}@example.test`)
  dbForAdmin.close()

  const wsSenderOnB1 = await openWs(portB1, senderOnB1.cookie)
  const wsSubscriberOnB2 = await openWs(portB2, subscriberOnB2.cookie)

  sendWs(wsSenderOnB1, { type: 'subscribe_lobby_chat' })
  await waitForWsMessage(wsSenderOnB1, (m) => m.type === 'lobby_chat_history')
  sendWs(wsSubscriberOnB2, { type: 'subscribe_lobby_chat' })
  await waitForWsMessage(wsSubscriberOnB2, (m) => m.type === 'lobby_chat_history')

  let crossMessageId = ''

  await check('[B1] Съобщение от instance #1 стига до абонат на instance #2 (cross-instance poll)', async () => {
    const marker = `cross-instance-${Date.now()}`
    sendWs(wsSenderOnB1, { type: 'send_lobby_chat_message', body: marker, requestId: 'req-cross-1' })
    const ownEcho = await waitForWsMessage(wsSenderOnB1, (m) => m.type === 'lobby_chat_message' && m.requestId === 'req-cross-1')
    crossMessageId = ownEcho.messageId as string

    // Cross-instance poll-ът тик-ва на ~700ms — изчакваме до 5с за instance #2.
    const seenOnB2 = await waitForWsMessage(
      wsSubscriberOnB2,
      (m) => m.type === 'lobby_chat_message' && m.messageId === crossMessageId,
      5000,
    )
    assert(seenOnB2.body === marker, 'съобщението, получено на instance #2, трябва да съвпада')
    assert(seenOnB2.senderDisplayName === 'CrossSender', 'display name трябва да е коректен и през cross-instance пътя')
  })

  await check('[B2] Няма двойно broadcast-ване към собствения subscriber на изпращащия instance', async () => {
    const marker = `no-double-broadcast-${Date.now()}`
    const collected = collectWsMessages(wsSenderOnB1, 2500)
    sendWs(wsSenderOnB1, { type: 'send_lobby_chat_message', body: marker, requestId: 'req-nodup' })
    const messages = await collected
    const matches = messages.filter((m) => m.type === 'lobby_chat_message' && m.body === marker)
    assert(matches.length === 1, `подателят на instance #1 трябва да види съобщението си точно веднъж, видени ${matches.length} пъти`)
  })

  await check('[B3] Admin delete на instance #1 се разпространява до абонат на instance #2', async () => {
    const del = await httpDeleteJson(portB1, `/api/lobby-chat/messages/${encodeURIComponent(crossMessageId)}`, senderOnB1.cookie)
    assert(del.status === 200, `delete на instance #1 трябва да е 200, получен ${del.status}`)

    const deletedOnB2 = await waitForWsMessage(
      wsSubscriberOnB2,
      (m) => m.type === 'lobby_chat_message_deleted' && m.messageId === crossMessageId,
      5000,
    )
    assert(deletedOnB2.messageId === crossMessageId, 'instance #2 трябва да получи deletion event-а за съобщението от instance #1')
  })

  wsSenderOnB1.terminate()
  wsSubscriberOnB2.terminate()
} catch (err) {
  fail('Section B cross-instance error', err)
  if (srvB1) console.error('\n[server B1 output]\n' + srvB1.output().slice(-2000))
  if (srvB2) console.error('\n[server B2 output]\n' + srvB2.output().slice(-2000))
} finally {
  if (srvB1) await stopSrv(srvB1)
  if (srvB2) await stopSrv(srvB2)
  await isoB.cleanup()
}

// ─── Резюме ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
