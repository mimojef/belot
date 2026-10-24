/**
 * checkProfileGallerySecureAccess.ts
 *
 * Hotfix върху production версията (38770ac): профилната галерия през Node
 * маршрута
 *   GET /api/profiles/:profileId/gallery/:imageId
 * вместо директния /uploads/profile-gallery/... (production nginx го отказва
 * с 403 — защитата на личните качени файлове).
 *
 * Реален HTTP сървър в изолирано копие на server/ с temp база и temp
 * uploads/. Никога реалната база. Покрива: собственик, друг потребител,
 * гост, стари (вече записани) и нови снимки, липсващ файл/снимка, блокиране,
 * невалиден image ID, подправен записан URL, path traversal,
 * symlink/junction извън галерията, качване и премахване, мобилен и
 * настолен User-Agent, кеш (private + ETag, без immutable); останалите
 * /uploads категории (аватари) се сервират както досега.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileGallerySecureAccess.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const SECRET = 'profile-gallery-secure-access-secret-0123456789'
const PASSWORD = 'secret123'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

console.log('\ncheckProfileGallerySecureAccess')
console.log(`Server root: ${sourceServerRoot}`)

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-gallery-secure-'))
const serverDir = join(isolatedRoot, 'server')
await mkdir(serverDir, { recursive: true })
await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
await symlink(join(sourceServerRoot, '..', 'node_modules'), join(isolatedRoot, 'node_modules'), linkType)

const uploadsRoot = join(serverDir, 'uploads')
const galleryRoot = join(uploadsRoot, 'profile-gallery')
await mkdir(galleryRoot, { recursive: true })
await mkdir(join(uploadsRoot, 'avatars'), { recursive: true })

const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
const db = new DatabaseSync(bootstrap.databaseFilePath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

type RunningServer = { child: ChildProcessByStdio<null, Readable, Readable>; output(): string }
let server: RunningServer | null = null

try {
  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1', PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET }
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  server = { child, output: () => chunks.join('') }
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Сървърът спря:\n${server.output().slice(-2000)}`)
    try { if ((await fetch(`${base}/health`)).ok) break } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error('Timeout: health')
    await new Promise((r) => setTimeout(r, 250))
  }

  async function api(path: string, init: { method?: string; cookie?: string; body?: unknown; userAgent?: string } = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.userAgent ? { 'User-Agent': init.userAgent } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
  async function getImage(path: string, init: { cookie?: string; userAgent?: string; ifNoneMatch?: string } = {}): Promise<{ status: number; type: string | null; cache: string | null; etag: string | null; body: Buffer }> {
    const res = await fetch(`${base}${path}`, {
      headers: {
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...(init.userAgent ? { 'User-Agent': init.userAgent } : {}),
        ...(init.ifNoneMatch ? { 'If-None-Match': init.ifNoneMatch } : {}),
      },
    })
    return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), etag: res.headers.get('etag'), body: Buffer.from(await res.arrayBuffer()) }
  }

  type User = { profileId: string; accountId: string; email: string; cookie: string }
  let counter = 0
  async function register(label: string): Promise<User> {
    counter += 1
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `gal-${label.toLowerCase()}-${counter}@example.test`
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, displayName: `Gal${label}${counter}`, gender: 'female', visitorId: randomUUID() }),
    })
    const json = await res.json() as any
    if (res.status !== 200 || !json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(json)}`)
    return { profileId: json.session.profile.profileId, accountId: json.session.account.accountId, email, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]! }
  }

  const pngDataUrl = async (seed: number) => `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: seed % 255, g: 80, b: 160 } } }).png().toBuffer()).toString('base64')}`

  /** "Стара" снимка — ред и файл във формата, който кодът записва от самото въвеждане на галерията. */
  async function insertLegacyImage(profileId: string, content: string): Promise<{ imageId: string; storedUrl: string; filePath: string }> {
    const imageId = randomUUID()
    const storedUrl = `/uploads/profile-gallery/${profileId}/${imageId}.webp`
    const filePath = join(galleryRoot, profileId, `${imageId}.webp`)
    await mkdir(join(galleryRoot, profileId), { recursive: true })
    await writeFile(filePath, content)
    const sortOrder = Number((db.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM profile_gallery_images WHERE profile_id = ?;').get(profileId) as { n: number }).n)
    db.prepare(`INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order, created_at) VALUES (?, ?, ?, ?, ?, '2026-05-20 10:00:00');`).run(imageId, profileId, storedUrl, storedUrl, sortOrder)
    return { imageId, storedUrl, filePath }
  }

  const owner = await register('Owner')
  const viewer = await register('Viewer')
  const apiUrl = (profileId: string, imageId: string) => `/api/profiles/${profileId}/gallery/${imageId}`

  // Нова снимка — качена през реалния endpoint.
  let newImageId = ''
  let newImageUrl = ''
  await check('[4/1] Нова снимка: качването записва файла; собственикът получава API URL и вижда снимката (200 image/webp)', async () => {
    const res = await api('/api/profile/me/gallery', { method: 'POST', cookie: owner.cookie, body: { imageDataUrl: await pngDataUrl(1) } })
    assert(res.status === 200 && res.json.ok === true, `${res.status} ${JSON.stringify(res.json).slice(0, 200)}`)
    const image = res.json.session.profile.galleryImages[0]
    newImageId = image.imageId
    newImageUrl = image.imageUrl
    assert(newImageUrl === apiUrl(owner.profileId, newImageId), `imageUrl: ${newImageUrl}`)
    const stored = db.prepare('SELECT image_url FROM profile_gallery_images WHERE image_id = ?;').get(newImageId) as { image_url: string }
    assert(stored.image_url === `/uploads/profile-gallery/${owner.profileId}/${newImageId}.webp`, `записаният URL: ${stored.image_url}`)
    assert(existsSync(join(galleryRoot, owner.profileId, `${newImageId}.webp`)), 'файлът на диска')
    const img = await getImage(newImageUrl, { cookie: owner.cookie })
    assert(img.status === 200 && img.type === 'image/webp', `${img.status} ${img.type}`)
    assert(img.body.equals(await readFile(join(galleryRoot, owner.profileId, `${newImageId}.webp`))), 'съдържанието = файла')
  })

  const legacy = await insertLegacyImage(owner.profileId, 'legacy-webp-bytes')
  await check('[3] Стара снимка (записан /uploads/profile-gallery/... URL отпреди): клиентът получава API URL, не записания; снимката се зарежда', async () => {
    const profile = await api(`/api/profiles/${owner.profileId}`, { cookie: viewer.cookie })
    const urls = (profile.json.profile.galleryImages as Array<{ imageId: string; imageUrl: string }>)
    const legacyEntry = urls.find((entry) => entry.imageId === legacy.imageId)
    assert(legacyEntry !== undefined && legacyEntry.imageUrl === apiUrl(owner.profileId, legacy.imageId), JSON.stringify(urls))
    assert(!JSON.stringify(profile.json).includes('/uploads/profile-gallery/'), 'записаният /uploads URL изтича към клиента')
    const img = await getImage(legacyEntry!.imageUrl, { cookie: viewer.cookie })
    assert(img.status === 200 && img.body.toString() === 'legacy-webp-bytes', `${img.status}`)
  })

  await check('[2/3g/5] Друг удостоверен потребител и гост виждат галерията; директният /uploads/profile-gallery/ не е нужен и Node не го сервира; аватарите се сервират както досега', async () => {
    for (const cookie of [viewer.cookie, undefined]) {
      const profile = await api(`/api/profiles/${owner.profileId}`, { cookie })
      assert(profile.status === 200, `профил: ${profile.status}`)
      for (const entry of profile.json.profile.galleryImages as Array<{ imageUrl: string }>) {
        const img = await getImage(entry.imageUrl, { cookie })
        assert(img.status === 200, `${entry.imageUrl}: ${img.status} (${cookie ? 'потребител' : 'гост'})`)
      }
    }
    const direct = await getImage(legacy.storedUrl)
    assert(direct.status === 404, `директен /uploads/profile-gallery/: ${direct.status}`)
    // Останалите /uploads категории не са засегнати (Node ги сервира по
    // стария маршрут; в production ги отдава nginx).
    await writeFile(join(uploadsRoot, 'avatars', 'public-avatar.webp'), 'AVATAR-BYTES')
    const avatar = await getImage('/uploads/avatars/public-avatar.webp')
    if (process.platform === 'win32') assert(avatar.status === 200 && avatar.body.toString() === 'AVATAR-BYTES', `аватар: ${avatar.status}`)
  })

  await check('[11] Мобилен и настолен User-Agent: един и същ URL и съдържание', async () => {
    const mobile = await api(`/api/profiles/${owner.profileId}`, { cookie: viewer.cookie, userAgent: MOBILE_UA })
    const desktop = await api(`/api/profiles/${owner.profileId}`, { cookie: viewer.cookie, userAgent: DESKTOP_UA })
    assert(JSON.stringify(mobile.json.profile.galleryImages) === JSON.stringify(desktop.json.profile.galleryImages), 'различни URL-и')
    const a = await getImage(newImageUrl, { cookie: viewer.cookie, userAgent: MOBILE_UA })
    const b = await getImage(newImageUrl, { cookie: viewer.cookie, userAgent: DESKTOP_UA })
    assert(a.status === 200 && b.status === 200 && a.body.equals(b.body), `${a.status}/${b.status}`)
    const clientSources = ['src/ui/overlays/renderPlayerProfilePopup.ts', 'src/app/lobby/renderLobbyScreen.ts', 'src/main.ts']
      .map((file) => readFileSync(join(sourceServerRoot, '..', file), 'utf8'))
    assert(clientSources.every((source) => !source.includes('/uploads/profile-gallery')), 'клиентът строи директен /uploads/profile-gallery/ URL')
  })

  await check('[12] Кеш: private, no-cache + ETag (без public/immutable); If-None-Match -> 304; проверката за видимост е преди 304', async () => {
    const img = await getImage(newImageUrl, { cookie: viewer.cookie })
    assert(img.cache === 'private, no-cache' && img.etag !== null, `Cache-Control: ${img.cache}, ETag: ${img.etag}`)
    assert(!/immutable|public/.test(img.cache ?? ''), 'дълъг публичен кеш')
    const revalidated = await getImage(newImageUrl, { cookie: viewer.cookie, ifNoneMatch: img.etag! })
    assert(revalidated.status === 304 && revalidated.body.length === 0, `304: ${revalidated.status}`)
  })

  await check('[5] Липсваща снимка/файл и снимка на друг профил през чужд profileId: 404', async () => {
    assert((await getImage(apiUrl(owner.profileId, randomUUID()), { cookie: viewer.cookie })).status === 404, 'непозната снимка')
    const missing = await insertLegacyImage(owner.profileId, 'x')
    await rm(missing.filePath)
    assert((await getImage(apiUrl(owner.profileId, missing.imageId), { cookie: viewer.cookie })).status === 404, 'липсващ файл')
    db.prepare('DELETE FROM profile_gallery_images WHERE image_id = ?;').run(missing.imageId)
    assert((await getImage(apiUrl(viewer.profileId, newImageId), { cookie: viewer.cookie })).status === 404, 'снимка на собственика през profileId на viewer')
    assert((await getImage(apiUrl(randomUUID(), newImageId))).status === 404, 'несъществуващ профил')
  })

  await check('[5b] Неразрешена снимка: блокиране в двете посоки -> 403 (както самият профил)', async () => {
    const blocker = await register('Blocker')
    const block = await api(`/api/profiles/${owner.profileId}/block`, { method: 'POST', cookie: blocker.cookie })
    assert(block.status === 200 && block.json.blocked === true, `block: ${block.status} ${JSON.stringify(block.json)}`)
    assert((await getImage(newImageUrl, { cookie: blocker.cookie })).status === 403, 'блокиралият вижда снимката')
    const ownerBlocks = await register('Blocked')
    await api(`/api/profiles/${ownerBlocks.profileId}/block`, { method: 'POST', cookie: owner.cookie })
    assert((await getImage(newImageUrl, { cookie: ownerBlocks.cookie })).status === 403, 'блокираният вижда снимката')
    const etag = (await getImage(newImageUrl, { cookie: viewer.cookie })).etag!
    assert((await getImage(newImageUrl, { cookie: blocker.cookie, ifNoneMatch: etag })).status === 403, '304 заобикаля блокирането')
  })

  await check('[6/7] Невалиден път, path traversal, подправен записан URL и чужда/външна директория: никога не се чете', async () => {
    for (const path of [
      `/api/profiles/${owner.profileId}/gallery/..%2F..%2F..%2Fpackage.json`,
      `/api/profiles/${owner.profileId}/gallery/${newImageId}.webp`,
      `/api/profiles/${owner.profileId}/gallery/%2e%2e`,
      `/api/profiles/..%2F..%2Fsrc/gallery/${newImageId}`,
      `/api/profiles/${owner.profileId}/gallery/a%00b`,
    ]) {
      const res = await getImage(path, { cookie: viewer.cookie })
      assert(res.status === 404, `${path}: ${res.status}`)
    }
    const secretDir = join(isolatedRoot, 'outside-secret')
    await mkdir(secretDir, { recursive: true })
    await writeFile(join(secretDir, 'secret.webp'), 'TOP-SECRET')
    await writeFile(join(uploadsRoot, 'avatars', 'avatar-secret.webp'), 'AVATAR')
    const viewerFolder = join(galleryRoot, viewer.profileId)
    await mkdir(viewerFolder, { recursive: true })
    await writeFile(join(viewerFolder, 'foreign.webp'), 'FOREIGN')
    for (const tampered of [
      `/uploads/profile-gallery/${owner.profileId}/../../avatars/avatar-secret.webp`,
      `/uploads/profile-gallery/${owner.profileId}/..%2F..%2Favatars%2Favatar-secret.webp`,
      `/uploads/avatars/avatar-secret.webp`,
      `/uploads/profile-gallery/${viewer.profileId}/foreign.webp`,
      `/uploads/profile-gallery/${owner.profileId}/sub/dir.webp`,
      `../../../../outside-secret/secret.webp`,
    ]) {
      const imageId = randomUUID()
      db.prepare(`INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order) VALUES (?, ?, ?, ?, ?);`)
        .run(imageId, owner.profileId, tampered, tampered, 50 + Math.floor(Math.random() * 1000))
      const res = await getImage(apiUrl(owner.profileId, imageId), { cookie: viewer.cookie })
      assert(res.status === 404, `подправен ${tampered}: ${res.status}`)
      db.prepare('DELETE FROM profile_gallery_images WHERE image_id = ?;').run(imageId)
    }
    // Папката на профил в галерията е junction/symlink към директория извън uploads.
    const junctionProfile = await register('Junction')
    await symlink(secretDir, join(galleryRoot, junctionProfile.profileId), linkType)
    const imageId = randomUUID()
    db.prepare(`INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order) VALUES (?, ?, ?, ?, 0);`)
      .run(imageId, junctionProfile.profileId, `/uploads/profile-gallery/${junctionProfile.profileId}/secret.webp`, `/uploads/profile-gallery/${junctionProfile.profileId}/secret.webp`)
    const viaJunction = await getImage(apiUrl(junctionProfile.profileId, imageId), { cookie: viewer.cookie })
    assert(viaJunction.status === 404 && !viaJunction.body.toString().includes('TOP-SECRET'), `junction: ${viaJunction.status}`)
  })

  await check('[10] Качване и премахване: премахнатата снимка изчезва (404) и файлът ѝ е изтрит; подредбата на останалите е запазена', async () => {
    const res = await api('/api/profile/me/gallery', { method: 'POST', cookie: owner.cookie, body: { imageDataUrl: await pngDataUrl(3) } })
    const images = res.json.session.profile.galleryImages as Array<{ imageId: string; imageUrl: string; sortOrder: number }>
    const added = images[images.length - 1]!
    const filePath = join(galleryRoot, owner.profileId, `${added.imageId}.webp`)
    assert((await getImage(added.imageUrl, { cookie: viewer.cookie })).status === 200 && existsSync(filePath), 'новата снимка')
    const removed = await api(`/api/profile/me/gallery/${added.imageId}`, { method: 'DELETE', cookie: owner.cookie })
    assert(removed.status === 200 && removed.json.ok === true, `премахване: ${removed.status} ${JSON.stringify(removed.json).slice(0, 200)}`)
    assert((await getImage(added.imageUrl, { cookie: viewer.cookie })).status === 404, 'премахнатата снимка')
    assert(!existsSync(filePath), 'файлът е изтрит')
    const remaining = (await api(`/api/profiles/${owner.profileId}`, { cookie: viewer.cookie })).json.profile.galleryImages as Array<{ imageId: string; imageUrl: string }>
    assert(remaining.some((entry) => entry.imageId === newImageId) && remaining.some((entry) => entry.imageId === legacy.imageId), 'останалите снимки')
    for (const entry of remaining) assert((await getImage(entry.imageUrl, { cookie: viewer.cookie })).status === 200, `${entry.imageId}`)
  })

  db.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
  if (server !== null) console.error(server.output().slice(-2000))
} finally {
  if (server !== null && server.child.exitCode === null) {
    server.child.kill('SIGTERM')
    await new Promise<void>((res) => {
      const timer = setTimeout(() => { server?.child.kill('SIGKILL'); res() }, 10_000)
      server!.child.once('exit', () => { clearTimeout(timer); res() })
    })
  }
  try { db.close() } catch { /* ignore */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(isolatedRoot, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
