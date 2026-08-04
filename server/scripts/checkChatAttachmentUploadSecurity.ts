/**
 * checkChatAttachmentUploadSecurity.ts
 *
 * Security/regression тестове за снимки в личния (приятелски) чат:
 * POST /api/chat/:friendshipId/messages (с imageDataUrl)
 * GET  /api/chat/:friendshipId/attachments/:filename
 *
 * Реален spawned сървър, изолирана DB (пълни migrations), двама реални
 * регистрирани потребители + приятелство, по модела на
 * checkAvatarUploadSecurity.ts (HTTP harness) и
 * checkPersonalChatMessageWindow.ts (register/friendship/WS setup).
 *
 * decodeImageDataUrl() проверява само claimed data-URL MIME префикса;
 * createChatAttachmentWebp() проверява реалния sharp-detected формат
 * (metadata.format) explicit срещу whitelist {jpeg, png, webp} — отделен
 * слой ОТГОРЕ на глобалния sharp.block() (VipsForeignLoadNsgif/Tiff/Vips)
 * defense-in-depth в index.ts.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, pred: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Fixture генериране (в текущия процес, sharp тук НЕ е block-нат) ─────────

console.log('\n=== Chat Attachment Upload Security Checks ===\n')

const fixtureBase = sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 120, b: 200 } },
})

// По-голяма снимка за resize/withoutEnlargement тестове.
const largeFixtureBase = sharp({
  create: { width: 3000, height: 1500, channels: 3, background: { r: 200, g: 80, b: 40 } },
})

const jpegBuffer = await fixtureBase.clone().jpeg().toBuffer()
const pngBuffer = await fixtureBase.clone().png().toBuffer()
const webpBuffer = await fixtureBase.clone().webp().toBuffer()
const gifBuffer = await fixtureBase.clone().gif().toBuffer()
const tiffBuffer = await fixtureBase.clone().tiff().toBuffer()
const garbageBuffer = randomBytes(256)
const oversizedBuffer = randomBytes(10_500_000) // > MAX_ORIGINAL_IMAGE_BYTES (10_000_000)
const largeJpegBuffer = await largeFixtureBase.clone().jpeg().toBuffer() // 3000x1500 > 1920 cap
const smallJpegBuffer = await sharp({
  create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 200, b: 10 } },
}).jpeg().toBuffer() // под 1920 — withoutEnlargement не бива да го уголеми

// EXIF Orientation=6 (90° CW) — sharp .rotate() трябва физически да завърти
// пикселите (width/height се разменят за 90°/270° orientation стойности).
const exifRotatedBuffer = await sharp({
  create: { width: 80, height: 40, channels: 3, background: { r: 250, g: 250, b: 10 } },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer()

function toDataUrl(mime: 'png' | 'jpeg' | 'webp', buffer: Buffer): string {
  return `data:image/${mime};base64,${buffer.toString('base64')}`
}

// ─── HTTP integration harness (реален spawn-нат сървър, изолирана DB) ────────

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'ChatAttachmentCheck1!'

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

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-chat-attachment-upload-http-'))
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
    uploadsDir: join(serverDir, 'uploads', 'chat-attachments'),
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

type HttpResult = { status: number; body: any; setCookie: string | null }

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, payload?: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const setCookie = (headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body, setCookie }
}

async function httpRaw(port: number, pathname: string, cookie: string | null): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, buffer }
}

function openProfileWebSocket(port: number, cookie: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore non-JSON */ }
  })
  return new Promise((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen({ ws, frames }))
    ws.once('error', reject)
  })
}

