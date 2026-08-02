/**
 * checkAvatarUploadSecurity.ts
 *
 * Security regression tests за POST /api/profile/me/avatar и
 * POST /api/profile/me/gallery след sharp 0.34.5 -> 0.35.3 ъпдейта и
 * добавения sharp.block() defense-in-depth (VipsForeignLoadNsgif,
 * VipsForeignLoadTiff, VipsForeignLoadVips).
 *
 * decodeImageDataUrl() проверява само claimed data-URL MIME префикса
 * (image/png|jpeg|webp), не реалното съдържание на файла — libvips
 * детектира истинския формат по magic bytes. Без sharp.block() атакуващ
 * може да изпрати GIF/TIFF/VIPS байтове с "data:image/png;base64,..."
 * префикс и sharp пак ще ги обработи. Тези тестове доказват, че
 * след defense-in-depth такива заявки биват безопасно отхвърляни.
 *
 * [1]  Валиден JPEG avatar → 200 + webp avatarUrl
 * [2]  Валиден PNG avatar → 200 + webp avatarUrl
 * [3]  Валиден WebP avatar → 200 + webp avatarUrl
 * [4]  GIF байтове с "image/png" MIME префикс (format confusion) → отхвърлено (не 200)
 * [5]  TIFF байтове с "image/jpeg" MIME префикс (format confusion) → отхвърлено (не 200)
 * [6]  Невалидни/повредени байтове с "image/png" префикс → отхвърлено (не 200)
 * [7]  Данни над MAX_ORIGINAL_IMAGE_BYTES (10MB) → 400 INVALID_IMAGE
 * [8]  Валиден JPEG gallery upload → 200 + webp imageUrl
 * [9]  GIF байтове с "image/png" MIME префикс в gallery → отхвърлено (не 200)
 * [10] sharp.block() е регистриран веднага след import-а с точния operation списък (static)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'

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

// ─── [10] Static source assertion за sharp.block() ────────────────────────────

console.log('\n=== Avatar/Gallery Upload Security Checks ===\n')

await check(
  '[10] sharp.block() е регистриран веднага след import-а с точния operation списък',
  async () => {
    const source = await readFile(join(serverRoot, 'src', 'index.ts'), 'utf8')
    const importIdx = source.indexOf("import sharp from 'sharp'")
    assert(importIdx !== -1, "import sharp from 'sharp' не е намерен")
    const afterImport = source.slice(importIdx, importIdx + 400)
    assert(afterImport.includes('sharp.block({'), 'sharp.block({...}) не следва веднага import-а')
    assert(afterImport.includes("'VipsForeignLoadNsgif'"), 'липсва VipsForeignLoadNsgif в block списъка')
    assert(afterImport.includes("'VipsForeignLoadTiff'"), 'липсва VipsForeignLoadTiff в block списъка')
    assert(afterImport.includes("'VipsForeignLoadVips'"), 'липсва VipsForeignLoadVips в block списъка')
    // sharp.block() трябва да се извиква преди първия import след sharp (Stripe),
    // за да важи глобално за целия процес преди каквато и да е обработка на снимки.
    const stripeIdx = source.indexOf("import Stripe from 'stripe'")
    assert(stripeIdx > importIdx, "import Stripe трябва да следва sharp import-а")
    const blockIdx = source.indexOf('sharp.block({')
    assert(blockIdx > importIdx && blockIdx < stripeIdx, 'sharp.block() не е между sharp import-а и следващия import')
  },
)

// ─── Fixture генериране (в текущия процес, sharp тук НЕ е block-нат) ─────────

const fixtureBase = sharp({
  create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 60, b: 60 } },
})

const jpegBuffer = await fixtureBase.clone().jpeg().toBuffer()
const pngBuffer = await fixtureBase.clone().png().toBuffer()
const webpBuffer = await fixtureBase.clone().webp().toBuffer()
const gifBuffer = await fixtureBase.clone().gif().toBuffer()
const tiffBuffer = await fixtureBase.clone().tiff().toBuffer()
const garbageBuffer = randomBytes(256)
const oversizedBuffer = randomBytes(10_500_000) // > MAX_ORIGINAL_IMAGE_BYTES (10_000_000)

function toDataUrl(mime: 'png' | 'jpeg' | 'webp', buffer: Buffer): string {
  return `data:image/${mime};base64,${buffer.toString('base64')}`
}

// ─── HTTP integration harness (реален spawn-нат сървър, изолирана DB) ────────

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'AvatarUploadCheck1!'

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-avatar-upload-http-'))
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

async function httpPostJson(port: number, pathname: string, payload: unknown, cookie?: string): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userEmail = `avatar-upload-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD, displayName: 'AvatarCheck', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${regRes.status}`)

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail, password: PASSWORD }),
  })
  const h2 = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h2.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error('No Set-Cookie on login')

  const crop = { cropX: 0, cropY: 0, cropSize: 64 }

  // ─── [1-3] Валидни формати ────────────────────────────────────────────────

  await check('[1] Валиден JPEG avatar → 200 + webp avatarUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('jpeg', jpegBuffer), ...crop }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { avatarUrl: string } } }
    assert(b.ok === true, 'ok трябва да е true')
    assert(b.session.profile.avatarUrl.endsWith('.webp'), `avatarUrl трябва да завършва на .webp, получено: ${b.session.profile.avatarUrl}`)
  })

  await check('[2] Валиден PNG avatar → 200 + webp avatarUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('png', pngBuffer), ...crop }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { avatarUrl: string } } }
    assert(b.ok === true, 'ok трябва да е true')
    assert(b.session.profile.avatarUrl.endsWith('.webp'), `avatarUrl трябва да завършва на .webp, получено: ${b.session.profile.avatarUrl}`)
  })

  await check('[3] Валиден WebP avatar → 200 + webp avatarUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('webp', webpBuffer), ...crop }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { avatarUrl: string } } }
    assert(b.ok === true, 'ok трябва да е true')
    assert(b.session.profile.avatarUrl.endsWith('.webp'), `avatarUrl трябва да завършва на .webp, получено: ${b.session.profile.avatarUrl}`)
  })

  // ─── [4-6] Format confusion / невалидни данни → трябва да се отхвърлят ────

  await check('[4] GIF байтове с "image/png" MIME префикс → отхвърлено (не 200)', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('png', gifBuffer), ...crop }, cookie)
    assert(r.status !== 200, `GIF-съдържание с png MIME претенция беше прието (status=200) — sharp.block() не работи`)
    const b = r.body as { ok: boolean }
    assert(b.ok === false, 'ok трябва да е false')
  })

  await check('[5] TIFF байтове с "image/jpeg" MIME префикс → отхвърлено (не 200)', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('jpeg', tiffBuffer), ...crop }, cookie)
    assert(r.status !== 200, `TIFF-съдържание с jpeg MIME претенция беше прието (status=200) — sharp.block() не работи`)
    const b = r.body as { ok: boolean }
    assert(b.ok === false, 'ok трябва да е false')
  })

  await check('[6] Невалидни/повредени байтове с "image/png" префикс → отхвърлено (не 200)', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('png', garbageBuffer), ...crop }, cookie)
    assert(r.status !== 200, `Повредени данни бяха приети (status=200)`)
    const b = r.body as { ok: boolean }
    assert(b.ok === false, 'ok трябва да е false')
  })

  // ─── [7] Size limit ────────────────────────────────────────────────────────

  await check('[7] Данни над MAX_ORIGINAL_IMAGE_BYTES (10MB) → 400', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: toDataUrl('png', oversizedBuffer), ...crop }, cookie)
    assert(r.status === 400, `status=${r.status}, очакван 400 (INVALID_IMAGE от decodeImageDataUrl size check)`)
    const b = r.body as { ok: boolean }
    assert(b.ok === false, 'ok трябва да е false')
  })

  // ─── [8-9] Gallery endpoint ────────────────────────────────────────────────

  await check('[8] Валиден JPEG gallery upload → 200 + webp imageUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/gallery', { imageDataUrl: toDataUrl('jpeg', jpegBuffer) }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { galleryImages: { imageUrl: string }[] } } }
    assert(b.ok === true, 'ok трябва да е true')
    const last = b.session.profile.galleryImages.at(-1)
    assert(!!last && last.imageUrl.endsWith('.webp'), `imageUrl трябва да завършва на .webp, получено: ${last?.imageUrl}`)
  })

  await check('[8b] Валиден PNG gallery upload → 200 + webp imageUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/gallery', { imageDataUrl: toDataUrl('png', pngBuffer) }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { galleryImages: { imageUrl: string }[] } } }
    const last = b.session.profile.galleryImages.at(-1)
    assert(!!last && last.imageUrl.endsWith('.webp'), `imageUrl трябва да завършва на .webp, получено: ${last?.imageUrl}`)
  })

  await check('[8c] Валиден WebP gallery upload → 200 + webp imageUrl', async () => {
    const r = await httpPostJson(port, '/api/profile/me/gallery', { imageDataUrl: toDataUrl('webp', webpBuffer) }, cookie)
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok: boolean; session: { profile: { galleryImages: { imageUrl: string }[] } } }
    const last = b.session.profile.galleryImages.at(-1)
    assert(!!last && last.imageUrl.endsWith('.webp'), `imageUrl трябва да завършва на .webp, получено: ${last?.imageUrl}`)
  })

  await check('[9] GIF байтове с "image/png" MIME префикс в gallery → отхвърлено с 400', async () => {
    const r = await httpPostJson(port, '/api/profile/me/gallery', { imageDataUrl: toDataUrl('png', gifBuffer) }, cookie)
    assert(r.status === 400, `GIF-съдържание с png MIME претенция трябва да върне 400, status=${r.status}`)
    const b = r.body as { ok: boolean; message?: string }
    assert(b.ok === false, 'ok трябва да е false')
    assert(typeof b.message === 'string' && b.message.length > 0, 'трябва да има видимо съобщение за грешка')
  })

  await check('[9b] HEIC/HEIF data URL prefix is not advertised as supported → 400 with visible message', async () => {
    const r = await httpPostJson(port, '/api/profile/me/avatar', { imageDataUrl: `data:image/heic;base64,${jpegBuffer.toString('base64')}`, ...crop }, cookie)
    assert(r.status === 400, `HEIC prefix трябва да върне 400, status=${r.status}`)
    const b = r.body as { ok: boolean; message?: string }
    assert(b.ok === false, 'ok трябва да е false')
    assert(typeof b.message === 'string' && b.message.length > 0, 'трябва да има видимо съобщение за грешка')
  })

} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Резюме ────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
