/**
 * checkSvaraAnimationDemo.ts — Свара, Етап 2А (без браузър).
 *
 *  A. Модел на движението: крайни точки, дъга, обръщане.
 *  B. Хореография: детерминизъм, 32 карти + 12 чипа, фази, вериги
 *     from/to, само 3 заредени лица, граници при различни размери.
 *  C. Измерител на кадрите (чиста функция).
 *  D. Изолация: pixi.js само в Pixi renderer-а, Белот/Ludo непроменени,
 *     svara chunks извън PWA precache (и проверка на dist/, ако има build).
 *
 * Пускане: npm run check:svara-animation-demo
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSvaraFlipMoment, sampleSvaraMove, type SvaraMove } from '../src/app/games/svara/demo/svaraDemoMotion'
import { buildSvaraDemoScript, getSvaraDemoFinalStates } from '../src/app/games/svara/demo/svaraDemoScript'
import { summarizeSvaraFrameDeltas } from '../src/app/games/svara/demo/svaraDemoFrameMeter'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const SIZES: Array<[number, number]> = [[320, 384], [366, 439], [390, 468], [640, 397], [720, 446], [1440, 893]]

console.log('\ncheckSvaraAnimationDemo')

// ─── A ───
console.log('\n=== A. движение ===')
const baseMove: SvaraMove = {
  id: 'x',
  from: { x: 10, y: 20, rotation: -4, scale: 1, alpha: 1, z: 1, faceUp: false },
  to: { x: 210, y: 120, rotation: 30, scale: 1.45, alpha: 0.5, z: 9, faceUp: true },
  delayMs: 0,
  durationMs: 500,
  easing: 'inOutCubic',
  liftPx: 40,
  liftScale: 1.1,
}

check('A1. t=0 и t=1 дават точно началното и крайното състояние', () => {
  const s0 = sampleSvaraMove(baseMove, 0)
  const s1 = sampleSvaraMove(baseMove, 1)
  assert(near(s0.x, 10) && near(s0.y, 20) && near(s0.rotation, -4) && near(s0.scaleY, 1) && near(s0.alpha, 1) && s0.faceUp === false, JSON.stringify(s0))
  assert(near(s1.x, 210) && near(s1.y, 120) && near(s1.rotation, 30) && near(s1.scaleY, 1.45) && near(s1.alpha, 0.5) && s1.faceUp === true, JSON.stringify(s1))
  assert(near(Math.abs(s1.scaleX), 1.45, 1e-3), `scaleX at end ${s1.scaleX}`)
})

check('A2. дъга: в средата картата е над правата линия с liftPx', () => {
  const tMid = findSvaraFlipMoment(baseMove)
  const s = sampleSvaraMove(baseMove, tMid)
  const straightY = 20 + (120 - 20) * 0.5
  assert(near(s.y, straightY - 40, 0.01), `y=${s.y}`)
})

check('A3. обръщане: лицето се сменя точно при |scaleX|≈0', () => {
  const at = findSvaraFlipMoment(baseMove)
  const before = sampleSvaraMove(baseMove, at - 0.002)
  const after = sampleSvaraMove(baseMove, at + 0.002)
  assert(before.faceUp === false && after.faceUp === true, 'face switch moment')
  assert(Math.abs(before.scaleX) < 0.05 && Math.abs(after.scaleX) < 0.05, `scaleX ${before.scaleX} / ${after.scaleX}`)
})

check('A4. без обръщане scaleX === scaleY; стойностите са крайни при t извън [0,1]', () => {
  const noFlip = { ...baseMove, to: { ...baseMove.to, faceUp: false } }
  for (const t of [-1, 0, 0.3, 0.7, 1, 2]) {
    const s = sampleSvaraMove(noFlip, t)
    assert(near(s.scaleX, s.scaleY) && Object.values(s).every((v) => typeof v === 'boolean' || Number.isFinite(v)), `t=${t}`)
  }
})

// ─── B ───
console.log('\n=== B. хореография ===')

check('B1. детерминистична (два build-а са идентични)', () => {
  assert(JSON.stringify(buildSvaraDemoScript(720, 446)) === JSON.stringify(buildSvaraDemoScript(720, 446)), 'non-deterministic')
})

check('B2. 32 уникални карти (7–A × 4 бои, налични файлове) + 12 чипа', () => {
  const script = buildSvaraDemoScript(720, 446)
  const cards = script.sprites.filter((s) => s.kind === 'card')
  const chips = script.sprites.filter((s) => s.kind === 'chip')
  assert(cards.length === 32 && chips.length === 12, `${cards.length}/${chips.length}`)
  assert(new Set(script.sprites.map((s) => s.id)).size === script.sprites.length, 'duplicate ids')
})

check('B3. фази: раздаване → обръщане → банка → СВАРКА → прибиране', () => {
  const script = buildSvaraDemoScript(720, 446)
  assert(script.phases.map((p) => p.name).join(',') === 'deal,reveal,bet,svarka,collect', script.phases.map((p) => p.name).join(','))
  assert(script.phases[0]!.moves.length === 12, 'deal = 4 × 3 карти')
  assert(script.phases[1]!.moves.length === 3 && script.phases[1]!.moves.every((m) => m.to.faceUp && !m.from.faceUp), 'reveal = 3 собствени карти')
  assert(script.phases[2]!.moves.length === 12 && script.phases[2]!.potAfter > 0, 'bet')
  assert(script.phases[3]!.showSvarkaBanner && script.phases.filter((p) => p.showSvarkaBanner).length === 1, 'svarka banner')
  assert(script.phases[4]!.winnerSeat === 0 && script.phases[4]!.moves.every((m) => m.to.alpha === 0), 'collect to winner')
})

check('B4. всяко движение започва от състоянието след предходната фаза', () => {
  const script = buildSvaraDemoScript(390, 468)
  let current = script.initial
  script.phases.forEach((phase, i) => {
    for (const move of phase.moves) assert(JSON.stringify(move.from) === JSON.stringify(current[move.id]), `phase ${phase.name} ${move.id}`)
    current = script.statesAfter[i]!
  })
  assert(getSvaraDemoFinalStates(script) === current, 'final state')
})

check('B5. лице се зарежда само за 3-те карти, които реално се обръщат', () => {
  const script = buildSvaraDemoScript(720, 446)
  const withFace = script.sprites.filter((s) => s.kind === 'card' && s.faceSrc !== null).map((s) => s.id).sort()
  const revealed = script.phases[1]!.moves.map((m) => m.id).sort()
  assert(JSON.stringify(withFace) === JSON.stringify(revealed), `${withFace} vs ${revealed}`)
  for (const sprite of script.sprites) {
    if (sprite.kind === 'card' && sprite.faceSrc) assert(existsSync(join('public', sprite.faceSrc)), `missing ${sprite.faceSrc}`)
  }
})

for (const [w, h] of SIZES) {
  check(`B6. ${w}×${h}: всички видими спрайтове и аватари са в масата, без NaN`, () => {
    const script = buildSvaraDemoScript(w, h)
    const { layout } = script
    const states = [script.initial, ...script.statesAfter]
    for (const snapshot of states) {
      for (const [id, s] of Object.entries(snapshot)) {
        assert([s.x, s.y, s.rotation, s.scale, s.alpha].every(Number.isFinite), `${id} NaN`)
        if (s.alpha === 0) continue
        const half = (id.startsWith('card') ? layout.cardHeight : layout.chipSize) * s.scale / 2
        assert(s.x - half >= -2 && s.x + half <= layout.width + 2 && s.y - half >= -2 && s.y + half <= layout.height + 2, `${id} out of bounds at ${s.x.toFixed(1)},${s.y.toFixed(1)}`)
      }
    }
    for (const seat of layout.seats) {
      const r = layout.avatarSize / 2
      assert(seat.avatar.x - r >= 0 && seat.avatar.x + r <= layout.width && seat.avatar.y - r >= 0 && seat.avatar.y + r <= layout.height, `seat ${seat.index}`)
    }
  })
}

check('B7. обърнатите карти не застъпват собствения аватар', () => {
  for (const [w, h] of SIZES) {
    const script = buildSvaraDemoScript(w, h)
    const { layout } = script
    const avatar = layout.seats[0]!.avatar
    for (const move of script.phases[1]!.moves) {
      const bottom = move.to.y + (layout.cardHeight * move.to.scale) / 2
      assert(bottom <= avatar.y - layout.avatarSize / 2 + 2, `${w}×${h}: card bottom ${bottom.toFixed(1)} over avatar top ${(avatar.y - layout.avatarSize / 2).toFixed(1)}`)
    }
  }
})

// ─── C ───
console.log('\n=== C. измерител ===')
check('C1. summarizeSvaraFrameDeltas: fps, p95, дълги кадри и моментите им', () => {
  const deltas = [...Array(58).fill(16.7), 50, 33.4]
  const ends = deltas.reduce<number[]>((acc, d) => [...acc, (acc[acc.length - 1] ?? 0) + d], [])
  const stats = summarizeSvaraFrameDeltas(deltas, 1000, ends)!
  assert(stats.frames === 60 && near(stats.avgFps, 60) && stats.longFrames === 2 && stats.maxFrameMs === 50, JSON.stringify(stats))
  assert(stats.longFrameAtMs.length === 2 && stats.longFrameAtMs[0] === Math.round(ends[58]!), JSON.stringify(stats.longFrameAtMs))
  assert(summarizeSvaraFrameDeltas([], 100) === null, 'empty')
})

// ─── D ───
console.log('\n=== D. изолация ===')
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(dir, e.name)] : []))
}

check('D1. pixi.js се импортира само от svaraDemoPixiRenderer.ts (и то само чрез dynamic import)', () => {
  const importers = walk('src').filter((f) => /from ['"]pixi\.js['"]|import\(['"]pixi\.js['"]\)/.test(readFileSync(f, 'utf8')))
  assert(importers.length === 1 && importers[0]!.replace(/\\/g, '/').endsWith('games/svara/demo/svaraDemoPixiRenderer.ts'), importers.join(', '))
  const staticImporters = walk('src').filter((f) => /from ['"]\.\/svaraDemoPixiRenderer['"]|from ['"].*svara\/demo\/svaraDemoPixiRenderer['"]/.test(readFileSync(f, 'utf8')))
  assert(staticImporters.length === 0, `static import of pixi renderer: ${staticImporters.join(', ')}`)
  const lobby = readFileSync(join('src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  assert(lobby.includes("await import('../games/svara/demo/createSvaraAnimationDemo')"), 'demo is not lazy-loaded')
  assert(!/^import .*svara\/demo/m.test(lobby), 'static import of demo in lobby controller')
})

check('D2. Белот (activeRoom) и Ludo модулите не са променени спрямо Етап 1 (9e0bc8b)', () => {
  const changed = execFileSync('git', ['diff', '--name-only', '9e0bc8b', '--', 'src/app/activeRoom', 'src/app/games/ludo', 'server/src/game'], { encoding: 'utf8' }).trim()
  assert(changed === '', changed)
})

check('D3. vite.config: svara chunks са именувани и изключени от PWA precache', () => {
  const config = readFileSync('vite.config.ts', 'utf8')
  assert(config.includes("globIgnores: ['index.html', 'assets/svara-*']"), 'globIgnores')
  assert(config.includes("'assets/svara-[name]-[hash].js'") && config.includes('facadeModuleId'), 'chunkFileNames')
})

if (existsSync(join('dist', 'sw.js'))) {
  check('D4. [dist] svara-* не са в precache манифеста; pixi кодът е само в svara-* chunks', () => {
    const sw = readFileSync(join('dist', 'sw.js'), 'utf8')
    assert(!sw.includes('svara-'), 'svara chunk in precache manifest')
    const assets = readdirSync(join('dist', 'assets')).filter((f) => f.endsWith('.js'))
    assert(assets.some((f) => f.startsWith('svara-') && f.includes('svaraDemoPixiRenderer')), 'pixi renderer chunk missing (stale build?)')
    const leaked = assets.filter((f) => !f.startsWith('svara-') && /autoDetectRenderer|GlProgram|svaraDemoPixiRenderer\(/.test(readFileSync(join('dist', 'assets', f), 'utf8')))
    assert(leaked.length === 0, `pixi code outside svara chunks: ${leaked.join(', ')}`)
    const html = readFileSync(join('dist', 'index.html'), 'utf8')
    assert(!html.includes('svara-'), 'svara chunk referenced from index.html (modulepreload)')
  })
} else {
  console.log('  skip D4 (няма dist/ — пусни npm run build)')
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
