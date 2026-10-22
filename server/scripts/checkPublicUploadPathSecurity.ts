/**
 * checkPublicUploadPathSecurity.ts
 *
 * Публичните /uploads пътища (src/uploads/publicUploadPath.ts) — детерминистично
 * за POSIX (Linux production) и Windows чрез path.posix / path.win32, без
 * значение на коя ОС върви тестът.
 *
 * [U1] Разрешени публични файлове (POSIX и Windows), каноничен URL.
 * [U2] Личните директории (чат, поддръжка, Теми, evidence) и самият uploads root — отказ.
 * [U3] Traversal и неканонични форми ('..', '%2e%2e', '%2F', '%5C', NUL, ':', '%', празни сегменти).
 * [U4] Заобикаляне на скритата галерия през друга директория — отказ.
 * [U5] Съседна директория със същия префикс ("avatars-evil") — отказ.
 * [U6] Регресия: старият алгоритъм ('\\' разделител) отказва валиден файл под POSIX; новият го разрешава.
 * [U7] Windows: различен диск и регистър на буквите.
 * [U8] Реална файлова система: symlink/junction извън root-а не се чете.
 * [U9] deletePublicUploadFile: трие обикновен файл; липсващ; споделен (реферира се); symlink; личен файл — непокътнат.
 * [U10] profileUploadReferenceReader върху временна база с всички миграции.
 * [U11] index.ts използва модула (без Windows разделител, каноничен URL за скритата галерия, realpath, референции).
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  deletePublicUploadFile,
  isPathStrictlyInsideDirectory,
  resolvePublicUploadRequestPath,
  resolveRealPublicUploadFilePath,
} from '../src/uploads/publicUploadPath.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createProfileUploadReferenceReader } from '../src/db/profileUploadReferenceReader.js'

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

const serverRoot = path.resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

const PUBLIC_DIRS = ['avatars', 'profile-gallery', 'ad-campaigns', 'gift-items', 'campaign-themes']
const PRIVATE_DIRS = ['chat-attachments', 'support-attachments', 'topic-attachments', 'topic-mute-evidence-attachments']

const platforms = [
  { name: 'POSIX', api: path.posix, uploadsRoot: '/var/www/belot-v2/server/uploads' },
  { name: 'Windows', api: path.win32, uploadsRoot: 'C:\\srv\\belot-v2\\server\\uploads' },
] as const

function optionsFor(platform: (typeof platforms)[number]) {
  return {
    uploadsRoot: platform.uploadsRoot,
    publicRoots: PUBLIC_DIRS.map((dir) => platform.api.join(platform.uploadsRoot, dir)),
    pathApi: platform.api,
  }
}

const profileId = randomUUID()
const VALID_URLS = [
  `/uploads/avatars/${randomUUID()}.webp`,
  `/uploads/profile-gallery/${profileId}/${randomUUID()}.webp`,
  `/uploads/gift-items/${randomUUID()}.webp`,
  `/uploads/ad-campaigns/${randomUUID()}.webp`,
  `/uploads/campaign-themes/${randomUUID()}/icons/${randomUUID()}.gif`,
]

console.log('\ncheckPublicUploadPathSecurity')

console.log('\n[U] Разрешаване на пътища (POSIX и Windows)')

await check('[U1] Публичните файлове се разрешават под POSIX и Windows; пътят е в правилния root; URL-ът е каноничен', () => {
  for (const platform of platforms) {
    for (const url of VALID_URLS) {
      const resolution = resolvePublicUploadRequestPath(url, optionsFor(platform))
      assert(resolution !== null, `${platform.name}: ${url} не е разрешен`)
      if (resolution === null) continue
      const relative = url.slice('/uploads/'.length).split('/')
      assert(resolution.filePath === platform.api.join(platform.uploadsRoot, ...relative), `${platform.name}: ${resolution.filePath}`)
      assert(resolution.publicRoot === platform.api.join(platform.uploadsRoot, relative[0]!), `${platform.name}: root ${resolution.publicRoot}`)
      assert(resolution.canonicalPathname === url, `${platform.name}: canonical ${resolution.canonicalPathname}`)
    }
  }
})

await check('[U2] Личните директории, самият uploads root и публичните root-ове като директории — отказ', () => {
  for (const platform of platforms) {
    for (const dir of PRIVATE_DIRS) {
      assert(resolvePublicUploadRequestPath(`/uploads/${dir}/${randomUUID()}.webp`, optionsFor(platform)) === null, `${platform.name}: ${dir} е публичен`)
    }
    for (const url of ['/uploads/', '/uploads/x.webp', '/uploads/avatars', '/uploads/avatars/', '/uploads/database/data/belot-v2.sqlite', '/avatars/x.webp', '/uploadsx/avatars/a.webp']) {
      assert(resolvePublicUploadRequestPath(url, optionsFor(platform)) === null, `${platform.name}: ${url} е разрешен`)
    }
  }
})

await check('[U3] Traversal и неканонични форми се отказват (без нормализация)', () => {
  const vectors = [
    '/uploads/avatars/../chat-attachments/a.webp',
    '/uploads/avatars/%2e%2e/chat-attachments/a.webp',
    '/uploads/avatars/..%2Fchat-attachments%2Fa.webp',
    '/uploads/avatars%2F..%2F..%2Fdatabase%2Fdata%2Fbelot-v2.sqlite',
    '/uploads/avatars/..%5Cchat-attachments%5Ca.webp',
    '/uploads/avatars/a.webp%00.png',
    '/uploads/avatars/./a.webp',
    '/uploads/avatars//a.webp',
    '/uploads/avatars/a.webp/',
    '/uploads/avatars/C:%5Cwindows%5Cwin.ini',
    '/uploads/avatars/a.webp:stream',
    '/uploads/avatars/%252e%252e/a.webp',
    '/uploads/avatars/%E0%A4%A.webp',
    '/uploads/avatars/' + encodeURIComponent('/etc/passwd'),
  ]
  for (const platform of platforms) {
    for (const vector of vectors) {
      assert(resolvePublicUploadRequestPath(vector, optionsFor(platform)) === null, `${platform.name}: ${vector} е разрешен`)
    }
  }
})

await check('[U4] Скритата галерия не може да се достигне през друга публична директория', () => {
  for (const platform of platforms) {
    for (const vector of [
      `/uploads/avatars/..%2Fprofile-gallery%2F${profileId}%2Fa.webp`,
      `/uploads/gift-items/../profile-gallery/${profileId}/a.webp`,
      `/uploads/avatars/%2e%2e/profile-gallery/${profileId}/a.webp`,
    ]) {
      assert(resolvePublicUploadRequestPath(vector, optionsFor(platform)) === null, `${platform.name}: ${vector}`)
    }
    const direct = resolvePublicUploadRequestPath(`/uploads/profile-gallery/${profileId}/a.webp`, optionsFor(platform))
    assert(direct !== null && direct.canonicalPathname.startsWith(`/uploads/profile-gallery/${profileId}/`), `${platform.name}: каноничен URL на галерията`)
  }
})

await check('[U5] Съседна директория със същия префикс ("avatars-evil", "profile-gallery2") — отказ', () => {
  for (const platform of platforms) {
    for (const vector of ['/uploads/avatars-evil/a.webp', '/uploads/profile-gallery2/x/a.webp']) {
      assert(resolvePublicUploadRequestPath(vector, optionsFor(platform)) === null, `${platform.name}: ${vector}`)
    }
    assert(!isPathStrictlyInsideDirectory(platform.api.join(platform.uploadsRoot, 'avatars'), platform.api.join(platform.uploadsRoot, 'avatars-evil', 'a.webp'), platform.api), `${platform.name}: isPathStrictlyInsideDirectory`)
  }
})

await check('[U6] Регресия (P2): старият алгоритъм отказва валиден аватар под POSIX; новият го разрешава', () => {
  // Точно копие на предишната проверка от index.ts, параметризирано по платформа.
  function legacyResolve(pathname: string, api: typeof path.posix, uploadsRoot: string): string | null {
    const relativePath = decodeURIComponent(pathname.slice('/uploads/'.length))
    const resolvedPath = api.resolve(uploadsRoot, relativePath)
    const ok = PUBLIC_DIRS.map((dir) => api.resolve(api.join(uploadsRoot, dir))).some((publicRoot) => {
      const publicRootWithSeparator = `${publicRoot}${/[/\\]$/.test(publicRoot) ? '' : '\\'}`
      return resolvedPath.startsWith(publicRootWithSeparator) || resolvedPath === publicRoot
    })
    return ok ? resolvedPath : null
  }
  const url = VALID_URLS[0]!
  assert(legacyResolve(url, path.posix, platforms[0].uploadsRoot) === null, 'старият алгоритъм вече разрешава под POSIX (тестът не възпроизвежда бъга)')
  assert(legacyResolve(url, path.win32, platforms[1].uploadsRoot) !== null, 'старият алгоритъм под Windows')
  assert(resolvePublicUploadRequestPath(url, optionsFor(platforms[0])) !== null, 'новият алгоритъм под POSIX')
})

await check('[U7] Windows: друг диск се отказва; регистърът на буквите на root-а не пречи', () => {
  const api = path.win32
  assert(!isPathStrictlyInsideDirectory('C:\\srv\\uploads\\avatars', 'D:\\srv\\uploads\\avatars\\a.webp', api), 'друг диск')
  assert(isPathStrictlyInsideDirectory('C:\\SRV\\Uploads\\Avatars', 'c:\\srv\\uploads\\avatars\\a.webp', api), 'регистър')
  assert(!isPathStrictlyInsideDirectory('/srv/uploads/avatars', '/srv/uploads/Avatars/a.webp', path.posix), 'POSIX е чувствителен към регистъра')
})

console.log('\n[F] Реална файлова система')

const fsRoot = await mkdtemp(path.join(tmpdir(), 'belot-public-upload-path-'))
const uploadsRoot = path.join(fsRoot, 'uploads')
const outside = path.join(fsRoot, 'outside')
const realOptions = {
  uploadsRoot,
  publicRoots: PUBLIC_DIRS.map((dir) => path.join(uploadsRoot, dir)),
}
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
let fileSymlinksSupported = true

try {
  for (const dir of [...PUBLIC_DIRS, ...PRIVATE_DIRS]) await mkdir(path.join(uploadsRoot, dir), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.webp'), 'SECRET')
  await writeFile(path.join(uploadsRoot, 'avatars', 'ok.webp'), 'OK')
  await symlink(outside, path.join(uploadsRoot, 'profile-gallery', 'escape'), linkType)
  try {
    await symlink(path.join(outside, 'secret.webp'), path.join(uploadsRoot, 'avatars', 'link.webp'), 'file')
  } catch {
    fileSymlinksSupported = false // Windows без Developer Mode/администратор
  }

  await check('[U8] Symlink/junction извън публичния root не се чете; обикновеният файл се чете', async () => {
    const ok = resolvePublicUploadRequestPath('/uploads/avatars/ok.webp', realOptions)
    assert(ok !== null && (await resolveRealPublicUploadFilePath(ok)) !== null, 'обикновеният файл')
    const viaJunction = resolvePublicUploadRequestPath('/uploads/profile-gallery/escape/secret.webp', realOptions)
    assert(viaJunction !== null, 'URL-ът е синтактично валиден')
    assert(viaJunction !== null && (await resolveRealPublicUploadFilePath(viaJunction)) === null, 'junction директория извън root-а')
    if (fileSymlinksSupported) {
      const viaLink = resolvePublicUploadRequestPath('/uploads/avatars/link.webp', realOptions)
      assert(viaLink !== null && (await resolveRealPublicUploadFilePath(viaLink)) === null, 'файлов symlink извън root-а')
    } else {
      console.log('        (файлови symlink-ове не са разрешени на тази машина — проверена е само junction директорията)')
    }
  })

  await check('[U9] deletePublicUploadFile: обикновен -> deleted; липсващ -> missing; споделен -> остава; symlink/junction -> отказ, целта е непокътната; личен файл -> непокътнат', async () => {
    await writeFile(path.join(uploadsRoot, 'avatars', 'del.webp'), 'X')
    assert(await deletePublicUploadFile('/uploads/avatars/del.webp', realOptions) === 'deleted', 'deleted')
    assert(!existsSync(path.join(uploadsRoot, 'avatars', 'del.webp')), 'файлът е изтрит')
    assert(await deletePublicUploadFile('/uploads/avatars/del.webp', realOptions) === 'missing', 'missing')

    await writeFile(path.join(uploadsRoot, 'avatars', 'shared.webp'), 'S')
    const shared = await deletePublicUploadFile('/uploads/avatars/shared.webp', { ...realOptions, isStillReferenced: () => true })
    assert(shared === 'still_referenced' && existsSync(path.join(uploadsRoot, 'avatars', 'shared.webp')), `споделен: ${shared}`)

    const viaJunction = await deletePublicUploadFile('/uploads/profile-gallery/escape/secret.webp', realOptions)
    assert(viaJunction === 'refused_outside_root', `junction: ${viaJunction}`)
    assert(readFileSync(path.join(outside, 'secret.webp'), 'utf8') === 'SECRET', 'целта зад junction-а е непокътната')
    if (fileSymlinksSupported) {
      const viaLink = await deletePublicUploadFile('/uploads/avatars/link.webp', realOptions)
      assert(viaLink === 'refused_symlink', `symlink: ${viaLink}`)
      assert(existsSync(path.join(uploadsRoot, 'avatars', 'link.webp')), 'symlink-ът не е пипан')
    }

    await writeFile(path.join(uploadsRoot, 'chat-attachments', 'private.webp'), 'P')
    for (const url of ['/uploads/chat-attachments/private.webp', '/uploads/avatars/..%2Fchat-attachments%2Fprivate.webp']) {
      assert(await deletePublicUploadFile(url, realOptions) === 'not_public_upload', url)
    }
    assert(existsSync(path.join(uploadsRoot, 'chat-attachments', 'private.webp')), 'личният файл е непокътнат')

    await mkdir(path.join(uploadsRoot, 'avatars', 'dir.webp'))
    assert(await deletePublicUploadFile('/uploads/avatars/dir.webp', realOptions) === 'refused_not_regular_file', 'директория')
  })

  await check('[U10] profileUploadReferenceReader: аватар и снимка от галерията (оригинал и thumbnail) се откриват; други URL — не', async () => {
    const dbRoot = path.join(fsRoot, 'db')
    await mkdir(path.join(dbRoot, 'database', 'migrations'), { recursive: true })
    await mkdir(path.join(dbRoot, 'database', 'data'), { recursive: true })
    for (const entry of await readdir(path.join(serverRoot, 'database', 'migrations'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.sql')) {
        await cp(path.join(serverRoot, 'database', 'migrations', entry.name), path.join(dbRoot, 'database', 'migrations', entry.name))
      }
    }
    const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: dbRoot })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(databaseFilePath)
    const reader = await createProfileUploadReferenceReader(databaseFilePath)
    try {
      const id = randomUUID()
      const avatarUrl = `/uploads/avatars/${randomUUID()}.webp`
      const imageUrl = `/uploads/profile-gallery/${id}/${randomUUID()}.webp`
      const thumbUrl = `/uploads/profile-gallery/${id}/${randomUUID()}-thumb.webp`
      db.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name, avatar_url) VALUES (?, ?, ?, ?);`).run(id, `Ref${id.slice(0, 6)}`, `ref${id.slice(0, 6)}`, avatarUrl)
      const galleryColumns = (db.prepare(`PRAGMA table_info(profile_gallery_images);`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>)
      const values: Record<string, unknown> = { profile_id: id, image_url: imageUrl, thumbnail_url: thumbUrl }
      for (const column of galleryColumns) {
        if (column.name in values || column.notnull === 0 || column.dflt_value !== null) continue
        values[column.name] = column.name.endsWith('_id') ? randomUUID() : 0
      }
      const names = Object.keys(values)
      db.prepare(`INSERT INTO profile_gallery_images (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')});`).run(...(Object.values(values) as Array<string | number>))
      assert(reader.isProfileUploadUrlReferenced(avatarUrl), 'аватар')
      assert(reader.isProfileUploadUrlReferenced(imageUrl), 'снимка')
      assert(reader.isProfileUploadUrlReferenced(thumbUrl), 'thumbnail')
      assert(!reader.isProfileUploadUrlReferenced(`/uploads/avatars/${randomUUID()}.webp`), 'нерефериран аватар')
      assert(!reader.isProfileUploadUrlReferenced(`/uploads/gift-items/${randomUUID()}.webp`), 'друг вид (gift-items) — не е в обхвата')
    } finally {
      reader.close()
      db.close()
    }
  })
} finally {
  await rm(fsRoot, { recursive: true, force: true }).catch(() => {})
}

console.log('\n[S] index.ts')

await check('[U11] index.ts: без Windows разделител; каноничен URL за скритата галерия; realpath при четене; референции при изтриване; личните директории не са публични', async () => {
  const source = (await readFile(path.join(serverRoot, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')
  const resolver = /function resolveUploadRequestPath\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert(resolver.includes('resolvePublicUploadRequestPath(') && !resolver.includes("'\\\\'"), 'resolveUploadRequestPath')
  const handler = /async function handleUploadsRequest\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert(handler.includes('isUploadPathHiddenForDeletion(resolution.canonicalPathname)'), 'скритата галерия по каноничния URL')
  assert(handler.includes('resolveRealPublicUploadFilePath(resolution)'), 'realpath при четене')
  assert(handler.indexOf('isUploadPathHiddenForDeletion') < handler.indexOf('readFile('), 'скриването е преди четенето')
  const deleter = /async function deleteUploadFileByUrl\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  assert(deleter.includes('deletePublicUploadFile(') && deleter.includes('isProfileUploadUrlReferenced(') && !deleter.includes('unlink('), 'deleteUploadFileByUrl')
  const roots = /PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ''
  for (const constant of ['CHAT_ATTACHMENT_UPLOADS_PATH', 'SUPPORT_ATTACHMENT_UPLOADS_PATH', 'TOPIC_ATTACHMENT_UPLOADS_PATH', 'TOPIC_MUTE_EVIDENCE_ATTACHMENT_UPLOADS_PATH']) {
    assert(!roots.includes(constant), `${constant} е публичен`)
  }
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
