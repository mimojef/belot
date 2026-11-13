// checkVoiceBundle.mjs — проверка на production build-а за гласовия чат (Етап 3).
//
//   node node_modules/vite/bin/vite.js build --outDir <dir> --emptyOutDir
//   node scripts/checkVoiceBundle.mjs <dir> [<baselineDir>]
//
// Проверява: voice chunks (assets/voice-*) съществуват; нито един не е в PWA
// precache-а (sw.js); главният bundle не съдържа livekit-client/WebRTC код;
// нито един precache-нат chunk не импортира статично voice chunk; voice
// chunks не импортират статично нищо, освен други voice chunks. С baseline
// директория отпечатва и ръста на главния bundle (raw/gzip/brotli).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const [dir, baselineDir] = process.argv.slice(2)
if (!dir) {
  console.error('usage: node scripts/checkVoiceBundle.mjs <distDir> [<baselineDistDir>]')
  process.exit(2)
}

let failures = 0
const ok = (condition, label) => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`)
  if (!condition) failures += 1
}

function sizes(file) {
  const buffer = readFileSync(file)
  return { raw: buffer.length, gzip: gzipSync(buffer).length, brotli: brotliCompressSync(buffer).length }
}

function mainBundle(distDir) {
  const name = readdirSync(join(distDir, 'assets')).find((file) => /^index-.*\.js$/.test(file))
  if (name === undefined) throw new Error(`no main bundle in ${distDir}`)
  return name
}

const assetsDir = join(dir, 'assets')
const jsFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.js'))
const voiceFiles = jsFiles.filter((file) => file.startsWith('voice-'))
const main = mainBundle(dir)
const mainText = readFileSync(join(assetsDir, main), 'utf8')
const sw = readFileSync(join(dir, 'sw.js'), 'utf8')
const precached = new Set([...sw.matchAll(/"url":"([^"]+)"/g)].map((match) => match[1]))

console.log(`\ncheckVoiceBundle ${dir}\n`)
ok(voiceFiles.length > 0, `voice chunks: ${voiceFiles.join(', ')}`)
ok(precached.size > 0, `sw.js precache: ${precached.size} записа`)
ok(precached.has(`assets/${main}`), 'главният bundle е в precache-а')
for (const file of voiceFiles) ok(!precached.has(`assets/${file}`), `${file} НЕ е в precache-а`)
ok(!/voice-/.test([...precached].join('\n')), 'нито един voice-* запис в precache-а')
ok(!/RTCPeerConnection|livekit/i.test(mainText), 'главният bundle: без livekit-client / WebRTC')

const staticImports = (text) => [...text.matchAll(/(?:import|export)\s*(?:[^'"`;]*?from\s*)?["'`]\.\/([^"'`]+\.js)["'`]/g)].map((match) => match[1])
for (const file of jsFiles.filter((name) => precached.has(`assets/${name}`))) {
  const imported = staticImports(readFileSync(join(assetsDir, file), 'utf8')).filter((name) => name.startsWith('voice-'))
  if (imported.length > 0) ok(false, `${file} импортира статично ${imported.join(', ')}`)
}
ok(true, 'нито един precache-нат chunk не импортира статично voice chunk')
for (const file of voiceFiles) {
  const imported = staticImports(readFileSync(join(assetsDir, file), 'utf8'))
  const foreign = imported.filter((name) => !name.startsWith('voice-'))
  ok(foreign.length === 0, `${file}: статични зависимости ${imported.length === 0 ? '(няма)' : imported.join(', ')}`)
}

const mainSizes = sizes(join(assetsDir, main))
console.log(`\n  главен bundle ${main}: raw=${mainSizes.raw} gzip=${mainSizes.gzip} brotli=${mainSizes.brotli}`)
for (const file of voiceFiles) {
  const voiceSizes = sizes(join(assetsDir, file))
  console.log(`  ${file}: raw=${voiceSizes.raw} gzip=${voiceSizes.gzip} brotli=${voiceSizes.brotli}`)
}
if (baselineDir) {
  const base = sizes(join(baselineDir, 'assets', mainBundle(baselineDir)))
  console.log(`  ръст спрямо baseline: raw=${mainSizes.raw - base.raw} gzip=${mainSizes.gzip - base.gzip} brotli=${mainSizes.brotli - base.brotli} (байта)`)
}

console.log(failures === 0 ? '\nOK' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