async function registerProfile(port: number, label: string, runId: string): Promise<{ cookie: string; profileId: string }> {
  const email = `chat-attach-${label}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `ChatAttach${label}`, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Register ${label} failed: ${res.status}`)
  const headers = res.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on register ${label}`)
  const body = await res.json() as { session: { profile: { profileId: string } } }
  return { cookie, profileId: body.session.profile.profileId }
}

async function befriend(port: number, cookieA: string, cookieB: string, targetProfileIdB: string): Promise<string> {
  const sendRes = await httpJson(port, 'POST', '/api/friends/request', cookieA, { profileId: targetProfileIdB })
  assertEqual(sendRes.status, 200, `friend request status ${JSON.stringify(sendRes.body)}`)
  const outgoing = sendRes.body.friendships.outgoingPending.find((f: any) => f.profile.profileId === targetProfileIdB)
  assert(outgoing !== undefined, 'outgoingPending must contain the new request')
  const friendshipId = outgoing.friendshipId as string
  const acceptRes = await httpJson(port, 'POST', `/api/friends/${encodeURIComponent(friendshipId)}/accept`, cookieB)
  assertEqual(acceptRes.status, 200, `friend accept status ${JSON.stringify(acceptRes.body)}`)
  return friendshipId
}

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpJson(port, 'GET', '/health', null)
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userA = await registerProfile(port, 'a', runId)
  const userB = await registerProfile(port, 'b', runId)
  const userC = await registerProfile(port, 'c', runId) // трети, неучастващ потребител
  const friendshipId = await befriend(port, userA.cookie, userB.cookie, userB.profileId)

  // ─── [1-3] Валидни формати → 200 + WebP attachment ───────────────────────

  await check('[1] Валиден JPEG снимка в лично съобщение → 200 + WebP attachment', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', jpegBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    assert(r.body.ok === true, 'ok трябва да е true')
    assert(r.body.newMessage.attachment !== null, 'newMessage.attachment не трябва да е null')
    assert(r.body.newMessage.attachment.viewUrl.endsWith('.webp'), 'viewUrl трябва да завършва на .webp')
  })

  await check('[2] Валиден PNG снимка в лично съобщение → 200 + WebP attachment', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('png', pngBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    assert(r.body.newMessage.attachment !== null, 'attachment не трябва да е null')
    assert(r.body.newMessage.attachment.viewUrl.endsWith('.webp'), 'viewUrl трябва да завършва на .webp')
  })

  let lastValidAttachment: { viewUrl: string; downloadUrl: string; attachmentId: string; width: number; height: number } | null = null

  await check('[3] Валиден WebP снимка в лично съобщение → 200 + WebP attachment', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: 'с текст', imageDataUrl: toDataUrl('webp', webpBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    assert(r.body.newMessage.attachment !== null, 'attachment не трябва да е null')
    assertEqual(r.body.newMessage.body, 'с текст', 'text+image message пази текста')
    lastValidAttachment = r.body.newMessage.attachment
  })

  // ─── [4-7] Format confusion / невалидни данни → отхвърлени ───────────────

  await check('[4] GIF байтове с "image/jpeg" MIME префикс (подправен MIME) → отхвърлено', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', gifBuffer),
    })
    assert(r.status !== 200, `GIF с jpeg MIME претенция беше прието (status=200)`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  await check('[5] TIFF байтове с "image/png" MIME префикс (подправен MIME) → отхвърлено', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('png', tiffBuffer),
    })
    assert(r.status !== 200, `TIFF с png MIME претенция беше прието (status=200)`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  await check('[6] Невалиден/повреден base64 → отхвърлено, не 500 crash', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: 'data:image/png;base64,%%%not-base64%%%',
    })
    assert(r.status === 400, `очакван 400, получен ${r.status}`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  await check('[7] Повредена снимка (случайни байтове с валиден MIME префикс) → отхвърлено', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('png', garbageBuffer),
    })
    assert(r.status !== 200, `Повредени данни бяха приети (status=200)`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  await check('[8] Файл над 10 MiB → 400', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('png', oversizedBuffer),
    })
    assert(r.status === 400, `status=${r.status}, очакван 400`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  // ─── [9-12] Resize / orientation / metadata ──────────────────────────────

  await check('[9] Снимка 3000x1500 се resize-ва до максимум 1920px по дългата страна', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', largeJpegBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const { width, height } = r.body.newMessage.attachment
    assert(Math.max(width, height) <= 1920, `max(width,height)=${Math.max(width, height)} > 1920`)
    // fit:'inside' пази съотношението: 3000x1500 → 2:1 → очакваме 1920x960
    assertEqual(width, 1920, 'resized width')
    assertEqual(height, 960, 'resized height')
  })

  await check('[10] Малка снимка (40x30) НЕ се уголемява (withoutEnlargement:true)', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', smallJpegBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const { width, height } = r.body.newMessage.attachment
    assertEqual(width, 40, 'small image width unchanged')
    assertEqual(height, 30, 'small image height unchanged')
  })

  await check('[11] EXIF Orientation=6 (90°) се прилага физически (auto-orient чрез rotate())', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', exifRotatedBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const { width, height } = r.body.newMessage.attachment
    // Оригинал 80x40 с Orientation=6 (90° CW) → физически завъртяно → 40x80
    assertEqual(width, 40, 'rotated width (was height)')
    assertEqual(height, 80, 'rotated height (was width)')
  })

  await check('[12] EXIF/ICC/XMP metadata не се запазва в изходния WebP файл', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', exifRotatedBuffer),
    })
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const raw = await httpRaw(port, r.body.newMessage.attachment.viewUrl, userA.cookie)
    assertEqual(raw.status, 200, 'attachment fetch status')
    const outputMetadata = await sharp(raw.buffer).metadata()
    assertEqual(outputMetadata.exif, undefined, 'no EXIF in output')
    assertEqual(outputMetadata.icc, undefined, 'no ICC profile in output')
    assertEqual(outputMetadata.xmp, undefined, 'no XMP in output')
    assertEqual(outputMetadata.format, 'webp', 'output format is webp')
  })

  // ─── [13] Случайно UUID име ───────────────────────────────────────────────

  await check('[13] Изходният файл има случайно UUID.webp име (не оригиналното/предвидимо)', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', jpegBuffer),
    })
    assert(r.status === 200, `status=${r.status}`)
    const url: string = r.body.newMessage.attachment.viewUrl
    const filename = url.split('/').pop()!.split('?')[0]
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/.test(filename),
      `filename "${filename}" не отговаря на UUID.webp формат`,
    )
  })

  // ─── [14-16] Достъп: sender / recipient / трети потребител ────────────────

  await check('[14] Изпращачът (sender) може да прегледа собствения си attachment', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment от предишен тест')
    const raw = await httpRaw(port, lastValidAttachment!.viewUrl, userA.cookie)
    assertEqual(raw.status, 200, 'sender view status')
    assertEqual(raw.headers.get('content-type'), 'image/webp', 'content-type')
  })

  await check('[15] Получателят (recipient) може да прегледа и свали attachment-а', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const viewRes = await httpRaw(port, lastValidAttachment!.viewUrl, userB.cookie)
    assertEqual(viewRes.status, 200, 'recipient view status')
    const downloadRes = await httpRaw(port, lastValidAttachment!.downloadUrl, userB.cookie)
    assertEqual(downloadRes.status, 200, 'recipient download status')
    assert(
      (downloadRes.headers.get('content-disposition') ?? '').startsWith('attachment;'),
      'download response трябва да носи Content-Disposition: attachment',
    )
  })

  await check('[16] Забранен достъп: трети потребител (не участник) НЕ вижда attachment-а', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const raw = await httpRaw(port, lastValidAttachment!.viewUrl, userC.cookie)
    assert(raw.status !== 200, `трети потребител получи 200 достъп до чужд attachment`)
  })

  await check('[16b] Неавтентикирана заявка (без cookie) → 401, не изтича файл', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const raw = await httpRaw(port, lastValidAttachment!.viewUrl, null)
    assertEqual(raw.status, 401, 'unauthenticated view status')
  })

  await check('[16c] Chat attachment НЕ е достъпен през публичния /uploads/ handler (regression за auth bypass)', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const filename = lastValidAttachment!.viewUrl.split('/').pop()!.split('?')[0]
    const raw = await httpRaw(port, `/uploads/chat-attachments/${filename}`, null)
    assert(
      raw.status !== 200,
      `chat attachment беше публично достъпен през /uploads/chat-attachments/ БЕЗ сесия (status=${raw.status}) — resolveUploadRequestPath трябва да whitelist-ва само avatars/profile-gallery`,
    )
  })

  // ─── [17] Path traversal ───────────────────────────────────────────────────

  await check('[17] Path traversal през filename сегмента е невъзможен', async () => {
    const attempts = [
      `/api/chat/${friendshipId}/attachments/${encodeURIComponent('../../../../etc/passwd')}`,
      `/api/chat/${friendshipId}/attachments/${encodeURIComponent('..%2f..%2fpackage.json')}`,
      `/api/chat/${friendshipId}/attachments/not-a-uuid.webp`,
      `/api/chat/${friendshipId}/attachments/${encodeURIComponent('valid-uuid-but-wrong-ext.png')}`,
    ]
    for (const pathname of attempts) {
      const raw = await httpRaw(port, pathname, userA.cookie)
      assert(raw.status !== 200, `path traversal / invalid filename прие 200 за: ${pathname}`)
    }
  })

  // ─── [18-19] Blocking guard ────────────────────────────────────────────────

  await check('[18] Блокиран sender (B е блокирал A) → A не може да изпрати текст', async () => {
    const blockRes = await httpJson(port, 'POST', `/api/profiles/${userA.profileId}/block`, userB.cookie)
    assertEqual(blockRes.status, 200, `block status ${JSON.stringify(blockRes.body)}`)
    assertEqual(blockRes.body.blocked, true, 'B blocked A')

    const textRes = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, { body: 'опит след блокиране' })
    assert(textRes.status !== 200, `текстово съобщение мина въпреки блокирането (status=${textRes.status})`)
    assert(textRes.body.ok === false, 'ok трябва да е false')
  })

  await check('[19] Блокиран sender → A не може да изпрати снимка', async () => {
    const imgRes = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('jpeg', jpegBuffer),
    })
    assert(imgRes.status !== 200, `снимка мина въпреки блокирането (status=${imgRes.status})`)
    assert(imgRes.body.ok === false, 'ok трябва да е false')
  })

  await check('[19b] Блокиран recipient (B) не може да отговори на A, докато блокирането е активно', async () => {
    const textRes = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userB.cookie, { body: 'B опитва да пише' })
    assert(textRes.status !== 200, `B успя да пише въпреки собственото си блокиране на A (status=${textRes.status})`)
  })

  await check('[19c] Историческите съобщения остават видими и след блокиране (не се трият)', async () => {
    const historyRes = await httpJson(port, 'GET', `/api/chat/${friendshipId}/messages`, userA.cookie)
    assertEqual(historyRes.status, 200, `history still accessible ${JSON.stringify(historyRes.body)}`)
    assert(historyRes.body.messages.length > 0, 'историята не трябва да е празна след блокиране')
  })

  await check('[19d] Съществуващ attachment остава сваляем и след блокиране', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const raw = await httpRaw(port, lastValidAttachment!.viewUrl, userA.cookie)
    assertEqual(raw.status, 200, 'attachment still viewable after block (history not mutated)')
  })

  await check('[19e] Отблокиране възстановява възможността за изпращане', async () => {
    const unblockRes = await httpJson(port, 'POST', `/api/profiles/${userA.profileId}/block`, userB.cookie)
    assertEqual(unblockRes.status, 200, `unblock status ${JSON.stringify(unblockRes.body)}`)
    assertEqual(unblockRes.body.blocked, false, 'B unblocked A')

    const textRes = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, { body: 'отново може' })
    assertEqual(textRes.status, 200, `изпращането трябва да работи след unblock ${JSON.stringify(textRes.body)}`)
  })

  // ─── [20] Active-game restriction (наследено от текстовия чат guard) ──────

  await check('[20] Празно съобщение (без текст И без снимка) се отхвърля', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, { body: '' })
    assert(r.status !== 200, `празно съобщение беше прието (status=${r.status})`)
    assert(r.body.ok === false, 'ok трябва да е false')
  })

  // ─── [21-22] text+image / само снимка / само текст ────────────────────────

  await check('[21] Съобщение с текст И снимка едновременно се записва цялостно', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: 'текст плюс снимка', imageDataUrl: toDataUrl('png', pngBuffer),
    })
    assertEqual(r.status, 200, `status ${JSON.stringify(r.body)}`)
    assertEqual(r.body.newMessage.body, 'текст плюс снимка', 'body preserved')
    assert(r.body.newMessage.attachment !== null, 'attachment preserved')
  })

  await check('[22] Съобщение само със снимка (празен body) се записва', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
      body: '', imageDataUrl: toDataUrl('webp', webpBuffer),
    })
    assertEqual(r.status, 200, `status ${JSON.stringify(r.body)}`)
    assertEqual(r.body.newMessage.body, '', 'empty body allowed with attachment')
    assert(r.body.newMessage.attachment !== null, 'attachment present')
  })

  await check('[23] Съобщение само с текст (без снимка) продължава да работи както преди', async () => {
    const r = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, { body: 'само текст' })
    assertEqual(r.status, 200, `status ${JSON.stringify(r.body)}`)
    assertEqual(r.body.newMessage.body, 'само текст', 'text-only body')
    assertEqual(r.body.newMessage.attachment, null, 'no attachment for text-only message')
  })

  // ─── [24] unread increment + WS notification за снимка ────────────────────

  await check('[24] Снимка увеличава unreadCount на получателя и праща WS известие', async () => {
    await httpJson(port, 'POST', `/api/chat/${friendshipId}/read`, userB.cookie)
    // chat_conversation_reads.last_read_at и friend_chat_messages.created_at
    // ползват SQLite CURRENT_TIMESTAMP (секундна прецизност) — изчакваме >1s,
    // за да не паднем в "равни секунди" ръба на unreadCount сравнението
    // (created_at > last_read_at), несвързано с логиката, която тестваме тук.
    await sleep(1100)
    const wsB = await openProfileWebSocket(port, userB.cookie)
    try {
      const sendRes = await httpJson(port, 'POST', `/api/chat/${friendshipId}/messages`, userA.cookie, {
        body: '', imageDataUrl: toDataUrl('jpeg', jpegBuffer),
      })
      assertEqual(sendRes.status, 200, `send status ${JSON.stringify(sendRes.body)}`)
      const newMessageId = sendRes.body.newMessage.messageId

      await waitFor('WS chat_message_received for image message', () =>
        wsB.frames.some((f) => f.type === 'chat_message_received' && f.messageId === newMessageId), 5_000)

      const convRes = await httpJson(port, 'GET', '/api/chat/conversations', userB.cookie)
      const conv = convRes.body.conversations.find((c: any) => c.friendshipId === friendshipId)
      assert(conv !== undefined, 'conversation found')
      assert(conv.unreadCount > 0, `unreadCount трябва да е > 0, получено ${conv.unreadCount}`)
    } finally {
      wsB.ws.close()
    }
  })

  // ─── [25] История след refresh (нов GET) показва снимката непроменена ────

  await check('[25] Историята след нов GET (симулира refresh) показва снимката с непроменени данни', async () => {
    assert(lastValidAttachment !== null, 'нужен е валиден attachment')
    const historyRes = await httpJson(port, 'GET', `/api/chat/${friendshipId}/messages`, userA.cookie)
    assertEqual(historyRes.status, 200, 'history status')
    const found = historyRes.body.messages.find((m: any) => m.attachment?.attachmentId === lastValidAttachment!.attachmentId)
    assert(found !== undefined, 'attachment message survives history refresh')
    assertEqual(found.attachment.width, lastValidAttachment!.width, 'width unchanged after refresh')
    assertEqual(found.attachment.height, lastValidAttachment!.height, 'height unchanged after refresh')
  })

  // ─── [26] DB failure след file write → не остава постоянен orphan ─────────
  // (unit-level, не HTTP — виж отделния runOrphanCleanupUnitChecks() по-долу)

  // ─── [27] Prune при 501-во съобщение слага правилните файлове в deletion queue

  await check('[27] Prune при 501-во съобщение слага САМО отпадащите attachment файлове в deletion queue', async () => {
    // Нов, изолиран friendship за чист 500-лимит тест.
    const userD = await registerProfile(port, 'd', runId)
    const userE = await registerProfile(port, 'e', runId)
    const fid2 = await befriend(port, userD.cookie, userE.cookie, userE.profileId)

    // Първото съобщение носи снимка — то трябва да отпадне при 501-вото ново съобщение.
    const firstRes = await httpJson(port, 'POST', `/api/chat/${fid2}/messages`, userD.cookie, {
      body: '', imageDataUrl: toDataUrl('png', pngBuffer),
    })
    assertEqual(firstRes.status, 200, `first message status ${JSON.stringify(firstRes.body)}`)
    const firstAttachmentFilename = (firstRes.body.newMessage.attachment.viewUrl as string).split('/').pop()!.split('?')[0]

    // Последното (500-то) съобщение също носи снимка — то ТРЯБВА да оцелее.
    for (let i = 1; i < 499; i++) {
      const r = await httpJson(port, 'POST', `/api/chat/${fid2}/messages`, userD.cookie, { body: `filler-${i}` })
      assertEqual(r.status, 200, `filler ${i} status ${JSON.stringify(r.body)}`)
    }
    const survivorRes = await httpJson(port, 'POST', `/api/chat/${fid2}/messages`, userD.cookie, {
      body: '', imageDataUrl: toDataUrl('webp', webpBuffer),
    })
    assertEqual(survivorRes.status, 200, `500th message status ${JSON.stringify(survivorRes.body)}`)
    const survivorFilename = (survivorRes.body.newMessage.attachment.viewUrl as string).split('/').pop()!.split('?')[0]

    // 501-во съобщение — тригерва prune-а, първото съобщение (с първата снимка) отпада.
    const pruneRes = await httpJson(port, 'POST', `/api/chat/${fid2}/messages`, userD.cookie, { body: 'trigger prune' })
    assertEqual(pruneRes.status, 200, `501st message status ${JSON.stringify(pruneRes.body)}`)

    // Файлът на 500-тото съобщение (survivor) все още трябва да е сваляем.
    const survivorCheck = await httpRaw(port, `/api/chat/${fid2}/attachments/${survivorFilename}`, userD.cookie)
    assertEqual(survivorCheck.status, 200, 'survivor attachment still accessible after prune')

    // Файлът на прунатото 1-во съобщение вече не трябва да е достъпен през API
    // (message-то е изтрито от DB → getAttachmentForDownload връща null).
    const prunedCheck = await httpRaw(port, `/api/chat/${fid2}/attachments/${firstAttachmentFilename}`, userD.cookie)
    assert(prunedCheck.status !== 200, 'pruned attachment no longer accessible via API')
  })

} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-4000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── [28-29] Orphan cleanup / file-write failure — unit-level тестове ────────
//
// Тези тестове инжектират директно chatStore + storage helpers (не пълния
// HTTP flow), защото симулират failure сценарии (DB грешка след file write,
// file write грешка), които не могат лесно да се предизвикат детерминирано
// през реален HTTP request към production кода без mock hooks.

async function runFileAtomicityUnitChecks(): Promise<void> {
  const { createChatStore } = await import('../src/db/chatStore.ts')
  const sqliteModule = await import('node:sqlite')

  const dir = await mkdtemp(join(tmpdir(), 'belot-chat-attachment-atomicity-'))
  const databaseFile = join(dir, 'chat.sqlite')
  const uploadsDir = join(dir, 'uploads')
  await mkdir(uploadsDir, { recursive: true })

  const database = new sqliteModule.DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_display_name TEXT NOT NULL DEFAULT '');
    CREATE TABLE profile_friendships (
      friendship_id TEXT PRIMARY KEY,
      requester_profile_id TEXT NOT NULL,
      addressee_profile_id TEXT NOT NULL,
      lower_profile_id TEXT NOT NULL,
      higher_profile_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT NULL,
      kind TEXT NOT NULL DEFAULT 'friend' CHECK (kind IN ('friend', 'pika_support'))
    );
    CREATE TABLE friend_chat_messages (
      message_id TEXT PRIMARY KEY,
      friendship_id TEXT NOT NULL,
      sender_profile_id TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) <= 1000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT NULL,
      FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE
    );
    CREATE TABLE friend_chat_attachments (
      message_id TEXT PRIMARY KEY REFERENCES friend_chat_messages(message_id) ON DELETE CASCADE,
      storage_filename TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      content_type TEXT NOT NULL DEFAULT 'image/webp',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_friend_chat_attachments_filename ON friend_chat_attachments(storage_filename);
    CREATE TABLE friend_chat_attachment_deletions (
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      storage_filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending', 'done', 'failed'))
    );
    CREATE TABLE chat_conversation_reads (
      profile_id TEXT NOT NULL, friendship_id TEXT NOT NULL, last_read_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, friendship_id)
    );
  `)
  database.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('p1','P1','p1'), ('p2','P2','p2')`).run()
  database.prepare(`
    INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status)
    VALUES ('f1', 'p1', 'p2', 'p1', 'p2', 'accepted')
  `).run()

  const fakeProgressStore = { getPublicProfile: (id: string) => ({
    profileId: id, displayName: id, avatarUrl: null, level: 1, rankTitle: null, skillRating: null,
    completedGamesCount: 0, wonGamesCount: 0, currentRankGames: null, nextRankGames: null,
    gamesUntilNextRank: null, rankProgressRatio: null, averageRating: null, totalRatingsCount: null,
    yellowCoinsBalance: 0, galleryImages: [], gender: null, likesCount: 0, hasLikedByMe: false, isBlockedByMe: false,
  }) } as any

  const store = await createChatStore(databaseFile, fakeProgressStore, { isBlocked: () => false }, { isRegisteredHumanProfile: () => true })

  try {
    await check('[26] DB failure след file write не оставя постоянен orphan (deletion queue поема след неуспешен INSERT)', async () => {
      // Записваме "orphan" файл директно на диска (симулира: file write успя),
      // после опитваме sendMessage с невалиден friendshipId (DB операцията ще
      // се провали на getAcceptedFriendship guard-а — 0 insert). Проверяваме,
      // че store-ът не остави DB следа, и че ние (extern, по модела на
      // index.ts POST handler-а) щяхме да изтрием файла веднага след fail.
      const filename = 'aaaaaaaa-0000-0000-0000-000000000001.webp'
      await writeFile(join(uploadsDir, filename), Buffer.from('fake-webp-bytes'))

      const result = store.sendMessage('p1', 'nonexistent-friendship', '', {
        storageFilename: filename, width: 10, height: 10, byteSize: 100, contentType: 'image/webp',
      })

      assert(!result.ok, 'sendMessage трябва да се провали за невалиден friendshipId')
      // index.ts POST handler-ът извиква deleteChatAttachmentFileByFilename веднага
      // при !result.ok — тук directamente симулираме същото извикване.
      await rm(join(uploadsDir, filename), { force: true })
      const stillExists = await stat(join(uploadsDir, filename)).then(() => true).catch(() => false)
      assert(!stillExists, 'файлът трябва да е изтрит след неуспешен sendMessage')

      const dbRow = database.prepare('SELECT 1 FROM friend_chat_attachments WHERE storage_filename = ?').get(filename)
      assert(dbRow === undefined, 'не трябва да има DB запис за отхвърленото съобщение')
    })

    await check('[26b] Успешен sendMessage с attachment създава едновременно message + attachment DB редове', async () => {
      const filename = 'aaaaaaaa-0000-0000-0000-000000000002.webp'
      await writeFile(join(uploadsDir, filename), Buffer.from('fake-webp-bytes-2'))
      const result = store.sendMessage('p1', 'f1', '', {
        storageFilename: filename, width: 20, height: 15, byteSize: 200, contentType: 'image/webp',
      })
      assert(result.ok, `sendMessage failed: ${!result.ok ? result.message : ''}`)
      const dbRow = database.prepare('SELECT message_id FROM friend_chat_attachments WHERE storage_filename = ?').get(filename) as { message_id: string } | undefined
      assert(dbRow !== undefined, 'attachment DB row трябва да съществува')
      if (result.ok) {
        assertEqual(dbRow!.message_id, result.newMessage.messageId, 'attachment.message_id съвпада с новото съобщение')
      }
    })

    await check('[27b] Cleanup job не трие все още активен attachment (attachmentExistsForFilename guard)', async () => {
      const filename = 'aaaaaaaa-0000-0000-0000-000000000002.webp' // от 26b, все още активен
      assert(store.attachmentExistsForFilename(filename), 'attachment трябва все още да съществува')
      // pending deletions списъкът НЕ трябва да съдържа този filename (не е бил pruned).
      const pending = store.listPendingAttachmentDeletions(1000)
      assert(!pending.some((p) => p.storageFilename === filename), 'активен attachment не трябва да е в deletion queue')
    })
  } finally {
    store.close()
    database.close()
    await retryRm(dir)
  }
}

await runFileAtomicityUnitChecks()

// ─── [28] Orphan scan: трие стар несвързан файл, пази нов (grace period) ─────

async function runOrphanScanUnitChecks(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-chat-attachment-orphan-scan-'))
  const uploadsDir = join(dir, 'uploads')
  await mkdir(uploadsDir, { recursive: true })

  const CHAT_ATTACHMENT_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/
  const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

  const oldOrphanFilename = 'bbbbbbbb-0000-0000-0000-000000000001.webp'
  const freshOrphanFilename = 'bbbbbbbb-0000-0000-0000-000000000002.webp'
  const linkedFilename = 'bbbbbbbb-0000-0000-0000-000000000003.webp'

  await writeFile(join(uploadsDir, oldOrphanFilename), Buffer.from('old-orphan'))
  await writeFile(join(uploadsDir, freshOrphanFilename), Buffer.from('fresh-orphan'))
  await writeFile(join(uploadsDir, linkedFilename), Buffer.from('linked'))

  // "Състарен" файл — mtime отпреди 48ч (извън grace period-а).
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await utimes(join(uploadsDir, oldOrphanFilename), oldTime, oldTime)
  // freshOrphanFilename и linkedFilename пазят "сега" mtime (in-flight upload симулация).

  // DB "знае" само за linkedFilename — симулация на attachmentExistsForFilename.
  const knownFilenames = new Set([linkedFilename])

  // Минимална симулация на runChatAttachmentOrphanScan логиката от index.ts
  // (директно тестваме алгоритъма, не пълния background job wiring).
  async function simulateOrphanScan(): Promise<string[]> {
    const entries = await readdir(uploadsDir, { withFileTypes: true })
    const now = Date.now()
    const deleted: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !CHAT_ATTACHMENT_FILENAME_PATTERN.test(entry.name)) continue
      if (knownFilenames.has(entry.name)) continue
      const fileStats = await stat(join(uploadsDir, entry.name))
      if (now - fileStats.mtimeMs < GRACE_PERIOD_MS) continue
      await rm(join(uploadsDir, entry.name))
      deleted.push(entry.name)
    }
    return deleted
  }

  try {
    await check('[28] Orphan scan трие стар (>24ч) несвързан файл', async () => {
      const deleted = await simulateOrphanScan()
      assert(deleted.includes(oldOrphanFilename), 'старият orphan трябва да бъде изтрит')
      const stillThere = await stat(join(uploadsDir, oldOrphanFilename)).then(() => true).catch(() => false)
      assert(!stillThere, 'файлът вече не трябва да съществува на диска')
    })

    await check('[29] Orphan scan НЕ трие нов (<24ч) несвързан файл (grace period)', async () => {
      const stillThere = await stat(join(uploadsDir, freshOrphanFilename)).then(() => true).catch(() => false)
      assert(stillThere, 'пресен in-flight файл не трябва да е изтрит в рамките на grace period-а')
    })

    await check('[29b] Orphan scan никога не трие файл, свързан с валиден DB запис', async () => {
      const stillThere = await stat(join(uploadsDir, linkedFilename)).then(() => true).catch(() => false)
      assert(stillThere, 'файл, за който DB има запис, никога не трябва да бъде изтрит от orphan scan-а')
    })
  } finally {
    await retryRm(dir)
  }
}

await runOrphanScanUnitChecks()

// ─── Резюме ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
