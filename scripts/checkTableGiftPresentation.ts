/**
 * checkTableGiftPresentation.ts
 *
 * Stage 2 (table/in-game gifts) — presentation & wiring проверки.
 *
 * Проектът няма jsdom, затова тук се комбинират два подхода (същият стил
 * като checkGiftNotificationModalFix.ts / checkGiftItemNotificationQueue.ts):
 *   1. Source-text проверки на реалния код (wiring, invariants, липса на
 *      забранени извиквания);
 *   2. Pure-function поведенчески тестове за логиката, която може да се
 *      репликира без DOM (dedup по transactionId, replacement на overlay,
 *      remaining-time изчисление, presentation routing).
 *
 * Покрити точки:
 *   [1]  RoomSeatSnapshot носи profileId и на клиента, и на сървъра
 *   [2]  Table gift се праща като WS action (send_table_gift), wired в
 *        network client-а и в active-room контролера
 *   [3]  Сървърът НЕ вика createDeliveryNotification за table gift —
 *        (§6/§12) няма дублирана лична презентация за същия transaction
 *   [4]  Broadcast се прави САМО при !isReplay (без втори broadcast за
 *        idempotent replay)
 *   [5]  Dedup строго по transactionId (никога по sender/recipient/gift)
 *   [6]  Reconnect: snapshot попълва overlay-и, но НЕ пуска летящата
 *        анимация (тя тръгва само от live push branch-а)
 *   [7]  Overlay-ът НЕ пипа avatar src — рисува се в отделен слот
 *   [8]  Gift иконата се показва само за чужди, човешки, заети места
 *   [9]  syncTableGiftOverlays е вързан в syncActiveRoomOverlayEffects
 *        (=> playing фазата минава оттам автоматично)
 *   [10] Gift state НЕ участва в никой stable render key (PATCH пътят
 *        остава непокътнат)
 *   [11] Таймерът за скриване ползва remaining time (expiresAt - now), не
 *        фиксирани 60 000 ms
 *   [12] Presentation routing: table gift → avatar overlay; profile gift →
 *        модал (извън игра) или компактен banner (в игра)
 *   [13] Профилният gift route праща live push и когато получателят е в
 *        стая (премахнат currentRoomId == null guard)
 *   [14] Летящата анимация ползва transform/opacity (без layout thrashing)
 *        и преизползван fixed слой
 *   [15] Root cause regression: send_table_gift е регистриран в
 *        parseClientMessage.ts (иначе modal остава заключен в disabled)
 *   [16] Defense-in-depth: generic {type:'error'} освобождава table gift
 *        in-flight state
 *   [17] Success flow: modal се затваря СЛЕД server confirmation
 *   [18] Duplicate-click guard: повторен submit докато requestId е
 *        in-flight е no-op
 *
 * Intermittent avatar overlay flicker fix (виж syncSeatPanels()):
 *   [19] ROOT CAUSE — syncSeatPanels() snapshot-ва и restore-ва gift-overlay
 *        nodes при fallback full rebuild (structural seat-panel промяна по
 *        време на нормален gameplay, напр. trick completion), вместо да
 *        остави overlay-а временно празен между rebuild-а и следващия
 *        syncTableGiftOverlays() call
 *   [20] Timer/innerHTML НЕ се пресъздават при повторен sync на СЪЩИЯ
 *        transaction (unrelated gameplay updates не local churn-ват overlay-а)
 *   [21] Нов transaction към същия recipient replace-ва стария overlay
 *        точно веднъж
 *   [22] Expiry премахва overlay-а точно веднъж, без повторни remove опити
 *
 * Presentation timing fix — overlay се разкрива само при landing, не при
 * получаване на live event (виж pendingLandingTransactionIdBySeat):
 *   [23] Seat-ът се маркира pending-landing ПРЕДИ playTableGiftFlightAnimation
 *   [24] syncTableGiftOverlays skip-ва напълно pending-landing seats (DOM
 *        недокоснат)
 *   [25] Recipient без стар gift: avatar остава видим по време на flight
 *   [26] Replacement: старият overlay остава видим, докато новият лети;
 *        смяната става само при landing
 *   [27] Landing НЕ рестартира server expiresAt (canonical timestamp)
 *   [28] Reconnect snapshot: директен show, без pending-landing/flight
 *   [29] Missing DOM anchor fallback: overlay се release-ва веднага, не
 *        остава hidden завинаги
 *   [30] Stale landing callback: по-стар transaction не може да overwrite-не
 *        по-нов (transactionId-gated release)
 *   [31] Duplicate event: без втори flight, без duplicate landing state промяна
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const ACTIVE_ROOM_CONTROLLER = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts')
const SEAT_PANELS = join(REPO_ROOT, 'src', 'app', 'activeRoom', 'cutting', 'renderCuttingSeatPanels.ts')
const NETWORK_CLIENT = join(REPO_ROOT, 'src', 'app', 'network', 'createGameServerClient.ts')
const LOBBY_CONTROLLER = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const SERVER_INDEX = join(REPO_ROOT, 'server', 'src', 'index.ts')
const SERVER_MESSAGE_TYPES = join(REPO_ROOT, 'server', 'src', 'protocol', 'messageTypes.ts')
const SERVER_SNAPSHOT = join(REPO_ROOT, 'server', 'src', 'protocol', 'createRoomSnapshotMessage.ts')
const SERVER_PARSE_CLIENT_MESSAGE = join(REPO_ROOT, 'server', 'src', 'protocol', 'parseClientMessage.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

/** Извлича тялото на функция по signature prefix, чрез броене на скоби. */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start === -1) throw new Error(`не е намерена сигнатура: ${signature}`)
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) throw new Error(`не е намерено тяло за: ${signature}`)
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(braceStart, i + 1)
    }
  }
  throw new Error(`небалансирани скоби за: ${signature}`)
}

console.log('\n=== checkTableGiftPresentation ===\n')

