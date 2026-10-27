/**
 * checkBelotVisualOverride.ts
 *
 * "Визия на Белот" — unit тестове без сървър:
 *  [P] приоритет (resolveBelotVisual): ръчна → кампания → стандартна,
 *      поотделно за всяко изображение; изключена ръчна визия = кампанията.
 *  [S] съхранение (belotVisualOverrideStore върху admin_settings): изключено
 *      по подразбиране; изключването пази изображенията; повторното
 *      включване ги връща; стойностите оцеляват "рестарт" (нов store
 *      върху същата база); премахването трие реда.
 *  [W] WebP оптимизация (processBelotVisualImageToWebp): PNG/JPEG → WebP,
 *      качество ~92 (малка грешка спрямо източника), запазена прозрачност,
 *      запазени пропорции, без увеличаване, размери по ресурс, lossless за
 *      графики с фини детайли, lossy за снимки, отказ на невалидни файлове.
 *  [C] кампанийните callers на processImageAttachmentToWebp дават същите
 *      байтове като преди (новите опции не променят default-ите).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { createBelotVisualOverrideStore } from '../src/belotVisual/belotVisualOverrideStore.js'
import { resolveBelotVisual } from '../src/belotVisual/resolveBelotVisual.js'
import {
  BELOT_VISUAL_WEBP_QUALITY,
  processBelotVisualImageToWebp,
} from '../src/belotVisual/belotVisualImageProcessing.js'
import {
  GIFT_ITEM_IMAGE_WEBP_QUALITY,
  IMAGE_ATTACHMENT_WEBP_QUALITY,
  processImageAttachmentToWebp,
} from '../src/uploads/imageAttachments.js'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// Размерите по ресурс — същите като кампанийните (CAMPAIGN_THEME_ASSET_DIMENSION_PX).
const DIM = { table_bg_desktop: 2200, table_bg_mobile: 1400, card_back: 500 } as const

console.log('\ncheckBelotVisualOverride\n')

// ─── [P] Приоритет ──────────────────────────────────────────────────────────
console.log('--- Приоритет ---')
const campaign = { tableBgDesktopUrl: '/c/desk.webp', tableBgMobileUrl: '/c/mob.webp', cardBackUrl: '/c/back.webp' }
const manualAll = { enabled: true, tableBgDesktopUrl: '/m/desk.webp', tableBgMobileUrl: '/m/mob.webp', cardBackUrl: '/m/back.webp' }

await check('[P1] няма ръчна визия, няма кампания → стандартна (всичко null)', () => {
  const r = resolveBelotVisual(null, null)
  assert(r.tableBgDesktopUrl === null && r.tableBgMobileUrl === null && r.cardBackUrl === null, JSON.stringify(r))
})
await check('[P2] изключена ръчна визия + активна кампания → кампанията', () => {
  const r = resolveBelotVisual({ ...manualAll, enabled: false }, campaign)
  assert(JSON.stringify(r) === JSON.stringify(campaign), JSON.stringify(r))
})
await check('[P3] изключена ръчна визия, без кампания → стандартна', () => {
  const r = resolveBelotVisual({ ...manualAll, enabled: false }, null)
  assert(r.tableBgDesktopUrl === null && r.tableBgMobileUrl === null && r.cardBackUrl === null, JSON.stringify(r))
})
await check('[P4] включена ръчна визия има предимство пред кампанията', () => {
  const r = resolveBelotVisual(manualAll, campaign)
  assert(r.tableBgDesktopUrl === '/m/desk.webp' && r.tableBgMobileUrl === '/m/mob.webp' && r.cardBackUrl === '/m/back.webp', JSON.stringify(r))
})
await check('[P5] липсващо ръчно изображение → само за него кампанийното (без празни)', () => {
  const r = resolveBelotVisual({ enabled: true, tableBgDesktopUrl: '/m/desk.webp', tableBgMobileUrl: null, cardBackUrl: null }, campaign)
  assert(r.tableBgDesktopUrl === '/m/desk.webp' && r.tableBgMobileUrl === '/c/mob.webp' && r.cardBackUrl === '/c/back.webp', JSON.stringify(r))
})
await check('[P6] липсващо ръчно изображение без кампания → стандартна за него', () => {
  const r = resolveBelotVisual({ enabled: true, tableBgDesktopUrl: null, tableBgMobileUrl: '/m/mob.webp', cardBackUrl: null }, null)
  assert(r.tableBgDesktopUrl === null && r.tableBgMobileUrl === '/m/mob.webp' && r.cardBackUrl === null, JSON.stringify(r))
})
await check('[P7] включена, но без нито едно изображение → изцяло кампанията', () => {
  const r = resolveBelotVisual({ enabled: true, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null }, campaign)
  assert(JSON.stringify(r) === JSON.stringify(campaign), JSON.stringify(r))
})
await check('[P8] кампания с частична тема + ръчна за липсващото → смесено коректно', () => {
  const r = resolveBelotVisual({ enabled: true, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: '/m/back.webp' }, { tableBgDesktopUrl: '/c/desk.webp', tableBgMobileUrl: null, cardBackUrl: null })
  assert(r.tableBgDesktopUrl === '/c/desk.webp' && r.tableBgMobileUrl === null && r.cardBackUrl === '/m/back.webp', JSON.stringify(r))
})

// ─── [S] Съхранение ─────────────────────────────────────────────────────────
console.log('--- Съхранение ---')
const tempDir = await mkdtemp(join(tmpdir(), 'belot-visual-store-'))
const dbFile = join(tempDir, 'test.sqlite')
{
  const db = new DatabaseSync(dbFile)
  db.exec(`CREATE TABLE admin_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
  db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('anti_bad_luck_threshold', '5')`).run()
  db.close()
}
try {
  let store = await createBelotVisualOverrideStore(dbFile)
  await check('[S1] по подразбиране изключена и без изображения', () => {
    const s = store.getSnapshot()
    assert(s.enabled === false && s.tableBgDesktopUrl === null && s.tableBgMobileUrl === null && s.cardBackUrl === null, JSON.stringify(s))
  })
  await check('[S2] качване на трите изображения + включване', () => {
    store.setAssetUrl('table_bg_desktop', '/u/d1.webp')
    store.setAssetUrl('table_bg_mobile', '/u/m1.webp')
    store.setAssetUrl('card_back', '/u/b1.webp')
    const s = store.setEnabled(true)
    assert(s.enabled && s.tableBgDesktopUrl === '/u/d1.webp' && s.tableBgMobileUrl === '/u/m1.webp' && s.cardBackUrl === '/u/b1.webp', JSON.stringify(s))
  })
  await check('[S3] замяна връща предишния URL (за изтриване на стария файл)', () => {
    const { previousUrl, snapshot } = store.setAssetUrl('table_bg_desktop', '/u/d2.webp')
    assert(previousUrl === '/u/d1.webp' && snapshot.tableBgDesktopUrl === '/u/d2.webp', JSON.stringify({ previousUrl, snapshot }))
  })
  await check('[S4] изключване НЕ трие изображенията', () => {
    const s = store.setEnabled(false)
    assert(!s.enabled && s.tableBgDesktopUrl === '/u/d2.webp' && s.tableBgMobileUrl === '/u/m1.webp' && s.cardBackUrl === '/u/b1.webp', JSON.stringify(s))
  })
  store.close()
  store = await createBelotVisualOverrideStore(dbFile)
  await check('[S5] след "рестарт" (нов store върху същата база) всичко е запазено', () => {
    const s = store.getSnapshot()
    assert(!s.enabled && s.tableBgDesktopUrl === '/u/d2.webp' && s.cardBackUrl === '/u/b1.webp', JSON.stringify(s))
  })
  await check('[S6] повторно включване връща същите изображения', () => {
    const s = store.setEnabled(true)
    assert(s.enabled && s.tableBgDesktopUrl === '/u/d2.webp' && s.tableBgMobileUrl === '/u/m1.webp' && s.cardBackUrl === '/u/b1.webp', JSON.stringify(s))
  })
  await check('[S7] премахване трие реда, останалите остават', () => {
    const { previousUrl, snapshot } = store.setAssetUrl('table_bg_mobile', null)
    assert(previousUrl === '/u/m1.webp' && snapshot.tableBgMobileUrl === null && snapshot.tableBgDesktopUrl === '/u/d2.webp', JSON.stringify(snapshot))
    const db = new DatabaseSync(dbFile)
    const row = db.prepare(`SELECT 1 FROM admin_settings WHERE setting_key = 'belot_visual_table_bg_mobile_url'`).get()
    const other = db.prepare(`SELECT setting_value FROM admin_settings WHERE setting_key = 'anti_bad_luck_threshold'`).get() as { setting_value: string }
    db.close()
    assert(row === undefined, 'row still present')
    assert(other.setting_value === '5', 'unrelated admin setting changed')
  })
  store.close()
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

// ─── [W] WebP оптимизация ───────────────────────────────────────────────────
console.log('--- WebP оптимизация ---')

async function decodeRaw(buffer: Buffer) {
  return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

async function meanAbsDiff(a: Buffer, b: Buffer, width: number, height: number): Promise<number> {
  const ra = await sharp(a).resize(width, height).removeAlpha().raw().toBuffer()
  const rb = await sharp(b).resize(width, height).removeAlpha().raw().toBuffer()
  let sum = 0
  for (let i = 0; i < ra.length; i++) sum += Math.abs(ra[i]! - rb[i]!)
  return sum / ra.length
}

// Плавен "фотографски" градиент + шум (типична маса).
async function photoLike(width: number, height: number, format: 'png' | 'jpeg'): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const noise = (rand() - 0.5) * 40
      raw[i] = Math.max(0, Math.min(255, 20 + (x / width) * 60 + noise))
      raw[i + 1] = Math.max(0, Math.min(255, 90 + (y / height) * 80 + noise))
      raw[i + 2] = Math.max(0, Math.min(255, 40 + noise))
    }
  }
  const img = sharp(raw, { raw: { width, height, channels: 3 } })
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 95 }).toBuffer()
}

// Графика с фини детайли: плътни цветове, тънки линии, прозрачен фон.
async function graphicWithAlpha(width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="none"/>
    <rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.8}" height="${height * 0.8}" rx="20" fill="#7a1020"/>
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${width * 0.1}" y1="${height * 0.15 + i * 8}" x2="${width * 0.9}" y2="${height * 0.15 + i * 8}" stroke="#f4c95b" stroke-width="1"/>`).join('')}
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

await check('[W1] PNG маса (desktop) → WebP, пропорциите запазени, свалена до 2200px', async () => {
  const source = await photoLike(3000, 1500, 'png')
  const out = await processBelotVisualImageToWebp(source, DIM.table_bg_desktop)
  assert(out !== null, 'null')
  const meta = await sharp(out!.buffer).metadata()
  assert(meta.format === 'webp', `format ${meta.format}`)
  assert(out!.width === 2200 && out!.height === 1100, `${out!.width}x${out!.height}`)
})

await check('[W2] JPEG маса → lossy WebP с качество ~92 (малка грешка спрямо източника)', async () => {
  const source = await photoLike(1600, 900, 'jpeg')
  const out = await processBelotVisualImageToWebp(source, DIM.table_bg_desktop)
  assert(out !== null && out.mode === 'lossy', `mode ${out?.mode}`)
  const diff = await meanAbsDiff(source, out!.buffer, 1600, 900)
  // За сравнение: кампанийното качество (82) дава видимо по-голяма грешка.
  const baseline = await processImageAttachmentToWebp(source, { dimensionPx: DIM.table_bg_desktop, quality: IMAGE_ATTACHMENT_WEBP_QUALITY })
  const baselineDiff = await meanAbsDiff(source, baseline!.buffer, 1600, 900)
  assert(diff < 6, `mean abs diff ${diff.toFixed(2)}`)
  assert(diff < baselineDiff, `q${BELOT_VISUAL_WEBP_QUALITY} diff ${diff.toFixed(2)} >= q${IMAGE_ATTACHMENT_WEBP_QUALITY} diff ${baselineDiff.toFixed(2)}`)
})

await check('[W3] без ненужно увеличаване: малка маса остава в оригиналния си размер', async () => {
  const source = await photoLike(800, 400, 'png')
  const out = await processBelotVisualImageToWebp(source, DIM.table_bg_desktop)
  assert(out !== null && out.width === 800 && out.height === 400, `${out?.width}x${out?.height}`)
})

await check('[W4] mobile маса (портрет) → свалена до 1400px по дългата страна, пропорции 1:2', async () => {
  const source = await photoLike(1000, 2000, 'jpeg')
  const out = await processBelotVisualImageToWebp(source, DIM.table_bg_mobile)
  assert(out !== null && out.width === 700 && out.height === 1400, `${out?.width}x${out?.height}`)
})

await check('[W5] гръб на картите → до 500px, пропорции 300:420 запазени', async () => {
  const source = await photoLike(600, 840, 'png')
  const out = await processBelotVisualImageToWebp(source, DIM.card_back)
  assert(out !== null && out.height === 500 && Math.abs(out.width - 357) <= 1, `${out?.width}x${out?.height}`)
})

await check('[W6] прозрачност: PNG с прозрачен фон запазва alpha (прозрачният пиксел е прозрачен)', async () => {
  const source = await graphicWithAlpha(300, 420)
  const out = await processBelotVisualImageToWebp(source, DIM.card_back)
  assert(out !== null, 'null')
  const meta = await sharp(out!.buffer).metadata()
  assert(meta.hasAlpha === true, 'alpha channel lost')
  const { data, info } = await decodeRaw(out!.buffer)
  const cornerAlpha = data[3]!
  const centerIndex = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4
  assert(cornerAlpha === 0, `corner alpha ${cornerAlpha}`)
  assert(data[centerIndex + 3] === 255, `center alpha ${data[centerIndex + 3]}`)
})

await check('[W7] графика с фини детайли (PNG) → lossless, пиксел-точна', async () => {
  const source = await graphicWithAlpha(300, 420)
  const out = await processBelotVisualImageToWebp(source, DIM.card_back)
  assert(out !== null && out.mode === 'lossless', `mode ${out?.mode}`)
  const a = await decodeRaw(source)
  const b = await decodeRaw(out!.buffer)
  assert(a.data.equals(b.data), 'lossless output differs from source pixels')
})

await check('[W8] снимка, записана като PNG → lossy (не многократно по-тежък lossless)', async () => {
  const source = await photoLike(1200, 800, 'png')
  const out = await processBelotVisualImageToWebp(source, DIM.table_bg_desktop)
  assert(out !== null && out.mode === 'lossy', `mode ${out?.mode}`)
  assert(out!.buffer.length < source.length, `webp ${out!.buffer.length} >= png ${source.length}`)
})

await check('[W9] невалидни файлове се отказват (GIF, повреден PNG, твърде голям източник)', async () => {
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).gif().toBuffer()
  assert(await processBelotVisualImageToWebp(gif, DIM.card_back) === null, 'gif accepted')
  const broken = Buffer.concat([(await graphicWithAlpha(50, 50)).subarray(0, 40), Buffer.alloc(40)])
  assert(await processBelotVisualImageToWebp(broken, DIM.card_back) === null, 'broken png accepted')
  const huge = await sharp({ create: { width: 12_001, height: 10, channels: 3, background: '#000' } }).png().toBuffer()
  assert(await processBelotVisualImageToWebp(huge, DIM.table_bg_desktop) === null, 'oversized source accepted')
})

// ─── [C] Кампаниите не се променят ──────────────────────────────────────────
console.log('--- Кампанийните изображения ---')
await check('[C1] кампанийният pipeline (без новите опции) дава байтове като директния sharp pipeline отпреди', async () => {
  const source = await photoLike(900, 500, 'png')
  for (const [quality, dimensionPx] of [[IMAGE_ATTACHMENT_WEBP_QUALITY, 2200], [GIFT_ITEM_IMAGE_WEBP_QUALITY, 500]] as const) {
    const viaHelper = await processImageAttachmentToWebp(source, { enforceSourcePixelLimit: true, dimensionPx, quality })
    const reference = await sharp(source).rotate().resize(dimensionPx, dimensionPx, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer()
    assert(viaHelper !== null && viaHelper.buffer.equals(reference), `q${quality}: bytes differ`)
  }
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