const activeRoomSrc = await readFile(ACTIVE_ROOM_CONTROLLER, 'utf8')
const seatPanelsSrc = await readFile(SEAT_PANELS, 'utf8')
const networkSrc = await readFile(NETWORK_CLIENT, 'utf8')
const lobbySrc = await readFile(LOBBY_CONTROLLER, 'utf8')
const serverIndexSrc = await readFile(SERVER_INDEX, 'utf8')
const serverTypesSrc = await readFile(SERVER_MESSAGE_TYPES, 'utf8')
const serverSnapshotSrc = await readFile(SERVER_SNAPSHOT, 'utf8')
const serverParseClientMessageSrc = await readFile(SERVER_PARSE_CLIENT_MESSAGE, 'utf8')

// ─── [1] profileId в seat snapshot ─────────────────────────────────────────

await check('[1] RoomSeatSnapshot носи profileId (клиент + сървър), popuplate-нат и за bot participants (Stage 2.1)', () => {
  assert(
    /export type RoomSeatSnapshot = \{[\s\S]*?profileId: string \| null/.test(serverTypesSrc),
    'сървърният RoomSeatSnapshot трябва да има profileId',
  )
  assert(
    /export type RoomSeatSnapshot = \{[\s\S]*?profileId: string \| null/.test(networkSrc),
    'клиентският RoomSeatSnapshot трябва да има profileId',
  )
  // Stage 2.1: profileId вече се излага UNIVERSALLY (participant.identity.profileId
  // директно), не само за human participants — regular matchmaking bots имат
  // стабилен DB-backed profileId, и клиентът трябва да го получи, за да може
  // да ги избере като gift target. Rare fallback bot без DB profile просто
  // получава profileId=null от самата identity (не explicit kind-based nulling).
  assert(
    serverSnapshotSrc.includes('profileId: participant.identity.profileId ?? null'),
    'profileId трябва да идва directно от participant.identity (human ИЛИ bot), не kind-gated',
  )
  assert(
    !serverSnapshotSrc.includes("participant.kind === 'human' ? participant.identity.profileId"),
    'РЕГРЕСИЯ: profileId не трябва повече да е ограничен само до human participants',
  )
})

// ─── [2] WS action wiring ──────────────────────────────────────────────────

await check('[2] send_table_gift е WS action, wired end-to-end', () => {
  assert(serverTypesSrc.includes("type: 'send_table_gift'"), 'сървърът трябва да приема send_table_gift')
  assert(networkSrc.includes('function sendTableGift('), 'network клиентът трябва да излага sendTableGift')
  assert(serverIndexSrc.includes("if (message.type === 'send_table_gift')"), 'index.ts трябва да има handler')
  assert(
    activeRoomSrc.includes('options.sendTableGift('),
    'active-room контролерът трябва да вика sendTableGift',
  )
})

// ─── [3] Няма дублирана лична презентация ─────────────────────────────────

await check("[3] Table gift handler-ът НЕ вика createDeliveryNotification (без дублирана презентация)", () => {
  const handler = serverIndexSrc.slice(
    serverIndexSrc.indexOf("if (message.type === 'send_table_gift')"),
    serverIndexSrc.indexOf("if (message.type === 'resume_room')"),
  )
  assert(handler.length > 0, 'handler блокът трябва да е намерен')
  // Игнорираме коментарните редове — интересува ни само реален call.
  const executableHandler = handler
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert(
    !executableHandler.includes('createDeliveryNotification('),
    "context='game' НЕ трябва да пише в personal delivery log — това би дало втора презентация",
  )
  assert(handler.includes("'game'"), "handler-ът трябва да подава context='game'")
})

// ─── [4] Broadcast само при нова транзакция ───────────────────────────────

await check('[4] Room broadcast се прави САМО при !isReplay', () => {
  const handler = serverIndexSrc.slice(
    serverIndexSrc.indexOf("if (message.type === 'send_table_gift')"),
    serverIndexSrc.indexOf("if (message.type === 'resume_room')"),
  )
  const guardIndex = handler.indexOf('if (!giftResult.isReplay)')
  const broadcastIndex = handler.indexOf('broadcastToRoomConnections(')
  assert(guardIndex !== -1, 'трябва да има isReplay guard')
  assert(broadcastIndex !== -1, 'трябва да има broadcast извикване')
  assert(broadcastIndex > guardIndex, 'broadcast-ът трябва да е ВЪТРЕ в !isReplay guard-а')
})

// ─── [5] Dedup строго по transactionId ────────────────────────────────────

await check('[5] Dedup строго по transactionId (никога по sender/recipient/gift)', () => {
  assert(
    activeRoomSrc.includes('processedTableGiftTransactionIds.has(message.transactionId)'),
    'dedup-ът трябва да е по transactionId',
  )

  // Поведенчески модел на dedup логиката от handler-а.
  const seen = new Set<string>()
  const applied: string[] = []
  const apply = (transactionId: string): void => {
    if (seen.has(transactionId)) return
    seen.add(transactionId)
    applied.push(transactionId)
  }

  apply('tx-1')
  apply('tx-1') // мрежов дубликат на СЪЩАТА транзакция → игнорира се
  // Два отделни подаръка от същия подател към същия получател със същия
  // артикул — РАЗЛИЧНИ transactionId, значи и двата трябва да минат.
  apply('tx-2')

  assertEqual(applied.length, 2, 'дубликатът се игнорира, но двата отделни подаръка минават')
  assertEqual(applied[0], 'tx-1', 'първата транзакция е приложена')
  assertEqual(applied[1], 'tx-2', 'втората (различна) транзакция също е приложена')
})

// ─── [6] Reconnect не пуска анимация ──────────────────────────────────────

await check('[6] Reconnect възстановява overlay-и без да пуска летящата анимация', () => {
  const snapshotFn = extractFunctionBody(
    activeRoomSrc,
    'function applyActiveTableGiftsFromSnapshot(',
  )
  assert(
    // Проверяваме за РЕАЛЕН call (с отваряща скоба), не просто текстово
    // споменаване — функцията legitimately обяснява в коментар защо НЕ
    // вика playTableGiftFlightAnimation (виж §28 delete pendingLanding... коментара).
    !snapshotFn.includes('playTableGiftFlightAnimation('),
    'snapshot пътят НЕ трябва да пуска анимация (иначе reconnect би я преиграл)',
  )
  assert(
    snapshotFn.includes('Date.parse(gift.expiresAt) <= nowMs'),
    'изтеклите подаръци се пропускат при reconnect',
  )
  assert(
    /message\.type === 'table_gift_item_sent'[\s\S]*?playTableGiftFlightAnimation\(/.test(activeRoomSrc),
    'анимацията трябва да се пуска САМО от live push branch-а',
  )

  // Remaining-time поведение при reconnect.
  const nowMs = Date.now()
  const expiresAt = new Date(nowMs + 18_000).toISOString()
  const remainingMs = Date.parse(expiresAt) - nowMs
  assert(remainingMs > 0 && remainingMs <= 60_000, 'остатъкът е положителен и в рамките на 60 сек')
  assert(remainingMs < 20_000, 'reconnect показва ОСТАТЪКА, не пълните 60 сек')
})

// ─── [7] Avatar-ът остава непроменен ──────────────────────────────────────

await check('[7] Overlay-ът е отделен слот — permanent avatar URL не се пипа', () => {
  assert(seatPanelsSrc.includes('data-seat-gift-overlay='), 'трябва да има gift overlay слот')
  const overlayFn = extractFunctionBody(seatPanelsSrc, 'function renderSeatGiftOverlaySlot(')
  assert(!overlayFn.includes('<img'), 'слотът се рендира празен; съдържанието се попълва императивно')

  const syncFn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(')
  assert(!syncFn.includes('avatarUrl'), 'sync-ът не трябва да пипа avatarUrl')
  assert(!syncFn.includes('.src ='), 'sync-ът не трябва да пренаписва avatar <img> src')
})

// ─── [8] Gift икона за валидни получатели — вкл. bots (Stage 2.1) ─────────

await check('[8] Gift иконата се показва за чужди заети места (human ИЛИ bot с реален profileId)', () => {
  const guard = seatPanelsSrc.slice(
    seatPanelsSrc.indexOf('const canSendGiftToSeat ='),
    seatPanelsSrc.indexOf('const isBottomSeat ='),
  )
  assert(guard.includes('seat.isOccupied'), 'изисква заето място')
  // Stage 2.1: ботовете вече НЕ са изключени по isBot флага — regular
  // matchmaking bots имат стабилен DB-backed profileId (виж
  // resolveTableGiftParticipants.ts), затова единственият client-side gate
  // е profileId наличност + не-собствено място + не tournament bot-replacement.
  assert(!guard.includes('!seat.isBot'), 'ботовете вече НЕ са изключени по isBot флага')
  assert(guard.includes('!isBotReplacement'), 'tournament bot-replacement (замества ЧОВЕШКИ играч визуално) остава изключен')
  // != null (не !==) — покрива и undefined от по-стар snapshot без полето.
  assert(guard.includes('seat.profileId != null'), 'изисква реален profileId (покрива и rare bot без profileId)')
  assert(guard.includes('seat.profileId.length > 0'), 'празен profileId не се приема')
  assert(guard.includes('seat.seat !== localSeat'), 'собственото място е изключено')
})

// ─── [9] Sync е вързан в общия overlay tail ───────────────────────────────

await check('[9] syncTableGiftOverlays е вързан в syncActiveRoomOverlayEffects', () => {
  const syncAll = extractFunctionBody(activeRoomSrc, 'function syncActiveRoomOverlayEffects(')
  assert(syncAll.includes('syncTableGiftOverlays()'), 'трябва да се вика от общия overlay sync')
})

// ─── [10] PATCH пътят остава непокътнат ───────────────────────────────────

await check('[10] Gift state НЕ участва в никой stable render key', () => {
  // Реалните имена в контролера: cuttingStableRenderKey,
  // biddingStableRenderKey, stablePhaseRenderKey.
  const stableKeyLines = activeRoomSrc
    .split('\n')
    .filter((line) => /StableRenderKey/.test(line) && !line.trim().startsWith('//'))
  assert(stableKeyLines.length > 0, 'в контролера трябва да има stable render key-ове')
  for (const line of stableKeyLines) {
    assert(
      !/tableGift|TableGift/i.test(line),
      `gift state не трябва да участва в stable key: ${line.trim()}`,
    )
  }

  // Самите key-конструкции също не трябва да съдържат gift state.
  const biddingKey = activeRoomSrc.slice(
    activeRoomSrc.indexOf('const biddingStableRenderKey = JSON.stringify({'),
    activeRoomSrc.indexOf('const biddingStableRenderKey = JSON.stringify({') + 900,
  )
  assert(
    !/tableGift/i.test(biddingKey),
    'biddingStableRenderKey не трябва да съдържа gift state',
  )
  assert(
    /table_gift_item_sent'[\s\S]*?scheduleActiveRoomRender\(true\)/.test(activeRoomSrc),
    'table gift трябва да ползва PATCH-preferring render (true), както emoji/phrase',
  )
})

// ─── [11] Таймер по remaining time ────────────────────────────────────────

await check('[11] Скриването ползва remaining time (expiresAt - now), не фиксирани 60 000 ms', () => {
  const syncFn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(')
  assert(
    syncFn.includes('const remainingMs = Date.parse(overlay.expiresAt) - nowMs'),
    'остатъкът се смята от authoritative expiresAt',
  )
  assert(syncFn.includes('}, remainingMs)'), 'таймерът се въоръжава с остатъка')
  assert(!syncFn.includes('60000') && !syncFn.includes('60_000'), 'без hardcoded 60 сек')
})

// ─── [12] Presentation routing ────────────────────────────────────────────

await check('[12] Routing: table gift → overlay; profile gift → модал (извън игра) / banner (в игра)', () => {
  const showNext = extractFunctionBody(lobbySrc, 'function showNextGiftItemNotification(')
  assert(showNext.includes('options.getIsInGame?.()'), 'решението чете актуалния in-game статус')
  assert(showNext.includes('showGiftItemReceivedBanner('), 'в игра се показва banner')
  assert(
    showNext.indexOf('showGiftItemReceivedBanner(') < showNext.lastIndexOf('render()'),
    'banner пътят връща преди нормалния lobby render',
  )
  // Решението се взима при ИЗВАЖДАНЕ от опашката, не при enqueue.
  const enqueue = extractFunctionBody(lobbySrc, 'function enqueueGiftItemNotifications(')
  assert(!enqueue.includes('getIsInGame'), 'presentation mode НЕ се решава при enqueue')

  // Table gift НИКОГА не минава през lobby queue-то.
  assert(
    !lobbySrc.includes('table_gift_item_sent'),
    'table gift има собствен път (avatar overlay), не минава през lobby notification queue',
  )

  // Поведенчески модел на routing-а.
  const route = (kind: 'table' | 'profile', isInGame: boolean): string =>
    kind === 'table' ? 'avatar-overlay' : isInGame ? 'banner' : 'modal'
  assertEqual(route('table', true), 'avatar-overlay', 'table gift в игра → overlay')
  assertEqual(route('table', false), 'avatar-overlay', 'table gift винаги → overlay')
  assertEqual(route('profile', true), 'banner', 'profile gift докато играе → banner')
  assertEqual(route('profile', false), 'modal', 'profile gift извън игра → модал')
})

// ─── [13] Live push и за получател в стая ─────────────────────────────────

await check('[13] Профилният gift route праща live push и когато получателят е в стая', () => {
  const routeBlock = serverIndexSrc.slice(
    serverIndexSrc.indexOf('const recipientConn = Object.values(serverState.connections).find('),
    serverIndexSrc.indexOf("type: 'gift_item_received',"),
  )
  assert(routeBlock.length > 0, 'блокът трябва да е намерен')
  assert(
    !routeBlock.includes('currentRoomId == null'),
    'guard-ът currentRoomId == null трябва да е премахнат — играещ получател също е online',
  )
  assert(routeBlock.includes("c.status === 'connected'"), 'online статусът се определя само от връзката')
})

// ─── [14] Анимационна техника ─────────────────────────────────────────────

await check('[14] Летящата анимация ползва transform/opacity върху преизползван fixed слой', () => {
  const flight = extractFunctionBody(activeRoomSrc, 'function playTableGiftFlightAnimation(')
  assert(flight.includes('.animate('), 'ползва Web Animations API')
  assert(flight.includes('transform: `translate('), 'позиционира се чрез transform')
  assert(
    !/\n\s*(top|left):\s*\$\{/.test(flight),
    'НЕ анимира top/left (layout thrashing)',
  )
  assert(
    flight.includes("querySelector<HTMLElement>('[data-table-gift-flight-layer=\"1\"]')"),
    'слоят се търси преди създаване (преизползва се, не се пресъздава)',
  )
  assert(flight.includes('getBoundingClientRect()'), 'позициите идват от реални DOM rect-ове')
  assert(
    flight.includes('data-profile-seat-btn="${senderSeat}"') &&
      flight.includes('data-profile-seat-btn="${recipientSeat}"'),
    'anchor-ите се намират по абсолютен seat (DOM slot-овете са keyed така)',
  )
  assert(flight.includes('flyer.remove()'), 'летящият елемент се маха след края')
})

// ─── [15] Root cause regression: send_table_gift е регистриран в runtime parser-а ──

await check('[15] send_table_gift е регистриран в parseClientMessage.ts (root cause на "modal остава заключен")', () => {
  // ROOT CAUSE: server/src/protocol/messageTypes.ts (ClientMessage union) и
  // src/app/network/createGameServerClient.ts вече знаеха за send_table_gift
  // (TypeScript компилираше чисто), но server/src/protocol/parseClientMessage.ts
  // е ОТДЕЛЕН, ръчно поддържан runtime whitelist — тип-checking не хваща
  // липсваща runtime регистрация там. Без нея, parseClientMessage() връщаше
  // null за ВСЯКО send_table_gift съобщение → index.ts пращаше generic
  // {type:'error', message:'Invalid message payload.'} вместо да стигне
  // изобщо до resolveTableGiftParticipants/sendGiftItem → клиентският
  // table_gift_send_result listener никога не се задейства →
  // tableGiftModal.submittingGiftItemId остава non-null завинаги (UI
  // заклещен в disabled/"not-allowed"). Важеше еднакво за human И bot
  // recipient, тъй като заявката никога не стигаше до validation логиката.
  assert(
    serverParseClientMessageSrc.includes("parsed.type === 'send_table_gift'"),
    'parseClientMessage.ts трябва explicit да разпознава send_table_gift',
  )

  const block = serverParseClientMessageSrc.slice(
    serverParseClientMessageSrc.indexOf("if (parsed.type === 'send_table_gift')"),
    serverParseClientMessageSrc.indexOf("if (parsed.type === 'request_private_rooms_list')"),
  )
  assert(block.includes('roomId'), 'трябва да normalize-ва roomId')
  assert(block.includes('recipientProfileId'), 'трябва да normalize-ва recipientProfileId')
  assert(block.includes('giftItemId'), 'трябва да normalize-ва giftItemId')
  assert(block.includes('requestId'), 'трябва да normalize-ва requestId')
  assert(
    block.includes('return null'),
    'трябва да отхвърля съобщение с липсващи/невалидни полета (не да ги coerce-ва мълчаливо)',
  )
  assert(
    block.includes("type: 'send_table_gift'"),
    'при успешен parse трябва да върне типизиран ClientMessage',
  )
})

// ─── [16] Defense-in-depth: generic error освобождава table gift in-flight state ──

await check('[16] Generic {type:"error"} response освобождава tableGiftModal.submittingGiftItemId', () => {
  const errorBlock = extractFunctionBody(activeRoomSrc, "if (message.type === 'error') {")
  assert(
    errorBlock.includes('tableGiftModal.submittingGiftItemId = null'),
    'error handler-ът трябва да освободи submitting state дори при неочакван generic error (не само explicit table_gift_send_result)',
  )
  assert(
    errorBlock.includes('syncTableGiftModal()'),
    'трябва да re-sync-не модала, за да се enable-нат картите отново',
  )
})

// ─── [17] Success flow: modal се затваря СЛЕД success response, преди 60-sec overlay ──

await check('[17] handleTableGiftSendResult затваря modal-а и освобождава state веднага при success', () => {
  // extractFunctionBody тръгва от ПЪРВАТА "{" след сигнатурата — параметърният
  // тип на handleTableGiftSendResult е inline object literal ({ requestId:
  // string; ok: boolean; ... }), затова 'function handleTableGiftSendResult('
  // само би хванал параметровия type literal, не реалния function body.
  // Anchor-ваме на края на параметровия списък ('): void {') вместо това.
  const fn = extractFunctionBody(activeRoomSrc, "senderBalanceAfter?: number\r\n  }): void {")
  assert(fn.includes('closeTableGiftModal()'), 'success клонът трябва да затвори модала')
  assert(
    /if \(!message\.ok\) \{[\s\S]*?submittingGiftItemId = null[\s\S]*?pendingRequestId = null/.test(fn),
    'failure клонът трябва да освободи submitting + pendingRequestId',
  )
  assert(
    fn.indexOf('if (!message.ok)') < fn.indexOf('closeTableGiftModal()'),
    'failure проверката трябва да е ПРЕДИ close (не затваряй модала при грешка)',
  )
})

// ─── [18] Duplicate-click guard: request НЕ се дублира докато е in-flight ──

await check('[18] submitTableGift блокира повторен click докато requestId вече е in-flight', () => {
  const fn = extractFunctionBody(activeRoomSrc, 'function submitTableGift(')
  assert(
    fn.includes('if (tableGiftModal.submittingGiftItemId !== null) return'),
    'повторен submit докато вече тече заявка трябва да е no-op',
  )

  // Поведенчески модел на самия guard — идентичен на реалната логика.
  let submittingGiftItemId: string | null = null
  let sentCount = 0
  const submit = (giftItemId: string): void => {
    if (submittingGiftItemId !== null) return
    submittingGiftItemId = giftItemId
    sentCount++
  }

  submit('gift-a')
  submit('gift-a') // double-click докато първата заявка е in-flight
  assertEqual(sentCount, 1, 'само ЕДНА заявка излиза при бърз двоен click')

  // Success освобождава state-а — следваща заявка (нов requestId) вече минава.
  submittingGiftItemId = null
  submit('gift-b')
  assertEqual(sentCount, 2, 'след release (success/failure) нова заявка е позволена')
})

// ─── [19] Root cause fix: overlay се preserve-ва при syncSeatPanels fallback rebuild ──

await check('[19] syncSeatPanels snapshot-ва и restore-ва gift overlay nodes при fallback full rebuild (flicker fix)', () => {
  // ROOT CAUSE на intermittent flicker: syncSeatPanels() има targeted-diff
  // "success" път (ok=true, seat-panels host НЕ се пипа) и fallback
  // "host.innerHTML = html" път (structural промяна — нов card-fan seat set
  // при trick completion, dealer/highlight промяна и т.н.). Fallback-ът
  // пресъздава ЦЯЛОТО seat-panels поддърво, включително [data-seat-gift-overlay]
  // slot-овете (връщат се към празния display:none template) — overlay-ът
  // изчезва за момент, докато syncTableGiftOverlays() (извикана по-късно в
  // СЪЩИЯ render pass) не го попълни отново. Между двете DOM мутации
  // браузърът може да paint-не intermediate frame → видим flicker.
  const fn = extractFunctionBody(activeRoomSrc, 'function syncSeatPanels(html: string): void {')

  assert(
    fn.includes("querySelectorAll<HTMLElement>('[data-seat-gift-overlay]')"),
    'трябва да snapshot-ва съществуващите gift-overlay nodes ПРЕДИ rebuild-а',
  )
  assert(
    /const preservedGiftOverlays[\s\S]*?host\.innerHTML = html/.test(fn),
    'snapshot-ът трябва да се вземе ПРЕДИ host.innerHTML = html презаписа',
  )
  assert(
    /host\.innerHTML = html[\s\S]*?for \(const preserved of preservedGiftOverlays\)/.test(fn),
    'restore-ът трябва да стане ВЕДНАГА след host.innerHTML = html, в СЪЩАТА синхронна функция',
  )
  assert(
    fn.includes('freshNode.dataset.giftTransactionId = preserved.transactionId'),
    'restore-ът трябва да пренесе transactionId маркера (иначе syncTableGiftOverlays пак би счел overlay-а за "нов" и би го rebuild-нал излишно)',
  )
  assert(
    fn.includes('freshNode.innerHTML = preserved.innerHTML'),
    'restore-ът трябва да пренесе реалното съдържание (image), не само маркера',
  )

  // Поведенчески модел на preserve+restore логиката (без реален DOM).
  type FakeOverlayNode = { transactionId: string | undefined; innerHTML: string; style: string | null }
  const hostBefore: Record<string, FakeOverlayNode> = {
    right: { transactionId: 'tx-1', innerHTML: '<img src="rose.webp">', style: 'display:flex;opacity:1;' },
  }
  // Симулира html rebuild-а — новите nodes са ПРАЗНИ (template default).
  const hostAfterRebuild: Record<string, FakeOverlayNode> = {
    right: { transactionId: undefined, innerHTML: '', style: 'display:none;' },
  }
  // Restore стъпката (mirror на реалния код).
  for (const [seat, preserved] of Object.entries(hostBefore)) {
    if (!preserved.transactionId) continue
    const fresh = hostAfterRebuild[seat]
    if (!fresh) continue
    fresh.transactionId = preserved.transactionId
    fresh.innerHTML = preserved.innerHTML
    if (preserved.style) fresh.style = preserved.style
  }

  assertEqual(hostAfterRebuild.right?.transactionId, 'tx-1', 'transactionId маркерът е пренесен')
  assertEqual(hostAfterRebuild.right?.innerHTML, '<img src="rose.webp">', 'съдържанието (image) е пренесено — overlay никога не е реално празен')
  assertEqual(hostAfterRebuild.right?.style, 'display:flex;opacity:1;', 'display:flex стилът е пренесен, не display:none')
})

// ─── [20] Timer НЕ се reschedule-ва при непроменен gift (repeated sync) ────

await check('[20] syncTableGiftOverlays не пресъздава timer или node при повторен sync на СЪЩИЯ transaction', () => {
  const fn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(): void {')
  assert(
    fn.includes("node.dataset.giftTransactionId !== overlay.transactionId"),
    'innerHTML rebuild трябва да е guard-нат зад transactionId сравнение',
  )
  assert(
    fn.includes('tableGiftOverlayTimerIds[seatKey] === undefined'),
    'нов timer трябва да се арми само ако няма вече активен timer за тоя seat',
  )

  // Поведенчески модел — два последователни sync-а на СЪЩИЯ transaction не
  // трябва да презаписват innerHTML нито да пресъздават timer-а.
  let innerHtmlWrites = 0
  let timerArms = 0
  const node: { transactionId: string | undefined } = { transactionId: undefined }
  const timers: Record<string, boolean> = {}

  const sync = (seat: string, transactionId: string): void => {
    if (node.transactionId !== transactionId) {
      node.transactionId = transactionId
      innerHtmlWrites++
    }
    if (timers[seat] === undefined) {
      timers[seat] = true
      timerArms++
    }
  }

  sync('right', 'tx-1')
  sync('right', 'tx-1') // unrelated gameplay update, СЪЩИЯТ active gift
  sync('right', 'tx-1')

  assertEqual(innerHtmlWrites, 1, 'innerHTML се пише точно веднъж за целия живот на transaction-а')
  assertEqual(timerArms, 1, 'timer-ът се арми точно веднъж, не при всеки sync')
})

// ─── [21] New gift transaction замества стария точно веднъж ───────────────

await check('[21] Нов gift transaction към същия recipient replace-ва стария overlay точно веднъж', () => {
  const fn = extractFunctionBody(activeRoomSrc, "if (message.type === 'table_gift_item_sent' && message.roomId === activeRoomState.roomId) {")
  assert(
    fn.includes('clearTableGiftOverlayTimer(message.recipientSeat)'),
    'стария timer трябва explicit да се отмени преди презаписа (иначе стария timeout би скрил новия overlay предсрочно)',
  )

  let innerHtmlWrites = 0
  const node: { transactionId: string | undefined } = { transactionId: undefined }
  const sync = (transactionId: string): void => {
    if (node.transactionId !== transactionId) {
      node.transactionId = transactionId
      innerHtmlWrites++
    }
  }

  sync('tx-rose')
  sync('tx-crown') // нов gift към СЪЩИЯ recipient seat
  assertEqual(innerHtmlWrites, 2, 'всеки РЕАЛНО различен transaction произвежда точно една innerHTML промяна')
  assertEqual(node.transactionId, 'tx-crown', 'текущият overlay е последния transaction')
})

// ─── [22] Expiry премахва overlay-а точно веднъж ───────────────────────────

await check('[22] Изтичане на gift премахва overlay-а точно веднъж (без repeated remove опити)', () => {
  const fn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(): void {')
  assert(
    fn.includes('if (remainingMs <= 0) {'),
    'expiry проверката трябва да е explicit срещу remainingMs <= 0',
  )
  assert(
    /remainingMs <= 0[\s\S]*?delete activeRoomState\.activeTableGiftOverlays\[seatKey\]/.test(fn),
    'expired entry трябва да се трие от state-а, за да не се обработва повторно при следващ sync',
  )

  let removeCalls = 0
  const state: Record<string, { expiresAt: number } | undefined> = { right: { expiresAt: Date.now() - 1000 } }
  const remove = (): void => { removeCalls++ }
  const sync = (seat: string): void => {
    const entry = state[seat]
    if (!entry) return
    if (entry.expiresAt <= Date.now()) {
      delete state[seat]
      remove()
    }
  }

  sync('right')
  sync('right') // втори sync СЛЕД expiry — entry вече е изтрит, remove не се вика пак
  assertEqual(removeCalls, 1, 'remove се извиква точно веднъж, не при всеки следващ sync')
})

// ─── Presentation timing fix: overlay се разкрива само при landing ────────
//
// ROOT CAUSE: table_gift_item_sent handler-ът записваше новия gift в
// activeRoomState.activeTableGiftOverlays[recipientSeat] ПРЕДИ
// playTableGiftFlightAnimation() изобщо да стартира, а последвалият
// scheduleActiveRoomRender(true) веднага викаше syncTableGiftOverlays(),
// която показваше overlay-а докато летящото изображение едва тръгваше.
// Fix: pendingLandingTransactionIdBySeat suppress-ва визуалното разкриване
// на seat-а, докато transactionId-то там съвпада с "текущо летящия" gift;
// syncTableGiftOverlays() го skip-ва напълно (DOM непроменен — стар
// overlay или празен avatar), а playTableGiftFlightAnimation() решава
// кога/дали да го освободи (onfinish за успешен полет, fallback веднага
// ако анимацията не може безопасно да стартира).

// ─── [23] pendingLandingTransactionIdBySeat: seat се маркира ПРЕДИ полета ──

await check('[23] table_gift_item_sent маркира recipientSeat pending ПРЕДИ playTableGiftFlightAnimation', () => {
  const block = activeRoomSrc.slice(
    activeRoomSrc.indexOf("if (message.type === 'table_gift_item_sent'"),
    activeRoomSrc.indexOf("if (message.type === 'table_gift_send_result'"),
  )
  assert(
    block.includes('pendingLandingTransactionIdBySeat[message.recipientSeat] = message.transactionId'),
    'recipientSeat трябва да се маркира pending-landing веднага при получаване на live event',
  )
  const markIdx = block.indexOf('pendingLandingTransactionIdBySeat[message.recipientSeat] = message.transactionId')
  const flightIdx = block.indexOf('playTableGiftFlightAnimation(')
  assert(markIdx !== -1 && flightIdx !== -1 && markIdx < flightIdx, 'маркирането трябва да е ПРЕДИ стартирането на анимацията')
  assert(
    block.includes('activeRoomState.activeTableGiftOverlays[message.recipientSeat] = {'),
    'canonical state продължава да се записва веднага (server е authoritative) — само визуалното разкриване е suppressed',
  )
})

// ─── [24] syncTableGiftOverlays skip-ва напълно pending-landing seats ─────

await check('[24] syncTableGiftOverlays НЕ докосва DOM за seat, чийто активен transactionId е pending-landing', () => {
  const fn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(): void {')
  assert(
    fn.includes('pendingLandingTransactionIdBySeat[seatKey] === overlay.transactionId'),
    'trябва explicit sравнение срещу pending-landing маркера за ТОЗИ seat/transaction',
  )
  const skipIdx = fn.indexOf('pendingLandingTransactionIdBySeat[seatKey] === overlay.transactionId')
  const nodeQueryIdx = fn.indexOf("host.querySelector<HTMLElement>(`[data-seat-gift-overlay=")
  assert(skipIdx !== -1 && nodeQueryIdx !== -1 && skipIdx < nodeQueryIdx, 'skip проверката трябва да е ПРЕДИ каквато и да е DOM мутация на overlay node-а')

  // Поведенчески модел — pending seat остава напълно недокоснат.
  let domWrites = 0
  const pending: Record<string, string | undefined> = { right: 'tx-new' }
  const overlays: Record<string, { transactionId: string }> = { right: { transactionId: 'tx-new' } }
  const sync = (seat: string): void => {
    const overlay = overlays[seat]
    if (!overlay) return
    if (pending[seat] === overlay.transactionId) return // skip — DOM недокоснат
    domWrites++
  }
  sync('right')
  assertEqual(domWrites, 0, 'DOM не се пипа изобщо докато gift-ът е pending-landing')
})

// ─── [25] Recipient БЕЗ стар gift: avatar остава видим по време на полета ──

await check('[25] Recipient без предишен gift: overlay slot остава display:none по време на flight', () => {
  // Overlay slot template-ът рендира display:none по подразбиране (виж
  // renderSeatGiftOverlaySlot в renderCuttingSeatPanels.ts) — щом
  // syncTableGiftOverlays skip-ва seat-а изцяло (тест [24]), slot-ът просто
  // никога не получава display:flex преди landing, значи оригиналният
  // avatar <img> отдолу е единственото видимо нещо.
  assert(
    seatPanelsSrc.includes("display:none"),
    'overlay slot template-ът трябва да рендира display:none по подразбиране',
  )

  let overlayVisible = false
  const pending: Record<string, string | undefined> = { right: 'tx-new' }
  const overlays: Record<string, { transactionId: string }> = { right: { transactionId: 'tx-new' } }
  const sync = (seat: string): void => {
    const overlay = overlays[seat]
    if (!overlay) return
    if (pending[seat] === overlay.transactionId) return
    overlayVisible = true
  }
  sync('right')
  assertEqual(overlayVisible, false, 'overlay никога не става видим преди landing release-а')
})

// ─── [26] Recipient С стар gift: старият остава видим по време на flight ──

await check('[26] Replacement: старият overlay остава видим по време на новия flight, заменя се само при landing', () => {
  // Canonical state (activeTableGiftOverlays[seat]) вече сочи НОВИЯ gift
  // веднага (server-authoritative), но DOM-ът все още показва СТАРИЯ,
  // защото syncTableGiftOverlays skip-ва seat-а изцяло, докато е
  // pending-landing — DOM node-ът не се пипа, значи старото innerHTML/
  // transactionId marker остават на екрана непроменени.
  let domTransactionId = 'tx-rose' // DOM показва старата роза
  const pending: Record<string, string | undefined> = { right: 'tx-crown' } // новата корона лети
  const canonical: Record<string, { transactionId: string }> = { right: { transactionId: 'tx-crown' } }

  const sync = (seat: string): void => {
    const overlay = canonical[seat]
    if (!overlay) return
    if (pending[seat] === overlay.transactionId) return // skip — DOM остава СЪС старата роза
    domTransactionId = overlay.transactionId
  }

  sync('right') // по време на полета на короната
  assertEqual(domTransactionId, 'tx-rose', 'старият overlay (Роза) остава видим, докато Короната лети')

  // Landing release — pending маркерът пада, следващ sync реално сменя DOM-а.
  delete pending.right
  sync('right')
  assertEqual(domTransactionId, 'tx-crown', 'едва при landing старият overlay се заменя с новия')
})

// ─── [27] expiresAt не се рестартира при landing ───────────────────────────

await check('[27] Landing НЕ рестартира server expiresAt — canonical timestamp остава source of truth', () => {
  assert(
    !activeRoomSrc.includes('releasePendingTableGiftLanding') ||
      !/releasePendingTableGiftLanding[\s\S]{0,400}Date\.now\(\)\s*\+\s*60/.test(activeRoomSrc),
    'releasePendingTableGiftLanding не трябва да изчислява нов +60s expiresAt',
  )
  const releaseFn = extractFunctionBody(activeRoomSrc, 'function releasePendingTableGiftLanding(recipientSeat: Seat, transactionId: string): void {')
  assert(!releaseFn.includes('expiresAt ='), 'release функцията не трябва да пипа expiresAt изобщо')
  assert(!releaseFn.includes('60_000') && !releaseFn.includes('60000'), 'няма hardcoded 60-секунден constant тук')

  // syncTableGiftOverlays продължава да чете remainingMs от canonical
  // overlay.expiresAt (сървърен timestamp) — landing release само маха
  // suppression-а, следващият sync използва СЪЩИЯ вече-съществуващ expiresAt.
  const syncFn = extractFunctionBody(activeRoomSrc, 'function syncTableGiftOverlays(): void {')
  assert(
    syncFn.includes('Date.parse(overlay.expiresAt) - nowMs'),
    'remaining time винаги се смята от canonical overlay.expiresAt, не от момента на landing',
  )
})

// ─── [28] Reconnect snapshot: директен show, pending-landing се чисти ──────

await check('[28] applyActiveTableGiftsFromSnapshot показва overlay директно, чисти евентуален stale pending marker', () => {
  const fn = extractFunctionBody(activeRoomSrc, 'function applyActiveTableGiftsFromSnapshot(gifts: ActiveTableGiftSnapshot[]): void {')
  assert(
    !fn.includes('pendingLandingTransactionIdBySeat[gift.recipientSeat] ='),
    'reconnect path не трябва да SLAGA pending-landing маркер (директен show, без flight)',
  )
  assert(
    fn.includes('delete pendingLandingTransactionIdBySeat[gift.recipientSeat]'),
    'трябва explicit да чисти евентуален stale pending marker от прекъснат полет преди reconnect-а',
  )
  assert(
    // Реален call, не текстово споменаване — функцията explicit обяснява в
    // коментар защо НЕ вика playTableGiftFlightAnimation.
    !fn.includes('playTableGiftFlightAnimation('),
    'reconnect path никога не трябва да пуска летящата анимация',
  )
})

// ─── [29] Missing DOM anchor fallback: overlay се показва, не остава hidden ──

await check('[29] playTableGiftFlightAnimation освобождава pending-landing веднага, ако анимацията не може да стартира', () => {
  const fn = extractFunctionBody(
    activeRoomSrc,
    'function playTableGiftFlightAnimation(\r\n    senderSeat: Seat,\r\n    recipientSeat: Seat,\r\n    imageUrl: string,\r\n    transactionId: string,\r\n  ): void {',
  )

  // Всеки ранен return path (без Web Animations API, липсващ seat-panels
  // host, липсващ sender/recipient DOM anchor, zero-size rect) трябва да
  // вика releasePendingTableGiftLanding ПРЕДИ да върне управлението.
  const earlyReturnGuards = [
    "document.createElement('div').animate !== 'function'",
    "!panelsHost",
    '!fromSeatNode || !toSeatNode',
    'fromRect.width === 0 || toRect.width === 0',
  ]
  for (const guard of earlyReturnGuards) {
    const guardIdx = fn.indexOf(guard)
    assert(guardIdx !== -1, `трябва да съдържа guard-а: ${guard}`)
    const nextReleaseIdx = fn.indexOf('releasePendingTableGiftLanding(recipientSeat, transactionId)', guardIdx)
    const nextReturnIdx = fn.indexOf('return', guardIdx)
    assert(
      nextReleaseIdx !== -1 && nextReleaseIdx < nextReturnIdx + 50,
      `fallback за "${guard}" трябва да release-не pending-landing преди/при early return`,
    )
  }
})

// ─── [30] Stale landing callback: по-стар transaction не overwrite-ва по-нов ──

await check('[30] releasePendingTableGiftLanding guard-ва срещу stale (изпреварен) callback', () => {
  const fn = extractFunctionBody(
    activeRoomSrc,
    'function releasePendingTableGiftLanding(recipientSeat: Seat, transactionId: string): void {',
  )
  assert(
    fn.includes('pendingLandingTransactionIdBySeat[recipientSeat] !== transactionId'),
    'трябва explicit да сравни текущия pending marker със СВОЯ transactionId, не безусловно да delete-ва',
  )
  assert(
    /!== transactionId\) \{\s*return/.test(fn),
    'mismatch трябва да е no-op (return), не force-delete',
  )

  // Поведенчески модел: gift1 лети към seat "right", после gift2 (нов
  // transaction) пристига към СЪЩИЯ seat, докато gift1 още лита.
  // gift1-ият (стар, late) onfinish не трябва да revela-не/пипне нищо.
  let revealedTransactionId: string | null = null
  const pending: Record<string, string | undefined> = {}
  const release = (seat: string, transactionId: string): void => {
    if (pending[seat] !== transactionId) return // stale — no-op
    delete pending[seat]
    revealedTransactionId = transactionId
  }

  pending.right = 'tx-gift1'
  pending.right = 'tx-gift2' // gift2 пристига, презаписва mapping-а (mirror на handler-а)

  release('right', 'tx-gift1') // late callback на СТАРИЯ (gift1) полет
  assertEqual(revealedTransactionId, null, 'stale (gift1) late callback НЕ разкрива нищо — все още pending gift2')
  assertEqual(pending.right, 'tx-gift2', 'pending маркерът остава непокътнат за текущо летящия gift2')

  release('right', 'tx-gift2') // реалният, текущ landing
  assertEqual(revealedTransactionId, 'tx-gift2', 'landing-ът на актуалния transaction реално разкрива overlay-а')
  assertEqual(pending.right, undefined, 'pending маркерът е изчистен след успешен release')
})

// ─── [31] Duplicate event: без втори flight, без duplicate landing ────────

await check('[31] Duplicate transactionId event не стартира втори flight и не пипа pending-landing state', () => {
  const block = activeRoomSrc.slice(
    activeRoomSrc.indexOf("if (message.type === 'table_gift_item_sent'"),
    activeRoomSrc.indexOf("if (message.type === 'table_gift_send_result'"),
  )
  const dedupIdx = block.indexOf('processedTableGiftTransactionIds.has(message.transactionId)')
  const pendingMarkIdx = block.indexOf('pendingLandingTransactionIdBySeat[message.recipientSeat] = message.transactionId')
  assert(dedupIdx !== -1 && pendingMarkIdx !== -1 && dedupIdx < pendingMarkIdx, 'dedup проверката трябва да е ПРЕДИ pending-landing маркирането и flight стартирането')
  assert(block.includes('return true'), 'duplicate трябва да е ранен return, без да стигне до playTableGiftFlightAnimation')
})

// ─── Резултат ─────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
